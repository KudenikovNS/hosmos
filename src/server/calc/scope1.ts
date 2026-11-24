// =============================================================================
// SCOPE 1 — THE CALCULATION CORE (CALC-1, CALC-4, VAL-017, §0.7).
//
// One pure function. It takes the activity rows of a revision, the factors of
// the period's PINNED set and the `unit_conversion` table, and returns one
// `calculation`-shaped line per row it accepted plus the reason for every row
// it did not. No database, no clock, no randomness: the same three arrays give
// the same lines forever, which is the whole of CALC-7/AC-8 that lives at this
// layer (the rest is the pin and the freeze, T5.4/T5.5).
//
// ── THE FORMULA (CALC-4) ────────────────────────────────────────────────────
//     co2e = input_value × conversion_factor × factor_value
// evaluated in EXACT DECIMAL (`./decimal.ts` — never a float), then rounded
// ONCE by `ROUNDING_RULE`. `input_value` is not always `activity_value`: a
// fugitive row states a refrigerant CHARGE that has to be derived first, see
// below. `conversion_factor` and `factor_value` come from T5.1 unchanged.
//
// ── BIOGENIC CARBON IS NOT IN THE FOSSIL TOTAL (VAL-017) ────────────────────
// A biogenic row's result lands in `biogenic_co2_result` and its `co2e_result`
// is a GENUINE zero — the fossil CO₂e of that combustion is zero by the
// accounting convention, not a value we failed to find (contrast §0.7). It is
// therefore safe, and required, for the fossil total to skip it: VSME discloses
// biogenic CO₂ on its own line, and folding it in would inflate the headline
// figure by the carbon the standard says to report separately.
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ───────────────────────────────
//   - persist anything (T5.4 owns `run_id`, `calculated_at`, the INSERT);
//   - build `factor_snapshot` (T5.4; the resolved factor is handed back whole
//     on {@link Scope1Line.factor} so it can);
//   - evaluate VAL-017/VAL-018/VAL-034 (T5.4 owns the evaluators — this module
//     produces the numbers those rules are ABOUT, and a producer that graded
//     itself would make the rules unfalsifiable);
//   - Scope 2 (T5.3 — dual reporting is a different shape, two lines per row).
// =============================================================================
import type { emissionActivity, emissionFactor } from "@/server/db/schema";
import type { CalculationMethod } from "@/shared/enums";

import {
  add,
  formatDecimal,
  multiply,
  parseDecimal,
  parseDecimalOrZero,
  roundHalfUp,
  subtract,
  ZERO,
  type Decimal,
} from "./decimal";
import {
  resolveFactor,
  type FactorProvenance,
  type FactorQuery,
} from "./factors";
import {
  FORMULA_VERSION,
  ROUNDING_DECIMALS,
  ROUNDING_RULE,
  type CalculationStatus,
} from "./formula-version";
import {
  applicableYearFor,
  calc1Exclusion,
  type CalcPeriod,
  type Calc1ExclusionReason,
} from "./selection";
import type { ConversionCandidate } from "./units";

/** `emission_activity` as Drizzle returns it. */
type EmissionActivityRow = typeof emissionActivity.$inferSelect;
/** `emission_factor` as Drizzle returns it. */
type EmissionFactorRow = typeof emissionFactor.$inferSelect;

/**
 * The factor fields this module needs — T5.1's resolution subset plus the four
 * that only the RESULT cares about.
 *
 * `biogenicTreatment` is the load-bearing addition: CALC-4 splits the result on
 * it, so it cannot stay out of the candidate type. The other three exist so
 * T5.4 can build `factor_snapshot` ("value, units, source, gwp_basis at the
 * moment of calculation", DM-29) from {@link Scope1Line.factor} without going
 * back to the database — a second read could return a different row and quietly
 * break AC-8.
 */
export type Scope1Factor = Pick<
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
  | "status"
  | "validFrom"
  | "validTo"
  | "factorCode"
  | "factorName"
  | "outputUnit"
  | "gwpBasis"
  | "biogenicTreatment"
