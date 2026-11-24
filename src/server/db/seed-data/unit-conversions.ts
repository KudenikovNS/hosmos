/**
 * `unit_conversion` — the Phase-1 conversion table (T1.5, MIG-5, DM-23/D7).
 *
 * See docs/decisions/server-db-seed-data-unit-conversions.md for the full account.
 */

import { derivedId } from "./derived-id";

/** One `unit_conversion` row (DM-23), column names verbatim. */
export type UnitConversionSeed = {
  /** UUIDv5 of `(from_unit, to_unit, activity_context)` — see `./derived-id.ts`. */
  id: string;
  from_unit: string;
  to_unit: string;
  /** NUMERIC-as-string: `to = from × multiplier`. */
  multiplier: string;
  /** NULL = universal physical conversion; non-null = contextual (calorific). */
  activity_context: string | null;
  source: string;
  notes: string;
};

const SI = "SI definition";
const CONVENTION = "Hosmos modelling convention";
const DERIVED = "derived from factor set legacy-v1";

/**
 * Energy, mass and volume conversions that hold for every activity.
 *
 * THE ONE NON-PHYSICAL ENTRY is `kWh ↔ kWh_gross` at ×1. A metered or billed
 * kWh carries no calorific basis, and the UK/DEFRA convention behind these
 * factors is that billed energy is Gross CV — which is also why the legacy set
 * prices `lpg_kwh` in "kWh (Gross CV)" with no plain-kWh sibling. Without it a
 * user entering gas in plain `kWh` (what the invoice says) has no route to any
 * gas factor at all. The Gross→Net step, by contrast, is fuel-specific and
 * therefore contextual, never universal.
 */
const UNIVERSAL: ReadonlyArray<
  readonly [from: string, to: string, multiplier: string, notes: string]
> = [
  // Energy — exact
  ["kWh", "MWh", "0.001", "1 MWh = 1000 kWh"],
  ["MWh", "kWh", "1000", "1 MWh = 1000 kWh"],
  ["kWh", "GJ", "0.0036", "1 kWh = 3.6 MJ"],
  ["GJ", "kWh", "277.777777777778", "1 GJ = 1000/3.6 kWh"],
  ["MWh", "GJ", "3.6", "1 MWh = 3.6 GJ"],
  ["GJ", "MWh", "0.277777777777778", "1 GJ = 1/3.6 MWh"],
  // Energy → the Gross CV basis the Scope-1 fuel factors are priced in
  ["kWh", "kWh_gross", "1", "a billed kWh is Gross CV (DEFRA convention)"],
  ["kWh_gross", "kWh", "1", "a billed kWh is Gross CV (DEFRA convention)"],
  ["MWh", "kWh_gross", "1000", "1 MWh = 1000 kWh, Gross CV basis"],
  ["kWh_gross", "MWh", "0.001", "1 MWh = 1000 kWh, Gross CV basis"],
  [
    "GJ",
    "kWh_gross",
    "277.777777777778",
    "1 GJ = 1000/3.6 kWh, Gross CV basis",
  ],
  ["kWh_gross", "GJ", "0.0036", "1 kWh = 3.6 MJ, Gross CV basis"],
  // Mass — exact
  ["kg", "t", "0.001", "1 t = 1000 kg"],
  ["t", "kg", "1000", "1 t = 1000 kg"],
  // Volume — exact
  ["L", "m3", "0.001", "1 m³ = 1000 L"],
  ["m3", "L", "1000", "1 m³ = 1000 L"],
];

/**
 * Contextual conversions, keyed by `activity_type` (CALC-3 tries these before
 * the universal table). Every multiplier is the ratio of two factors of
 * `legacy-v1` for the same fuel — see the header.
 *
 * `natural_gas` is the fuel that needs all of them: it is priced in three units
 * (`kWh_gross`, `kWh_net`, `m3`) and Net CV appears nowhere else in the set, so
 * a gas row entered in kWh, MWh, GJ or m³ has to reach the Net CV basis too.
 */
