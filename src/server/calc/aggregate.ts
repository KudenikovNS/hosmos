// =============================================================================
// CALC-8 — THE AGGREGATION A REPORT IS BUILT FROM (T5.4, §9, VSME B3).
//
// One pure function over the lines a run produced: no database, no clock, no
// currency feed. It takes the calculation lines, the energy volumes the Scope-2
// matching denominated, the legal entities of the boundary with their turnover,
// and a resolved FX map — and returns the four things §9's CALC-8 names: totals
// by scope (1 / 2 LB / 2 MB), totals by legal entity and by facility, energy in
// MWh split renewable / non-renewable, and the intensity `tCO2e / turnover`.
//
// ── A FAILED RUN PUBLISHES NO TOTALS (§0.7, AC-6) ───────────────────────────
// THE most important rule in this file, and the reason the figures are
// `string | null` rather than `string`. If ONE line of the run failed, every
// emission figure here is `null` — not "the sum of the lines that worked".
//
// The tempting alternative is to sum the `ok` lines and carry a footnote. It is
// wrong in the only way that matters: the sum of the successful lines is a
// PLAUSIBLE NUMBER. It has the right magnitude, it reconciles with itself, and
// it is silently too small by exactly the emissions nobody could price. A
// reviewer cannot see that by looking at it; a renderer would print it; an
// auditor would sign it. §0.7 says a missing factor must never become a zero,
// and a total that quietly omits a line IS that zero, one level up. So the
// aggregate refuses: `status: 'failed'`, every figure `null`, and
// {@link CalcAggregates.failedLines} names the lines to fix.
//
// ── WHY THE ROUNDING CONSTANTS HERE ARE NOT PART OF `FORMULA_VERSION` ────────
// `FORMULA_VERSION` identifies how a STORED `calculation` row was produced
// (`formula-version.ts` says so, and the golden fixtures pin it). Nothing in
// this module is stored: aggregation is a PRESENTATION of rows that already
// exist, recomputed from them on every read, and changing a display precision
// here cannot move a figure in a locked report. What IS shared with the version
// is {@link VAL_034_TOLERANCE} — the reconciliation tolerance — because that one
// is a claim about the arithmetic and is imported rather than re-typed.
// =============================================================================
import {
  add,
  compare,
  divideHalfUp,
  formatDecimal,
  isZero,
  multiply,
  parseDecimal,
  subtract,
  ZERO,
  type Decimal,
} from "./decimal";
import {
  ROUNDING_DECIMALS,
  VAL_034_TOLERANCE,
  type CalculationStatus,
} from "./formula-version";

// ─── Precision of the derived figures (see the header: NOT the formula) ──────

/** Decimal places kept for an MWh figure — a watt-hour, as in `scope2.ts`. */
const ENERGY_DECIMALS = 6;

/** Decimal places kept for a tCO₂e figure — a milligram of CO₂e. */
const TONNE_DECIMALS = 9;

/** kg per tonne — the one unit change between a stored line and a headline. */
const KG_PER_TONNE = parseDecimal("1000");

/** `renewable_share` is a PERCENT (§4.10), so the share applied is `share/100`. */
const PERCENT = parseDecimal("0.01");

/**
 * Decimal places kept for an intensity (`tCO2e / turnover`).
 *
 * Twelve, because the quantity is genuinely tiny: a company with €10M of
 * turnover and 500 tCO₂e reports 0.00005 tCO₂e per EUR, and six places would
 * round two significant digits of it away. It costs nothing — the figure is
 * derived on read.
 */
const INTENSITY_DECIMALS = 12;

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * One calculation line as the aggregation reads it.
 *
 * Structurally satisfied by both `Scope1Line` and `Scope2Line` (T5.2/T5.3) AND
 * by a line read back out of the `calculation` table — which is the point: the
 * aggregate a run returns and the aggregate `GET …/results` recomputes from the
 * stored rows come out of the SAME function, so the number a preparer saw when
 * they pressed Calculate and the number the report prints cannot drift.
 */
