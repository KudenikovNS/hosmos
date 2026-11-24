// Scope-3 spend lines data access (DATA-INTEGRITY §Q3(b)/§Q3-FX, T1.5b). Read and
// write helpers over `scope3_spend` and `scope3_results`, keyed by (company,
// year) — the annual per-commodity spend lines that feed cats 1 & 2 and the
// per-category totals computed from them.
//
// T3.6: this module is now purely those two TABLES. The compute
// (`@/server/scope3/compute`), the factor source (`@/server/scope3/factors`) and
// the recalculation that joins them (`@/server/scope3/recalculate`) all live in
// `src/server/scope3` — outside the legacy emissions stack deleted by T3.8/T3.9,
// because the spend feature is parked, not dropped (О-8/MIG-10).
import "server-only";

import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "@/server/db/schema";
import { scope3Results, scope3Spend } from "@/server/db/schema";

/** One `scope3_spend` line, NUMERIC coerced to a JS number, for the recalc compute. */
export interface Scope3SpendLine {
  id: string;
  category: number; // 1 (purchased goods) | 2 (capital goods)
  commodityKey: string; // → emission_factor.activity_type 'scope3_spend:<key>' (EXIOBASE per-€1000)
  spendAmount: number; // denominated in `currency`, NOT EUR
  currency: string; // ISO-4217, converted to EUR server-side before the factor applies
}

// The db singleton or a transaction handle (recalc passes its `tx`), so
// `recalculateScope3Spend` can read spend lines inside its own transaction.
type Database = PostgresJsDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Scope3SpendDb = Database | Transaction;

/**
 * All `scope3_spend` lines for `(companyId, year)`. `numeric spend_amount` comes
 * back as a string, so it is coerced here; the currency is passed through as-is
 * (converted to EUR by the pure compute using the year's FX map).
 */
export async function getScope3Spend(
  db: Scope3SpendDb,
  companyId: string,
  year: string,
): Promise<Scope3SpendLine[]> {
  const rows = await db
    .select({
      id: scope3Spend.id,
      category: scope3Spend.category,
      commodityKey: scope3Spend.commodityKey,
      spendAmount: scope3Spend.spendAmount,
      currency: scope3Spend.currency,
    })
    .from(scope3Spend)
    .where(
      and(eq(scope3Spend.companyId, companyId), eq(scope3Spend.year, year)),
    );
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    commodityKey: r.commodityKey,
    spendAmount: Number(r.spendAmount),
    currency: r.currency,
  }));
}

/** One persisted per-category Scope-3 result, NUMERIC coerced to a JS number. */
export interface Scope3ResultRow {
  categoryId: number;
  categoryName: string;
  tco2e: number;
  methodology: string | null;
  dataQuality: string | null;
}

/**
 * The persisted Scope-3 per-category breakdown for `(companyId, year)`, ordered by
 * `category_id` (T1.6 §Q4). Cats 1/2 are written by `recalculateScope3Spend`
 * (T3.6), cats 4–7 by the legacy engine until T3.8 removes it; the report (T3.1)
 * consumes the whole breakdown to replace the fabricated 60/40 split.
 */
export async function getScope3Results(
  db: Scope3SpendDb,
  companyId: string,
  year: string,
): Promise<Scope3ResultRow[]> {
  const rows = await db
    .select({
      categoryId: scope3Results.categoryId,
      categoryName: scope3Results.categoryName,
      tco2e: scope3Results.tco2e,
      methodology: scope3Results.methodology,
      dataQuality: scope3Results.dataQuality,
    })
    .from(scope3Results)
    .where(
      and(eq(scope3Results.companyId, companyId), eq(scope3Results.year, year)),
    )
    .orderBy(asc(scope3Results.categoryId));
  return rows.map((r) => ({
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    tco2e: Number(r.tco2e),
    methodology: r.methodology,
    dataQuality: r.dataQuality,
  }));
}

// The commodity CATALOGUE used to be derived here, from legacy `emission_factors
// (category='scope3', unit='EUR 1000 spent')`. T3.6 moved it to
// `@/server/scope3/factors#listSpendCommodities`, off the new `emission_factor`
// library — the same rows the recalculation resolves, so what the editor offers
// and what the engine can price are one query apart, not one table apart.

/** The values a spend-line write may set (identity/year are pinned by the route). */
export interface Scope3SpendValues {
  commodityKey: string;
  category: number; // server-derived from the commodity, never trusted from a client
  spendAmount: number; // in `currency`, ≥ 0
  currency: string; // ISO-4217, must exist in `currencies`
}

/**
 * Upsert one spend line on the natural key `(company_id, year, commodity_key)`
 * (§Q3(b)). A second write for the same commodity/year edits the existing line in
 * place rather than inserting a duplicate. `spendAmount`/`category`/`currency` are
 * all set by the SERVER (category derived from the commodity, factor+FX applied in
 * recalc) — the caller has already validated them. Returns the persisted row.
 */
export async function upsertScope3SpendLine(
  db: Scope3SpendDb,
  companyId: string,
  year: string,
  values: Scope3SpendValues,
) {
  const [row] = await db
    .insert(scope3Spend)
    .values({
      companyId,
      year,
      category: values.category,
      commodityKey: values.commodityKey,
      spendAmount: String(values.spendAmount),
      currency: values.currency,
    })
    .onConflictDoUpdate({
      target: [
        scope3Spend.companyId,
        scope3Spend.year,
        scope3Spend.commodityKey,
      ],
      set: {
        category: values.category,
        spendAmount: String(values.spendAmount),
        currency: values.currency,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/**
 * Delete a spend line, pinned to `company_id` so a cross-tenant id/commodity is a
 * no-op (returns `false`, never touches another company's line). Accepts either a
 * row `id` or a `(year, commodityKey)` pair — whichever the client sends.
 */
export async function deleteScope3SpendLine(
  db: Scope3SpendDb,
  companyId: string,
  target: { id?: string; year?: string; commodityKey?: string },
): Promise<boolean> {
  const where = target.id
    ? and(eq(scope3Spend.id, target.id), eq(scope3Spend.companyId, companyId))
    : target.year && target.commodityKey
      ? and(
          eq(scope3Spend.companyId, companyId),
          eq(scope3Spend.year, target.year),
          eq(scope3Spend.commodityKey, target.commodityKey),
        )
      : null;
  if (!where) return false;
  const rows = await db
    .delete(scope3Spend)
    .where(where)
    .returning({ id: scope3Spend.id });
  return rows.length > 0;
}
