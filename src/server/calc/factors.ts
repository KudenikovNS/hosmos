// CALC-2 — deterministic factor resolution (§0.7, D7, API-1). For one activity
// row the module names the factor of the period's PINNED set that prices it, or
// refuses: `failed_missing_factor` (never a silent zero), `failed_unit` (no
// conversion path), and a THROW on ambiguity (data bug, answered 503). The
// ladder is a tuple [geography tier, unit distance, conversion basis, year],
// then newest publication; every rung list lives in `./formula-version`.
// Pure: no database, resolved in memory against the set's candidate rows.
//
// See docs/decisions/factor-resolution-calc-2.md for the full account.
import type { emissionFactor } from "@/server/db/schema";
import type { FactorStatus } from "@/shared/enums";

import { compare, parseDecimal } from "./decimal";
import { normaliseFactorOutput } from "./output-units";
import {
  FACTOR_PRIORITY_TIERS,
  UNIT_CONVERSION_DISTANCES,
  type CalculationStatus,
  type FactorPriorityTier,
  type UnitConversionBasis,
  type UnitConversionDistance,
} from "./formula-version";
import {
  reachableUnits,
  UNIT_CONVERSION_BASES_INDEX,
  type AppliedConversion,
  type ConversionCandidate,
} from "./units";

/** An `emission_factor` row as Drizzle returns it. */
type EmissionFactorRow = typeof emissionFactor.$inferSelect;

/**
 * What resolution needs of a factor — a structural subset of the table, so the
 * run passes real rows (and gets its own richer type back, see the generic on
 * {@link resolveFactor}) while a test passes literals.
 */
export type FactorCandidate = Pick<
  EmissionFactorRow,
  | "id"
  | "factorSetId"
  | "activityType"
  | "geography"
  | "inputUnit"
  | "applicableYear"
  | "publicationDate"
  | "sourceName"
  | "sourceVersion"
  | "supplierName"
  | "factorValue"
  | "outputUnit"
  | "status"
  | "validFrom"
  | "validTo"
>;

/** The question CALC-2 answers, one activity row at a time. */
export interface FactorQuery {
  /** The period's PINNED set (К-24). A candidate from any other set is ignored. */
  readonly factorSetId: string;
  readonly activityType: string;
  /**
   * The facility's country (ISO-3166 alpha-2), or `GLOBAL` when the row has no
   * country. Mandatory for Scope 2 — VAL-021 refuses the row before it gets here.
   */
  readonly geography: string;
  /** The unit the activity row was ENTERED in (not the factor's). */
  readonly inputUnit: string;
  /**
   * The year the activity belongs to. `null` asks for a year-independent factor
   * ONLY; a caller that knows the period's year should always pass it — the
   * year-agnostic factors (the 14 refrigerant GWPs, О-18) stay reachable
   * through the year rule below.
   */
  readonly applicableYear: number | null;
  /**
   * The date the factor's validity window is judged at, `YYYY-MM-DD`. The run
   * passes the reporting period's `end_date`: one period must resolve through
   * one factor, or a factor expiring mid-period would split a single line of the
   * report across two methodologies with nothing recording the split.
   */
  readonly asOf: string;
  /**
   * The supplier named on the activity row, if any. Without it the
   * `supplier_specific` rung is UNREACHABLE, and WITH it the rung is reachable
   * only by a factor whose own `supplier_name` is the same seller — see
   * {@link TIER_PREDICATES}.
   */
  readonly supplier?: string | null;
}

/** The candidate as it is listed in a `FACTORS_AMBIGUOUS` payload (wire shape). */
export interface AmbiguousCandidate {
  readonly id: string;
  readonly source_name: string;
  readonly source_version: string;
  /** Whose factor it is, when it is a supplier's own (0007); else `null`. */
  readonly supplier_name: string | null;
  readonly geography: string;
  readonly input_unit: string;
  readonly applicable_year: number | null;
  readonly publication_date: string | null;
}

/**
 * CALC-2's refusal to guess (§12.1). Thrown, not returned: it is not a property
 * of the activity row (which is fine) but of the factor SET, so it aborts the
 * run rather than failing one line, and the admin sees which rows collide.
 *
 * `code` is the `ApiErrorCode` the route answers with (`statusForError` maps it
 * to 503); `calculationStatus` is what T5.4 stamps on the `calculation` row it
 * was resolving when this was thrown.
 */
