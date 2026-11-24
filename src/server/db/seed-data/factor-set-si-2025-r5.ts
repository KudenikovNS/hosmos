/**
 * FACTOR SET `si-2025-r5` — Slovenia 2025, revision 5: THE 2024 REPORTING YEAR.
 *
 * ── The gap this closes (Z'dežele pilot, 17.09.2026, партия 17) ─────────────
 *   Every national row of `si-2025` … `si-2025-r4` is stamped
 *   `applicable_year = 2025`. The factor library matches the ROW's year (the
 *   year the period ends in, CALC-8) against the factor's, and passes a
 *   national row over on a mismatch (`passed_over: year_mismatch`) rather
 *   than silently pricing 2024 fuel with a 2025 factor. So a period for the
 *   reporting year 2024 — the first year most Slovenian SMEs are asked for —
 *   found no Slovenian factor at all: natural gas fell through to the
 *   year-agnostic IPCC default, diesel entered in litres could not be
 *   converted to the IPCC row's GJ (`failed_unit`), and grid electricity has
 *   no international fallback (`failed_missing_factor`). The run failed, the
 *   revision could not be approved, and the screen showed nothing that said
 *   why.
 *
 * ── What is added, and where the numbers come from ──────────────────────────
 *   • FUELS, `applicable_year = 2024`, geography SI — ARSO, «Značilne neto
 *     kalorične vrednosti in emisijski faktorji za leto 2024» (the values the
 *     Republic of Slovenia reported in its national inventory and that
 *     ETS operators must use for 2024):
 *       natural gas   56.5 kg CO2/GJ; NCV 0.035971 TJ/10³ Nm³
 *                     → 0.2034 kg/kWh_net, 203.4 kg/MWh, 2.0323615 kg/Nm³
 *       gas oil       74.1 kg CO2/GJ; NCV 42.6 GJ/t; density 0.845 kg/l
 *                     → 2.6673777 kg/l   (unchanged from the 2025 edition)
 *       petrol        69.3 kg CO2/GJ; NCV 43.85 GJ/t; density 0.755 kg/l
 *                     → 2.29429778 kg/l
 *       fuel oil      77.4 kg CO2/GJ; NCV 41.42 GJ/t → 3205.908 kg/t
 *       LPG           63.1 kg CO2/GJ; NCV 46.05 GJ/t → 2905.755 kg/t
 *   • GRID ELECTRICITY, `applicable_year = 2024`, geography SI — AIB,
 *     «European Residual Mixes 2024» (final results, 30.05.2025):
 *       production mix SI  212.22 g CO2/kWh → 0.21222 kg/kWh (location-based)
 *       residual mix   SI  250.20 g CO2/kWh → 0.2502  kg/kWh (market-based
 *                          default for untracked supply; the 2025 rows carry
 *                          AGEN-RS's national residual mix instead — both are
 *                          named in the methodology)
 *   No CH4/N2O split: like every ARSO row so far these are CO2-only factors
 *   (`co2_value = factor_value`, AR5 basis, no well-to-tank).
 *
 * Everything else is `si-2025-r4`, row for row, under the new set id (DM-21:
 * a released set is never edited). `scripts/gen-factor-set-si-2025-r5.mjs`
 * renders `drizzle/0024_factor_set_si_2025_r5.sql`; the parity test proves
 * they agree. New periods pin this set; existing pins are untouched — a
 * period on r4 re-pins through `PATCH /api/periods/:id { factor_set_id }`.
 */
import { derivedId } from "./derived-id";
import type { Si2025R4Addition } from "./factor-set-si-2025-r4";

export const SI_2025_R5 = {
  code: "si-2025-r5",
  name: "Slovenia 2025 (rev. 5, reporting year 2024)",
  description:
    "Revision 5 of the national Slovenian set: every si-2025-r4 row plus the ARSO 2024 fuel factors (natural gas, gas oil, petrol, fuel oil, LPG) and the AIB 2024 Slovenian production and residual electricity mixes, all stamped applicable_year 2024, so a period for the reporting year 2024 resolves national factors instead of falling through to IPCC defaults. Still carries NO United Kingdom fuel rows.",
  publishedAt: "2026-09-17T00:00:00Z",
  get id() {
    return derivedId("factor_set", this.code);
  },
} as const;

export type Si2025R5Addition = Si2025R4Addition;

const ARSO_2024 = {
  source_name: "Slovenian Environment Agency (ARSO)",
  source_version:
    "Značilne neto kalorične vrednosti in emisijski faktorji 2024",
  publication_date: "2024-01-01",
  applicable_year: 2024,
  geography: "SI",
  source_url:
    "https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2024.pdf",
  source_locator: "SRC_ARSO_SI_2024",
} as const;

