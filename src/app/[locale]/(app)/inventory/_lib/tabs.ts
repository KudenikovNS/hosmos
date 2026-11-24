// =============================================================================
// THE SEVEN TABS OF `/inventory` (UI-2) — five Scope-1 categories and the two
// halves of Scope 2, as ONE table of literals.
//
// WHY A TABLE AND NOT SEVEN COMPONENTS. §4.9 puts all five Scope-1 categories in
// ONE table with `activity_category` as the discriminator (К-6), so the five
// Scope-1 tabs differ in exactly two things: which `activity_category` they
// write, and which vocabulary `activity_type` is picked from. Seven components
// would spread that pair across seven files and make "the mobile tab forgot to
// send its category" a thing that can happen.
//
// THE LITERALS ARE TYPE-CHECKED AGAINST THE SERVER'S OWN DISCRIMINATORS.
// `category` is `ActivityCategory` and `energyType` is `EnergyType` — both
// `import type` from the wire contracts that declare them, so renaming a
// category in `@/server/inventory/emission-activity` stops THIS file compiling
// rather than producing a tab that silently matches nothing. The types are
// erased at compile; no server module reaches the bundle.
//
// `family` IS THE ROUTE SEGMENT, `table` IS `source_table`. They are different
// vocabularies on purpose: `/api/activities/emission` is the URL, and
// `emission_activity` is what `/api/inventory` labels the row with (К-8, the
// same string `evidence_link.linked_object_type` uses). Holding both means the
// listing can be filtered and the row opened without a lookup table elsewhere.
// =============================================================================
import type { ActivityCategory } from "@/server/inventory/emission-activity";
import type { EnergyType } from "@/server/inventory/purchased-energy";
import type { InputTableName } from "@/server/inventory/tables";
import {
  FUEL_TYPES,
  PROCESS_TYPES,
  REFRIGERANT_TYPES,
  VEHICLE_TYPES,
  type FuelType,
} from "@/shared/enums";

/**
 * The fuels a company's OWN vehicles and machinery burn — the subset of
 * `FUEL_TYPES` the mobile-combustion tab offers next to the per-km vehicle
 * keys. The stage-1 specification (13.08.2026, §5.5) ranks the fuel invoice /
 * fuel card ABOVE any distance-based estimate, and the Slovenian set prices
 * these per litre (its rows 27/28 "any owned diesel/petrol vehicle or
 * machinery" carry the same numbers as its stationary `gas_oil` /
 * `petrol_mineral` litre rows). CALC-2 resolves on
 * `(activity_type, geography, input_unit, year)` and never on the category,
 * so a `mobile_combustion` row with `gas_oil` in `L` prices through the same
 * factor a boiler would — which is the GHG Protocol's own treatment of fuel.
 *
 * A form vocabulary, not an enum: it lives here and not in `shared/enums`
 * because it adds no value the enums lack, only an ordering and a subset.
 */
const MOBILE_FUEL_TYPES = [
  "gas_oil",
  "diesel_mineral",
  "diesel_biofuel",
  "petrol_mineral",
  "petrol_biofuel",
  "lpg",
] as const satisfies readonly FuelType[];

/** Fleet fuels first (litres off an invoice), per-km vehicle keys after. */
const MOBILE_ACTIVITY_TYPES = [...MOBILE_FUEL_TYPES, ...VEHICLE_TYPES] as const;

/** The `/api/activities/<family>` segment a tab's rows are served from. */
export type RowFamily = "emission" | "energy" | "instruments";

/** The tab identifiers — also the `inventory.tabs.*` message keys. */
export type TabId =
  | "stationary"
  | "mobile"
  | "fugitive"
  | "process"
  | "onsite"
  | "energy"
  | "instruments";

