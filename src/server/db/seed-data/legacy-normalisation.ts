/**
 * THE NORMALISATION CONTRACT, EXECUTABLE — legacy factor tuples → Phase-1
 * `(activity_type, geography, input_unit, applicable_year)`.
 *
 * See docs/decisions/server-db-seed-data-legacy-normalisation.md for the full account.
 */

import type { UnitCode } from "@/shared/enums";

import {
  FLIGHTS,
  GRID,
  HEAT,
  REFRIGERANTS,
  SCOPE3,
  STATIONARY,
  VEHICLE_ENERGY,
  VEHICLES,
} from "./legacy-factors";

/** `emission_factor.geography` for a factor with no country (schema §DM-22).
 *  Not exported: it reaches callers on every row's `geography`. */
const GLOBAL_GEOGRAPHY = "GLOBAL";

/**
 * Rule 3 — the full legacy `unit` → {@link UnitCode} map, one entry per
 * DISTINCT string that occurs anywhere in the legacy set (23 of them: 18 carried
 * in the arrays, 5 that the legacy seed hard-coded per category, see
 * {@link LEGACY_CATEGORY_UNITS}).
 *
 * Non-injective ON PURPOSE where collapsing cannot collide on the CALC-2 key,
 * injective where it would:
 *   - `kWh` ← `kWh` / `kWh cooling` / `kWh (lifetime)` / `kgCO2e/kWh`
 *   - `L`   ← `litre` / `litre (lifetime)`
 *   - `m3`  ← `m³` / `m3`
 *   - `km`  ← `km` / `kgCO2e/km` / `kWh/km`
 *   - `kWh_gross` vs `kWh_net` STAY APART — both belong to activity_type
 *     `natural_gas` after rule 1, so one `kWh` code puts two factors on one key.
 *
 * The ratio units (`kgCO2e/km`, `kgCO2e/pkm`, `kgCO2e/kWh`, `kWh/km`) map to
 * their DENOMINATOR: that is the unit the activity row is entered in. The
 * numerator is `emission_factor.output_unit` ({@link outputUnitFor}).
 *
 * `enums-vs-seed.test.ts` asserts both directions — no legacy string missing
 * from this table, no entry here that the data no longer contains.
 */
export const LEGACY_UNIT_TO_CODE = {
  // Energy
  "kWh (Gross CV)": "kWh_gross",
  "kWh (Net CV)": "kWh_net",
  kWh: "kWh",
  "kWh cooling": "kWh",
  "kWh (lifetime)": "kWh",
  "kgCO2e/kWh": "kWh",
  // Mass
  kg: "kg",
  tonne: "t",
  // Volume
  litre: "L",
  "litre (lifetime)": "L",
  "m³": "m3",
  m3: "m3",
  // Distance and transport work
  km: "km",
  "kgCO2e/km": "km",
  "kWh/km": "km",
  "tonne-km": "tkm",
  "kgCO2e/pkm": "pkm",
  // Spend, count, occupancy, area-time
  "EUR 1000 spent": "EUR_1000",
  unit: "unit",
  parcel: "parcel",
  "room-night": "room_night",
  day: "day",
  "m2/year": "m2_year",
} as const satisfies Record<string, UnitCode>;

/** A legacy `unit` string that {@link LEGACY_UNIT_TO_CODE} knows. */
export type LegacyUnit = keyof typeof LEGACY_UNIT_TO_CODE;

/**
 * The legacy `unit` strings that are not carried on the tuple: the legacy seed
 * wrote them as a per-category literal. They are part of the legacy vocabulary
 * all the same, so the unit-coverage test has to see them.
 */
export const LEGACY_CATEGORY_UNITS = {
  vehicle: "kgCO2e/km",
  vehicle_energy: "kWh/km",
  flight: "kgCO2e/pkm",
  refrigerant: "kg",
  grid: "kgCO2e/kWh",
} as const satisfies Record<string, LegacyUnit>;

/** Rule 3 applied. Throws on an unmapped string — silence here is a factor that
 *  resolves against nothing at runtime (§0.7). */