export interface AggregateLine {
  readonly legalEntityId: string;
  readonly facilityId: string | null;
  readonly scope: "scope1" | "scope2";
  readonly reportingBasis: "location_based" | "market_based" | null;
  /** kgCO2e, or `null` when this line did not compute (§0.7). */
  readonly co2eResult: string | null;
  /** kgCO₂, or `null` when the line is fossil or did not compute (VAL-017). */
  readonly biogenicCo2Result: string | null;
  readonly calculationStatus: CalculationStatus;
}

/**
 * One purchased-energy row's volume, already denominated in MWh by CALC-3.
 *
 * `consumptionMwh` is `null` when the row's unit reaches no MWh — the same hole
 * VAL-024 reports. It is NOT read as zero here either: the energy figures go
 * `null` and a warning names the row.
 */
export interface AggregateEnergyRow {
  readonly energyRowId: string;
  readonly legalEntityId: string;
  readonly facilityId: string | null;
  readonly energyType: string;
  readonly consumptionMwh: string | null;
  /** `0`–`100`, or `null` when the preparer has not stated one. */
  readonly renewableShare: string | null;
}

/** A legal entity of the period's boundary, with the VSME B3 intensity input. */
export interface AggregateEntity {
  readonly legalEntityId: string;
  /** `null` when an older run did not record the historical name. */
  readonly name: string | null;
  /** `numeric` as entered, in {@link AggregateEntity.currency}; `null` if unset. */
  readonly turnover: string | null;
  /** ISO-4217 of `turnover`; `null` when the entity has no reporting currency. */
  readonly currency: string | null;
}

/** A facility, so a per-site total can carry a name rather than a bare uuid. */
export interface AggregateFacility {
  readonly facilityId: string;
  readonly legalEntityId: string;
  readonly name: string;
}

/** The FX context of CALC-8: the year the period ENDS and the resolved rates. */
interface AggregateFx {
  /** `YYYY` — the year `reporting_period.end_date` falls in (§9 CALC-8). */
  readonly year: string;
  /** `currency_code → rate_to_eur`, from `@/server/db/fx`. A currency with no
   *  rate is ABSENT — never present with a 1.0. */
  readonly rates: ReadonlyMap<string, number>;
}

/** Everything {@link aggregateRun} needs. */
export interface AggregateInput {
  readonly lines: readonly AggregateLine[];
  readonly energy: readonly AggregateEnergyRow[];
  readonly entities: readonly AggregateEntity[];
  readonly facilities: readonly AggregateFacility[];
  readonly fx: AggregateFx;
}

// ─── Warnings ────────────────────────────────────────────────────────────────

/**
 * The things an aggregate can only report rather than compute.
 *
 * EVERY ONE OF THEM IS A PLACE WHERE A DEFAULT WOULD HAVE BEEN CHEAPER AND
 * WRONG. `fx_rate_missing` is the one the acceptance names: the alternative is
 * `rate ?? 1.0`, which silently reports Serbian dinars as euros and understates
 * the intensity by two orders of magnitude. The others are the same failure in
 * other columns.
 */
export const AGGREGATE_WARNINGS = [
  "historical_context_missing",
  /** No `fx_rates` row reaches this currency, even through the year ladder. */
  "fx_rate_missing",
  /** An included legal entity has no `turnover` — the denominator is short. */
  "turnover_missing",
  /** An included legal entity has no `reporting_currency` to convert FROM. */
  "currency_missing",
  /** An energy row's unit reaches no MWh (CALC-3), so it is in no split. */
  "energy_unconvertible",
  /**
   * An energy row states no `renewable_share`. It is NOT read as 0% renewable:
   * every bucket it joins publishes its TOTAL and withholds the SPLIT.
   */
  "renewable_share_missing",
  /** A calculation line names a legal entity outside the aggregated set. */
  "line_outside_boundary",
] as const;