export interface TabSpec {
  readonly id: TabId;
  /** Which of the two scopes the tab is grouped under in the tab strip. */
  readonly scope: "scope1" | "scope2";
  /** `source_table` of `/api/inventory` (К-8). */
  readonly table: InputTableName;
  /** The `/api/activities/<family>` route family. */
  readonly family: RowFamily;
  /**
   * The `activity_category` this tab writes and filters on, or `null` for the
   * two Scope-2 tabs — whose table has no fifth-category problem to solve
   * (`purchased_energy_activity` discriminates on `energy_type`, and
   * `contractual_instrument` has no discriminator at all, §4.11).
   */
  readonly category: ActivityCategory | null;
  /**
   * The vocabulary `activity_type` is picked from (К-6). OPEN lists — every one
   * of them is `@/shared/enums`', so the select can never offer a value the
   * factor set has never heard of.
   */
  readonly activityTypes: readonly string[];
  /** The `energy_type` a new row of this tab defaults to (Scope 2 only). */
  readonly energyType: EnergyType | null;
}

/**
 * The four carriers of §4.10, as a value the browser may hold.
 *
 * `ENERGY_TYPES` itself lives in `@/server/inventory/purchased-energy`, which
 * imports the drizzle schema and therefore may not be imported for its RUNTIME
 * value here. The annotation is what keeps the copy honest: the array is
 * declared `readonly EnergyType[]`, so a carrier renamed or removed on the
 * server stops this file compiling. (A carrier ADDED there would need a tab and
 * a factor branch anyway — §4.10 calls a fifth carrier a new table shape.)
 */
export const ENERGY_TYPE_VALUES: readonly EnergyType[] = [
  "electricity",
  "district_heating",
  "steam",
  "cooling",
];

/** THE seven tabs, in reading order: Scope 1 §4.9 then Scope 2 §4.10/§4.11. */
export const TABS: readonly TabSpec[] = [
  {
    id: "stationary",
    scope: "scope1",
    table: "emission_activity",
    family: "emission",
    category: "stationary_combustion",
    activityTypes: FUEL_TYPES,
    energyType: null,
  },
  {
    id: "mobile",
    scope: "scope1",
    table: "emission_activity",
    family: "emission",
    category: "mobile_combustion",
    // Fleet fuels by the litre first, per-km vehicle keys after: the Slovenian
    // set prices the former and not the latter, and the fuel invoice is the
    // stage-1 preferred source. See `MOBILE_ACTIVITY_TYPES`.
    activityTypes: MOBILE_ACTIVITY_TYPES,
    energyType: null,
  },
  {
    id: "fugitive",
    scope: "scope1",
    table: "emission_activity",
    family: "emission",
    category: "fugitive_emissions",
    activityTypes: REFRIGERANT_TYPES,
    energyType: null,
  },
  {
    id: "process",
    scope: "scope1",
    table: "emission_activity",
    family: "emission",
    category: "process_emissions",
    activityTypes: PROCESS_TYPES,
    energyType: null,
  },
  {
    // §4.9's fifth category: generation on the company's own site. Its input is
    // a fuel, so it shares the stationary vocabulary.
    id: "onsite",
    scope: "scope1",
    table: "emission_activity",
    family: "emission",
    category: "onsite_generation",
    activityTypes: FUEL_TYPES,
    energyType: null,
  },
  {
    id: "energy",
    scope: "scope2",
    table: "purchased_energy_activity",
    family: "energy",
    category: null,
    activityTypes: [],
    energyType: "electricity",
  },
  {
    id: "instruments",
    scope: "scope2",
    table: "contractual_instrument",
    family: "instruments",
    category: null,
    activityTypes: [],
    energyType: null,
  },
];

/** The tab a `TabId` names. Falls back to the first — an id is a URL fragment. */
export function tabOf(id: TabId | null): TabSpec {
  return TABS.find((tab) => tab.id === id) ?? TABS[0];
}

/**
 * Does this inventory row belong on this tab?
 *
 * `kind` is what `/api/inventory` projects as the body summary's discriminator
 * (`activity_category` for Scope 1, `energy_type` / `instrument_type` for Scope
 * 2), so the five Scope-1 tabs are one table filtered five ways and the two
 * Scope-2 tabs are two tables shown whole.
 */
export function belongsToTab(
  tab: TabSpec,
  row: { source_table: string; kind: string },
): boolean {
  if (row.source_table !== tab.table) return false;
  return tab.category === null || row.kind === tab.category;
}