export function unitCodeFor(legacyUnit: string): UnitCode {
  const code = (LEGACY_UNIT_TO_CODE as Record<string, UnitCode | undefined>)[
    legacyUnit
  ];
  if (code === undefined) {
    throw new Error(
      `legacy unit ${JSON.stringify(legacyUnit)} has no UnitCode — add it to ` +
        `LEGACY_UNIT_TO_CODE and to the table in shared/enums/activities.ts`,
    );
  }
  return code;
}

/**
 * Rule 1 — the unit suffixes a `STATIONARY` `factor_key` bundles, longest
 * first, with the code each one implies (`null` = carries no unit).
 *
 * `_co2` is the odd entry and is NOT a unit: it is the tail of the one row that
 * prices the BIOGENIC CO₂ of burning logs (`wood_logs_biogenic_co2`). Rule 2
 * keeps that distinction in the VALUE (`wood_logs_biogenic`, which shares unit
 * `t` with `wood_logs` and has no `biogenic_treatment` component in the resolve
 * key), so only the redundant `_co2` tail comes off.
 */
const FUEL_KEY_SUFFIXES: ReadonlyArray<readonly [string, UnitCode | null]> = [
  ["_kwh_gross", "kWh_gross"],
  ["_kwh_net", "kWh_net"],
  ["_kwh", null], // `lpg_kwh` — the tuple's unit says which kWh basis it is
  ["_litre", "L"],
  ["_tonne", "t"],
  ["_m3", "m3"],
  ["_co2", null],
];

/**
 * Rule 1 applied to a `STATIONARY` row: `natural_gas_kwh_gross` +
 * `"kWh (Gross CV)"` → `{ activityType: "natural_gas", inputUnit: "kWh_gross" }`.
 *
 * The INPUT UNIT COMES FROM THE TUPLE, never from the suffix — the tuple is the
 * measured fact and the suffix is a naming habit. Where the suffix does imply a
 * code, the two must AGREE: a `*_tonne` key priced in litres is a data error
 * that would otherwise be normalised into a plausible-looking wrong factor.
 */
export function decomposeFuelKey(
  legacyKey: string,
  legacyUnit: string,
): { activityType: string; inputUnit: UnitCode } {
  const inputUnit = unitCodeFor(legacyUnit);
  for (const [suffix, impliedCode] of FUEL_KEY_SUFFIXES) {
    if (!legacyKey.endsWith(suffix)) continue;
    if (impliedCode !== null && impliedCode !== inputUnit) {
      throw new Error(
        `legacy fuel key ${legacyKey} implies input_unit ${impliedCode} but is ` +
          `priced in ${JSON.stringify(legacyUnit)} (${inputUnit})`,
      );
    }
    return { activityType: legacyKey.slice(0, -suffix.length), inputUnit };
  }
  // No unit bundled in the key — rule 1 has nothing to split off.
  return { activityType: legacyKey, inputUnit };
}

/** The legacy `emission_factors.category` values, unchanged. Reachable as
 *  `NormalisedFactorRow["legacyCategory"]`, so it is not exported separately. */
type LegacyCategory =
  | "stationary_fuel"
  | "vehicle"
  | "flight"
  | "refrigerant"
  | "grid"
  | "heat"
  | "scope3";

/**
 * Categories with NO Phase-1 enum keep MIG-4's `<category>:` prefix on
 * `activity_type` (see the tail of the `activities.ts` header). `grid` collapses
 * to one activity_type — the country lives in `geography`, per-country rows
 * would otherwise all be `grid:<code>` and unresolvable by geography.
 *
 * RESOLVED BY T1.5 — the spend half of `scope3` uses `scope3_spend:` instead
 * (see {@link SPEND_LEGACY_UNIT}). The pointer comment that used to sit here
 * said T3.6 would have to rename; it does not, because the rename happened at
 * the moment the factors were first seeded, in this one place.
 */