/** One value of {@link AGGREGATE_WARNINGS}. */
export type AggregateWarningCode = (typeof AGGREGATE_WARNINGS)[number];

/** A warning, with enough context to act on without a second query. */
interface AggregateWarning {
  readonly code: AggregateWarningCode;
  readonly detail: Readonly<Record<string, string | null>>;
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

/**
 * The four figures §9 asks for, per grouping. `null` means "not published",
 * never "zero" — see the header.
 */
export interface ScopeTotals {
  /** Scope 1, FOSSIL kgCO2e (biogenic is not in it — VAL-017). */
  readonly scope1Co2e: string | null;
  /** Scope 1 biogenic kgCO₂, disclosed on its own line (VAL-017). */
  readonly scope1BiogenicCo2: string | null;
  readonly scope2LocationBasedCo2e: string | null;
  readonly scope2MarketBasedCo2e: string | null;
}

/** Energy in MWh, split by `renewable_share` (CALC-8 / VSME B3). */
export interface EnergySplit {
  readonly totalMwh: string | null;
  readonly renewableMwh: string | null;
  readonly nonRenewableMwh: string | null;
}

/** One legal entity's slice of the report. */
export interface EntityAggregate {
  readonly legalEntityId: string;
  readonly name: string | null;
  readonly totals: ScopeTotals;
  readonly energy: EnergySplit;
}

/** One facility's slice; `facilityId: null` is "attributed to no site" (К-18). */
interface FacilityAggregate {
  readonly facilityId: string | null;
  readonly legalEntityId: string | null;
  readonly name: string | null;
  readonly totals: ScopeTotals;
  readonly energy: EnergySplit;
}

/** VSME B3's intensity, on both Scope-2 bases because the report carries both. */
export interface IntensityAggregate {
  /** Σ turnover of the included entities, converted to EUR. */
  readonly turnoverEur: string | null;
  /** Scope 1 + Scope 2 LB, in tonnes. */
  readonly locationBasedTco2e: string | null;
  /** Scope 1 + Scope 2 MB, in tonnes. */
  readonly marketBasedTco2e: string | null;
  /** `locationBasedTco2e / turnoverEur`. */
  readonly locationBasedIntensity: string | null;
  /** `marketBasedTco2e / turnoverEur`. */
  readonly marketBasedIntensity: string | null;
  /** The year the FX rate was resolved for — the year the period ENDS (§9). */
  readonly fxYear: string;
}

/**
 * VAL-034's evidence: the grand total against the sum of each PARTITION.
 *
 * It is a real reconciliation and not a tautology. The grand total is summed
 * over the lines; the partitions are summed over the per-entity and per-facility
 * buckets, and a line lands in a bucket only if its legal entity is in the
 * aggregated set. A line whose entity fell out of the boundary between the run
 * and the read is therefore IN the total and in NO bucket, and the two figures
 * separate — which is exactly the accounting gap VAL-034 exists to catch.
 */
interface ReconciliationEntry {
  readonly key: keyof ScopeTotals;
  readonly total: string | null;
  readonly byLegalEntity: string | null;
  readonly byFacility: string | null;
  /** Both partitions agree with the total within {@link VAL_034_TOLERANCE}. */
  readonly balanced: boolean;
}

/** What {@link aggregateRun} returns. */
export interface CalcAggregates {
  /** `failed` when ANY line failed — every figure below is then `null`. */
  readonly status: "ok" | "failed";
  readonly totals: ScopeTotals;
  readonly energy: EnergySplit;
  readonly byLegalEntity: readonly EntityAggregate[];
  readonly byFacility: readonly FacilityAggregate[];
  readonly intensity: IntensityAggregate;
  readonly reconciliation: readonly ReconciliationEntry[];
  readonly warnings: readonly AggregateWarning[];
  /** The lines that stopped the aggregate — empty iff `status === 'ok'`. */
  readonly failedLines: readonly {
    readonly legalEntityId: string;
    readonly scope: string;
    readonly reportingBasis: string | null;
    readonly calculationStatus: CalculationStatus;
  }[];
}

// ─── The accumulator ─────────────────────────────────────────────────────────

/** Four running sums, one per figure of {@link ScopeTotals}. */
interface TotalsAccumulator {
  scope1Co2e: Decimal;
  scope1BiogenicCo2: Decimal;
  scope2LocationBasedCo2e: Decimal;
  scope2MarketBasedCo2e: Decimal;
}

/** Three running sums, one per figure of {@link EnergySplit}. */
interface EnergyAccumulator {
  totalMwh: Decimal;
  renewableMwh: Decimal;
  nonRenewableMwh: Decimal;
  /**
   * Set by an unconvertible row: NOTHING of this bucket is publishable. The
   * volume itself never reached MWh, so the total is as unknown as the split.
   */
  incomplete: boolean;
  /**
   * Set by a row with no `renewable_share`: the TOTAL still stands, the SPLIT
   * does not.
   *
   * Two flags rather than one because two different things are missing. An
   * unconvertible row withholds a quantity nobody can compute; an unstated share
   * withholds only the DIVISION of a quantity that was entered, read and
   * converted. Collapsing them would throw away a figure the preparer typed in —
   * which is the mirror of the mistake this flag exists to fix.
   */
  splitUnknown: boolean;
}

const emptyTotals = (): TotalsAccumulator => ({
  scope1Co2e: ZERO,
  scope1BiogenicCo2: ZERO,
  scope2LocationBasedCo2e: ZERO,
  scope2MarketBasedCo2e: ZERO,
});

const emptyEnergy = (): EnergyAccumulator => ({
  totalMwh: ZERO,
  renewableMwh: ZERO,
  nonRenewableMwh: ZERO,
  incomplete: false,
  splitUnknown: false,
});

/** Add one line to one bucket, on the figure its (scope, basis) names. */
function accumulate(into: TotalsAccumulator, line: AggregateLine): void {
  if (line.scope === "scope1") {
    // A biogenic line's fossil result is a GENUINE zero (VAL-017) and adding it
    // is a no-op; its biogenic kilograms go on their own figure. Both columns
    // are read, so neither carbon can hide in the other.
    if (line.co2eResult !== null) {
      into.scope1Co2e = add(into.scope1Co2e, parseDecimal(line.co2eResult));
    }
    if (line.biogenicCo2Result !== null) {
      into.scope1BiogenicCo2 = add(
        into.scope1BiogenicCo2,
        parseDecimal(line.biogenicCo2Result),
      );
    }
    return;
  }
  if (line.co2eResult === null) return;
  const value = parseDecimal(line.co2eResult);
  if (line.reportingBasis === "market_based") {
    into.scope2MarketBasedCo2e = add(into.scope2MarketBasedCo2e, value);
  } else {
    // К-20: `location_based` is the only other value the CHECK admits, and a
    // Scope-2 line always carries one.
    into.scope2LocationBasedCo2e = add(into.scope2LocationBasedCo2e, value);
  }
}

/** A finished accumulator as published figures — all `null` on a failed run. */
function publishTotals(acc: TotalsAccumulator, failed: boolean): ScopeTotals {
  const at = (value: Decimal) =>
    failed ? null : formatDecimal(value, ROUNDING_DECIMALS);
  return {
    scope1Co2e: at(acc.scope1Co2e),
    scope1BiogenicCo2: at(acc.scope1BiogenicCo2),
    scope2LocationBasedCo2e: at(acc.scope2LocationBasedCo2e),
    scope2MarketBasedCo2e: at(acc.scope2MarketBasedCo2e),
  };
}

/**
 * A finished energy accumulator as published figures.
 *
 * TWO DEGREES OF WITHHOLDING, because two different things can be missing (see
 * {@link EnergyAccumulator}). An unconvertible row takes the whole bucket down;
 * an energy row with no `renewable_share` takes only the split, and the total —
 * a figure somebody entered and CALC-3 converted — is still published beside a
 * `renewable_share_missing` warning that says why the two halves are absent.
 */
function publishEnergy(acc: EnergyAccumulator, failed: boolean): EnergySplit {
  if (failed || acc.incomplete) {
    return { totalMwh: null, renewableMwh: null, nonRenewableMwh: null };
  }
  const half = (value: Decimal) =>
    acc.splitUnknown ? null : formatDecimal(value, ENERGY_DECIMALS);
  return {
    totalMwh: formatDecimal(acc.totalMwh, ENERGY_DECIMALS),
    renewableMwh: half(acc.renewableMwh),
    nonRenewableMwh: half(acc.nonRenewableMwh),
  };
}

/** `|a − b| ≤ tolerance × |scale|`, the shared VAL-034/VAL-024 comparison. */
function withinTolerance(a: Decimal, b: Decimal, scale: Decimal): boolean {
  const absolute = (value: Decimal): Decimal =>
    value.units < BigInt(0) ? { ...value, units: -value.units } : value;
  return (
    compare(
      absolute(subtract(a, b)),
      absolute(multiply(scale, parseDecimal(String(VAL_034_TOLERANCE)))),
    ) <= 0
  );
}

// ─── The aggregation ─────────────────────────────────────────────────────────

/**
 * CALC-8, end to end. Pure: the same inputs give the same figures for ever.
 *
 * @param input the run's lines, the energy volumes, the boundary's entities and
 *              facilities, and the FX map resolved for the year the period ends
 */
export function aggregateRun(input: AggregateInput): CalcAggregates {
  const warnings: AggregateWarning[] = [];
  const warn = (
    code: AggregateWarningCode,
    detail: Record<string, string | null>,
  ) => warnings.push({ code, detail });

  const failedLines = input.lines
    .filter((line) => line.calculationStatus !== "ok")
    .map((line) => ({
      legalEntityId: line.legalEntityId,
      scope: line.scope,
      reportingBasis: line.reportingBasis,
      calculationStatus: line.calculationStatus,
    }));
  const failed = failedLines.length > 0;

  // ── Emissions: the grand total and the two partitions ────────────────────
  const grand = emptyTotals();
  const byEntity = new Map<string, TotalsAccumulator>(
    input.entities.map((entity) => [entity.legalEntityId, emptyTotals()]),
  );
  const noSite = emptyTotals();
  const byFacility = new Map<string | null, TotalsAccumulator>([
    [null, noSite],
  ]);
  for (const facility of input.facilities) {
    byFacility.set(facility.facilityId, emptyTotals());
  }

  for (const line of input.lines) {
    accumulate(grand, line);
    const entity = byEntity.get(line.legalEntityId);
    if (entity) {
      accumulate(entity, line);
    } else {
      // The line is IN the total and in no bucket. Reported rather than
      // absorbed — this is precisely the hole VAL-034 reconciles for.
      warn("line_outside_boundary", {
        legal_entity_id: line.legalEntityId,
        scope: line.scope,
      });
    }
    // A facility the caller did not list (deleted from the registry, say) joins
    // the "no site" bucket, so the partition still sums to the grand total.
    accumulate(byFacility.get(line.facilityId) ?? noSite, line);
  }

  // ── Energy: MWh, split by `renewable_share` ──────────────────────────────
  const grandEnergy = emptyEnergy();
  const entityEnergy = new Map<string, EnergyAccumulator>(
    input.entities.map((entity) => [entity.legalEntityId, emptyEnergy()]),
  );
  const facilityEnergy = new Map<string | null, EnergyAccumulator>([
    [null, emptyEnergy()],
  ]);
  for (const facility of input.facilities) {
    facilityEnergy.set(facility.facilityId, emptyEnergy());
  }

  for (const row of input.energy) {
    const buckets = [
      grandEnergy,
      entityEnergy.get(row.legalEntityId),
      facilityEnergy.get(row.facilityId) ?? facilityEnergy.get(null),
    ].filter((bucket): bucket is EnergyAccumulator => bucket !== undefined);

    if (row.consumptionMwh === null) {
      // CALC-3 reached no MWh. The volume is NOT read as zero: every bucket it
      // would have joined stops publishing a split.
      warn("energy_unconvertible", {
        energy_row_id: row.energyRowId,
        energy_type: row.energyType,
      });
      for (const bucket of buckets) bucket.incomplete = true;
      continue;
    }

    const total = parseDecimal(row.consumptionMwh);
    if (row.renewableShare === null) {
      // An unstated share is NOT 0% renewable. Reading NULL as "fully fossil"
      // would put the whole volume on `nonRenewableMwh` — a number nobody
      // entered, indistinguishable from a measured one, and wrong in the
      // direction that flatters nothing and misleads everything: the report
      // would claim, of energy whose provenance is unknown, that it was
      // certainly not renewable. So the bucket stops publishing the SPLIT (the
      // same refusal the unconvertible branch above makes, one degree weaker),
      // while the volume still counts in the total, which is a figure the
      // preparer did enter. The warning names the row that has to be filled in.
      warn("renewable_share_missing", { energy_row_id: row.energyRowId });
      for (const bucket of buckets) {
        bucket.splitUnknown = true;
        bucket.totalMwh = add(bucket.totalMwh, total);
      }
      continue;
    }
    const renewable = multiply(
      multiply(total, parseDecimal(row.renewableShare)),
      PERCENT,
    );
    const nonRenewable = subtract(total, renewable);
    for (const bucket of buckets) {
      bucket.totalMwh = add(bucket.totalMwh, total);
      bucket.renewableMwh = add(bucket.renewableMwh, renewable);
      bucket.nonRenewableMwh = add(bucket.nonRenewableMwh, nonRenewable);
    }
  }

  // ── Intensity: tCO2e ÷ turnover, in EUR, at the FX of the END year ───────
  let turnover: Decimal | null = ZERO;
  for (const entity of input.entities) {
    if (entity.turnover === null) {
      warn("turnover_missing", { legal_entity_id: entity.legalEntityId });
      turnover = null;
      continue;
    }
    if (entity.currency === null) {
      warn("currency_missing", { legal_entity_id: entity.legalEntityId });
      turnover = null;
      continue;
    }
    const rate = input.fx.rates.get(entity.currency);
    if (rate === undefined) {
      // THE ACCEPTANCE CRITERION, in one branch: no rate is a WARNING and a
      // withheld figure. Never `?? 1`, which would report dinars as euros.
      warn("fx_rate_missing", {
        legal_entity_id: entity.legalEntityId,
        currency: entity.currency,
        year: input.fx.year,
      });
      turnover = null;
      continue;
    }
    if (turnover !== null) {
      turnover = add(
        turnover,
        multiply(parseDecimal(entity.turnover), parseDecimal(String(rate))),
      );
    }
  }

  const totals = publishTotals(grand, failed);
  const toTonnes = (kg: Decimal) =>
    divideHalfUp(kg, KG_PER_TONNE, TONNE_DECIMALS);
  const locationTonnes = toTonnes(
    add(grand.scope1Co2e, grand.scope2LocationBasedCo2e),
  );
  const marketTonnes = toTonnes(
    add(grand.scope1Co2e, grand.scope2MarketBasedCo2e),
  );
  // A zero denominator is not divided by: an intensity per nothing is not a
  // small number, it is no number.
  const divisible = turnover !== null && !isZero(turnover) && !failed;
  const intensity: IntensityAggregate = {
    turnoverEur:
      turnover === null || failed ? null : formatDecimal(turnover, 2),
    locationBasedTco2e: failed
      ? null
      : formatDecimal(locationTonnes, TONNE_DECIMALS),
    marketBasedTco2e: failed
      ? null
      : formatDecimal(marketTonnes, TONNE_DECIMALS),
    locationBasedIntensity:
      divisible && turnover !== null
        ? formatDecimal(
            divideHalfUp(locationTonnes, turnover, INTENSITY_DECIMALS),
            INTENSITY_DECIMALS,
          )
        : null,
    marketBasedIntensity:
      divisible && turnover !== null
        ? formatDecimal(
            divideHalfUp(marketTonnes, turnover, INTENSITY_DECIMALS),
            INTENSITY_DECIMALS,
          )
        : null,
    fxYear: input.fx.year,
  };

  // ── The two partitions, published ────────────────────────────────────────
  const entityAggregates: EntityAggregate[] = input.entities.map((entity) => ({
    legalEntityId: entity.legalEntityId,
    name: entity.name,
    totals: publishTotals(
      byEntity.get(entity.legalEntityId) ?? emptyTotals(),
      failed,
    ),
    energy: publishEnergy(
      entityEnergy.get(entity.legalEntityId) ?? emptyEnergy(),
      failed,
    ),
  }));

  const facilityById = new Map(
    input.facilities.map((facility) => [facility.facilityId, facility]),
  );
  const facilityAggregates: FacilityAggregate[] = [...byFacility.entries()].map(
    ([facilityId, acc]) => {
      const facility =
        facilityId === null ? undefined : facilityById.get(facilityId);
      return {
        facilityId,
        legalEntityId: facility?.legalEntityId ?? null,
        name: facility?.name ?? null,
        totals: publishTotals(acc, failed),
        energy: publishEnergy(
          facilityEnergy.get(facilityId) ?? emptyEnergy(),
          failed,
        ),
      };
    },
  );

  // ── VAL-034's evidence ───────────────────────────────────────────────────
  const keys: (keyof ScopeTotals)[] = [
    "scope1Co2e",
    "scope1BiogenicCo2",
    "scope2LocationBasedCo2e",
    "scope2MarketBasedCo2e",
  ];
  const accKey: Record<keyof ScopeTotals, keyof TotalsAccumulator> = {
    scope1Co2e: "scope1Co2e",
    scope1BiogenicCo2: "scope1BiogenicCo2",
    scope2LocationBasedCo2e: "scope2LocationBasedCo2e",
    scope2MarketBasedCo2e: "scope2MarketBasedCo2e",
  };
  const reconciliation: ReconciliationEntry[] = keys.map((key) => {
    const field = accKey[key];
    const total = grand[field];
    const entitySum = [...byEntity.values()].reduce<Decimal>(
      (sum, acc) => add(sum, acc[field]),
      ZERO,
    );
    const facilitySum = [...byFacility.values()].reduce<Decimal>(
      (sum, acc) => add(sum, acc[field]),
      ZERO,
    );
    return {
      key,
      total: failed ? null : formatDecimal(total, ROUNDING_DECIMALS),
      byLegalEntity: failed
        ? null
        : formatDecimal(entitySum, ROUNDING_DECIMALS),
      byFacility: failed ? null : formatDecimal(facilitySum, ROUNDING_DECIMALS),
      balanced:
        withinTolerance(entitySum, total, total) &&
        withinTolerance(facilitySum, total, total),
    };
  });

  return {
    status: failed ? "failed" : "ok",
    totals,
    energy: publishEnergy(grandEnergy, failed),
    byLegalEntity: entityAggregates,
    byFacility: facilityAggregates,
    intensity,
    reconciliation,
    warnings,
    failedLines,
  };
}
