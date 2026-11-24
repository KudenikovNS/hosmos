/**
 * FACTOR SET `si-2025-r3` — Slovenia 2025, revision 3: BIOMASS.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * Wood is a common Scope-1 fuel for Slovenian SMEs (the March 2026 test case
 * was a meat producer smoking with beech wood), and no national set priced it:
 * `si-2025` / `-r2` carry no wood row, and 0009 deliberately left out the UK
 * fallback rows. Since 0011 retired `legacy-v1`, a company burning wood got
 * `failed_missing_factor`.
 *
 * ── What the sources say, and the choice made (06.09.2026) ──────────────────
 * ARSO 2025 («Značilne neto kalorične vrednosti in emisijski faktorji 2025»)
 * lists «Lesna biomasa» with a net calorific value of 15.6 GJ/t and a CO2
 * emission factor of 0 t/TJ — the national inventory convention: the CO2 of
 * biomass is biogenic and reported outside the fossil total, not that burning
 * wood emits nothing. The GHG Protocol and VSME B3 want the same split: the
 * biogenic CO2 stated SEPARATELY, and only the CH4 + N2O of combustion — as
 * CO2e — inside Scope 1.
 *
 *   • BIOGENIC CO2 → `wood_logs_biogenic` (the dedicated literal the model
 *     already has; CALC-4 moves it off the fossil line by
 *     `biogenic_treatment = 'biogenic'`). Value: IPCC 2006 Guidelines Vol. 2
 *     Ch. 2 Table 2.2 default for wood / wood waste, 112 000 kg CO2/TJ =
 *     112 kg CO2/GJ. Per tonne, using ARSO's own NCV: 112 × 15.6 = 1 747.2 kg
 *     CO2/t (geography SI, year 2025 — the NCV is the national 2025 figure).
 *   • SCOPE-1 CO2e OF WOOD (CH4 + N2O) → `wood_logs`, `wood_chips`,
 *     `wood_pellets` (per tonne): the expert's workbook rows 36–38, DESNZ 2026
 *     — 48.73751 / 45.05983 / 57.25249 kg CO2e/t. ARSO publishes no CH4/N2O
 *     factor and IPCC's stationary defaults span 30–300 kg CH4/TJ by sector,
 *     so the one figure the expert put in the workbook is used, at GLOBAL, as
 *     an explicit fallback (stage-1 factor hierarchy, rung 5 — shown as such
 *     and lowering the data-quality tier). The methodologist can replace it
 *     with a Slovenian or sector-specific value in a later revision.
 *
 * Everything else is `si-2025-r2`, row for row, under the new set id (DM-21:
 * a released set is never edited). `scripts/gen-factor-set-si-2025-r3.mjs`
 * renders `drizzle/0020_factor_set_si_2025_r3.sql`; the parity test proves
 * they agree. Flagged for the methodologist's review like every factor.
 */
import { derivedId } from "./derived-id";
import type { Si2025R2Addition } from "./factor-set-si-2025-r2";

export const SI_2025_R3 = {
  code: "si-2025-r3",
  name: "Slovenia 2025 (rev. 3, biomass)",
  description:
    "Revision 3 of the national Slovenian set: every si-2025-r2 row plus wood biomass — biogenic CO2 (IPCC 2006 default × ARSO 2025 net calorific value, reported outside the fossil total) and the Scope-1 CH4+N2O CO2e of wood logs, chips and pellets (DESNZ 2026, explicit international fallback). Still carries NO United Kingdom fuel rows.",
  publishedAt: "2026-09-07T00:00:00Z",
  get id() {
    return derivedId("factor_set", this.code);
  },
} as const;

export type Si2025R3Addition = Si2025R2Addition & {
  /** `'biogenic'` moves the result off the fossil line (CALC-4, VAL-017). */
  biogenic_treatment: "biogenic" | null;
};

