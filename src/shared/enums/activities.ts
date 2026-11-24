// Activity-data domain lists — Scope 1 `emission_activity` and the units /
// method vocabulary shared with `purchased_energy_activity` (§4.9, §4.10).
// Not DB tables, not CHECK constraints (F6, §0.8); values are wire literals.
// CONTRACT: CALC-2 resolves on `(activity_type, geography, input_unit, year)`,
// so a literal here that is not also an `emission_factor` key in the pinned set
// can never price a row. The legacy seed was normalised onto these literals by
// three rules (split the unit out, keep bundled dimensions, fold units only
// where no key collides); `enums-vs-seed.test.ts` enforces reachability.
//
// See docs/decisions/activity-enums-factor-contract.md for the full account.

import { enumGuard } from "./guard";

/**
 * `emission_activity.activity_type` when `activity_category =
 * 'stationary_combustion'` or `'onsite_generation'` (К-6).
 *
 * See docs/decisions/shared-enums-activities-L14.md for the full account.
 */
export const FUEL_TYPES = [
  "natural_gas",
  "gas_oil",
  "diesel_biofuel",
  "diesel_mineral",
  "petrol_biofuel",
  "petrol_mineral",
  "lpg",
  "coal_industrial",
  "coal_domestic",
  // `lignite` and `coke` are priced ONLY by `si-2025-r2` (0015): the ESG
  // expert's workbook carries ARSO 2025 and IPCC 2006 rows for both, and
  // 0009 could not load them because no form produced the literal. Neither
  // is a `coal_*` — filing brown coal (1816 kg CO2/t) under `coal_domestic`
  // would price household anthracite at lignite's carbon.
  "lignite",
  "coke",
  "fuel_oil",
  "burning_oil",
  "butane",
  "propane",
  "wood_pellets",
  "wood_chips",
  "wood_logs",
  "wood_logs_biogenic",
] as const;
export type FuelType = (typeof FUEL_TYPES)[number];
export const isFuelType = enumGuard(FUEL_TYPES);

/**
 * `emission_activity.activity_type` when `activity_category =
 * 'mobile_combustion'` (К-6).
 *
 * OPEN LIST, and the clearest case of rule 2: the legacy key
 * `car_petrol_small` bundles VEHICLE + FUEL + SIZE, and an `emission_activity`
 * row has a column for none of the three — only `activity_type`. So the value
 * IS the legacy key. The DD gloss ("Owned/controlled cars, vans, HGV, ships,
 * machinery and other mobile sources") is what a `car`/`van`/`hgv` list would
 * have been; it is not resolvable, so it is not the list.
 *
 * The values are the 35 `VEHICLES` keys plus `car_bev_kwh_per_km`, in seed
 * order. All resolve on `input_unit = 'km'`: the legacy `unit` on these rows
 * (`kgCO2e/km`) is the factor's RATIO, whose denominator is the input unit and
 * whose numerator is `output_unit`.
 *
 * `car_bev_kwh_per_km` is the odd one and T1.5 must handle it explicitly. It is
 * an energy-INTENSITY row (`kWh/km`), so it converts fleet-EV km into Scope 2
 * charging rather than into CO₂e: its `output_unit` is `kWh`, NOT MIG-4's
 * blanket `'kgCO2e'`. It also cannot be folded into `car_bev_avg` — that key
 * already occupies `(car_bev_avg, GLOBAL, km, 2024)` with a kgCO2e/km factor,
 * and the seed keeps the two apart on purpose.
 *
 * `ship` and `machinery` from the DD gloss are NOT here: the seed prices no
 * factor for either, so both would be guaranteed `failed_missing_factor`. They
 * arrive with their factor rows, per §0.8.
 */
