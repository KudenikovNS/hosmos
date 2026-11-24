// =============================================================================
// `DbClient` — "the pooled singleton `db`, or a transaction handle".
//
// WHY IT IS ITS OWN FILE. Every service module of the Phase-1 model takes a
// database handle as its first argument so that the SAME function can be called
// outside a transaction (a plain read) and inside one (the write path of
// `writeValidated`). Spelling that union out per module is four imports and
// eight lines of Drizzle generics each; by T2.3 it had been written three times
// (`legal-entities.ts`, `validation/types.ts`, and about to be `facilities.ts`),
// which is where a copy becomes a definition.
//
// It is TYPE-ONLY and imports `./schema` type-only, so it pulls no runtime code
// and — unlike `./index` — carries no `server-only` marker: a type cannot leak a
// connection into a client bundle.
// =============================================================================
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";

import type * as schema from "./schema";

type Schema = typeof schema;

/** The pooled singleton `db` or a transaction handle — interchangeable to a service. */
export type DbClient =
  | PostgresJsDatabase<Schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      Schema,
      ExtractTablesWithRelations<Schema>
    >;