const CONTEXTUAL: ReadonlyArray<
  readonly [
    context: string,
    from: string,
    to: string,
    multiplier: string,
    notes: string,
  ]
> = [
  // Natural gas — calorific value of a cubic metre (Gross 11.034 kWh/m³).
  // Every reversed row carries 12 significant digits of the reciprocal, not a
  // rounded one: the suite asserts `m × m⁻¹ = 1` to 1e-6, because a lossy
  // round-trip would quietly change a number as it passed through two units.
  ["natural_gas", "m3", "kWh_gross", "11.0342", "gross CV 11.034 kWh/m³"],
  ["natural_gas", "m3", "kWh", "11.0342", "gross CV 11.034 kWh/m³"],
  ["natural_gas", "m3", "kWh_net", "9.9594", "net CV 9.959 kWh/m³"],
  ["natural_gas", "kWh_gross", "m3", "0.0906273223251", "1 / 11.0342"],
  ["natural_gas", "kWh", "m3", "0.0906273223251", "1 / 11.0342"],
  ["natural_gas", "kWh_net", "m3", "0.100407655080", "1 / 9.9594"],
  // Natural gas — Gross CV ↔ Net CV (DEFRA's 0.9 rule, here the set's own ratio)
  ["natural_gas", "kWh_gross", "kWh_net", "0.90259", "net = gross × 0.9026"],
  ["natural_gas", "kWh_net", "kWh_gross", "1.10792275563", "1 / 0.90259"],
  ["natural_gas", "kWh", "kWh_net", "0.90259", "billed kWh is gross; × 0.9026"],
  ["natural_gas", "kWh_net", "kWh", "1.10792275563", "1 / 0.90259"],
  ["natural_gas", "MWh", "kWh_net", "902.59", "1000 × 0.90259"],
  ["natural_gas", "kWh_net", "MWh", "0.00110792275563", "1 / 902.59"],
  ["natural_gas", "GJ", "kWh_net", "250.719444444444", "277.7778 × 0.90259"],
  ["natural_gas", "kWh_net", "GJ", "0.00398852192025", "1 / 250.719444444"],
  // LPG — litres, tonnes and Gross CV kWh all price the same fuel
  ["lpg", "L", "kWh_gross", "7.2593", "7.259 kWh(gross)/litre"],
  ["lpg", "L", "kWh", "7.2593", "7.259 kWh(gross)/litre"],
  ["lpg", "kWh_gross", "L", "0.137754328930", "1 / 7.2593"],
  ["lpg", "kWh", "L", "0.137754328930", "1 / 7.2593"],
  ["lpg", "t", "L", "1887.3", "density 0.53 kg/L"],
  ["lpg", "L", "t", "0.000529857468341", "1 / 1887.3"],
  // Fuel oil — litres and tonnes
  ["fuel_oil", "t", "L", "1016.92", "density 0.983 kg/L"],
  ["fuel_oil", "L", "t", "0.000983361523030", "1 / 1016.92"],
];

/**
 * THE WHOLE `unit_conversion` SET — universal first, then contextual, in the
 * order above. Pure: both the seed and `scripts/gen-reference-sql.mjs` read it.
 */
export function unitConversionRows(): UnitConversionSeed[] {
  return [
    ...UNIVERSAL.map(([from_unit, to_unit, multiplier, notes]) => ({
      id: derivedId("unit_conversion", from_unit, to_unit, null),
      from_unit,
      to_unit,
      multiplier,
      activity_context: null,
      // The Gross-CV edges are a stated convention, not an SI identity; the
      // `source` column is where a reviewer sees which is which.
      source:
        from_unit === "kWh_gross" || to_unit === "kWh_gross" ? CONVENTION : SI,
      notes,
    })),
    ...CONTEXTUAL.map(
      ([activity_context, from_unit, to_unit, multiplier, notes]) => ({
        id: derivedId("unit_conversion", from_unit, to_unit, activity_context),
        from_unit,
        to_unit,
        multiplier,
        activity_context,
        source: DERIVED,
        notes,
      }),
    ),
  ];
}
