/**
 * Drizzle database client + connection pool (PG-IMPL-SPEC §2.4).
 *
 * Server-only module singleton. The pool is deliberately small: on the target
 * cPanel-shared host (neoserv) Passenger may run several workers, each with its
 * own module singleton, so the effective connection count is `max × workers`.
 * Keep `max` at 1..2 per worker and a short `idle_timeout` so the total stays
 * well under the DB connection limit (§2.4, risk Р-6).
 *
 * Load-safety contract: creating the postgres.js client (and reading
 * DATABASE_URL) is deferred to first use of `db`, NOT done at import time. That
 * keeps `next build` (which imports server modules without a database in the
 * environment) green — a missing DATABASE_URL only throws when `db` is actually
 * touched, with a clear message. Access is routed through a Proxy that builds
 * the real drizzle instance lazily and caches it.
 */
import "server-only";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

type Schema = typeof schema;
type Database = PostgresJsDatabase<Schema>;

let instance: Database | undefined;

/**
 * Resolve the postgres.js pool `max` from DB_POOL_MAX, clamped to a safe value.
 *
 * postgres.js treats `max: 0` as an UNLIMITED pool. `Number(process.env.DB_POOL_MAX)`
 * silently produces `0` for an empty string and `NaN` for junk / undefined, either
 * of which would blow past the shared-host connection cap (risk Р-6). Only a
 * positive integer is honoured; everything else falls back to the safe default 2.
 */
export function resolvePoolMax(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

/** Build (once) the postgres.js pool + drizzle instance, guarding DATABASE_URL. */
function getDb(): Database {
  if (instance) return instance;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — cannot create the database client. " +
        "Set DATABASE_URL in the environment before using `db`.",
    );
  }

  const client = postgres(url, {
    // cPanel-shared (neoserv): hard process/connection limits → tiny pool per
    // Passenger worker. Effective connections = max × workers (§2.4). Clamped so
    // an empty/invalid DB_POOL_MAX can never become postgres.js max:0 (unlimited).
    max: resolvePoolMax(process.env.DB_POOL_MAX),
    idle_timeout: 20, // release idle connections quickly
  });

  instance = drizzle(client, { schema });
  return instance;
}

/**
 * The Drizzle client, typed by the full schema (`db.select().from(...)` is
 * schema-aware). Backed by a lazily-initialised singleton so the module is safe
 * to import without a database configured.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    const real = getDb();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
