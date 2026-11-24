/**
 * Supply-chain / supplier-disclosure data-access — Drizzle service functions
 * (§Q5, DATA-INTEGRITY-PLAN T2.3).
 *
 * A company owns many `supply_chain_data` rows (one per disclosed supplier), so the
 * service is a small CRUD surface (mirrors `goals.ts`, not the 1-per-year upsert):
 *   - `listSuppliers` — the company's suppliers, newest first (feeds the form list + GET);
 *   - `insertSupplier` — create a new supplier row for the company;
 *   - `updateSupplier` — edit an EXISTING supplier, but only when its id belongs to the
 *                        session company (the WHERE pins `company_id`, so a foreign id
 *                        updates nothing and returns `null`);
 *   - `deleteSupplier` — remove a supplier, again pinned to `company_id` so a cross-tenant
 *                        id is a no-op (returns `false`, never touches another company).
 *
 * Every function takes the Drizzle client/tx as its first argument (same contract as
 * `goals.ts`), so routes pass the pooled `db` and tests pass the harness instance.
 * Numeric columns stay `string` on read (Drizzle default).
 *
 * DISCLOSURE ONLY (D7): supplier rows NEVER enter the carbon formula. The per-supplier
 * `spendEur`/`emissionsTco2e`/`esgScore` are self-reported disclosure figures — the
 * Scope-3 cat.1 spend path is the separate §Q3(b) spend editor (T2.4), not this table.
 */
import { and, desc, eq, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";

import { supplyChainData } from "./schema";
import type * as schema from "./schema";

/** The pooled singleton `db` or a transaction handle — same contract as `goals.ts`. */
type Schema = typeof schema;
type DbClient =
  | PostgresJsDatabase<Schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      Schema,
      ExtractTablesWithRelations<Schema>
    >;

/** The mutable supplier columns a write route may set (identity/timestamps excluded). */
export type SupplierValues = Omit<
  typeof supplyChainData.$inferInsert,
  "id" | "companyId" | "createdAt" | "updatedAt"
>;

/** All of a company's suppliers, newest first (for the form list + `GET /api/supply-chain`). */
export async function listSuppliers(db: DbClient, companyId: string) {
  return db
    .select()
    .from(supplyChainData)
    .where(eq(supplyChainData.companyId, companyId))
    .orderBy(desc(supplyChainData.createdAt));
}

/** Create a new supplier row for the company. Returns the inserted row. */
export async function insertSupplier(
  db: DbClient,
  companyId: string,
  values: SupplierValues,
) {
  const [row] = await db
    .insert(supplyChainData)
    .values({ companyId, ...values })
    .returning();
  return row;
}

/**
 * Update an existing supplier in place — but ONLY when `id` belongs to `companyId`.
 * A foreign id matches no row (the WHERE pins `company_id`), so this returns `null`
 * and never edits another tenant's supplier.
 */
export async function updateSupplier(
  db: DbClient,
  companyId: string,
  id: string,
  values: SupplierValues,
) {
  const [row] = await db
    .update(supplyChainData)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(eq(supplyChainData.id, id), eq(supplyChainData.companyId, companyId)),
    )
    .returning();
  return row ?? null;
}

/**
 * Delete a supplier, pinned to `company_id`. Returns `true` when a row was removed,
 * `false` when the id is unknown OR belongs to another company (no cross-tenant
 * delete: the foreign id simply matches nothing).
 */
export async function deleteSupplier(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(supplyChainData)
    .where(
      and(eq(supplyChainData.id, id), eq(supplyChainData.companyId, companyId)),
    )
    .returning({ id: supplyChainData.id });
  return rows.length > 0;
}