const AIB_2024 = {
  source_name: "Association of Issuing Bodies (AIB)",
  source_version: "European Residual Mixes 2024",
  publication_date: "2025-05-30",
  applicable_year: 2024,
  geography: "SI",
  source_url:
    "https://www.aib-net.org/sites/default/files/assets/facts/residual-mix/2024/2024_Final%20_Residual%20mix%20calculation%20results_30052025%20pdf%20v1.pdf",
  source_locator: "SRC_AIB_2024",
} as const;

const common = {
  output_unit: "kgCO2e",
  gwp_basis: "AR5",
  wtt_included: false,
  licence: "unspecified",
  status: "active",
  biogenic_treatment: null,
} as const;

/** A CO2-only row: `co2_value` repeats `factor_value`, as every ARSO row does. */
function co2Only<T extends { factor_value: string }>(
  row: T,
): T & { co2_value: string } {
  return { ...row, co2_value: row.factor_value };
}

export const SI_2025_R5_ADDITIONS: readonly Si2025R5Addition[] = [
  // ── natural gas: 56.5 kg CO2/GJ, NCV 0.035971 TJ/10³ Nm³ ─────────────────
  co2Only({
    ...ARSO_2024,
    ...common,
    factor_code: "arso_si_2024_natural_gas_gj",
    factor_name: "Natural gas",
    activity_type: "natural_gas",
    input_unit: "GJ",
    factor_value: "56.5",
  }),
  co2Only({
    ...ARSO_2024,
    ...common,
    factor_code: "arso_si_2024_natural_gas_kwh_net",
    factor_name: "Natural gas",
    activity_type: "natural_gas",
    input_unit: "kWh_net",
    factor_value: "0.2034", // 56.5 × 0.0036
  }),
  co2Only({
    ...ARSO_2024,
    ...common,
    factor_code: "arso_si_2024_natural_gas_mwh",
    factor_name: "Natural gas",
    activity_type: "natural_gas",
    input_unit: "MWh",
    factor_value: "203.4", // 56.5 × 3.6
  }),
  co2Only({
    ...ARSO_2024,
    ...common,
    factor_code: "arso_si_2024_natural_gas_nm3",
    factor_name: "Natural gas",
    activity_type: "natural_gas",
    input_unit: "m3",
    factor_value: "2.0323615", // 56.5 × 0.035971 GJ/Nm³
  }),
  // ── liquid fuels ─────────────────────────────────────────────────────────
  co2Only({
    ...ARSO_2024,
    ...common,
    factor_code: "arso_si_2024_gas_oil_litre",
    factor_name: "Diesel / gas oil",
    activity_type: "gas_oil",
    input_unit: "L",
    factor_value: "2.6673777", // 74.1 × 42.6 GJ/t × 0.845 kg/l / 1000
  }),
  co2Only({
    ...ARSO_2024,
    ...common,
    factor_code: "arso_si_2024_petrol_litre",
    factor_name: "Petrol (motor gasoline)",
    activity_type: "petrol_mineral",
    input_unit: "L",
    factor_value: "2.29429778", // 69.3 × 43.85 GJ/t × 0.755 kg/l / 1000
  }),
  co2Only({
    ...ARSO_2024,
    ...common,
    factor_code: "arso_si_2024_fuel_oil_tonne",
    factor_name: "Heating oil (residual fuel oil)",
    activity_type: "fuel_oil",
    input_unit: "t",
    factor_value: "3205.908", // 77.4 × 41.42 GJ/t
  }),
  co2Only({
    ...ARSO_2024,
    ...common,
    factor_code: "arso_si_2024_lpg_tonne",
    factor_name: "LPG mixture (~60% propane)",
    activity_type: "lpg",
    input_unit: "t",
    factor_value: "2905.755", // 63.1 × 46.05 GJ/t
  }),
  // ── grid electricity ─────────────────────────────────────────────────────
  co2Only({
    ...AIB_2024,
    ...common,
    factor_code: "aib_si_2024_grid_electricity",
    factor_name: "Grid electricity — Slovenian production mix 2024",
    activity_type: "grid:grid_electricity",
    input_unit: "kWh",
    factor_value: "0.21222", // Production Mix 2024, SI: 212.22 g CO2/kWh
  }),
  co2Only({
    ...AIB_2024,
    ...common,
    factor_code: "aib_si_2024_residual_mix",
    factor_name: "Grid electricity — Slovenian residual mix 2024",
    activity_type: "grid:residual_mix",
    input_unit: "kWh",
    factor_value: "0.2502", // Residual Mix 2024, SI: 250.20 g CO2/kWh
  }),
];

/** The derived `emission_factor.id` of an addition — the same recipe 0009/0015/0020/0023 use. */
export function si2025R5FactorId(row: {
  source_name: string;
  source_version: string;
  activity_type: string;
  geography: string;
  input_unit: string;
  applicable_year: number | null;
}): string {
  return derivedId(
    SI_2025_R5.code,
    row.source_name,
    row.source_version,
    row.activity_type,
    row.geography,
    row.input_unit,
    row.applicable_year ?? "any",
  );
}