const PREFIXED_CATEGORIES = {
  flight: "flight",
  heat: "heat",
  scope3: "scope3",
  /**
   * О-8 / plan T1.5: the spend-based Scope-3 factors are seeded as
   * `scope3_spend:<commodity_key>`, NOT `scope3:<commodity_key>`.
   *
   * WHY A SECOND PREFIX INSIDE ONE LEGACY CATEGORY. `scope3_spend` is a
   * different METHOD, not a different commodity: `calc_method='spend_based'`
   * prices €1000 of purchase, while every other `scope3` row prices a physical
   * activity. CALC-2 resolves on `(activity_type, geography, input_unit,
   * applicable_year)` and nothing else — so the method has to be visible in
   * `activity_type` or it is not visible to the resolver at all.
   *
   * `<commodity_key>` is the legacy `factor_key` VERBATIM (`s3_c1_electronics`),
   * because that is exactly what the live `scope3_spend.commodity_key` column
   * already stores (it is documented in `schema.ts` as "→
   * emission_factors.factor_key"). T3.6's narrow `recalculateScope3Spend` can
   * therefore build the resolve key by concatenation, with no second mapping
   * table to drift.
   */
  scope3_spend: "scope3_spend",
} as const;

/**
 * The legacy `unit` string that marks a `scope3` row as SPEND-based — the one
 * discriminator the legacy arrays carry for it (there is no method column).
 * Eight `SCOPE3` commodities are priced this way, in categories 1 and 2.
 */
const SPEND_LEGACY_UNIT = "EUR 1000 spent";

/** One normalised factor row — the CALC-2 resolve key plus its value. */
export type NormalisedFactorRow = {
  /** Legacy provenance, kept so a mismatch is traceable back to the tuple. */
  legacyCategory: LegacyCategory;
  legacyKey: string;
  legacyUnit: LegacyUnit;
  /** CALC-2 resolve key. */
  activityType: string;
  geography: string;
  inputUnit: UnitCode;
  applicableYear: number | null;
  /** `emission_factor.factor_value`, verbatim NUMERIC-as-string. */
  value: string;
  /** `kgCO2e` everywhere except the BEV energy-intensity row (`kWh`). */
  outputUnit: "kgCO2e" | "kWh";
  /** `SOURCES[].code` of the row's source. */
  sourceCode: string;
};

/**
 * THE WHOLE LEGACY SET, NORMALISED — 440 rows, the same 440 the legacy seed used
 * to write into `emission_factors` before T3.9 dropped that table (its
 * `s3_c7_rail` insert-if-missing block re-inserted rows already present in
 * `SCOPE3`, so it added none).
 *
 * Row order follows the legacy insert order, array by array. Uniqueness of
 * `(activityType, geography, inputUnit, applicableYear)`
 * across the result is asserted by `enums-vs-seed.test.ts`, not here: a throw
 * would only move a seed-time VAL-031 failure earlier, while the test names it.
 */
