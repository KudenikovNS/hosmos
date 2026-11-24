// SCOPE 2 — DUAL REPORTING (CALC-5, D19, К-20, VAL-022, VAL-024).
//
// See docs/decisions/server-calc-scope2.md for the full account.
import type {
  contractualInstrument,
  purchasedEnergyActivity,
} from "@/server/db/schema";
import type { CalculationMethod } from "@/shared/enums";

import {
  add,
  compare,
  divideHalfUp,
  formatDecimal,
  isZero,
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
  type FactorResolution,
} from "./factors";
import {
  FORMULA_VERSION,
  INSTRUMENT_CONSUMPTION_ORDER,
  MATCHING_UNIT,
  PRORATION_DECIMALS,
  ROUNDING_DECIMALS,
  ROUNDING_RULE,
  type CalculationStatus,
  type InstrumentConsumptionRank,
  type MarketFactorBasis,
} from "./formula-version";
import type { Scope1Factor } from "./scope1";
import {
  applicableYearFor,
  calc1Exclusion,
  type Calc1ExclusionReason,
  type CalcPeriod,
} from "./selection";
import {
  convertUnit,
  type AppliedConversion,
  type ConversionCandidate,
} from "./units";

/** `purchased_energy_activity` as Drizzle returns it. */
type PurchasedEnergyRow = typeof purchasedEnergyActivity.$inferSelect;
/** `contractual_instrument` as Drizzle returns it. */
type ContractualInstrumentRow = typeof contractualInstrument.$inferSelect;

/** The factor fields Scope 2 needs — identical to Scope 1's (T5.2). */
export type Scope2Factor = Scope1Factor;

/** The window and the pinned factor set, shared with Scope 1 (`./selection`). */
export type Scope2Period = CalcPeriod;

/**
 * What §9's MATCHING needs of an energy row — volumes and lifecycle, no
 * geography.
 *
 * Split out from {@link Scope2EnergyRow} because the two callers need different
 * halves: the calculation resolves factors and therefore needs the country,
 * while VAL-022/VAL-024 only balance volumes. Handing the evaluators a type
 * with a `geography` they would have to invent is how a placeholder `''`
 * reaches a factor query.
 */
export type Scope2MatchableRow = Pick<
  PurchasedEnergyRow,
  | "id"
  | "legalEntityId"
  | "facilityId"
  | "yearMonth"
  | "unit"
  | "state"
  | "isDeleted"
  | "supersededById"
  | "energyType"
  | "supplier"
  | "consumption"
>;

/**
 * A `purchased_energy_activity` row as the CALCULATION reads it, PLUS
 * `geography` — the country its location-based factor is resolved by.
 *
 * The country is not on the table; VAL-021 already decided WHOSE it is (the
 * facility's when there is one, the legal entity's otherwise) and refuses the
 * row when there is none, so by the time a row reaches here the caller has a
 * country to pass. Passing it in rather than joining keeps this module free of
 * the organisation model, exactly as in `scope1.ts`.
 */
export type Scope2EnergyRow = Scope2MatchableRow & {
  readonly geography: string;
};

/** A `contractual_instrument` row as the matching reads it (§4.11, DM-17). */
export type Scope2Instrument = Pick<
  ContractualInstrumentRow,
  | "id"
  | "legalEntityId"
  | "facilityId"
  | "yearMonth"
  | "state"
  | "isDeleted"
  | "supersededById"
  | "instrumentType"
  | "certificateId"
  | "coveredVolume"
  | "generationPeriodStart"
  | "generationPeriodEnd"
  | "residualMixVolume"
>;

// ─── The vocabulary the matching is expressed in ─────────────────────────────

/**
 * The InstrumentTypes that are a CLAIM ON A VOLUME, and therefore participate
 * in the matching at a factor of exactly zero.
 *
 * All five are cancelled attribute certificates: the electricity they cover is
 * accounted at zero by the GHG Protocol Scope 2 market-based method, which is
 * the whole reason the market-based figure exists. `supplier_product` — the
 * sixth value — is NOT here: it names a product whose emission factor the
 * supplier publishes, which may be anything at all, and pricing it at zero
 * because it arrived in the same table would be the substitution §0.7 forbids
 * wearing a certificate's clothes. It reaches the calculation through CALC-2's
 * `supplier_specific` rung instead (see {@link MarketFactorBasis}).
 */
const ATTRIBUTE_INSTRUMENT_TYPES = [
  "GoO",
  "REGO",
  "REC",
  "PPA",
  "green_tariff",
] as const;

/**
 * `energy_type` → the `activity_type` its LOCATION-BASED factor is filed under
 * in the pinned set.
 *
 * The four carriers of §4.10 each resolve to the DEFAULT published factor of
 * that carrier, because `purchased_energy_activity` carries no column that
 * could choose between the seed's five district-heating products. Anything
 * narrower than "the carrier's default" is either a supplier's own factor —
 * which the market-based ladder already reaches, by name, through the row's
 * `supplier` — or a column §4.10 does not have and this task may not invent.
 *
 * Electricity is the only one resolved BY COUNTRY: the grid rows are seeded per
 * geography, the heat/steam/cooling rows are `GLOBAL`. CALC-2 does that on its
 * own; the mapping here only names the activity type.
 */
