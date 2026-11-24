// FACTOR-AXIS evaluators (spec §6.2, scope `reference_org`) — VAL-031, VAL-032,
// VAL-033. The last three entries `reference_org` had in `PENDING_EVALUATORS`.
//
// See docs/decisions/server-validation-evaluators-factors.md for the full account.
import { sql } from "drizzle-orm";

import { emissionFactor } from "@/server/db/schema";
import { EXPLICIT_ZERO_ACTIVITY_TYPES } from "@/server/db/seed-data/explicit-zeros";

import type { EvaluatorContext, RuleFinding, ValidationDb } from "../types";

/** `validation_result.object_type` for every finding here (К-8 vocabulary). */
const OBJECT_TYPE = "emission_factor";

/**
 * The year an absent `applicable_year` stands in as — the sentinel of the
 * expression index (О-18). `-1` is a year an `integer` column cannot legally
 * hold, which is the whole reason it can mean "no year" without colliding with
 * one.
 *
 * It is a CONSTANT here and a literal in `0004_data_model.sql` / `schema.ts`;
 * the three are a hand-kept pair (R-1) and `schema-0004.integration.test.ts`
 * pins the two declarations against each other.
 */
const NO_YEAR_SENTINEL = -1;

/**
 * The supplier an absent `supplier_name` stands in as, in the same expression
 * index (0007). `'--'` is the sentinel `unit_conversion_from_to_context_key`
 * already uses for its own nullable column — a two-dash string is not a company.
 */
const NO_SUPPLIER_SENTINEL = "--";

/** The six columns + the year + the supplier that make one factor unique in a set. */
export interface FactorResolutionKey {
  readonly factorSetId: string;
  readonly sourceName: string;
  readonly sourceVersion: string;
  readonly activityType: string;
  readonly geography: string;
  readonly inputUnit: string;
  /** `null` = "this factor does not depend on a year" (GWP values, О-18). */
  readonly applicableYear: number | null;
  /** `null` = "this factor is not one supplier's own" (0007) — the 440 seeded rows. */
  readonly supplierName: string | null;
}

/**
 * The id of a factor that ALREADY occupies `key`, or `undefined`.
 *
 * `exceptId` excludes the row being updated: a PATCH that does not touch the key
 * must not collide with itself. `geography` needs no COALESCE — it is NOT NULL
 * (a missing country normalises to `'GLOBAL'`), which is why the index does not
 * wrap it either.
 *
 * Written as raw SQL rather than Drizzle conditions so the predicate reads
 * IDENTICALLY to the index it mirrors: the two are only equivalent by
 * inspection, and an expression spelled two different ways is exactly the drift
 * R-1 warns about.
 */
