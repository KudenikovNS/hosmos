// =============================================================================
// THE SPEND FACTOR SOURCE (О-8 / plan T3.6) — `emission_factor`, the Phase-1
// factor library, which is what let T3.9 drop the legacy `emission_factors`.
//
// ONE MODULE, BECAUSE THERE MUST BE ONE ANSWER. Two questions are asked about
// spend factors: "which commodities may a line name?" (the editor's dropdown and
// the route's whitelist) and "what does each one cost per €1000?" (the recalc).
// Before T3.6 those were answered from the SAME legacy table by two different
// queries; if they had ever disagreed, the editor would have offered a commodity
// the engine then failed to price and the line would have silently contributed 0.
// Both now come from this file, off the same rows, filtered by the same three
// predicates — so a commodity is offered exactly when it can be priced.
//
// THE ROWS. T1.5 seeded the eight EXIOBASE per-€1000 commodities into
// `emission_factor` of set `legacy-v1` (via migration 0004 — О-13, no seed step
// exists in production) as:
//
//     activity_type = 'scope3_spend:<commodity_key>'   (О-8: the METHOD is in the
//                                                       resolve key, because
//                                                       CALC-2 resolves on
//                                                       nothing else)
//     input_unit    = 'EUR_1000'                       (the `UnitCode`)
//     geography     = 'GLOBAL'                         (country-agnostic)
//     factor_code   = <commodity_key>                  (the legacy `factor_key`,
//                                                       verbatim)
//
// and `scope3_spend.commodity_key` already stores that same `factor_key`. So the
// mapping from a stored line to its factor is a string concatenation, with no
// lookup table in between to drift.
//
// WHY THE CATEGORY COMES OFF THE KEY. The legacy table carried a JSON
// `attributes.category_id`; `emission_factor` has no attributes column and §4
// gives it none — a factor prices an activity, it does not know which GHG
// Protocol category a REPORT will file it under. The key itself carries the
// answer and always has (`s3_c1_*` = cat 1, `s3_c2_*` = cat 2), so it is read
// from there, and a key that does not parse into 1 or 2 is EXCLUDED from the
// catalogue rather than defaulted — an unfileable commodity must not be
// offerable (§0.7: never a silent fallback).
// =============================================================================
import "server-only";

import {
  and,
  asc,
  eq,
  exists,
  inArray,
  like,
  sql,
  type AnyColumn,
} from "drizzle-orm";
import { EMISSION_OUTPUT_UNITS } from "@/shared/factor-output-units";
import { normaliseFactorOutput } from "@/server/calc/output-units";

import type { DbClient } from "@/server/db/client";
import { emissionFactor, factorSet, reportingPeriod } from "@/server/db/schema";

import { SPEND_COMPUTE_UNIT, type FactorRow } from "./compute";

/**
 * The `activity_type` prefix T1.5 seeded the spend half of the legacy `scope3`
 * category under (О-8): `activity_type = SPEND_ACTIVITY_PREFIX + commodity_key`.
 */
const SPEND_ACTIVITY_PREFIX = "scope3_spend:";

/** The `emission_factor.input_unit` (`UnitCode`) of a per-€1000 spend factor. */
const SPEND_INPUT_UNIT = "EUR_1000";

/** `geography` of a country-agnostic factor — every EXIOBASE commodity is this. */
const GLOBAL_GEOGRAPHY = "GLOBAL";

/** `s3_c1_electronics` → 1. Anything that does not name cat 1 or 2 → `null`. */
function spendCategoryOf(commodityKey: string): 1 | 2 | null {
  const m = /^s3_c([12])_/.exec(commodityKey);
  return m === null ? null : (Number(m[1]) as 1 | 2);
}

/**
 * The three predicates that make an `emission_factor` row a spend factor.
 *
 * `factorSetId` is a literal id at the two call sites that load rows, and the
 * `factor_set.id` COLUMN at the one that asks "does this set price spend at
 * all?" — a correlated EXISTS. One helper for both, so the definition of "a
 * spend factor" cannot drift between the question and the answer.
 */
const spendFactorsOf = (factorSetId: string | AnyColumn) =>
  and(
    eq(emissionFactor.factorSetId, factorSetId),
    eq(emissionFactor.status, "active"),
    like(emissionFactor.activityType, `${SPEND_ACTIVITY_PREFIX}%`),
    eq(emissionFactor.inputUnit, SPEND_INPUT_UNIT),
    inArray(emissionFactor.outputUnit, EMISSION_OUTPUT_UNITS),
  );