>;

/**
 * An `emission_activity` row as the calculation reads it, PLUS `geography`.
 *
 * The country is not on the table — it hangs off `facility.country_code`, and
 * joining it is the caller's job (T5.4). Passing it in keeps this module free
 * of the organisation model, and makes the geography a visible input of the
 * golden fixtures rather than a hidden lookup. `'GLOBAL'` is the value for a
 * row with no facility (К-18/VAL-104 already demand a documented reason for
 * that); VAL-021's "Scope 2 needs a country" does not apply here.
 */
export type Scope1Row = Pick<
  EmissionActivityRow,
  | "id"
  | "legalEntityId"
  | "facilityId"
  | "yearMonth"
  | "unit"
  | "state"
  | "isDeleted"
  | "supersededById"
  | "activityCategory"
  | "activityType"
  | "activityValue"
  | "method"
  | "biogenicFlag"
  | "refrigerantAdded"
  | "refrigerantRecovered"
  | "equipmentCapacity"
  | "openingStock"
  | "closingStock"
  | "leakageRate"
> & { readonly geography: string };

/**
 * The period the run is for: its window and the factor set it PINS (§4.5).
 *
 * The same shape Scope 2 runs against — CALC-1 is one rule over four tables, so
 * it lives in `./selection` and both scopes read it from there.
 */
export type Scope1Period = CalcPeriod;

/** Why CALC-1's filter dropped a row — one value of `CALC1_EXCLUSION_REASONS` (selection.ts). */
export type Scope1ExclusionReason = Calc1ExclusionReason;

/** A row CALC-1 did not calculate, and why. */
interface Scope1Exclusion {
  readonly activityRowId: string;
  readonly reason: Scope1ExclusionReason;
}

/** Where {@link Scope1Line.inputValue} came from — CALC-4's three branches. */
export const SCOPE1_INPUT_BASES = [
  /** `activity_value` verbatim: every category but the two fugitive methods. */
  "activity_value",
  /** `opening_stock + refrigerant_added − refrigerant_recovered − closing_stock`. */
  "mass_balance",
  /** `equipment_capacity × leakage_rate / 100`. */
  "leakage_estimate",
] as const;

/** One value of {@link SCOPE1_INPUT_BASES}. */
export type Scope1InputBasis = (typeof SCOPE1_INPUT_BASES)[number];

/**
 * One `calculation` row's worth of arithmetic (DM-29), before persistence.
 *
 * Column names are the Drizzle ones so T5.4's INSERT is a rename-free spread of
 * this object plus `run_id`/`calculated_at`/`company_id`/`revision_id`.
 */
export interface Scope1Line {
  readonly activityTable: "emission_activity";
  readonly activityRowId: string;
  readonly legalEntityId: string;
  readonly facilityId: string | null;
  readonly scope: "scope1";
  /** NULL for Scope 1 — `reporting_basis` is Scope 2's discriminator (К-20). */
  readonly reportingBasis: null;
  readonly methodCode: string;
  readonly formulaVersion: string;
  readonly roundingRule: string;
  /** What actually entered the formula — see {@link Scope1InputBasis}. */
  readonly inputBasis: Scope1InputBasis;
  /** `numeric`-as-string; for a fugitive row this is the DERIVED charge. */
  readonly inputValue: string;
  /** The unit `inputValue` is in — `kg` on both mass-balance branches. */
  readonly inputUnit: string;
  /** The applied `unit_conversion.multiplier`, `'1'` for the identity. */
  readonly conversionFactor: string;
  /** The `unit_conversion` row used, `null` for the identity or a failure. */
  readonly conversionId: string | null;
  readonly factorId: string | null;
  /** The resolved factor, whole — T5.4 builds `factor_snapshot` from it. */
  readonly factor: Scope1Factor | null;
  /**
   * WHY that factor, and what was passed over to reach it (CALC-2's account).
   *
   * `null` only when nothing was resolved: a line with no factor has no basis
   * to disclose, and the failure statuses already say what is missing. T5.4
   * copies this into `factor_snapshot` beside the factor itself.
   */
  readonly provenance: FactorProvenance | null;
  /** Whether VAL-017 sends this row's result to the biogenic line. */
  readonly biogenic: boolean;
  /**
   * FOSSIL kgCO2e at {@link ROUNDING_DECIMALS} places, or `null` when the row
   * did not calculate.
   *
   * `null` and not `0`: §0.7/AC-6. A biogenic row, by contrast, carries a
   * genuine `'0.000000'` here — its fossil share really is nothing.
   *
   * NOTE FOR T5.4: `calculation.co2e_result` is `NOT NULL`, so persisting a
   * failed line needs an explicit decision at that layer. It must not be made
   * here by handing back a number nobody computed.
   */
  readonly co2eResult: string | null;
  /** BIOGENIC kgCO₂, or `null` when the row is fossil or did not calculate. */
  readonly biogenicCo2Result: string | null;
  readonly calculationStatus: CalculationStatus;
  /**
   * On `failed_unit`, every `input_unit` an eligible factor is priced in — the
   * `unit_conversion` rows that would fix the row, named rather than guessed.
   */
  readonly wantedUnits: readonly string[];
}

