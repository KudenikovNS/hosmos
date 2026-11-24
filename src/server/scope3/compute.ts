// =============================================================================
// SPEND-BASED SCOPE 3 — THE PURE COMPUTE (О-8 / plan T3.6).
//
// This function used to live in the legacy `emissions/calculate.ts`, next to
// the wide-table monthly engine deleted by `T3.8`/`T3.9`. It is moved here VERBATIM
// — same body, same arithmetic, same D4 warning strings — because the feature it
// serves is PARKED, not dropped: `scope3_spend`, `scope3_results` and the
// `/inventory/scope-3` editor all survive Phase 1 (MIG-10). The move is the whole
// point of T3.6: after it, nothing in the spend path reaches into the legacy
// recalculation, so dropping the wide tables cannot change a single spend number.
//
// WHY THE BODY IS UNTOUCHED. T3.6's acceptance is a before/after comparison of
// `scope3_results` on a fixed fixture — the plan's ONE sanctioned parity check,
// and it is only meaningful if the formula is literally the same code. So the
// only thing that changed on the way over is the file it sits in.
//
// PURE — no `server-only`, no db import. The caller resolves the three inputs
// (spend lines, factor rows, FX map) and passes them in; `recalculate.ts` in this
// directory is the one that talks to Postgres.
//
// THE RESOLVER IT LEANS ON NOW LIVES NEXT DOOR (T3.8 — the 4th tail, §5).
// `FactorRow` is a row SHAPE and `resolveFactor` is the year-fallback ladder
// (exact year → nearest past → nearest future → missing); neither reads a table,
// and `recalculate.ts` builds `FactorRow[]` out of the NEW `emission_factor`
// rows. Until T3.8 both were imported from the legacy `emissions` engine
// directory — the last thread from this directory into it. T3.8 deleted that directory and
// moved them VERBATIM into `./factor-resolve`, so the arithmetic is unchanged
// and the spend path now names only modules inside `src/server/scope3`.
// =============================================================================
import { resolveFactor, type FactorRow, type Year } from "./factor-resolve";

/** A per-commodity annual spend line (§Q3(b)) — the pure-compute input shape. */
export interface Scope3SpendInput {
  category: number; // 1 (purchased goods) | 2 (capital goods)
  commodityKey: string; // EXIOBASE per-€1000 factor_key
  spendAmount: number; // denominated in `currency`, NOT EUR
  currency: string; // ISO-4217
}

/** Annual spend-based Scope-3 subtotals plus any per-line warnings (D4). */
export interface Scope3SpendTotals {
  cat1: number; // Σ cat-1 line tCO2e (unrounded; caller rounds the cat1+cat2 sum)
  cat2: number; // Σ cat-2 line tCO2e
  warnings: string[];
}

/** EXIOBASE spend-based unit — only these commodities are eligible for spend lines. */
const SPEND_UNIT = "EUR 1000 spent";

/**
 * Compute annual Scope-3 spend cats 1 & 2 tCO2e from per-commodity spend lines
 * (§Q3(b)/§Q3-FX). PURE: the year's FX map and the resolved scope3 factor rows are
 * passed in — the server resolves both, the client never sends a rate or a factor.
 *
 *   spend_eur  = spend_amount × fx_rate(currency)      // EUR → 1.0
 *   line_tCO2e = spend_eur × factor_value ÷ 1_000_000  // ÷1000 €→€1000, ÷1000 kg→t
 *
 * D4 discipline (never a silent 1.0/0): a currency with no FX rate, or a commodity
 * whose factor is missing / not per-€1000, contributes 0 AND pushes a warning.
 */
export function computeScope3Spend(
  lines: Scope3SpendInput[],
  scope3Rows: FactorRow[],
  fxMap: Map<string, number>,
  year: Year,
): Scope3SpendTotals {
  let cat1 = 0;
  let cat2 = 0;
  const warnings: string[] = [];
  for (const line of lines) {
    const rate = fxMap.get(line.currency);
    if (rate === undefined) {
      warnings.push(`no FX rate for ${line.currency} ${year}`);
      continue; // line contributes 0 — not a silent conversion
    }
    const rf = resolveFactor(
      scope3Rows,
      "scope3_factors",
      line.commodityKey,
      null, // EXIOBASE commodities are country-agnostic (country_code NULL)
      year,
    );
    if (rf.missing || rf.unit !== SPEND_UNIT) {
      warnings.push(`no spend factor for ${line.commodityKey} ${year}`);
      continue; // only per-€1000 spend commodities are eligible
    }
    const spendEur = line.spendAmount * rate;
    const lineTco2e = (spendEur * rf.value) / 1_000_000;
    if (line.category === 1) cat1 += lineTco2e;
    else cat2 += lineTco2e;
  }
  return { cat1, cat2, warnings };
}

/**
 * The row shape {@link computeScope3Spend} resolves against, re-exported so the
 * spend path names ONE module. `recalculate.ts` maps `emission_factor` onto it.
 */
export type { FactorRow };

/** The `input_unit` a spend factor must carry, in the pure engine's vocabulary. */
export { SPEND_UNIT as SPEND_COMPUTE_UNIT };