/**
 * The `factor_set` SPEND is priced from — the most recently published ACTIVE set
 * THAT ACTUALLY CARRIES SPEND FACTORS, ties broken by code. `null` when no
 * active set carries any.
 *
 * `NULLS LAST` is load-bearing: Postgres sorts NULLs FIRST under DESC, so
 * without it an active set that was never stamped with a `published_at` would
 * outrank every released one.
 *
 * WHY THE EXISTS CLAUSE, WHICH USED NOT TO BE HERE. This function used to be the
 * plain "newest active set", the same query `resolveFactorSet` runs. That was
 * true-by-accident while `legacy-v1` was the only active set in existence, and
 * migration 0009 ended it: `si-2025` is a NATIONAL Scope-1/2 set built from a
 * client workbook and it carries no `scope3_spend:*` row at all, by design. As
 * the plain newest set it became the answer here too, and the effect was silent
 * and total — {@link listSpendCommodities} returned nothing, so the editor's
 * dropdown emptied and the route refused every spend write with `VALIDATION`,
 * while {@link loadSpendFactorRows} returned nothing, so every stored line
 * priced at 0 and `scope3_results` deleted the category rows it no longer
 * "supported". Nobody would have been told.
 *
 * THE FIX IS THIS MODULE'S OWN RULE, ONE LEVEL UP. Its header commits to "a
 * commodity is offered exactly when it can be priced", enforced by asking both
 * questions of the same rows. A set with no spend factors cannot answer either
 * question, so it is not the set to ask — and the answer stays `null` (the
 * documented "refuse every write" branch) only when NO active set can price
 * spend, which is the state that genuinely deserves a refusal.
 *
 * THIS IS A STOPGAP AND SHOULD BE READ AS ONE. Scope-3 spend is not pinned to a
 * period's `factor_set_id` the way CALC-2 is (К-24) — it resolves globally, per
 * company-year — so "which set" is a question it has to answer for itself. Once
 * spend moves onto the period pin, this function goes away with it.
 */