export async function findKeyConflict(
  db: ValidationDb,
  key: FactorResolutionKey,
  exceptId?: string,
): Promise<string | undefined> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM emission_factor
     WHERE factor_set_id = ${key.factorSetId}
       AND source_name    = ${key.sourceName}
       AND source_version = ${key.sourceVersion}
       AND activity_type  = ${key.activityType}
       AND geography      = ${key.geography}
       AND input_unit     = ${key.inputUnit}
       AND COALESCE(applicable_year, ${NO_YEAR_SENTINEL})
         = COALESCE(${key.applicableYear}::integer, ${NO_YEAR_SENTINEL})
       AND COALESCE(supplier_name, ${NO_SUPPLIER_SENTINEL})
         = COALESCE(${key.supplierName}::text, ${NO_SUPPLIER_SENTINEL})
       AND (${exceptId ?? null}::uuid IS NULL OR id <> ${exceptId ?? null}::uuid)
     LIMIT 1
  `);
  return rows[0]?.id;
}

/** The factor `targetId` points at, or `undefined` (the target is not one). */
async function loadFactor(ctx: EvaluatorContext) {
  const [row] = await ctx.db
    .select()
    .from(emissionFactor)
    .where(sql`${emissionFactor.id} = ${ctx.targetId}`)
    .limit(1);
  return row;
}

/**
 * VAL-031 — one factor per resolution key inside a set.
 *
 * The key mirrors CALC-2's resolve key BECAUSE it must: if two rows can answer
 * "the factor for this activity, country, unit and year", the calculation is
 * non-deterministic and S5 meets it as a runtime `FACTORS_AMBIGUOUS` (503) in
 * front of a user who cannot fix it. Refusing the second row at the moment it is
 * written is the only place the problem has an owner.
 */
export async function evaluateVal031(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadFactor(ctx);
  if (!row) return [];
  const conflict = await findKeyConflict(
    ctx.db,
    {
      factorSetId: row.factorSetId,
      sourceName: row.sourceName,
      sourceVersion: row.sourceVersion,
      activityType: row.activityType,
      geography: row.geography,
      inputUnit: row.inputUnit,
      applicableYear: row.applicableYear,
      supplierName: row.supplierName,
    },
    row.id,
  );
  return [
    {
      passed: conflict === undefined,
      objectType: OBJECT_TYPE,
      objectId: row.id,
    },
  ];
}

/**
 * The earliest year a factor may claim. Emission-factor publication predates
 * this, but a reporting product does not price 1970 — and the bound's real job
 * is to catch a typo (`202`, `20245`) and the sentinel itself: `-1` must never
 * be storable as a real year, or a hand-written row would collide with every
 * yearless factor in its set.
 */
const EARLIEST_YEAR = 1990;

/**
 * How far into the future a factor may be dated. Factor sets are published
 * ahead of the year they price (a 2026 set arrives in 2025), and a locked
 * period reproduces under the set it pinned — so a few years of headroom is
 * normal and anything past it is a typo.
 */
const FUTURE_YEARS = 5;

/** The `YYYY-MM-DD` span of a calendar year — `date` columns compare as strings. */
function yearSpan(year: number): { from: string; to: string } {
  const yyyy = String(year).padStart(4, "0");
  return { from: `${yyyy}-01-01`, to: `${yyyy}-12-31` };
}

/**
 * VAL-032 — the factor's validity is internally consistent.
 *
 * THREE STATEMENTS, and each one is a different way to be wrong:
 *   1. `valid_from ≤ valid_to`. An open end (either NULL) is legal — a factor
 *      with no `valid_to` is simply still current — which is the same reading
 *      VAL-004 gives an entity's effective dating.
 *   2. `applicable_year` is a plausible calendar year (see the two bounds
 *      above). NULL passes: it means "year-independent", which is what the 14
 *      refrigerant GWPs are.
 *   3. When the factor states BOTH a year and a validity window, the two must
 *      overlap. A factor "for 2023" that is only valid from 2024-01-01 answers
 *      no question at all — CALC-2 resolves on the year and the calculation
 *      then applies a factor its own provenance says was not in force.
 * The date bounds are compared as `YYYY-MM-DD` strings, which sort
 * chronologically and are exactly what Drizzle returns for a `date`.
 */
export async function evaluateVal032(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadFactor(ctx);
  if (!row) return [];

  const { validFrom, validTo, applicableYear: year } = row;
  const orderedDates =
    validFrom === null || validTo === null || validFrom <= validTo;

  const maxYear = new Date().getUTCFullYear() + FUTURE_YEARS;
  const plausibleYear =
    year === null || (year >= EARLIEST_YEAR && year <= maxYear);

  let yearInWindow = true;
  if (year !== null && plausibleYear) {
    const span = yearSpan(year);
    if (validFrom !== null && validFrom > span.to) yearInWindow = false;
    if (validTo !== null && validTo < span.from) yearInWindow = false;
  }

  return [
    {
      passed: orderedDates && plausibleYear && yearInWindow,
      objectType: OBJECT_TYPE,
      objectId: row.id,
    },
  ];
}

/**
 * THE MARKER THAT MAKES A ZERO FACTOR LEGITIMATE (VAL-033's "unless explicitly
 * valid zero").
 *
 * WHY IT IS A PREFIX ON `source_locator` AND NOT A COLUMN. §0.7 forbids the
 * substitution of a missing factor by zero, so what the rule has to tell apart
 * is not two VALUES (both are `0`) but two INTENTIONS — "the number is zero" and
 * "I had no number". An intention is not observable, so the author has to state
 * it, and the statement has to survive into the row or a re-run of the rule
 * would fail the factor it passed a minute earlier. `emission_factor` has 24
 * columns and none of them is a flag (DM-22 is the DD field list, verbatim);
 * adding one would mean editing `0004` and the column-parity suite that guards
 * it, for a value that is a sentence rather than a boolean. `source_locator`
 * ("where inside the source this number came from") is the column whose subject
 * this IS: for a legitimate zero, the locator is the justification.
 *
 * So a hand-written zero carries
 *   `source_locator: "explicit-zero: NH3 has no GWP — IPCC AR5 table 8.A.1"`
 * and the marker is worth nothing without the sentence after it: an empty
 * `"explicit-zero:"` is refused exactly like an unmarked zero, because a
 * justification nobody wrote is not one.
 */
export const EXPLICIT_ZERO_PREFIX = "explicit-zero:";

/**
 * Does this row say, in so many words, that its zero is real?
 *
 * TWO FORMS, one per author. The SEED's two legitimate zeros (ammonia, and
 * commuting by bicycle) were reviewed as a list in T1.5 —
 * `EXPLICIT_ZERO_ACTIVITY_TYPES` — because they arrive with the migration and
 * have no author to write a sentence. Anything a human adds through
 * /admin/factors states its case in `source_locator` (above). Recognising both
 * is what keeps the seeded set passing its own rule: the alternative was to
 * rewrite two rows of reference data that ship inside `0004`.
 */
function isExplicitZero(row: {
  activityType: string;
  sourceLocator: string | null;
}): boolean {
  if (EXPLICIT_ZERO_ACTIVITY_TYPES.includes(row.activityType)) return true;
  const locator = row.sourceLocator?.trim().toLowerCase() ?? "";
  if (!locator.startsWith(EXPLICIT_ZERO_PREFIX)) return false;
  return locator.slice(EXPLICIT_ZERO_PREFIX.length).trim() !== "";
}

/**
 * VAL-033 — a factor is not zero unless its zero is explicit (§0.7, AC-6).
 *
 * `factor_value` is `numeric`, i.e. a string in JS, and `Number` is what makes
 * `"0"`, `"0.00"` and `"-0"` the same fact. A NEGATIVE factor is not this
 * rule's subject and is not refused here — no Phase-1 rule owns it, and
 * inventing a refusal under VAL-033's name would report the wrong problem.
 */
export async function evaluateVal033(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadFactor(ctx);
  if (!row) return [];
  const isZero = Number(row.factorValue) === 0;
  return [
    {
      passed: !isZero || isExplicitZero(row),
      objectType: OBJECT_TYPE,
      objectId: row.id,
    },
  ];
}