export class FactorsAmbiguousError extends Error {
  readonly code = "FACTORS_AMBIGUOUS" as const;
  readonly calculationStatus: CalculationStatus = "failed_ambiguous_factor";
  readonly candidates: readonly AmbiguousCandidate[];
  readonly query: FactorQuery;

  constructor(query: FactorQuery, candidates: readonly FactorCandidate[]) {
    super(
      `FACTORS_AMBIGUOUS: ${candidates.length} factors tie for ` +
        `${query.activityType}/${query.geography}/${query.inputUnit}` +
        `/${query.applicableYear ?? "any-year"} in factor set ${query.factorSetId}: ` +
        candidates.map((c) => c.id).join(", "),
    );
    this.name = "FactorsAmbiguousError";
    this.query = query;
    this.candidates = candidates.map(describeCandidate);
  }

  /** The colliding ids, for the assertion a caller actually wants to write. */
  get candidateIds(): readonly string[] {
    return this.candidates.map((c) => c.id);
  }

  /** The API-1 error body: `{ok:false, error, candidates:[…]}`. */
  get payload(): Record<string, unknown> {
    return { ok: false, error: this.code, candidates: this.candidates };
  }
}

/** True for the error above, across module instances (`name` is the marker). */
export function isFactorsAmbiguousError(
  e: unknown,
): e is FactorsAmbiguousError {
  return e instanceof FactorsAmbiguousError;
}

// ─── THE ACCOUNT: WHY THIS FACTOR, AND WHAT WAS PASSED OVER ──────────────────
//
// A resolution that says only "ok, 266.760000" is unfalsifiable. The ladder can
// take a 2006 IPCC GLOBAL default for a Slovenian site and be RIGHT to — it was
// the only reachable candidate — and the report that prints the figure has no
// way to say so. The account below is the resolver explaining itself, computed
// from the candidate array it already holds and from nothing else.
//
// THE HALF THAT MATTERS IS `passedOver`. Not "which candidates lost" — those
// competed and the ladder is the answer — but which candidate NEVER GOT TO
// COMPETE, and by what. Two obstacles can do that, and only two, because
// everything else the eligibility filter drops is a legitimate exclusion (the
// wrong set, the wrong activity, archived, expired, another country):
//
//   • the entered unit reaches no conversion to the candidate's `input_unit`
//     (`si-2025` holds diesel nationally per LITRE and internationally per GJ;
//     a bill entered in kWh can reach the second and not the first);
//   • the candidate is published for a DIFFERENT year (all 13 Slovenian rows
//     carry `applicable_year = 2025`, so a 2024 row falls to the year-agnostic
//     global default).
//
// A candidate is listed ONLY when it would have WON but for that obstacle —
// see {@link explainWinner} for the two certainty rules. That is what keeps the
// noise floor at zero: a line with nothing to disclose carries an empty list,
// and every marker downstream is `passedOver.length > 0`.
//
// NOTHING HERE CHANGES WHICH FACTOR IS CHOSEN. The account is derived AFTER the
// winner is picked, from the same array, and no figure moves because of it.

/**
 * How the winner's `applicable_year` answered the query's (see {@link yearRank}).
 *
 * @public
 */
export const FACTOR_YEAR_BASES = [
  /** The factor is published for exactly the year the row belongs to. */
  "exact",
  /** `applicable_year IS NULL` — the quantity does not depend on a year (О-18). */
  "year_agnostic",
] as const;

/** One value of {@link FACTOR_YEAR_BASES}. */
export type FactorYearBasis = (typeof FACTOR_YEAR_BASES)[number];

/**
 * Why a better-ranked candidate never reached the ladder. Ordered, so a grouped
 * list of them prints in the same order for the same run (a rendered report is a
 * promise about bytes).
 */