const LOCATION_ACTIVITY_TYPES: Readonly<Record<string, string>> = {
  electricity: "grid:grid_electricity",
  district_heating: "heat:heat_defra_default",
  steam: "heat:steam_defra",
  cooling: "heat:cooling_defra",
};

/**
 * `energy_type` → the `activity_type` of its RESIDUAL MIX, where one exists.
 *
 * Only electricity has an attribute market to strip, so only electricity has a
 * residual mix. THE SHIPPED `legacy-v1` SET DOES NOT CARRY THESE ROWS YET — the
 * AIB market-based value sits unused as the second number of every `GRID` tuple
 * (see `seed-data/legacy-normalisation.ts`, which says so outright). Until a
 * later task seeds them, an unmatched electricity MWh falls to the `grid_average`
 * rung, which is the GHGP hierarchy's last step and is REPORTED as such on the
 * line rather than applied quietly — see {@link MarketFactorBasis}.
 */
const RESIDUAL_MIX_ACTIVITY_TYPES: Readonly<Record<string, string>> = {
  electricity: "grid:residual_mix",
};

/** The carrier whose consumption instruments may be matched against. */
const MATCHABLE_ENERGY_TYPE = "electricity";

/** The one `activity_table` value this module emits (К-10). */
const ACTIVITY_TABLE = "purchased_energy_activity";

/**
 * `calculation.method_code` for the two lines (DM-29, CalculationMethod).
 *
 * `purchased_energy_activity` has no `method` column — Scope 2 has no choice of
 * method to record, it has a choice of BASIS, and К-20 gave that its own column.
 * So the method is derived: a grid average is `average_data`, a factor the
 * supplier published for its own product is `supplier_specific`.
 */
const AVERAGE_DATA_METHOD: CalculationMethod = "average_data";
const SUPPLIER_METHOD: CalculationMethod = "supplier_specific";

/** Sort sentinels for a NULL vintage bound — see {@link instrumentOrderKey}. */
const EARLIEST_DATE = "0000-01-01";
const LATEST_DATE = "9999-12-31";

const MILLISECONDS_PER_DAY = 86_400_000;

