/**
 * FACTOR SET `si-2025-r4` — Slovenia 2025, revision 4: DISTRICT HEAT + SPEND.
 *
 * ── The two gaps this closes (prod test of 15.09.2026, партия 15) ──────────
 *   1. `district_heating` rows were accepted by the API but `si-2025-r3` has no
 *      factor under `heat:heat_defra_default` (the key `calc/scope2.ts` files
 *      purchased heat under), so the run failed and the revision could not be
 *      approved. Slovenian SMEs in Ljubljana, Maribor, Velenje buy district
 *      heat every winter.
 *   2. No active set carried the EXIOBASE per-€1000 spend factors since 0011
 *      retired `legacy-v1`, so `scope3_spend` refused every line
 *      (`NO_SPEND_FACTORS`) on every plan — while the public page sold a
 *      Scope 3 estimate on every plan.
 *
 * ── What is added, and where the numbers come from ──────────────────────────
 *   • DISTRICT HEAT → `heat:heat_defra_default`, per kWh, GLOBAL, no year:
 *     DESNZ «GHG Conversion Factors for Company Reporting 2024», heat and
 *     steam — district heat, 0.16590 kg CO2e/kWh (the same value the retired
 *     `legacy-v1` carried for 2024). Slovenia publishes no national purchased-
 *     heat factor; this is an EXPLICIT international fallback (stage-1 factor
 *     hierarchy, rung 5), shown as such in the methodology and lowering the
 *     data-quality tier. The methodologist can replace it with a supplier-
 *     specific or national value in a later revision.
 *   • SPEND → the eight `scope3_spend:s3_c1_*` / `s3_c2_*` commodities of
 *     0004, value for value (EXIOBASE v3 2024, kg CO2e per €1 000, GLOBAL),
 *     for the years 2024, 2025 and 2026 — the spend engine matches on year
 *     (`scope3/factors.ts`) and the same catalogue edition serves all three
 *     until a newer EXIOBASE release is adopted.
 *
 * Everything else is `si-2025-r3`, row for row, under the new set id (DM-21:
 * a released set is never edited). `scripts/gen-factor-set-si-2025-r4.mjs`
 * renders `drizzle/0023_factor_set_si_2025_r4.sql`; the parity test proves
 * they agree. New periods pin this set; existing pins are untouched — a
 * company on r3 re-pins from the period's methodology settings.
 */
import { derivedId } from "./derived-id";
import type { Si2025R3Addition } from "./factor-set-si-2025-r3";

export const SI_2025_R4 = {
  code: "si-2025-r4",
  name: "Slovenia 2025 (rev. 4, district heat + spend)",
  description:
    "Revision 4 of the national Slovenian set: every si-2025-r3 row plus purchased district heat (DESNZ 2024 heat-and-steam default, explicit international fallback) and the eight EXIOBASE v3 spend-based Scope 3 factors for categories 1 and 2 (per €1 000, 2024–2026). Still carries NO United Kingdom fuel rows.",
  publishedAt: "2026-09-16T00:00:00Z",
  get id() {
    return derivedId("factor_set", this.code);
  },
} as const;

export type Si2025R4Addition = Si2025R3Addition;

const DESNZ_2024 = {
  source_name: "UK Department for Energy Security and Net Zero (DESNZ)",
  source_version:
    "GHG Conversion Factors for Company Reporting 2024 — heat and steam (district heat)",
  publication_date: "2024-06-01",
  applicable_year: null,
  geography: "GLOBAL",
  source_url:
    "https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2024",
  source_locator: "SRC_DESNZ_2024",
} as const;

const EXIOBASE = {
  source_name: "Exiobase Consortium",
  source_version: "Exiobase v3 2024",
  publication_date: "2024-01-01",
  geography: "GLOBAL",
  source_url: "https://www.exiobase.eu/",
  source_locator: "SRC_EXIOBASE_V3_2024",
} as const;

const common = {
  output_unit: "kgCO2e",
  gwp_basis: "AR5",
  wtt_included: false,
  licence: "unspecified",
  status: "active",
  co2_value: null,
  biogenic_treatment: null,
} as const;

/** The 0004 commodities, verbatim: key, name, kg CO2e per €1 000. */
export const SPEND_COMMODITIES = [
  ["s3_c1_electronics", "Electronics (average)", "350"],
  ["s3_c1_food", "Food products (average)", "680"],
  ["s3_c1_construction", "Construction materials", "520"],
  ["s3_c1_it_services", "IT services / cloud", "120"],
  ["s3_c1_consulting", "Professional services", "85"],
  ["s3_c1_furniture", "Furniture", "310"],
  ["s3_c2_machinery", "Machinery / equipment", "450"],
  ["s3_c2_buildings", "Buildings / renovations", "600"],
] as const;

/** The years the spend engine can match a line against (`scope3/factors.ts`). */
export const SPEND_YEARS = [2024, 2025, 2026] as const;

export const SI_2025_R4_ADDITIONS: readonly Si2025R4Addition[] = [
  {
    ...DESNZ_2024,
    ...common,
    factor_code: "desnz_2024_district_heat_kwh",
    factor_name:
      "Purchased district heat — DESNZ default (international fallback)",
    activity_type: "heat:heat_defra_default",
    input_unit: "kWh",
    factor_value: "0.1659",
  },
  ...SPEND_YEARS.flatMap((year) =>
    SPEND_COMMODITIES.map(([key, name, value]) => ({
      ...EXIOBASE,
      ...common,
      applicable_year: year,
      // The commodity key itself: `scope3_spend.commodity_key` stores it and the
      // catalogue dedupes on it, so one code serves every year (as in 0004).
      factor_code: key,
      factor_name: name,
      activity_type: `scope3_spend:${key}`,
      input_unit: "EUR_1000",
      factor_value: value,
    })),
  ),
];

/** The derived `emission_factor.id` of an addition — the same recipe 0009/0015/0020 use. */
export function si2025R4FactorId(row: {
  source_name: string;
  source_version: string;
  activity_type: string;
  geography: string;
  input_unit: string;
  applicable_year: number | null;
}): string {
  return derivedId(
    SI_2025_R4.code,
    row.source_name,
    row.source_version,
    row.activity_type,
    row.geography,
    row.input_unit,
    row.applicable_year ?? "any",
  );
}