/** Totals across the calculated lines. Rounded lines summed exactly (VAL-034). */
interface Scope1Totals {
  /** Σ `co2e_result` of the OK fossil lines. Biogenic lines add `0` (VAL-017). */
  readonly fossilCo2e: string;
  /** Σ `biogenic_co2_result` of the OK biogenic lines. */
  readonly biogenicCo2: string;
  readonly lineCount: number;
  readonly okCount: number;
  readonly failedCount: number;
}

/** What {@link computeScope1} returns. */
export interface Scope1Result {
  readonly lines: readonly Scope1Line[];
  readonly excluded: readonly Scope1Exclusion[];
  readonly totals: Scope1Totals;
  /** `failed` if ANY line failed — CALC-6 blocks approve/render/lock on it. */
  readonly runStatus: "ok" | "failed";
  readonly formulaVersion: string;
  readonly roundingRule: string;
}

/** The one `activity_table` value this module emits (К-10). */
const ACTIVITY_TABLE = "emission_activity";

/** `activity_category` whose two methods derive a charge instead of using one. */
const FUGITIVE_CATEGORY = "fugitive_emissions";

/**
 * `method` → mass balance. The refrigerant columns are all `kg` (§4.9), so the
 * derived charge is `kg` whatever the row's own `unit` says.
 */
const MASS_BALANCE_METHOD: CalculationMethod = "mass_balance";

/**
 * `method` → `equipment_capacity × leakage_rate`. §9 calls it "leakage
 * estimate"; the closed `CalculationMethod` list spells that
 * `engineering_estimate`, and there is no second candidate — the other eight
 * values name how an ACTIVITY figure was obtained, not how a leak was modelled.
 */
const LEAKAGE_ESTIMATE_METHOD: CalculationMethod = "engineering_estimate";

/** The unit the refrigerant columns are denominated in (§4.9). */
const REFRIGERANT_UNIT = "kg";

/** `leakage_rate` is a PERCENT (§4.9), so the factor applied is `rate / 100`. */
const PERCENT = parseDecimal("0.01");

/** `emission_factor.biogenic_treatment` that moves a result off the fossil line. */
const BIOGENIC_TREATMENT = "biogenic";

