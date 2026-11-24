// =============================================================================
// SPEND-BASED SCOPE 3 — THE NARROW RECALCULATION (О-8 / MIG-10, plan T3.6).
//
// WHAT THIS REPLACES. `POST/DELETE /api/scope3-spend` used to call
// `recalculateEmissions(companyId, year)` — the whole wide-table engine: it read
// `monthly_emissions_data`, read `people_data.fte`, resolved all 25 factors,
// UPDATEd twelve monthly rows and UPSERTed `emission_results`, and it REFUSED
// with `NoMonthlyDataError` when the company had no monthly rows. That made a
// live, billable, parked feature depend on three tables `T3.9` dropped, and made
// "save my purchasing spend" fail for any company that had not first filled in a
// monthly grid it has nothing to do with.
//
// WHAT IT DOES INSTEAD. Exactly the three reads the formula needs — the year's
// `scope3_spend` lines, the year's FX map, and the spend factors of the active
// `factor_set` — and one write: `scope3_results` categories 1 and 2. It never
// touched the wide tables (`monthly_emissions_data`, `people_data`,
// `emission_results`), which is why T3.9 could drop them, and it does not write
// the activity-based categories 4/5/6/7 either — those never came from spend, and
// nothing writes them until S5.
//
// NO `NoMonthlyDataError`. An empty `scope3_spend` is not an error and never was
// a fact about spend: it yields cat1 = cat2 = 0, the stale result rows are
// deleted, and the caller gets 200 with no warnings. The route's old
// "Spend saved; add monthly activity data to compute a footprint." consolation
// message goes with it — there is nothing left to console.
//
// THE ARITHMETIC IS UNCHANGED. `computeScope3Spend` moved here byte-identical
// (see `./compute`) and the factor rows are re-expressed in its own vocabulary
// (see `./factors`); this module only sequences the two. A number computed
// before T3.6 and after it is the same number — which is T3.6's acceptance
// criterion, and the plan's ONE sanctioned before/after comparison, precisely
// because this feature is parked rather than deleted.
// =============================================================================
import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { getFxRates } from "@/server/db/fx";
import { scope3Results } from "@/server/db/schema";
import { getScope3Spend } from "@/server/db/scope3-spend";

import { computeScope3Spend } from "./compute";
import { activeFactorSetId, loadSpendFactorRows } from "./factors";

/**
 * The two spend-based categories, and how the persisted row describes itself.
 * Byte-identical to what the legacy engine wrote, so a re-save of an existing
 * company's spend does not silently relabel its rows.
 */
const SPEND_CATEGORY_META: Record<
  1 | 2,
  { name: string; methodology: string; dataQuality: "secondary" }
> = {
  1: {
    name: "Purchased goods & services",
    methodology: "spend-based (EXIOBASE)",
    dataQuality: "secondary",
  },
  2: {
    name: "Capital goods",
    methodology: "spend-based (EXIOBASE)",
    dataQuality: "secondary",
  },
};

/** The same 2-decimal rounding the persisted result has always used. */
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** What a recalculation reports back — the two persisted subtotals plus D4 warnings. */
export interface Scope3SpendRecalculation {
  /** Cat 1 tCO2e as persisted (rounded); 0 when no cat-1 line contributes. */
  cat1: number;
  /** Cat 2 tCO2e as persisted (rounded). */
  cat2: number;
  /** Per-line D4 warnings: a currency with no FX rate, a commodity with no factor. */
  warnings: string[];
}

/**
 * Recalculate the spend-based half of Scope 3 for `(companyId, year)` and persist
 * it as `scope3_results` categories 1 and 2.
 *
 * One transaction, four steps: FX map → spend lines → the active set's spend
 * factors → compute; then per category an UPSERT on `(company, year, category)`
 * when the subtotal is > 0 and a DELETE of the stale row when it is not, so the
 * breakdown never keeps a number the current lines no longer support.
 *
 * NOTHING ELSE IS READ OR WRITTEN — no gross totals, and no categories 4–7. A
 * company that has entered nothing but spend lines gets a full, correct answer.
 */
export async function recalculateScope3Spend(
  companyId: string,
  year: string,
): Promise<Scope3SpendRecalculation> {
  return db.transaction(async (tx) => {
    const fxMap = await getFxRates(tx, year);
    const lines = await getScope3Spend(tx, companyId, year);
    const setId = await activeFactorSetId(tx);
    const factorRows =
      setId === null ? [] : await loadSpendFactorRows(tx, setId);

    const spend = computeScope3Spend(lines, factorRows, fxMap, year);
    const totals: Record<1 | 2, number> = {
      1: round2(spend.cat1),
      2: round2(spend.cat2),
    };

    const now = new Date();
    for (const categoryId of [1, 2] as const) {
      const tco2e = totals[categoryId];
      if (tco2e > 0) {
        const meta = SPEND_CATEGORY_META[categoryId];
        await tx
          .insert(scope3Results)
          .values({
            companyId,
            year,
            categoryId,
            categoryName: meta.name,
            tco2e: String(tco2e),
            methodology: meta.methodology,
            dataQuality: meta.dataQuality,
            calculatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              scope3Results.companyId,
              scope3Results.year,
              scope3Results.categoryId,
            ],
            set: {
              categoryName: meta.name,
              tco2e: String(tco2e),
              methodology: meta.methodology,
              dataQuality: meta.dataQuality,
              calculatedAt: now,
            },
          });
      } else {
        await tx
          .delete(scope3Results)
          .where(
            and(
              eq(scope3Results.companyId, companyId),
              eq(scope3Results.year, year),
              eq(scope3Results.categoryId, categoryId),
            ),
          );
      }
    }

    return { cat1: totals[1], cat2: totals[2], warnings: spend.warnings };
  });
}