const PASSED_OVER_REASONS = [
  /** Acceptable year; no conversion reaches its `input_unit` from the row's. */
  "unit_unreachable",
  /**
   * Published for a DIFFERENT year, which settles it whatever its unit does —
   * a factor for another year is a different measurement and never substitutes
   * (see {@link yearRank}), so the year is the obstacle worth naming and the
   * unit is second-order. Reporting a group's four denominations under two
   * reasons because three of them are reachable and one is not would be two
   * sentences about one measurement.
   */
  "year_mismatch",
] as const;

/** One value of {@link PASSED_OVER_REASONS}. */
export type PassedOverReason = (typeof PASSED_OVER_REASONS)[number];

/**
 * A GROUP of factors that would have priced the row better, and did not.
 *
 * Grouped rather than listed one by one because the set publishes one national
 * measurement in several denominations — ARSO's 2025 gas is four rows (m³,
 * kWh_net, MWh, GJ) of one fact — and four identical sentences differing only in
 * a unit code is noise, not disclosure. One entry per (reason, tier, geography,
 * source, year); {@link inputUnits} carries every denomination the group holds,
 * which is exactly the list a reader needs to see that none of them is reachable.
 */
interface PassedOverFactors {
  readonly reason: PassedOverReason;
  /** The rung the group sits on — better than, or equal to, the winner's. */
  readonly tier: FactorPriorityTier;
  readonly geography: string;
  readonly sourceName: string;
  readonly sourceVersion: string;
  readonly applicableYear: number | null;
  /** Every `input_unit` the group is published in, sorted. */
  readonly inputUnits: readonly string[];
  /** The `emission_factor.id`s of the group, sorted — lineage, not display. */
  readonly factorIds: readonly string[];
}

/**
 * WHY THIS FACTOR — the resolver's own account of one `ok` resolution.
 *
 * Everything here is a fact about the ranking that produced the winner, plus
 * {@link passedOver}. It is persisted into `factor_snapshot` (DM-29) so a locked
 * report can still explain itself after the factor library has moved on: the
 * snapshot is what makes a run re-derivable, and "why this factor" is part of
 * being re-derivable.
 */
export interface FactorProvenance {
  /** The rung of {@link FACTOR_PRIORITY_TIERS} the winner was admitted on. */
  readonly tier: FactorPriorityTier;
  readonly yearBasis: FactorYearBasis;
  /** The year the ROW asked for; `null` when the query asked for none. */
  readonly requestedYear: number | null;
  readonly geography: string;
  /** The unit the activity row was ENTERED in. */
  readonly enteredUnit: string;
  /** The winner's `input_unit` — equal to {@link enteredUnit} on the identity. */
  readonly factorUnit: string;
  readonly unitDistance: UnitConversionDistance;
  readonly conversionBasis: UnitConversionBasis;
  /** The multiplier applied, NUMERIC-as-string; `"1"` when nothing was converted. */
  readonly conversionMultiplier: string;
  /**
   * Better-ranked candidates that never competed. EMPTY is the normal case and
   * the honest one — every marker downstream is this list being non-empty.
   */
  readonly passedOver: readonly PassedOverFactors[];
}

/** CALC-2's answer for one activity row. `value` is `null` on EVERY failure. */
export type FactorResolution<C extends FactorCandidate = FactorCandidate> =
  | {
      readonly status: "ok";
      /** Exact factor numerator in kgCO2e; the factor itself keeps source units. */
      readonly value: string;
      readonly factor: C;
      readonly conversion: AppliedConversion;
      readonly tier: FactorPriorityTier;
      /** WHY this one, and what it was taken instead of. */
      readonly provenance: FactorProvenance;
    }
  | {
      readonly status: Extract<
        CalculationStatus,
        "failed_missing_factor" | "failed_unit"
      >;
      readonly value: null;
      readonly factor: null;
      readonly conversion: null;
      readonly failureReason?: "output_unit";
      /** Every unit an eligible factor is priced in — the fix for `failed_unit`. */
      readonly wantedUnits: readonly string[];
    };

/** `emission_factor.status` a candidate must hold (draft/archived are invisible). */
const ELIGIBLE_STATUS: FactorStatus = "active";

/** The `geography` value meaning "no country in particular" (DM-22). */
const GLOBAL_GEOGRAPHY = "GLOBAL";

