/**
 * Goals / sustainability-target data-access — Drizzle service functions
 * (§Q5, DATA-INTEGRITY-PLAN T2.2).
 *
 * A company owns many `goals` rows (unlike the 1-per-year `people_data`), so the
 * service is a small CRUD surface rather than an upsert-on-a-natural-key:
 *   - `listGoals`   — the company's goals, newest first (feeds the form list + GET);
 *   - `insertGoal`  — create a new goal for the company;
 *   - `updateGoal`  — edit an EXISTING goal, but only when its id belongs to the
 *                     session company (the WHERE pins `company_id`, so a foreign id
 *                     updates nothing and returns `null`);
 *   - `deleteGoal`  — remove a goal, again pinned to `company_id` so a cross-tenant
 *                     id is a no-op (returns `false`, never touches another company).
 *
 * Every function takes the Drizzle client/tx as its first argument (same contract
 * as `emissions.ts`), so routes pass the pooled `db` and tests pass the harness
 * instance. Numeric columns stay `string` on read (Drizzle default).
 *
 * No footprint effect: goals never enter the carbon formula. `category='emissions'`
 * goals feed the ESRS E1-4 targets table in the report (T3.2).
 */
import { and, desc, eq, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";

import { goals } from "./schema";
import type * as schema from "./schema";

/** The pooled singleton `db` or a transaction handle — same contract as `emissions.ts`. */
type Schema = typeof schema;
type DbClient =
  | PostgresJsDatabase<Schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      Schema,
      ExtractTablesWithRelations<Schema>
    >;

/** The mutable goal columns a write route may set (identity/timestamps excluded). */
export type GoalValues = Omit<
  typeof goals.$inferInsert,
  "id" | "companyId" | "createdAt" | "updatedAt"
>;

/** All of a company's goals, newest first (for the form list + `GET /api/goals`). */
export async function listGoals(db: DbClient, companyId: string) {
  return db
    .select()
    .from(goals)
    .where(eq(goals.companyId, companyId))
    .orderBy(desc(goals.createdAt));
}

/** Create a new goal for the company. Returns the inserted row. */
export async function insertGoal(
  db: DbClient,
  companyId: string,
  values: GoalValues,
) {
  const [row] = await db
    .insert(goals)
    .values({ companyId, ...values })
    .returning();
  return row;
}

/**
 * Update an existing goal in place — but ONLY when `id` belongs to `companyId`.
 * A foreign id matches no row (the WHERE pins `company_id`), so this returns
 * `null` and never edits another tenant's goal.
 */
export async function updateGoal(
  db: DbClient,
  companyId: string,
  id: string,
  values: GoalValues,
) {
  const [row] = await db
    .update(goals)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(goals.id, id), eq(goals.companyId, companyId)))
    .returning();
  return row ?? null;
}

/**
 * Delete a goal, pinned to `company_id`. Returns `true` when a row was removed,
 * `false` when the id is unknown OR belongs to another company (no cross-tenant
 * delete: the foreign id simply matches nothing).
 */
export async function deleteGoal(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(goals)
    .where(and(eq(goals.id, id), eq(goals.companyId, companyId)))
    .returning({ id: goals.id });
  return rows.length > 0;
}