export async function activeFactorSetId(db: DbClient): Promise<string | null> {
  const rows = await db
    .select({ id: factorSet.id })
    .from(factorSet)
    .where(
      and(
        eq(factorSet.status, "active"),
        exists(
          db
            .select({ one: sql`1` })
            .from(emissionFactor)
            .where(spendFactorsOf(factorSet.id)),
        ),
      ),
    )
    .orderBy(sql`${factorSet.publishedAt} DESC NULLS LAST`, asc(factorSet.code))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * THE NAMED BUSINESS REFUSAL a spend write carries when {@link activeFactorSetId}
 * is `null` — API-1's `{ok:false, error:"VALIDATION", refusal, …}` shape, the same
 * mechanism `NEW_VERSION_ONLY` and `CODE_TAKEN` travel on (`_lib/refusal`).
 *
 * WHY IT IS NOT A BARE 422. The 422 was already correct — nothing may be written
 * that nothing can price — but it said only "invalid", and "invalid" is what a
 * client sends when it gets a field wrong. Here the client sent nothing wrong:
 * the FACTOR LIBRARY cannot price spend at all, and the user's move is an
 * administrative one, not a different commodity. No VAL-* rule owns that (no
 * rule is evaluated — the catalogue is simply empty), so it is a named refusal,
 * and the screen renders the token as the sentence that says so.
 *
 * It is deliberately NOT a new HTTP status and NOT a 200: the write is still
 * refused, with the status it always had.
 */
export const NO_SPEND_FACTORS = "NO_SPEND_FACTORS";

/** A factor set as a refusal names it to a user: the code, and the human name. */
export interface SpendFactorSetRef {
  code: string;
  name: string;
}

/**
 * The factor set IN FORCE for `(company, year)` — the one a refusal names when
 * spend cannot be priced.
 *
 * WHICH SET THAT IS. The period's pin first (К-24: `reporting_period.factor_set_id`
 * is the version a year's figures reproduce from, and it is what the dashboard
 * already shows the user as "factor set X"), falling back to the platform's
 * ACTIVE set — the one `resolveFactorSet` gives a period that names none, i.e.
 * the set the year WOULD be pinned to. Spend itself still resolves globally
 * ({@link activeFactorSetId}, and that function's header explains why that is a
 * stopgap); this function exists to NAME the set, not to price with it.
 *
 * ONLY AN ACTIVE SET IS NAMED, and that is what keeps the sentence true. The
 * refusal says "this set carries no spend factors", and `activeFactorSetId`
 * returning `null` proves exactly that about every ACTIVE set — no more. A
 * period whose pinned set was archived afterwards would be named wrongly, so it
 * is not named: the fallback answers with the active set instead.
 *
 * `null` only on a platform with no active set at all, which is a state periods
 * cannot exist in (the column is NOT NULL). The screen still has a sentence for
 * it rather than printing an empty name.
 */
export async function factorSetInForce(
  db: DbClient,
  companyId: string,
  year: string,
): Promise<SpendFactorSetRef | null> {
  const reportingYear = Number.parseInt(year, 10);
  if (Number.isFinite(reportingYear)) {
    const pinned = await db
      .select({ code: factorSet.code, name: factorSet.name })
      .from(reportingPeriod)
      .innerJoin(factorSet, eq(factorSet.id, reportingPeriod.factorSetId))
      .where(
        and(
          eq(reportingPeriod.companyId, companyId),
          eq(reportingPeriod.reportingYear, reportingYear),
          eq(factorSet.status, "active"),
        ),
      )
      // Newest period first, ties broken by id: several periods may share a
      // reporting year (VAL-009 warns about overlap, it does not forbid it), and
      // a refusal must not name a different set on every reload.
      .orderBy(
        sql`${reportingPeriod.createdAt} DESC NULLS LAST`,
        asc(reportingPeriod.id),
      )
      .limit(1);
    if (pinned.length > 0) return pinned[0];
  }

  const active = await db
    .select({ code: factorSet.code, name: factorSet.name })
    .from(factorSet)
    .where(eq(factorSet.status, "active"))
    .orderBy(sql`${factorSet.publishedAt} DESC NULLS LAST`, asc(factorSet.code))
    .limit(1);
  return active[0] ?? null;
}

/**
 * The active set's spend factors, mapped onto the pure engine's row shape.
 *
 * ALL YEARS ARE LOADED, not just the requested one: `computeScope3Spend` runs the
 * year-fallback ladder itself (exact year → nearest past → nearest future →
 * missing), and it can only do that if it is handed the whole per-commodity
 * history.
 *
 * `geography` maps to `country_code` with `GLOBAL → null`. The compute asks for
 * `country = null`, so a hypothetical country-specific spend factor is simply
 * never picked rather than silently standing in for the global one.
 *
 * `input_unit` is re-expressed as the engine's {@link SPEND_COMPUTE_UNIT}: the two
 * vocabularies name the same unit (`EUR_1000` is the `UnitCode`, "EUR 1000 spent"
 * is what the legacy library called it), and the engine re-checks the unit before
 * it will price a line.
 *
 * A row with no `applicable_year` is skipped — the ladder compares years
 * numerically and a NULL cannot take part.
 */
export async function loadSpendFactorRows(
  db: DbClient,
  factorSetId: string,
): Promise<FactorRow[]> {
  const rows = await db
    .select({
      id: emissionFactor.id,
      activityType: emissionFactor.activityType,
      geography: emissionFactor.geography,
      applicableYear: emissionFactor.applicableYear,
      factorValue: emissionFactor.factorValue,
      outputUnit: emissionFactor.outputUnit,
      sourceName: emissionFactor.sourceName,
    })
    .from(emissionFactor)
    .where(spendFactorsOf(factorSetId));

  const out: FactorRow[] = [];
  for (const r of rows) {
    if (r.applicableYear === null) continue;
    const normalised = normaliseFactorOutput(r.factorValue, r.outputUnit);
    if (!normalised) continue;
    out.push({
      id: r.id,
      factor_id: r.activityType.slice(SPEND_ACTIVITY_PREFIX.length),
      country_code: r.geography === GLOBAL_GEOGRAPHY ? null : r.geography,
      year: String(r.applicableYear),
      value: Number(normalised.value),
      unit: SPEND_COMPUTE_UNIT,
      source: r.sourceName,
    });
  }
  return out;
}

/** One eligible spend commodity for the editor dropdown (server-derived, §Q3(b)). */
export interface Scope3Commodity {
  /** The ONLY value a write may carry — validated against this list by the route. */
  commodityKey: string;
  /** 1 (purchased goods) or 2 (capital goods), read off the key. */
  category: number;
  /** Human label — the factor's `factor_name` (e.g. "Electronics (average)"). */
  label: string;
}

/**
 * The spend-commodity catalogue, derived FROM the very rows the recalculation
 * will resolve, so the dropdown can never offer something the engine cannot
 * price. Deduped by commodity (the set has one row per applicable year), ordered
 * by category then label. Empty when no active factor set can price spend — the
 * route then refuses every write rather than persisting a line nothing can
 * price, and it refuses it BY NAME ({@link NO_SPEND_FACTORS}) so the screen can
 * say why instead of showing an empty dropdown and a bare 422.
 */
export async function listSpendCommodities(
  db: DbClient,
): Promise<Scope3Commodity[]> {
  const setId = await activeFactorSetId(db);
  if (setId === null) return [];

  const rows = await db
    .select({
      factorCode: emissionFactor.factorCode,
      factorName: emissionFactor.factorName,
    })
    .from(emissionFactor)
    .where(spendFactorsOf(setId));

  const byKey = new Map<string, Scope3Commodity>();
  for (const r of rows) {
    if (byKey.has(r.factorCode)) continue;
    const category = spendCategoryOf(r.factorCode);
    if (category === null) continue; // unfileable → not offerable
    byKey.set(r.factorCode, {
      commodityKey: r.factorCode,
      category,
      label: r.factorName,
    });
  }
  return [...byKey.values()].sort(
    (a, b) => a.category - b.category || a.label.localeCompare(b.label),
  );
}