/**
 * `source_name` that CLAIMS supplier provenance (FACTOR_SOURCES).
 *
 * It is the value a factor admin writes under the `factors.custom` capability
 * (§4.14) to say "this number came from the seller, not from a statistics
 * agency". Since 0007 it is a claim that must be accompanied by an identity:
 * `emission_factor_supplier_name_check` refuses `source_name='supplier'` with a
 * NULL `supplier_name`, and {@link isSupplierFactor} treats either marker as
 * supplier-sourced so that a row violating the constraint (a literal in a test,
 * a hand-written row on an unmigrated database) still cannot leak downwards.
 */
const SUPPLIER_SOURCE_NAME = "supplier";

/**
 * Is this candidate one seller's own factor rather than a published average?
 *
 * Two markers, either of which is enough. `supplier_name` is the load-bearing
 * one (it is what the top rung MATCHES on); `source_name = 'supplier'` is the
 * claim, kept here so that a row making the claim without the identity belongs
 * to no rung at all instead of quietly falling through to `site_country`.
 */
function isSupplierFactor(candidate: FactorCandidate): boolean {
  return (
    supplierOf(candidate) !== null ||
    candidate.sourceName === SUPPLIER_SOURCE_NAME
  );
}

/**
 * The candidate's `supplier_name`, or `null` — INCLUDING when the property is
 * absent altogether.
 *
 * The type says `string | null`, and every caller inside the application obeys
 * it (the run selects whole rows). The golden fixtures do not: they are JSON
 * cast into the shape, so a factor written before 0007 arrives with the key
 * missing. Read through `??` a missing key means "no supplier", which is what a
 * factor that predates the column IS; read directly, `undefined !== null` would
 * make every one of them supplier-specific and price nothing at all.
 */
function supplierOf(candidate: FactorCandidate): string | null {
  return candidate.supplierName ?? null;
}

/**
 * A supplier name reduced to what two spellings of ONE seller have in common:
 * case-folded, edge-trimmed, internal whitespace collapsed.
 *
 * AND NOTHING MORE. No stripping of `d.o.o.`/`GmbH`, no substring or edit
 * distance. A near-miss ("Elektro Ljubljana" against "Elektro Ljubljana
 * d.o.o.") therefore does NOT match, and the row falls through to the country
 * grid factor — a published, auditable, conservative number. That is the safe
 * direction of the error: a false NEGATIVE prices electricity with the national
 * average, while a false POSITIVE prices it with a different company's contract,
 * which is the defect this whole rung was rebuilt to remove.
 */