export const VEHICLE_TYPES = [
  "car_petrol_small",
  "car_petrol_medium",
  "car_petrol_large",
  "car_petrol_avg",
  "car_diesel_small",
  "car_diesel_medium",
  "car_diesel_large",
  "car_diesel_avg",
  "car_hybrid_small",
  "car_hybrid_medium",
  "car_hybrid_large",
  "car_hybrid_avg",
  "car_bev_small",
  "car_bev_medium",
  "car_bev_large",
  "car_bev_avg",
  "car_cng_avg",
  "car_lpg_avg",
  "motorbike_small",
  "motorbike_medium",
  "motorbike_large",
  "motorbike_avg",
  "van_diesel_class1",
  "van_diesel_class2",
  "van_diesel_class3",
  "van_diesel_avg",
  "van_petrol_avg",
  "hgv_rigid_small",
  "hgv_rigid_medium",
  "hgv_rigid_large",
  "hgv_rigid_avg",
  "hgv_artic_small",
  "hgv_artic_large",
  "hgv_artic_avg",
  "hgv_avg",
  "car_bev_kwh_per_km",
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const isVehicleType = enumGuard(VEHICLE_TYPES);

/**
 * `emission_activity.activity_type` when `activity_category =
 * 'fugitive_emissions'` (К-6).
 *
 * OPEN LIST. The DD gloss for this section names applications ("air
 * conditioning, refrigeration, heat pumps, fire suppression"), not gases, so
 * the values are the refrigerant keys the platform already prices — the
 * `REFRIGERANTS` seed array (`server/db/seed.ts`, moving to `seed-data/` in
 * T1.3), in its order, verbatim. This is the one list that needed no
 * normalisation: the legacy keys are already clean, and all 14 resolve on
 * `input_unit = 'kg'`. Keeping the two in step matters: an `activity_type` with
 * no matching factor is a calculation failure, never a silent zero (§0.7).
 */
// T1.3: assert set-equality against the exported REFRIGERANTS keys
export const REFRIGERANT_TYPES = [
  "r134a",
  "r410a",
  "r407c",
  "r32",
  "r404a",
  "r507a",
  "r449a",
  "r448a",
  "r290",
  "r600a",
  "r744",
  "r717",
  "r22",
  "sf6",
  // HFC-125 (R-125), AR5 GWP-100 3170 — priced only by `si-2025-r2` (0015).
  "r125",
] as const;
export type RefrigerantType = (typeof REFRIGERANT_TYPES)[number];
export const isRefrigerantType = enumGuard(REFRIGERANT_TYPES);

/**
 * `emission_activity.activity_type` when `activity_category =
 * 'process_emissions'` (К-6).
 *
 * OPEN LIST. Neither the spec nor the workbook enumerates it; the DD gloss is
 * "Emissions from industrial or chemical processes", so the list starts as that
 * split plus an escape hatch. Deliberately narrow — process factors are not in
 * the Phase-1 factor set, so a longer invented list would be fiction.
 *
 * NO FACTOR YET — the honest exception to the reachability rule above: none of
 * these three resolves against the legacy seed, because it prices no process
 * emissions at all. Every process row therefore fails CALC-2 until T1.5 (or a
 * later factor set) seeds them. The alternative was an empty list, which would
 * leave `activity_category='process_emissions'` with no vocabulary at all and
 * hide the gap instead of naming it. Either those factors get seeded or this
 * list goes.
 */
export const PROCESS_TYPES = [
  "industrial_process",
  "chemical_process",
  "other",
] as const;
export type ProcessType = (typeof PROCESS_TYPES)[number];
export const isProcessType = enumGuard(PROCESS_TYPES);

/**
 * The lifecycle mixin's `unit` column on activity rows (§4.8, §4.9) and, via
 * the contract above, `emission_factor.input_unit`. Canonical CODES, not display
 * strings: the legacy seed's units were normalised onto these (`tonne`→`t`,
 * `m³`→`m3`, `kWh (Gross CV)`→`kWh_gross`); gross/net kWh stay split because
 * both belong to `natural_gas` and one code would put two factors on one key.
 *
 * See docs/decisions/unit-codes-legacy-map.md for the full account.
 */
export const UNIT_CODES = [
  // Energy
  "kWh",
  "MWh",
  "GJ",
  "kWh_gross",
  "kWh_net",
  // Mass
  "kg",
  "t",
  // Volume
  "L",
  "m3",
  // Distance and transport work
  "km",
  "tkm",
  "pkm",
  // Spend
  "EUR_1000",
  // Count, occupancy, area-time — Scope-3 factor set only, identity conversions
  "unit",
  "parcel",
  "room_night",
  "day",
  "m2_year",
] as const;
export type UnitCode = (typeof UNIT_CODES)[number];
export const isUnitCode = enumGuard(UNIT_CODES);

/**
 * The mixin `unit` on `purchased_energy_activity` — spec §4.10 states it
 * exactly: kWh / MWh / GJ. A strict subset of {@link UNIT_CODES}, and the
 * `satisfies` below is what keeps it one (a typo here fails `tsc`, not review).
 *
 * Deliberately does NOT include `kWh_gross`/`kWh_net`: the calorific basis is a
 * property of a combusted FUEL (Scope 1), not of purchased electricity, heat,
 * steam or cooling.
 */
export const ENERGY_UNITS = [
  "kWh",
  "MWh",
  "GJ",
] as const satisfies readonly UnitCode[];
export type EnergyUnit = (typeof ENERGY_UNITS)[number];
export const isEnergyUnit = enumGuard(ENERGY_UNITS);

/**
 * `emission_activity.method` and `calculation.method_code` (spec §4.9, §4.19).
 *
 * CLOSED LIST — the workbook's 9 CalculationMethod values (ENUM-054…062), in
 * the sheet's sort order, as snake_case wire literals.
 */
export const CALCULATION_METHODS = [
  "supplier_specific",
  "activity_based",
  "fuel_based",
  "distance_based",
  "average_data",
  "hybrid",
  "spend_based",
  "engineering_estimate",
  "mass_balance",
] as const;
export type CalculationMethod = (typeof CALCULATION_METHODS)[number];
export const isCalculationMethod = enumGuard(CALCULATION_METHODS);