/** CALC-4's three input branches, resolved by `activity_category` + `method`. */
function deriveInput(row: Scope1Row): {
  value: Decimal;
  unit: string;
  basis: Scope1InputBasis;
} {
  if (row.activityCategory === FUGITIVE_CATEGORY) {
    if (row.method === MASS_BALANCE_METHOD) {
      // opening + added − recovered − closing. A NULL component reads as 0:
      // "nothing was recovered" and "no recovery was recorded" are the same
      // quantity, and the columns are individually nullable by design (§4.9).
      // The sum may come out NEGATIVE on inconsistent data — it is returned as
      // it falls, because VAL-018 is a WARNING (§6.2) and clamping it to zero
      // here would hide the very inconsistency the rule reports.
      const value = subtract(
        add(
          parseDecimalOrZero(row.openingStock),
          parseDecimalOrZero(row.refrigerantAdded),
        ),
        add(
          parseDecimalOrZero(row.refrigerantRecovered),
          parseDecimalOrZero(row.closingStock),
        ),
      );
      return { value, unit: REFRIGERANT_UNIT, basis: "mass_balance" };
    }
    if (row.method === LEAKAGE_ESTIMATE_METHOD) {
      const value = multiply(
        multiply(
          parseDecimalOrZero(row.equipmentCapacity),
          parseDecimalOrZero(row.leakageRate),
        ),
        PERCENT,
      );
      return { value, unit: REFRIGERANT_UNIT, basis: "leakage_estimate" };
    }
  }

  // EVERY other row, including a fugitive one whose `method` is absent or is
  // not one of the two above. The branch is chosen by `method` ALONE and never
  // by "which columns happen to be filled in": a row that populates
  // `equipment_capacity` and asks for `average_data` gets `activity_value`,
  // because guessing at the intent would make the stored figure depend on
  // data-entry leftovers rather than on the method the preparer declared.
  return {
    value: parseDecimal(row.activityValue),
    unit: row.unit ?? "",
    basis: "activity_value",
  };
}

/**
 * VAL-017's split. The ROW's flag and the FACTOR's treatment are ORed, exactly
 * as §9 CALC-4 states ("`biogenic_flag` OR the factor's `biogenic_treatment`").
 *
 * So the two cannot deadlock: whichever side says "biogenic" wins, and
 * `biogenic_flag = false` does NOT pull a factor marked `biogenic` back onto
 * the fossil line. The asymmetry is deliberate — a biogenic factor is curated
 * reference data (the seed's `wood_logs_biogenic` row exists only to price
 * biogenic CO₂), while the flag is preparer input, and the failure mode the
 * rule guards against is biogenic carbon hiding INSIDE the fossil total.
 *
 * The mirror case — a flag of `true` over a fossil-priced factor — moves a
 * result off the fossil line, which understates the headline figure. The engine
 * still follows the OR, because the alternative is an engine that silently
 * overrides a preparer's explicit declaration; catching the mismatch is
 * VAL-017's job at T5.4, where it can be reported to the person who set it.
 */
function isBiogenic(row: Scope1Row, factor: Scope1Factor): boolean {
  return (
    row.biogenicFlag === true || factor.biogenicTreatment === BIOGENIC_TREATMENT
  );
}

/** The failure line for a row that resolved no usable factor (§0.7). */
function failedLine(
  row: Scope1Row,
  input: ReturnType<typeof deriveInput>,
  status: Extract<CalculationStatus, "failed_missing_factor" | "failed_unit">,
  wantedUnits: readonly string[],
): Scope1Line {
  return {
    activityTable: ACTIVITY_TABLE,
    activityRowId: row.id,
    legalEntityId: row.legalEntityId,
    facilityId: row.facilityId,
    scope: "scope1",
    reportingBasis: null,
    methodCode: row.method,
    formulaVersion: FORMULA_VERSION,
    roundingRule: ROUNDING_RULE,
    inputBasis: input.basis,
    inputValue: formatDecimal(input.value, input.value.scale),
    inputUnit: input.unit,
    conversionFactor: "1",
    conversionId: null,
    factorId: null,
    factor: null,
    provenance: null,
    biogenic: row.biogenicFlag === true,
    co2eResult: null,
    biogenicCo2Result: null,
    calculationStatus: status,
    wantedUnits,
  };
}