const IPCC = {
  source_name: "Intergovernmental Panel on Climate Change (IPCC)",
  source_version:
    "2006 IPCC Guidelines for National Greenhouse Gas Inventories, Volume 2, Chapter 2, Table 2.2 (wood/wood waste)",
  publication_date: "2006-01-01",
  source_url:
    "https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_2_Ch2_Stationary_Combustion.pdf",
  source_locator: "SRC_IPCC_2006",
} as const;

const DESNZ = {
  source_name: "UK Department for Energy Security and Net Zero (DESNZ)",
  source_version: "GHG Conversion Factors for Company Reporting 2026",
  publication_date: "2026-01-01",
  applicable_year: null,
  geography: "GLOBAL",
  source_url:
    "https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026",
  source_locator: "SRC_DESNZ_2026",
} as const;

const common = {
  output_unit: "kgCO2e",
  gwp_basis: "AR5",
  wtt_included: false,
  licence: "unspecified",
  status: "active",
} as const;

export const SI_2025_R3_ADDITIONS: readonly Si2025R3Addition[] = [
  {
    ...IPCC,
    ...common,
    factor_code: "ipcc_2006_wood_biogenic_gj",
    factor_name: "Wood / wood waste — biogenic CO2 (IPCC default)",
    applicable_year: null,
    geography: "GLOBAL",
    activity_type: "wood_logs_biogenic",
    input_unit: "GJ",
    factor_value: "112",
    co2_value: "112",
    biogenic_treatment: "biogenic",
  },
  {
    ...IPCC,
    ...common,
    factor_code: "ipcc_2006_x_arso_2025_wood_biogenic_tonne",
    factor_name:
      "Wood biomass — biogenic CO2 per tonne (IPCC 112 kg CO2/GJ × ARSO 2025 NCV 15.6 GJ/t)",
    source_version:
      "2006 IPCC Guidelines Vol. 2 Ch. 2 Table 2.2 CO2 EF × ARSO «Značilne neto kalorične vrednosti 2025» NCV for lesna biomasa (15.6 GJ/t)",
    publication_date: "2025-01-01",
    applicable_year: 2025,
    geography: "SI",
    activity_type: "wood_logs_biogenic",
    input_unit: "t",
    factor_value: "1747.2",
    co2_value: "1747.2",
    biogenic_treatment: "biogenic",
  },
  {
    // workbook row 36 — Wood logs, 48.73751 kg CO2e/t (CH4 + N2O of combustion)
    ...DESNZ,
    ...common,
    factor_code: "desnz_2026_wood_logs",
    factor_name: "Wood logs — Scope 1 CH4 + N2O (international fallback)",
    activity_type: "wood_logs",
    input_unit: "t",
    factor_value: "48.73751",
    co2_value: null,
    biogenic_treatment: null,
  },
  {
    // workbook row 37 — Wood chips, 45.05983 kg CO2e/t
    ...DESNZ,
    ...common,
    factor_code: "desnz_2026_wood_chips",
    factor_name: "Wood chips — Scope 1 CH4 + N2O (international fallback)",
    activity_type: "wood_chips",
    input_unit: "t",
    factor_value: "45.05983",
    co2_value: null,
    biogenic_treatment: null,
  },
  {
    // workbook row 38 — Wood pellets, 57.25249 kg CO2e/t
    ...DESNZ,
    ...common,
    factor_code: "desnz_2026_wood_pellets",
    factor_name: "Wood pellets — Scope 1 CH4 + N2O (international fallback)",
    activity_type: "wood_pellets",
    input_unit: "t",
    factor_value: "57.25249",
    co2_value: null,
    biogenic_treatment: null,
  },
];

/** VAL-031's key inside the set — the same seven components 0009 derived with. */
export function si2025R3FactorId(row: {
  source_name: string;
  source_version: string;
  activity_type: string;
  geography: string;
  input_unit: string;
  applicable_year: number | null;
}): string {
  return derivedId(
    SI_2025_R3.code,
    row.source_name,
    row.source_version,
    row.activity_type,
    row.geography,
    row.input_unit,
    row.applicable_year ?? "any",
  );
}