function normaliseSupplier(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Do the query's supplier and the candidate's name the SAME seller? */
function sameSupplier(candidate: FactorCandidate, query: FactorQuery): boolean {
  const wanted = query.supplier;
  const named = supplierOf(candidate);
  if (!wanted || named === null) return false;
  const left = normaliseSupplier(wanted);
  return left !== "" && left === normaliseSupplier(named);
}

/**
 * The predicate for each rung, attached to the ORDER declared in
 * `./formula-version`. Exhaustive by type: adding a name there without a
 * predicate here does not compile.
 *
 * `supplier_specific` demands that the query and the candidate name THE SAME
 * SUPPLIER. Before 0007 it demanded only that the query name *some* supplier
 * and that the candidate be supplier-sourced — and a factor set is reference
 * data shared by every tenant, so that rung handed one seller's contract to
 * another seller's customers, and made two RIVAL suppliers' factors tie all the
 * way to the `publication_date` tie-break, where the newer silently won a
 * comparison that means nothing between two different companies. Matching the
 * identity fixes both at once: an unrelated supplier's factor is not on the rung
 * at all (so it can never price the row), and two rivals can no longer be
 * candidates for the same row (so there is nothing for the tie-break to pick
 * between). Two factors of the SAME supplier still can, and if they survive to
 * equal publication dates the resolver raises `FACTORS_AMBIGUOUS` exactly as it
 * does everywhere else.
 *
 * The rung is ALSO fenced by geography — a supplier row for another country is
 * not "specific" to this site by any reading, and without the fence the rung
 * would be a back door around the country check the two lower rungs enforce. The
 * lower rungs exclude supplier factors for the mirror reason: an unmatched
 * supplier row must not silently serve as a country average.
 */
const TIER_PREDICATES: Record<
  FactorPriorityTier,
  (candidate: FactorCandidate, query: FactorQuery) => boolean
> = {
  supplier_specific: (candidate, query) =>
    sameSupplier(candidate, query) &&
    (candidate.geography === query.geography ||
      candidate.geography === GLOBAL_GEOGRAPHY),
  site_country: (candidate, query) =>
    !isSupplierFactor(candidate) &&
    query.geography !== GLOBAL_GEOGRAPHY &&
    candidate.geography === query.geography,
  global: (candidate) =>
    !isSupplierFactor(candidate) && candidate.geography === GLOBAL_GEOGRAPHY,
};

/** Index of the best rung `candidate` sits on, or `-1` (it sits on none). */
function tierIndex(candidate: FactorCandidate, query: FactorQuery): number {
  return FACTOR_PRIORITY_TIERS.findIndex((tier) =>
    TIER_PREDICATES[tier](candidate, query),
  );
}

/** `1` as a {@link parseDecimal} value — the multiplier that changes nothing. */
const ONE = parseDecimal("1");

/**
 * Does the entered number reach this factor UNCHANGED?
 *
 * The identity path trivially does (no row is read, the multiplier is the
 * literal `"1"`). A `unit_conversion` row does when its multiplier IS one —
 * which in the shipped table means exactly `kWh ↔ kWh_gross`, the statement that
 * a billed kilowatt-hour and a Gross-CV kilowatt-hour are one quantity under two
 * names. See {@link UNIT_CONVERSION_DISTANCES} for why the rung is written this
 * way and not as "the unit codes are equal".
 *
 * The comparison goes through `decimal.ts` rather than a second notion of one
 * (`=== "1"` would miss `"1.0"`, `Number(m) === 1` would launder a NUMERIC
 * through a double). It parses but does not multiply, so the promise this module
 * makes — that no arithmetic happens here — still holds; and a multiplier that
 * is not a decimal literal throws the same `DecimalParseError` T5.2 would raise
 * on it a moment later, rather than being silently ranked.
 */
function reachedUnchanged(conversion: AppliedConversion): boolean {
  return (
    conversion.basis === "identity" ||
    compare(parseDecimal(conversion.multiplier), ONE) === 0
  );
}

/**
 * The predicate for each rung of {@link UNIT_CONVERSION_DISTANCES}. Exhaustive
 * by type, exactly as {@link TIER_PREDICATES} is: a name added to the ordered
 * constant without a predicate here does not compile.
 */
const DISTANCE_PREDICATES: Record<
  UnitConversionDistance,
  (conversion: AppliedConversion) => boolean
> = {
  as_entered: reachedUnchanged,
  // Everything a nearer rung did not claim. `converted` is last, so this is
  // total and `distanceIndex` never returns `-1`.
  converted: () => true,
};

/** Index of the nearest rung this conversion sits on (never `-1`). */
function distanceIndex(conversion: AppliedConversion): number {
  return UNIT_CONVERSION_DISTANCES.findIndex((distance) =>
    DISTANCE_PREDICATES[distance](conversion),
  );
}

/**
 * `0` for the exact year, `1` for a year-agnostic factor, `-1` for another year.
 *
 * The `-1` is the load-bearing one: a 2023 grid factor is NOT an approximation
 * of the 2024 one, it is a different measurement, and substituting it would put
 * a number in the report that no source ever published for that year. So a
 * year-specific factor competes only for ITS year, while a NULL — "this quantity
 * does not depend on a year", which is true of a refrigerant's GWP (О-18) —
 * competes for every year and loses to an exact match within the same rung.
 */
function yearRank(candidate: FactorCandidate, query: FactorQuery): number {
  if (candidate.applicableYear === query.applicableYear) return 0;
  if (candidate.applicableYear === null) return 1;
  return -1;
}

/** Whether `asOf` falls inside the factor's validity window (open ends allowed). */
function isValidAt(candidate: FactorCandidate, asOf: string): boolean {
  if (candidate.validFrom !== null && asOf < candidate.validFrom) return false;
  if (candidate.validTo !== null && asOf > candidate.validTo) return false;
  return true;
}

/**
 * "Archived or expired", in one predicate: the wrong SET, the wrong activity, a
 * `status` other than `active` (draft = never released, archived = superseded),
 * an `asOf` outside `[valid_from, valid_to]`, or a geography on no rung at all.
 * Everything here is a hard exclusion — no rung, no tie-break, not listed in an
 * ambiguity payload, AND NOT DISCLOSABLE: a factor for another country or
 * another activity is not something this row was "priced instead of".
 *
 * THE YEAR RULE IS DELIBERATELY NOT HERE (it used to be). A candidate published
 * for a different year is excluded from the ladder just as hard — {@link
 * resolveFactor} drops it a line later — but it IS disclosable: "the set
 * publishes this activity nationally, only for another year" is the second of
 * the two substitutions this module now reports. Folding the year into the hard
 * filter would throw that candidate away before anything could see it.
 */
function isAdmissible(candidate: FactorCandidate, query: FactorQuery): boolean {
  return (
    candidate.factorSetId === query.factorSetId &&
    candidate.activityType === query.activityType &&
    candidate.status === ELIGIBLE_STATUS &&
    isValidAt(candidate, query.asOf) &&
    tierIndex(candidate, query) >= 0
  );
}

/** `publication_date` as a sortable key; a missing date counts as the OLDEST. */
function publicationKey(candidate: FactorCandidate): string {
  return candidate.publicationDate ?? "";
}

/** The wire description of a colliding candidate. */
function describeCandidate(candidate: FactorCandidate): AmbiguousCandidate {
  return {
    id: candidate.id,
    source_name: candidate.sourceName,
    source_version: candidate.sourceVersion,
    supplier_name: supplierOf(candidate),
    geography: candidate.geography,
    input_unit: candidate.inputUnit,
    applicable_year: candidate.applicableYear,
    publication_date: candidate.publicationDate,
  };
}

/** Lexicographic compare of two equal-length rank tuples. */
function compareRanks(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * One admissible candidate, with everything the ladder and the account both
 * need, computed ONCE.
 *
 * `conversion` is `null` when the entered unit reaches this candidate's
 * `input_unit` through no row of the pinned set or the shared table; `year` is
 * {@link yearRank}, so a negative value means "published for another year".
 * Neither is a rejection by itself — the ladder reads them one way and
 * {@link explainWinner} reads the same two fields the other way.
 */
interface Considered<C extends FactorCandidate> {
  readonly candidate: C;
  readonly tier: number;
  readonly year: number;
  readonly conversion: AppliedConversion | null;
}

/** The `Considered` entries that actually competed, with their rank tuple. */
interface Ranked<C extends FactorCandidate> {
  readonly candidate: C;
  readonly conversion: AppliedConversion;
  readonly rank: readonly number[];
}

/** The rank tuple of a candidate whose unit is reachable, at a given year rank. */
function rankOf(
  tier: number,
  conversion: AppliedConversion,
  year: number,
): readonly number[] {
  return [
    tier,
    distanceIndex(conversion),
    UNIT_CONVERSION_BASES_INDEX[conversion.basis],
    year,
  ];
}

/** Group identity of a {@link PassedOverFactors} entry (see its doc comment). */
function passedOverKey(
  reason: PassedOverReason,
  candidate: FactorCandidate,
): string {
  return [
    reason,
    candidate.geography,
    candidate.sourceName,
    candidate.sourceVersion,
    candidate.applicableYear ?? "",
  ].join(" ");
}

/**
 * WHAT WOULD HAVE PRICED THIS ROW BETTER, AND WHY IT COULD NOT — derived from
 * the SAME candidate array the ladder just ran over, with no second query and
 * no second pass over the database.
 *
 * TWO QUESTIONS, ASKED SEPARATELY. "Would it certainly have won?" decides
 * whether the candidate is reported at all; "what stopped it?" only names the
 * reason. Conflating them is what produced two sentences about one ARSO
 * measurement in an early draft of this function.
 *
 * IT IS REPORTED WHEN IT CERTAINLY OUTRANKS THE WINNER, and there are exactly
 * two ways to be certain:
 *
 *   • A STRICTLY STRONGER GEOGRAPHY TIER. Geography is the OUTERMOST component
 *     of the rank tuple, so such a candidate beats the winner whatever the
 *     remaining three components would have said — which matters because an
 *     unreachable unit leaves the distance and the basis unknowable. Hence the
 *     strict `<`, and hence a SAME-TIER unreachable factor is NOT reported: it
 *     might well have lost on distance anyway, and a disclosure that might be
 *     wrong is worse than none.
 *   • THE SAME TIER, A REACHABLE UNIT AND A WRONG YEAR. Here the distance and
 *     the basis ARE known, so the whole tuple can be built with the year
 *     component set to `0` — the counterfactual "had the set published this for
 *     the row's year". If that beats the winner's tuple, the substitution is
 *     real.
 *
 * THE REASON IS THE OBSTACLE THAT SETTLED IT. A wrong year settles the matter
 * whatever the unit does, so it wins the label; only a candidate whose year was
 * fine is reported as `unit_unreachable`.
 *
 * Candidates that competed and lost are not here, by construction: they have a
 * reachable unit and an acceptable year, which is exactly the pair this function
 * skips. The ladder is the answer for those, and repeating it would be noise.
 */
function explainWinner<C extends FactorCandidate>(
  query: FactorQuery,
  winner: Ranked<C>,
  considered: readonly Considered<C>[],
): FactorProvenance {
  const winnerTier = winner.rank[0];
  const groups = new Map<
    string,
    {
      reason: PassedOverReason;
      tier: number;
      candidate: FactorCandidate;
      units: Set<string>;
      ids: Set<string>;
    }
  >();

  for (const entry of considered) {
    const unitOk = entry.conversion !== null;
    const yearOk = entry.year >= 0;
    // It competed. The ladder already answered for it.
    if (unitOk && yearOk) continue;

    // Would it CERTAINLY have won? (See the two arguments above.)
    const certain =
      entry.tier < winnerTier ||
      (entry.tier === winnerTier &&
        !yearOk &&
        entry.conversion !== null &&
        compareRanks(rankOf(entry.tier, entry.conversion, 0), winner.rank) < 0);
    if (!certain) continue;

    // What stopped it? The year, if the year is wrong; the unit otherwise.
    const reason: PassedOverReason = yearOk
      ? "unit_unreachable"
      : "year_mismatch";

    const key = passedOverKey(reason, entry.candidate);
    const group = groups.get(key) ?? {
      reason,
      tier: entry.tier,
      candidate: entry.candidate,
      units: new Set<string>(),
      ids: new Set<string>(),
    };
    group.units.add(entry.candidate.inputUnit);
    group.ids.add(entry.candidate.id);
    groups.set(key, group);
  }

  const passedOver = [...groups.values()]
    .map((group) => ({
      reason: group.reason,
      tier: FACTOR_PRIORITY_TIERS[group.tier],
      geography: group.candidate.geography,
      sourceName: group.candidate.sourceName,
      sourceVersion: group.candidate.sourceVersion,
      applicableYear: group.candidate.applicableYear,
      inputUnits: [...group.units].sort(),
      factorIds: [...group.ids].sort(),
    }))
    // Deterministic: strongest rung first, then the declared reason order, then
    // the remaining fields. A grouped list that reordered itself between two
    // runs of one revision would move the bytes of a rendered report (REN-5).
    .sort(
      (a, b) =>
        FACTOR_PRIORITY_TIERS.indexOf(a.tier) -
          FACTOR_PRIORITY_TIERS.indexOf(b.tier) ||
        PASSED_OVER_REASONS.indexOf(a.reason) -
          PASSED_OVER_REASONS.indexOf(b.reason) ||
        a.geography.localeCompare(b.geography) ||
        (a.applicableYear ?? 0) - (b.applicableYear ?? 0) ||
        a.sourceName.localeCompare(b.sourceName) ||
        a.sourceVersion.localeCompare(b.sourceVersion),
    );

  return {
    tier: FACTOR_PRIORITY_TIERS[winnerTier],
    yearBasis: winner.rank[3] === 0 ? "exact" : "year_agnostic",
    requestedYear: query.applicableYear,
    geography: winner.candidate.geography,
    enteredUnit: query.inputUnit,
    factorUnit: winner.candidate.inputUnit,
    unitDistance: UNIT_CONVERSION_DISTANCES[winner.rank[1]],
    conversionBasis: winner.conversion.basis,
    conversionMultiplier: winner.conversion.multiplier,
    passedOver,
  };
}

/**
 * THE resolver (CALC-2 + CALC-3).
 *
 * @param query      the activity row's coordinates, including the PINNED set
 * @param candidates any pool of factors; foreign sets are filtered out here
 *                   rather than trusted to the caller, because the pin is what
 *                   AC-8 rests on and a resolver that merely assumes it would
 *                   fail silently the day someone passes a wider query
 * @param conversions the `unit_conversion` table (CALC-3)
 *
 * @throws {FactorsAmbiguousError} when the ladder ends in a tie.
 */
export function resolveFactor<C extends FactorCandidate>(
  query: FactorQuery,
  candidates: readonly C[],
  conversions: readonly ConversionCandidate[],
): FactorResolution<C> {
  // CALC-3. A factor priced in a unit this row cannot reach is not a candidate;
  // if that removes ALL of them the row fails as `failed_unit`, which is a
  // different fix (seed a conversion) from `failed_missing_factor` (seed a
  // factor) — hence two statuses rather than one.
  // The pinned set reaches CALC-3 from the SAME place CALC-2 reads it — the
  // query — so a run cannot resolve its factors under one set and its
  // multipliers under another (0010).
  const reachable = reachableUnits(
    query.inputUnit,
    query.activityType,
    query.factorSetId,
    conversions,
  );

  // ONE PASS over the pool, and the ONLY one. Both the ladder and the account
  // read this array: the ladder narrows it by the year rule and then by
  // reachability, the account looks at exactly the candidates those two steps
  // dropped. Deriving the account from a second filter of `candidates` would
  // walk the pool twice per activity row for no new information.
  const considered = candidates.flatMap((candidate) => {
    if (!isAdmissible(candidate, query)) return [];
    return [
      {
        candidate,
        tier: tierIndex(candidate, query),
        year: yearRank(candidate, query),
        conversion: reachable.get(candidate.inputUnit) ?? null,
      },
    ];
  });

  const eligible = considered.filter((entry) => entry.year >= 0);
  if (eligible.length === 0) {
    return {
      status: "failed_missing_factor",
      value: null,
      factor: null,
      conversion: null,
      wantedUnits: [],
    };
  }

  const ranked = eligible.flatMap((entry) =>
    entry.conversion === null
      ? []
      : [
          {
            candidate: entry.candidate,
            conversion: entry.conversion,
            rank: rankOf(entry.tier, entry.conversion, entry.year),
          },
        ],
  );
  if (ranked.length === 0) {
    return {
      status: "failed_unit",
      value: null,
      factor: null,
      conversion: null,
      wantedUnits: [
        ...new Set(eligible.map((entry) => entry.candidate.inputUnit)),
      ].sort(),
    };
  }

  const bestRank = ranked.reduce(
    (best, entry) => (compareRanks(entry.rank, best) < 0 ? entry.rank : best),
    ranked[0].rank,
  );
  const tied = ranked.filter(
    (entry) => compareRanks(entry.rank, bestRank) === 0,
  );

  // The last tie-break the methodology has: the freshest publication.
  const newest = tied.reduce(
    (best, entry) =>
      publicationKey(entry.candidate) > best
        ? publicationKey(entry.candidate)
        : best,
    publicationKey(tied[0].candidate),
  );
  const winners = tied.filter(
    (entry) => publicationKey(entry.candidate) === newest,
  );

  if (winners.length > 1) {
    throw new FactorsAmbiguousError(
      query,
      winners.map((entry) => entry.candidate),
    );
  }

  const winner = winners[0];
  const output = normaliseFactorOutput(
    winner.candidate.factorValue,
    winner.candidate.outputUnit,
  );
  if (!output)
    return {
      status: "failed_unit",
      failureReason: "output_unit",
      value: null,
      factor: null,
      conversion: null,
      wantedUnits: [],
    };
  return {
    status: "ok",
    value: output.value,
    factor: winner.candidate,
    conversion: winner.conversion,
    tier: FACTOR_PRIORITY_TIERS[winner.rank[0]],
    provenance: explainWinner(query, winner, considered),
  };
}