/**
 * SCOPE 1, end to end (CALC-1 → CALC-2/3 → CALC-4).
 *
 * @param rows        the revision's `emission_activity` rows, each carrying its
 *                    facility's country; CALC-1 filters them HERE rather than
 *                    trusting the caller's WHERE clause, so the four rejections
 *                    are testable and are reported back on
 *                    {@link Scope1Result.excluded}
 * @param factors     any pool; `period.factorSetId` is what selects from it
 * @param conversions the `unit_conversion` table (CALC-3)
 * @param period      the window and the pinned set
 *
 * @throws {FactorsAmbiguousError} from T5.1, when a factor set ties (§12.1).
 *         It aborts the RUN rather than failing one line: a set that cannot
 *         answer one question deterministically cannot be trusted with the rest.
 */
export function computeScope1(
  rows: readonly Scope1Row[],
  factors: readonly Scope1Factor[],
  conversions: readonly ConversionCandidate[],
  period: Scope1Period,
): Scope1Result {
  const lines: Scope1Line[] = [];
  const excluded: Scope1Exclusion[] = [];
  let fossilTotal: Decimal = ZERO;
  let biogenicTotal: Decimal = ZERO;
  let failedCount = 0;

  for (const row of rows) {
    const reason = calc1Exclusion(row, period);
    if (reason !== null) {
      excluded.push({ activityRowId: row.id, reason });
      continue;
    }

    const input = deriveInput(row);
    const query: FactorQuery = {
      factorSetId: period.factorSetId,
      activityType: row.activityType,
      geography: row.geography,
      inputUnit: input.unit,
      applicableYear: applicableYearFor(row.yearMonth, period),
      // The whole period resolves at ONE instant, so a factor expiring mid-year
      // cannot split one reported line across two methodologies (T5.1).
      asOf: period.endDate,
    };
    const resolution = resolveFactor(query, factors, conversions);

    if (resolution.status !== "ok") {
      lines.push(
        failedLine(row, input, resolution.status, resolution.wantedUnits),
      );
      failedCount += 1;
      continue;
    }

    // CALC-4, in exact decimal, rounded exactly once (`ROUNDING_RULE`).
    const conversionFactor = parseDecimal(resolution.conversion.multiplier);
    const factorValue = parseDecimal(resolution.value);
    const exact = multiply(
      multiply(input.value, conversionFactor),
      factorValue,
    );
    const rounded = roundHalfUp(exact, ROUNDING_DECIMALS);
    const result = formatDecimal(rounded, ROUNDING_DECIMALS);

    const biogenic = isBiogenic(row, resolution.factor);
    if (biogenic) {
      biogenicTotal = add(biogenicTotal, rounded);
    } else {
      fossilTotal = add(fossilTotal, rounded);
    }

    lines.push({
      activityTable: ACTIVITY_TABLE,
      activityRowId: row.id,
      legalEntityId: row.legalEntityId,
      facilityId: row.facilityId,
      scope: "scope1",
      reportingBasis: null,
      methodCode: row.method,
      formulaVersion: FORMULA_VERSION,
      roundingRule: ROUNDING_RULE,
      inputBasis: input.basis,
      inputValue: formatDecimal(input.value, input.value.scale),
      inputUnit: input.unit,
      conversionFactor: resolution.conversion.multiplier,
      conversionId: resolution.conversion.conversionId,
      factorId: resolution.factor.id,
      factor: resolution.factor,
      provenance: resolution.provenance,
      biogenic,
      // VAL-017: a biogenic row's FOSSIL result is a genuine zero, and the
      // fossil total above never saw the figure at all.
      co2eResult: biogenic ? formatDecimal(ZERO, ROUNDING_DECIMALS) : result,
      biogenicCo2Result: biogenic ? result : null,
      calculationStatus: "ok",
      wantedUnits: [],
    });
  }

  return {
    lines,
    excluded,
    totals: {
      fossilCo2e: formatDecimal(fossilTotal, ROUNDING_DECIMALS),
      biogenicCo2: formatDecimal(biogenicTotal, ROUNDING_DECIMALS),
      lineCount: lines.length,
      okCount: lines.length - failedCount,
      failedCount,
    },
    runStatus: failedCount > 0 ? "failed" : "ok",
    formulaVersion: FORMULA_VERSION,
    roundingRule: ROUNDING_RULE,
  };
}
