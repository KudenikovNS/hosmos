// T-13 guard unit-tests for the db client module (src/server/db/index.ts).
// No database is touched here — these run in the pure/unit group (no DATABASE_URL
// required). They lock in three contracts:
//   1. importing the module never throws (server-only is neutralised for node);
//   2. touching `db` without DATABASE_URL throws a clear, actionable error;
//   3. with DATABASE_URL set, `db.select().from(schema.companies)` builds SQL
//      (drizzle is schema-typed) — no connection is opened by `.toSQL()`;
//   4. the DB_POOL_MAX pool-size guard clamps junk / empty / <=0 values to 2 so
//      an empty DB_POOL_MAX can never become postgres.js `max:0` (= unlimited
//      pool, which would defeat the shared-host connection cap, risk Р-6).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts starts with `import "server-only"` which throws under node/vitest —
// neutralise it so the module is importable outside the RSC bundle.
vi.mock("server-only", () => ({}));

import * as schema from "../schema";
import { resolvePoolMax } from "../index";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolvePoolMax (DB_POOL_MAX clamp, risk Р-6)", () => {
  it("defaults to 2 for undefined / empty / non-numeric / non-positive input", () => {
    // The dangerous cases: "" and undefined used to yield Number("")===0 /
    // Number(undefined)===NaN, and postgres.js treats max:0 as UNLIMITED.
    expect(resolvePoolMax(undefined)).toBe(2);
    expect(resolvePoolMax("")).toBe(2);
    expect(resolvePoolMax("   ")).toBe(2);
    expect(resolvePoolMax("0")).toBe(2);
    expect(resolvePoolMax("-1")).toBe(2);
    expect(resolvePoolMax("abc")).toBe(2);
    expect(resolvePoolMax("2.5")).toBe(2); // non-integer → default
  });

  it("honours a valid positive integer", () => {
    expect(resolvePoolMax("1")).toBe(1);
    expect(resolvePoolMax("2")).toBe(2);
    expect(resolvePoolMax("5")).toBe(5);
  });
});

describe("db client module", () => {
  it("imports without throwing and exposes `db`", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const mod = await import("../index");
    expect(mod.db).toBeDefined();
  });

  it("throws a clear error when `db` is touched without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const mod = await import("../index");
    expect(() => mod.db.select()).toThrow(/DATABASE_URL is not set/);
  });

  it("builds schema-typed SQL when DATABASE_URL is set (no connection opened)", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/db");
    const mod = await import("../index");
    const { sql } = mod.db.select().from(schema.companies).toSQL();
    expect(sql).toContain("companies");
  });
});
