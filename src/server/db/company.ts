/**
 * Company data-access — Drizzle service functions (PG-PLAN T-16, §1.2).
 *
 * A 1:1 port of `queries/company.ts:updateCompany` onto Drizzle. Pure service
 * function (no `"use server"`): it takes the Drizzle client/transaction first so
 * callers pass the singleton `db` (route handlers) or a `tx`, and tests exercise
 * it against the real Postgres harness (T-13). The legacy `queries/company.ts`
 * stays until its consumers are cut over (T-26); this is the parallel Drizzle
 * version the API phase (T-21) will call.
 *
 * The Supabase `.update(...).eq("id").select().single()` becomes
 * `db.update(companies).set(updates).where(eq(id)).returning()` → `rows[0]`, the
 * full updated company row (NUMERIC columns stay `string`, same as before).
 */
import { eq, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";

import { companies } from "./schema";
import type * as schema from "./schema";

/**
 * The Drizzle client accepted by the service function: either the pooled
 * singleton (`db` from ./index) or a transaction handle (`tx`).
 */
type Schema = typeof schema;
type DbClient =
  | PostgresJsDatabase<Schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      Schema,
      ExtractTablesWithRelations<Schema>
    >;

/** Column keys of `companies` that `updateCompany` is allowed to set. */
type CompanyUpdate = Partial<typeof companies.$inferInsert>;

/** Update a company's profile / settings and return the updated row. */
export async function updateCompany(
  db: DbClient,
  companyId: string,
  updates: CompanyUpdate,
) {
  const [row] = await db
    .update(companies)
    .set(updates)
    .where(eq(companies.id, companyId))
    .returning();
  return row;
}