export function normaliseLegacyFactors(): NormalisedFactorRow[] {
  const rows: NormalisedFactorRow[] = [];

  for (const [legacyKey, , legacyUnit, years] of STATIONARY) {
    const { activityType, inputUnit } = decomposeFuelKey(legacyKey, legacyUnit);
    for (const [year, value] of years) {
      rows.push({
        legacyCategory: "stationary_fuel",
        legacyKey,
        legacyUnit: legacyUnit as LegacyUnit,
        activityType,
        geography: GLOBAL_GEOGRAPHY,
        inputUnit,
        applicableYear: Number(year),
        value,
        outputUnit: "kgCO2e",
        sourceCode: "DEFRA",
      });
    }
  }

  // Rule 2 at its purest: the key IS the activity_type — vehicle, fuel and size
  // have no column of their own on `emission_activity`.
  for (const [legacyKey, , , , years] of VEHICLES) {
    for (const [year, value] of years) {
      rows.push({
        legacyCategory: "vehicle",
        legacyKey,
        legacyUnit: LEGACY_CATEGORY_UNITS.vehicle,
        activityType: legacyKey,
        geography: GLOBAL_GEOGRAPHY,
        inputUnit: unitCodeFor(LEGACY_CATEGORY_UNITS.vehicle),
        applicableYear: Number(year),
        value,
        outputUnit: "kgCO2e",
        sourceCode: "DEFRA",
      });
    }
  }

  // The one `output_unit = 'kWh'` row: km of fleet-EV driving → Scope-2 charging,
  // NOT kgCO2e. It cannot fold into `car_bev_avg`, which already holds
  // `(car_bev_avg, GLOBAL, km, year)` with a kgCO2e/km factor.
  for (const [legacyKey, , , years] of VEHICLE_ENERGY) {
    for (const [year, value] of years) {
      rows.push({
        legacyCategory: "vehicle",
        legacyKey,
        legacyUnit: LEGACY_CATEGORY_UNITS.vehicle_energy,
        activityType: legacyKey,
        geography: GLOBAL_GEOGRAPHY,
        inputUnit: unitCodeFor(LEGACY_CATEGORY_UNITS.vehicle_energy),
        applicableYear: Number(year),
        value,
        outputUnit: "kWh",
        sourceCode: "DEFRA",
      });
    }
  }

  for (const [legacyKey, , , years] of FLIGHTS) {
    for (const [year, withRf] of years) {
      rows.push({
        legacyCategory: "flight",
        legacyKey,
        legacyUnit: LEGACY_CATEGORY_UNITS.flight,
        activityType: `${PREFIXED_CATEGORIES.flight}:${legacyKey}`,
        geography: GLOBAL_GEOGRAPHY,
        inputUnit: unitCodeFor(LEGACY_CATEGORY_UNITS.flight),
        applicableYear: Number(year),
        value: withRf,
        outputUnit: "kgCO2e",
        sourceCode: "DEFRA",
      });
    }
  }

  // Year-agnostic (keyed by GWP version — the seed is AR5-only).
  for (const [legacyKey, , , kgCo2ePerKg] of REFRIGERANTS) {
    rows.push({
      legacyCategory: "refrigerant",
      legacyKey,
      legacyUnit: LEGACY_CATEGORY_UNITS.refrigerant,
      activityType: legacyKey,
      geography: GLOBAL_GEOGRAPHY,
      inputUnit: unitCodeFor(LEGACY_CATEGORY_UNITS.refrigerant),
      applicableYear: null,
      value: kgCo2ePerKg,
      outputUnit: "kgCO2e",
      sourceCode: "DEFRA",
    });
  }

  for (const [countryCode, , years] of GRID) {
    for (const [year, locationKwh] of years) {
      rows.push({
        legacyCategory: "grid",
        legacyKey: "grid_electricity",
        legacyUnit: LEGACY_CATEGORY_UNITS.grid,
        activityType: "grid:grid_electricity",
        geography: countryCode,
        inputUnit: unitCodeFor(LEGACY_CATEGORY_UNITS.grid),
        applicableYear: Number(year),
        value: locationKwh,
        outputUnit: "kgCO2e",
        sourceCode: "AIB",
      });
    }
  }

  for (const [
    legacyKey,
    ,
    ,
    legacyUnit,
    countryCode,
    ,
    sourceCode,
    years,
  ] of HEAT) {
    for (const [year, value] of years) {
      rows.push({
        legacyCategory: "heat",
        legacyKey,
        legacyUnit: legacyUnit as LegacyUnit,
        activityType: `${PREFIXED_CATEGORIES.heat}:${legacyKey}`,
        geography: countryCode ?? GLOBAL_GEOGRAPHY,
        inputUnit: unitCodeFor(legacyUnit),
        applicableYear: Number(year),
        value,
        outputUnit: "kgCO2e",
        sourceCode,
      });
    }
  }

  for (const [legacyKey, , , , legacyUnit, , sourceCode, years] of SCOPE3) {
    // О-8: spend-based rows take the `scope3_spend:` prefix, everything else in
    // the category keeps `scope3:`. The unit IS the discriminator.
    const prefix =
      legacyUnit === SPEND_LEGACY_UNIT
        ? PREFIXED_CATEGORIES.scope3_spend
        : PREFIXED_CATEGORIES.scope3;
    for (const [year, value] of years) {
      rows.push({
        legacyCategory: "scope3",
        legacyKey,
        legacyUnit: legacyUnit as LegacyUnit,
        activityType: `${prefix}:${legacyKey}`,
        geography: GLOBAL_GEOGRAPHY,
        inputUnit: unitCodeFor(legacyUnit),
        applicableYear: Number(year),
        value,
        outputUnit: "kgCO2e",
        sourceCode,
      });
    }
  }

  return rows;
}

/** The CALC-2 resolve key of a row, as one comparable string. */
export function resolveKey(row: NormalisedFactorRow): string {
  return [
    row.activityType,
    row.geography,
    row.inputUnit,
    row.applicableYear ?? "any",
  ].join("|");
}