// ─── Dates ───────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` at UTC midnight — never the runner's local timezone. */
function utcMillis(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Days from `from` to `to`, BOTH ENDS INCLUDED (a one-day window is 1 day). */
function daysInclusive(from: string, to: string): number {
  return (
    Math.round((utcMillis(to) - utcMillis(from)) / MILLISECONDS_PER_DAY) + 1
  );
}

/** An integer as an exact {@link Decimal} — the day counts of the proration. */
function fromInteger(value: number): Decimal {
  return parseDecimal(String(value));
}

// ─── What the matching produces ──────────────────────────────────────────────

/** A row or an instrument CALC-1 did not take, and why. */
interface Scope2Exclusion {
  readonly rowId: string;
  readonly reason: Calc1ExclusionReason;
}

/**
 * Why an instrument that PASSED CALC-1 still claims no volume.
 *
 * @public
 */
export const INSTRUMENT_SKIP_REASONS = [
  /** `covered_volume` is NULL or zero — nothing to match. */
  "no_covered_volume",
  /** `supplier_product`: a factor, not a volume claim (see the constant). */
  "not_a_volume_claim",
] as const;

/** One value of {@link INSTRUMENT_SKIP_REASONS}. */
export type InstrumentSkipReason = (typeof INSTRUMENT_SKIP_REASONS)[number];

/** An instrument that survived CALC-1 but claims nothing. */
interface Scope2InstrumentSkip {
  readonly instrumentId: string;
  readonly reason: InstrumentSkipReason;
}

/** One energy row's volumes, in the MWh the matching is denominated in. */
interface Scope2RowVolumes {
  readonly energyRowId: string;
  readonly legalEntityId: string;
  readonly facilityId: string | null;
  readonly energyType: string;
  /** `consumption` as entered, in {@link Scope2RowVolumes.unit}. */
  readonly consumption: string;
  readonly unit: string;
  /** The conversion that reached MWh, or `null` when no path exists. */
  readonly toMwh: AppliedConversion | null;
  /** Consumption in MWh, or `null` when the unit reaches no MWh (CALC-3). */
  readonly consumptionMwh: string | null;
  /** MWh instruments covered on this row. `'0.000000'` when none did. */
  readonly coveredMwh: string;
  /** `consumption − covered`, never negative; `null` when unconvertible. */
  readonly residualMwh: string | null;
}

/** One instrument's bite out of one energy row, in the order it was taken. */
interface Scope2Allocation {
  readonly energyRowId: string;
  readonly volumeMwh: string;
  /**
   * `own_facility` when the row sits at the `facility_id` the instrument names,
   * `entity_spill` when the instrument had volume left over afterwards.
   *
   * The distinction is what makes "facility-bound instruments are consumed
   * first" ASSERTABLE rather than merely true of a total: §9 uses `facility_id`
   * for the ORDER only, so the leftover must still reach the rest of the
   * entity — matching granularity is `legal_entity`.
   */
  readonly pass: "own_facility" | "entity_spill";
}

/** One instrument's whole story: what it claimed, what it got, where it went. */
interface Scope2InstrumentMatch {
  readonly instrumentId: string;
  readonly legalEntityId: string;
  readonly facilityId: string | null;
  readonly instrumentType: string;
  readonly rank: InstrumentConsumptionRank;
  /** Its position in its entity's consumption order, from 0 — deterministic. */
  readonly sequence: number;
  /** `covered_volume` as entered (MWh). */
  readonly declaredVolumeMwh: string;
  /** The effective vintage window and its overlap with the period, in days. */
  readonly vintage: {
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly windowDays: number;
    readonly overlapDays: number;
  };
  /** `declared × overlapDays ÷ windowDays`, the engine's one quotient. */
  readonly proratedVolumeMwh: string;
  /** What consumption actually absorbed — below `prorated` iff the cap bit. */
  readonly matchedVolumeMwh: string;
  readonly allocations: readonly Scope2Allocation[];
}

/** The §9 balance of one legal entity over the whole period. */
interface Scope2EntityBalance {
  readonly legalEntityId: string;
  /** Σ electricity consumption (MWh) of the rows that reached MWh. */
  readonly consumptionMwh: string;
  /** Σ prorated instrument volume — VAL-022's numerator, UNCAPPED. */
  readonly claimedMwh: string;
  /** Σ matched — `min(claimed, consumption)` by construction (the cap). */
  readonly coveredMwh: string;
  /** `consumption − covered`. Never negative: that is what the cap buys. */
  readonly residualMwh: string;
  /** `claimed > consumption` — the over-claim VAL-022 blocks on. */
  readonly overClaimed: boolean;
  /** Σ `residual_mix_volume` declared on its instruments, `null` if none is. */
  readonly declaredResidualMwh: string | null;
  /** Electricity rows whose unit reaches no MWh — holes in VAL-024's balance. */
  readonly unconvertibleRowIds: readonly string[];
}

/** Everything §9's matching algorithm produces, before any factor is applied. */
export interface Scope2Matching {
  readonly rows: readonly Scope2RowVolumes[];
  readonly excludedRows: readonly Scope2Exclusion[];
  readonly excludedInstruments: readonly Scope2Exclusion[];
  readonly skippedInstruments: readonly Scope2InstrumentSkip[];
  readonly matches: readonly Scope2InstrumentMatch[];
  readonly entities: readonly Scope2EntityBalance[];
}

// ─── The matching (§9, verbatim) ─────────────────────────────────────────────

/**
 * The effective vintage window and the share of it that lies in the period.
 *
 * AN OPEN END IS CLOSED AT THE PERIOD'S EDGE — a NULL `generation_period_start`
 * reads as "from before this period", a NULL end as "until after it". That is
 * VAL-023's convention already (`validation/evaluators/energy.ts`), and reusing
 * it means the Warning a preparer saw at data entry and the volume the
 * calculation grants are talking about the same window. Both NULL therefore
 * prorates to the FULL volume, which is what "an instrument covers the period"
 * (§4.11) means.
 *
 * THREE CASES AND ONE OF THEM DIVIDES:
 *   - no overlap at all (the window ends before the period or starts after it)
 *     → zero. Not an error, not a skip, not a warning here: the instrument is
 *     reported with `prorated = 0`, so it contributes nothing to the covered
 *     volume AND nothing to VAL-022's numerator, and it is still visible in the
 *     result rather than vanishing from it;
 *   - the window lies wholly inside the period → the volume, EXACTLY, with no
 *     quotient formed at all. This is the common case (a certificate for the
 *     reporting year) and it is worth short-circuiting precisely because it
 *     keeps the ordinary report free of the one rounding in the engine;
 *   - anything else → `volume × overlapDays ÷ windowDays`, half-up to
 *     `PRORATION_DECIMALS`.
 */
function prorate(
  volume: Decimal,
  instrument: Scope2Instrument,
  period: Scope2Period,
): Pick<Scope2InstrumentMatch, "vintage"> & { prorated: Decimal } {
  const windowStart = instrument.generationPeriodStart ?? period.startDate;
  const windowEnd = instrument.generationPeriodEnd ?? period.endDate;
  const windowDays =
    windowEnd < windowStart ? 0 : daysInclusive(windowStart, windowEnd);

  const overlapStart =
    windowStart > period.startDate ? windowStart : period.startDate;
  const overlapEnd = windowEnd < period.endDate ? windowEnd : period.endDate;
  const overlapDays =
    overlapEnd < overlapStart ? 0 : daysInclusive(overlapStart, overlapEnd);

  const vintage = { windowStart, windowEnd, windowDays, overlapDays };

  if (windowDays <= 0 || overlapDays <= 0) return { vintage, prorated: ZERO };
  if (overlapDays >= windowDays) return { vintage, prorated: volume };
  return {
    vintage,
    prorated: divideHalfUp(
      multiply(volume, fromInteger(overlapDays)),
      fromInteger(windowDays),
      PRORATION_DECIMALS,
    ),
  };
}

/**
 * THE CONSUMPTION ORDER, as a total order that no database can perturb.
 *
 * §9 fixes the first component — facility-bound instruments before entity-level
 * ones — and says nothing about the rest, which is exactly the gap T5.1 was
 * about: `candidates[0]` makes a reported figure a function of the physical
 * order of an index, so the same revision reproduces differently after a
 * VACUUM. When the cap bites, the order decides WHICH instrument was cut, so
 * the remaining components are chosen rather than left to chance:
 *
 *   1. `facility_bound` before `entity_level` (§9);
 *   2. the OLDEST vintage first. Certificates expire; retiring the ones closest
 *      to the end of their claimable life before the fresh ones is the
 *      convention every registry operates on, and it makes the instrument left
 *      unmatched by a cap the one with the most life left in it;
 *   3. then the earliest window END, which separates two instruments starting
 *      the same day by which is the narrower claim;
 *   4. then `certificate_id`, the registry's own identifier — the tie-break a
 *      human would use;
 *   5. then `id`. A primary key, so the order is TOTAL: no two instruments can
 *      tie, and the sort never has to fall through to array position.
 *
 * A NULL bound sorts as its open end (`0000-01-01` / `9999-12-31`), consistent
 * with {@link prorate} reading it as "from before" / "until after".
 */
function instrumentOrderKey(instrument: Scope2Instrument): readonly string[] {
  return [
    instrument.facilityId === null ? "1" : "0",
    instrument.generationPeriodStart ?? EARLIEST_DATE,
    instrument.generationPeriodEnd ?? LATEST_DATE,
    instrument.certificateId ?? "",
    instrument.id,
  ];
}

/**
 * The order consumption is TAKEN FROM, within a legal entity: by month, then by
 * site, then by id.
 *
 * WHY AN ORDER IS NEEDED AT ALL, AND WHY IT DOES NOT CHANGE ANY TOTAL. §9
 * matches at `legal_entity` granularity over the period TOTAL, but DM-29 stores
 * a result per ROW, so the entity's covered MWh have to be attributed to
 * individual rows somewhere. The attribution is linear — every row's
 * market-based term is `(consumption − covered) × factor` and the factors do not
 * depend on the split — so the ENTITY's market-based total is identical under
 * any attribution. What the order decides is only which detail line carries the
 * covered share.
 *
 * PRO RATA WOULD HAVE BEEN THE OTHER CANDIDATE and was rejected for a concrete
 * reason: `row_consumption × matched ÷ total` is a quotient PER ROW, so every
 * detail line would carry a rounding of its own and the residuals would no
 * longer sum to the entity's residual without a tolerance. Sequential
 * attribution is exact — additions and subtractions only — and VAL-024's
 * balance therefore closes on the nose rather than within a fudge.
 */
function rowOrderKey(row: Scope2MatchableRow): readonly string[] {
  return [row.yearMonth ?? "", row.facilityId ?? "", row.id];
}

/** Lexicographic compare of two equal-length string keys. */
function compareKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** A row's consumption in MWh, mid-matching. */
interface RowState {
  readonly row: Scope2MatchableRow;
  readonly toMwh: AppliedConversion | null;
  readonly consumptionMwh: Decimal | null;
  covered: Decimal;
}

/**
 * §9's ALGORITHM, on volumes alone — no factors, no emissions.
 *
 * It is exported because VAL-022 and VAL-024 need exactly this and nothing more
 * (`validation/evaluators/scope2.ts`). A second implementation inside the
 * evaluators would be the one the calculation does not use, and the rule would
 * then be able to pass a run the engine got differently — which is the failure
 * `plan-gate.ts` was built to avoid in S2 and the reason T3.2 left both codes in
 * `PENDING_EVALUATORS` rather than writing them early.
 *
 * @param rows        the revision's energy rows, each carrying its geography;
 *                    CALC-1 filters them HERE, so the four rejections are
 *                    reported rather than assumed of the caller's WHERE clause
 * @param instruments the revision's `contractual_instrument` rows
 * @param conversions the `unit_conversion` table (CALC-3), for the MWh leg
 * @param period      the window the vintage overlap is measured against
 */
export function matchInstruments(
  rows: readonly Scope2MatchableRow[],
  instruments: readonly Scope2Instrument[],
  conversions: readonly ConversionCandidate[],
  period: Scope2Period,
): Scope2Matching {
  const excludedRows: Scope2Exclusion[] = [];
  const excludedInstruments: Scope2Exclusion[] = [];
  const skippedInstruments: Scope2InstrumentSkip[] = [];

  // ── CALC-1, over both tables ──────────────────────────────────────────────
  const states = new Map<string, RowState>();
  for (const row of rows) {
    const reason = calc1Exclusion(row, period);
    if (reason !== null) {
      excludedRows.push({ rowId: row.id, reason });
      continue;
    }
    const unit = row.unit ?? "";
    const activityType =
      LOCATION_ACTIVITY_TYPES[row.energyType] ?? row.energyType;
    // The pinned set (К-24) comes off the PERIOD, which is the caller that
    // already knows it — never a "current set" lookup (0010).
    const path = convertUnit(
      unit,
      MATCHING_UNIT,
      activityType,
      period.factorSetId,
      conversions,
    );
    const toMwh = path.status === "ok" ? path.conversion : null;
    states.set(row.id, {
      row,
      toMwh,
      consumptionMwh:
        toMwh === null
          ? null
          : multiply(
              parseDecimal(row.consumption),
              parseDecimal(toMwh.multiplier),
            ),
      covered: ZERO,
    });
  }

  const survivors: Scope2Instrument[] = [];
  const claimants: Scope2Instrument[] = [];
  for (const instrument of instruments) {
    const reason = calc1Exclusion(instrument, period);
    if (reason !== null) {
      excludedInstruments.push({ rowId: instrument.id, reason });
      continue;
    }
    survivors.push(instrument);
    if (
      !(ATTRIBUTE_INSTRUMENT_TYPES as readonly string[]).includes(
        instrument.instrumentType,
      )
    ) {
      skippedInstruments.push({
        instrumentId: instrument.id,
        reason: "not_a_volume_claim",
      });
      continue;
    }
    const volume = parseDecimalOrZero(instrument.coveredVolume);
    if (isZero(volume)) {
      skippedInstruments.push({
        instrumentId: instrument.id,
        reason: "no_covered_volume",
      });
      continue;
    }
    claimants.push(instrument);
  }

  // ── The entities in play: anyone who consumed OR claimed ──────────────────
  const entityIds = new Set<string>();
  for (const state of states.values()) entityIds.add(state.row.legalEntityId);
  for (const instrument of survivors) entityIds.add(instrument.legalEntityId);

  const matches: Scope2InstrumentMatch[] = [];
  const entities: Scope2EntityBalance[] = [];

  for (const legalEntityId of [...entityIds].sort()) {
    // The matching pool: ELECTRICITY only. §9's denominator is "the entity's
    // total purchased ELECTRICITY", and every InstrumentType of D19 is an
    // electricity certificate — a GoO cannot cover district heating, and
    // letting one do so here would understate a carrier nothing was bought for.
    const pool = [...states.values()]
      .filter(
        (state) =>
          state.row.legalEntityId === legalEntityId &&
          state.row.energyType === MATCHABLE_ENERGY_TYPE,
      )
      .sort((a, b) => compareKeys(rowOrderKey(a.row), rowOrderKey(b.row)));

    const convertible = pool.filter((state) => state.consumptionMwh !== null);
    const consumption = convertible.reduce<Decimal>(
      (total, state) => add(total, state.consumptionMwh as Decimal),
      ZERO,
    );

    const entityInstruments = claimants
      .filter((instrument) => instrument.legalEntityId === legalEntityId)
      .sort((a, b) =>
        compareKeys(instrumentOrderKey(a), instrumentOrderKey(b)),
      );

    let claimed: Decimal = ZERO;
    let covered: Decimal = ZERO;
    let declaredResidual: Decimal | null = null;

    entityInstruments.forEach((instrument, sequence) => {
      const declared = parseDecimalOrZero(instrument.coveredVolume);
      const { vintage, prorated } = prorate(declared, instrument, period);
      claimed = add(claimed, prorated);

      // TWO PASSES, and the second is what keeps the granularity at
      // `legal_entity`: the instrument is offered its own site's rows first
      // (§9's order), and whatever it still holds afterwards spills onto the
      // rest of the entity. Without the spill, `facility_id` would silently
      // become a matching KEY, which §9 explicitly defers.
      let remaining = prorated;
      const allocations: Scope2Allocation[] = [];
      const consume = (state: RowState, pass: Scope2Allocation["pass"]) => {
        if (compare(remaining, ZERO) <= 0) return;
        if (state.consumptionMwh === null) return;
        const free = subtract(state.consumptionMwh, state.covered);
        if (compare(free, ZERO) <= 0) return;
        const take = compare(free, remaining) < 0 ? free : remaining;
        state.covered = add(state.covered, take);
        remaining = subtract(remaining, take);
        covered = add(covered, take);
        allocations.push({
          energyRowId: state.row.id,
          volumeMwh: formatDecimal(take, PRORATION_DECIMALS),
          pass,
        });
      };

      if (instrument.facilityId !== null) {
        for (const state of convertible) {
          if (state.row.facilityId === instrument.facilityId) {
            consume(state, "own_facility");
          }
        }
      }
      for (const state of convertible) consume(state, "entity_spill");

      matches.push({
        instrumentId: instrument.id,
        legalEntityId,
        facilityId: instrument.facilityId,
        instrumentType: instrument.instrumentType,
        rank:
          instrument.facilityId === null
            ? INSTRUMENT_CONSUMPTION_ORDER[1]
            : INSTRUMENT_CONSUMPTION_ORDER[0],
        sequence,
        declaredVolumeMwh: instrument.coveredVolume ?? "0",
        vintage,
        proratedVolumeMwh: formatDecimal(prorated, PRORATION_DECIMALS),
        matchedVolumeMwh: formatDecimal(
          subtract(prorated, remaining),
          PRORATION_DECIMALS,
        ),
        allocations,
      });
    });

    // `residual_mix_volume` is a DECLARATION ABOUT THE ENTITY'S BALANCE (§4.11,
    // "MWh — VAL-024 balance"), so it is read off every instrument that survived
    // CALC-1, not only off the ones that claim a volume. A `supplier_product`
    // states no volume claim and still knows what the residual should be.
    for (const instrument of survivors) {
      if (
        instrument.legalEntityId === legalEntityId &&
        instrument.residualMixVolume !== null
      ) {
        declaredResidual = add(
          declaredResidual ?? ZERO,
          parseDecimal(instrument.residualMixVolume),
        );
      }
    }

    entities.push({
      legalEntityId,
      consumptionMwh: formatDecimal(consumption, PRORATION_DECIMALS),
      claimedMwh: formatDecimal(claimed, PRORATION_DECIMALS),
      coveredMwh: formatDecimal(covered, PRORATION_DECIMALS),
      residualMwh: formatDecimal(
        subtract(consumption, covered),
        PRORATION_DECIMALS,
      ),
      overClaimed: compare(claimed, consumption) > 0,
      declaredResidualMwh:
        declaredResidual === null
          ? null
          : formatDecimal(declaredResidual, PRORATION_DECIMALS),
      unconvertibleRowIds: pool
        .filter((state) => state.consumptionMwh === null)
        .map((state) => state.row.id),
    });
  }

  const volumes: Scope2RowVolumes[] = [...states.values()].map((state) => ({
    energyRowId: state.row.id,
    legalEntityId: state.row.legalEntityId,
    facilityId: state.row.facilityId,
    energyType: state.row.energyType,
    consumption: state.row.consumption,
    unit: state.row.unit ?? "",
    toMwh: state.toMwh,
    consumptionMwh:
      state.consumptionMwh === null
        ? null
        : formatDecimal(state.consumptionMwh, PRORATION_DECIMALS),
    coveredMwh: formatDecimal(state.covered, PRORATION_DECIMALS),
    residualMwh:
      state.consumptionMwh === null
        ? null
        : formatDecimal(
            subtract(state.consumptionMwh, state.covered),
            PRORATION_DECIMALS,
          ),
  }));

  return {
    rows: volumes,
    excludedRows,
    excludedInstruments,
    skippedInstruments,
    matches,
    entities,
  };
}

// ─── The two lines (CALC-5) ──────────────────────────────────────────────────

/** One `calculation` row's worth of Scope-2 arithmetic (DM-29, К-20). */
export interface Scope2Line {
  readonly activityTable: typeof ACTIVITY_TABLE;
  readonly activityRowId: string;
  readonly legalEntityId: string;
  readonly facilityId: string | null;
  readonly scope: "scope2";
  /** К-20's discriminator — the two lines of one row differ ONLY here. */
  readonly reportingBasis: "location_based" | "market_based";
  readonly methodCode: string;
  readonly formulaVersion: string;
  readonly roundingRule: string;
  /**
   * What entered the formula: the row's `consumption` on the location-based
   * line, the UNMATCHED volume in MWh on the market-based one.
   *
   * The two are deliberately in different units and both are honest: the
   * location-based figure prices everything the meter recorded, the
   * market-based one prices only what no certificate covered, and that quantity
   * is produced by the matching, which §9 denominates in MWh.
   */
  readonly inputValue: string | null;
  readonly inputUnit: string;
  readonly conversionFactor: string;
  readonly conversionId: string | null;
  readonly factorId: string | null;
  readonly factor: Scope2Factor | null;
  /**
   * WHY that factor, and what was passed over to reach it (CALC-2's account).
   * `null` when nothing resolved — see `Scope1Line.provenance`.
   */
  readonly provenance: FactorProvenance | null;
  /** Which rung priced the remainder; `null` on the location-based line. */
  readonly marketFactorBasis: MarketFactorBasis | null;
  /** MWh certificates covered — `null` on the location-based line. */
  readonly coveredMwh: string | null;
  /** kgCO2e at {@link ROUNDING_DECIMALS} places, or `null` on a failure (§0.7). */
  readonly co2eResult: string | null;
  /** Always `null`: purchased energy has no biogenic component (VAL-017). */
  readonly biogenicCo2Result: null;
  readonly calculationStatus: CalculationStatus;
  /** On `failed_unit`, the units an eligible factor is priced in. */
  readonly wantedUnits: readonly string[];
}

/** The `location_factor_id` / `market_factor_id` write-back of §4.10. */
interface Scope2FactorWriteBack {
  readonly energyRowId: string;
  readonly locationFactorId: string | null;
  readonly marketFactorId: string | null;
}

/** Totals across the calculated lines, per basis (CALC-8 consumes them). */
interface Scope2Totals {
  readonly locationBasedCo2e: string;
  readonly marketBasedCo2e: string;
  readonly lineCount: number;
  readonly okCount: number;
  readonly failedCount: number;
}

/** What {@link computeScope2} returns. */
export interface Scope2Result {
  readonly lines: readonly Scope2Line[];
  readonly matching: Scope2Matching;
  readonly writeBacks: readonly Scope2FactorWriteBack[];
  readonly totals: Scope2Totals;
  /** `failed` if ANY line failed — CALC-6 blocks approve/render/lock on it. */
  readonly runStatus: "ok" | "failed";
  readonly formulaVersion: string;
  readonly roundingRule: string;
}

/** The resolution that priced a line, plus which rung of the ladder it was. */
interface MarketResolution {
  readonly basis: MarketFactorBasis;
  readonly resolution: FactorResolution<Scope2Factor>;
}

/**
 * The market-based ladder of {@link MarketFactorBasis}, walked in order.
 *
 * Every rung asks for the input in MWh, because that is the unit the
 * market-based line is denominated in — a factor reachable from kWh but not
 * from MWh is not a factor this line can use, and pretending otherwise would
 * record a `conversion_factor` that does not convert what `input_value` holds.
 */
function resolveMarketFactor(
  row: Scope2EnergyRow,
  base: FactorQuery,
  factors: readonly Scope2Factor[],
  conversions: readonly ConversionCandidate[],
): MarketResolution {
  const query: FactorQuery = { ...base, inputUnit: MATCHING_UNIT };

  const supplier = row.supplier?.trim();
  if (supplier) {
    const resolution = resolveFactor(
      { ...query, supplier },
      factors,
      conversions,
    );
    // The TIER, not merely a hit: `resolveFactor` answers the same question
    // with the country's grid row when the supplier has no factor of its own,
    // and calling that "supplier-specific" would put a market-based label on a
    // location-based number.
    if (resolution.status === "ok" && resolution.tier === "supplier_specific") {
      return { basis: "supplier_specific", resolution };
    }
    if (
      resolution.status !== "ok" &&
      resolution.failureReason === "output_unit"
    )
      return { basis: "supplier_specific", resolution };
  }

  const residualType = RESIDUAL_MIX_ACTIVITY_TYPES[row.energyType];
  if (residualType !== undefined) {
    const resolution = resolveFactor(
      { ...query, activityType: residualType },
      factors,
      conversions,
    );
    if (resolution.status === "ok")
      return { basis: "residual_mix", resolution };
    if (resolution.failureReason === "output_unit")
      return { basis: "residual_mix", resolution };
  }

  return {
    basis: "grid_average",
    resolution: resolveFactor(query, factors, conversions),
  };
}

/** `input × conversion × factor`, in exact decimal, rounded exactly once. */
function apply(
  input: Decimal,
  conversion: AppliedConversion,
  factorValue: string,
): string {
  return formatDecimal(
    roundHalfUp(
      multiply(
        multiply(input, parseDecimal(conversion.multiplier)),
        parseDecimal(factorValue),
      ),
      ROUNDING_DECIMALS,
    ),
    ROUNDING_DECIMALS,
  );
}

/** The common half of both lines. */
function baseLine(
  row: Scope2EnergyRow,
  reportingBasis: Scope2Line["reportingBasis"],
): Pick<
  Scope2Line,
  | "activityTable"
  | "activityRowId"
  | "legalEntityId"
  | "facilityId"
  | "scope"
  | "reportingBasis"
  | "formulaVersion"
  | "roundingRule"
  | "biogenicCo2Result"
> {
  return {
    activityTable: ACTIVITY_TABLE,
    activityRowId: row.id,
    legalEntityId: row.legalEntityId,
    facilityId: row.facilityId,
    scope: "scope2",
    reportingBasis,
    formulaVersion: FORMULA_VERSION,
    roundingRule: ROUNDING_RULE,
    biogenicCo2Result: null,
  };
}

/**
 * SCOPE 2, end to end (CALC-1 → §9's matching → CALC-2/3 → CALC-4 twice).
 *
 * @throws {FactorsAmbiguousError} from T5.1, when the pinned set ties. It
 *         aborts the RUN rather than failing one line, for the reason T5.1
 *         gives: a set that cannot answer one question deterministically cannot
 *         be trusted with the rest.
 */
export function computeScope2(
  rows: readonly Scope2EnergyRow[],
  instruments: readonly Scope2Instrument[],
  factors: readonly Scope2Factor[],
  conversions: readonly ConversionCandidate[],
  period: Scope2Period,
): Scope2Result {
  const matching = matchInstruments(rows, instruments, conversions, period);
  const volumes = new Map(matching.rows.map((row) => [row.energyRowId, row]));

  const lines: Scope2Line[] = [];
  const writeBacks: Scope2FactorWriteBack[] = [];
  let locationTotal: Decimal = ZERO;
  let marketTotal: Decimal = ZERO;
  let failedCount = 0;

  for (const row of rows) {
    const volume = volumes.get(row.id);
    if (volume === undefined) continue; // excluded by CALC-1, already reported.

    const base: FactorQuery = {
      factorSetId: period.factorSetId,
      activityType: LOCATION_ACTIVITY_TYPES[row.energyType] ?? row.energyType,
      geography: row.geography,
      inputUnit: row.unit ?? "",
      applicableYear: applicableYearFor(row.yearMonth, period),
      // The whole period resolves at ONE instant (T5.1), so a factor expiring
      // mid-year cannot split one reported line across two methodologies.
      asOf: period.endDate,
    };

    // ── LOCATION-BASED: the grid of the country, no supplier in the query ──
    const location = resolveFactor(base, factors, conversions);
    const locationLine: Scope2Line =
      location.status === "ok"
        ? {
            ...baseLine(row, "location_based"),
            methodCode: AVERAGE_DATA_METHOD,
            inputValue: row.consumption,
            inputUnit: row.unit ?? "",
            conversionFactor: location.conversion.multiplier,
            conversionId: location.conversion.conversionId,
            factorId: location.factor.id,
            factor: location.factor,
            provenance: location.provenance,
            marketFactorBasis: null,
            coveredMwh: null,
            co2eResult: apply(
              parseDecimal(row.consumption),
              location.conversion,
              location.value,
            ),
            calculationStatus: "ok",
            wantedUnits: [],
          }
        : {
            ...baseLine(row, "location_based"),
            methodCode: AVERAGE_DATA_METHOD,
            inputValue: row.consumption,
            inputUnit: row.unit ?? "",
            conversionFactor: "1",
            conversionId: null,
            factorId: null,
            factor: null,
            provenance: null,
            marketFactorBasis: null,
            coveredMwh: null,
            co2eResult: null,
            calculationStatus: location.status,
            wantedUnits: location.wantedUnits,
          };

    // ── MARKET-BASED: the UNMATCHED MWh, priced by the ladder ──────────────
    // The matched MWh are absent from `input_value` rather than multiplied by a
    // zero factor: the certificate's zero IS the reason they are absent, and a
    // reader re-deriving `input × conversion × factor` from the stored row gets
    // the stored result. `coveredMwh` keeps the other half visible.
    const market = resolveMarketFactor(row, base, factors, conversions);
    let marketLine: Scope2Line;
    if (volume.residualMwh === null) {
      // The row's unit reaches no MWh, so the matching could not denominate it
      // and the market-based line has no input at all. A DIFFERENT failure from
      // the location-based line's, which may well have succeeded.
      marketLine = {
        ...baseLine(row, "market_based"),
        methodCode: AVERAGE_DATA_METHOD,
        inputValue: null,
        inputUnit: MATCHING_UNIT,
        conversionFactor: "1",
        conversionId: null,
        factorId: null,
        factor: null,
        provenance: null,
        marketFactorBasis: null,
        coveredMwh: volume.coveredMwh,
        co2eResult: null,
        calculationStatus: "failed_unit",
        wantedUnits: [MATCHING_UNIT],
      };
    } else if (market.resolution.status === "ok") {
      marketLine = {
        ...baseLine(row, "market_based"),
        methodCode:
          market.basis === "supplier_specific"
            ? SUPPLIER_METHOD
            : AVERAGE_DATA_METHOD,
        inputValue: volume.residualMwh,
        inputUnit: MATCHING_UNIT,
        conversionFactor: market.resolution.conversion.multiplier,
        conversionId: market.resolution.conversion.conversionId,
        factorId: market.resolution.factor.id,
        factor: market.resolution.factor,
        provenance: market.resolution.provenance,
        marketFactorBasis: market.basis,
        coveredMwh: volume.coveredMwh,
        co2eResult: apply(
          parseDecimal(volume.residualMwh),
          market.resolution.conversion,
          market.resolution.value,
        ),
        calculationStatus: "ok",
        wantedUnits: [],
      };
    } else {
      marketLine = {
        ...baseLine(row, "market_based"),
        methodCode: AVERAGE_DATA_METHOD,
        inputValue: volume.residualMwh,
        inputUnit: MATCHING_UNIT,
        conversionFactor: "1",
        conversionId: null,
        factorId: null,
        factor: null,
        provenance: null,
        marketFactorBasis: null,
        coveredMwh: volume.coveredMwh,
        co2eResult: null,
        calculationStatus: market.resolution.status,
        wantedUnits: market.resolution.wantedUnits,
      };
    }

    for (const line of [locationLine, marketLine]) {
      lines.push(line);
      if (line.calculationStatus !== "ok") failedCount += 1;
    }
    if (locationLine.co2eResult !== null) {
      locationTotal = add(locationTotal, parseDecimal(locationLine.co2eResult));
    }
    if (marketLine.co2eResult !== null) {
      marketTotal = add(marketTotal, parseDecimal(marketLine.co2eResult));
    }

    writeBacks.push({
      energyRowId: row.id,
      locationFactorId: locationLine.factorId,
      marketFactorId: marketLine.factorId,
    });
  }

  return {
    lines,
    matching,
    writeBacks,
    totals: {
      locationBasedCo2e: formatDecimal(locationTotal, ROUNDING_DECIMALS),
      marketBasedCo2e: formatDecimal(marketTotal, ROUNDING_DECIMALS),
      lineCount: lines.length,
      okCount: lines.length - failedCount,
      failedCount,
    },
    runStatus: failedCount > 0 ? "failed" : "ok",
    formulaVersion: FORMULA_VERSION,
    roundingRule: ROUNDING_RULE,
  };
}
