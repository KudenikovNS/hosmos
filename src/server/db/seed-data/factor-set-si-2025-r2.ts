/**
 * FACTOR SET `si-2025-r2` — Slovenia 2025, revision 2 — as DATA IN THE TREE.
 *
 * ── Why a second revision and not five more rows in `si-2025` ───────────────
 * DM-21: a released factor set is never edited; a correction is a NEW set.
 * `si-2025` (0009) shipped 23 of the client workbook's rows and named, in its
 * own header, seven it could not load because `emission_factor.activity_type`
 * must be a literal the input forms produce. Five of those seven are loaded
 * here, now that the literals exist (`lignite`, `coke`, `r125` — see
 * `src/shared/enums/activities.ts`). The other two (the litre-denominated
 * "any diesel / petrol vehicle or machinery" rows 27/28) are byte-identical to
 * the SI `gas_oil` / `petrol_mineral` litre rows already in the set and are
 * reached by letting the mobile-combustion form pick a FUEL — a UI change, not
 * a factor.
 *
 * The revision therefore = every row of `si-2025`, re-keyed under the new set
 * code, PLUS the five additions below, PLUS the ten set-scoped natural-gas
 * conversions of 0010 (a calorific value belongs to the methodology, so a new
 * set must carry its own copies or the m³/kWh tie 0010 closed reopens).
 *
 * `drizzle/0015_factor_set_si_2025_r2.sql` is generated from this module by
 * `scripts/gen-factor-set-si-2025-r2.mjs`; `factor-set-si-2025-r2.test.ts`
 * proves the two agree. Production receives the set through the migration
 * only (О-13). Periods already pinned to `si-2025` are untouched; new periods
 * pin this set because `resolveFactorSet` picks the newest `published_at`.
 *
 * ── Provenance of the five additions ────────────────────────────────────────
 * All five come from the ESG expert's workbook `Hosmos_ emission factors.xlsx`
 * (sheet `Factors`, `docs/expert-aleksandra/`), rows 13, 14, 41, 51, 52 in the
 * CSV extract. Nothing here is a number the team chose.
 */
import { derivedId } from "./derived-id";

export const SI_2025_R2 = {
  code: "si-2025-r2",
  name: "Slovenia 2025 (rev. 2)",
  description:
    "Revision 2 of the national Slovenian set: every si-2025 row (ARSO 2025 fuels, AIB 2025 production mix, AGEN-RS 2025 residual mix, IPCC 2006 defaults, DESNZ 2026 refrigerant GWPs) plus lignite, coke and HFC-125 from the same client workbook. Still carries NO United Kingdom rows.",
  publishedAt: "2026-09-06T00:00:00Z",
  get id() {
    return derivedId("factor_set", this.code);
  },
} as const;

const ARSO = {
  source_name: "Slovenian Environment Agency (ARSO)",
  source_version:
    "Značilne neto kalorične vrednosti in emisijski faktorji 2025",
  publication_date: "2025-01-01",
  applicable_year: 2025,
  geography: "SI",
  source_url:
    "https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf",
  source_locator: "SRC_ARSO_SI_2025",
} as const;

const IPCC = {
  source_name: "Intergovernmental Panel on Climate Change (IPCC)",
  source_version:
    "2006 IPCC Guidelines for National Greenhouse Gas Inventories, Volume 2, Chapter 2",
  publication_date: "2006-01-01",
  applicable_year: null,
  geography: "GLOBAL",
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

export type Si2025R2Addition = {
  factor_code: string;
  factor_name: string;
  source_name: string;
  source_version: string;
  publication_date: string;
  applicable_year: number | null;
  geography: string;
  activity_type: string;
  input_unit: string;
  factor_value: string;
  output_unit: "kgCO2e";
  /** `factor_value` again on CO₂-only rows; NULL on a GWP-weighted refrigerant. */
  co2_value: string | null;
  gwp_basis: "AR5";
  wtt_included: false;
  source_url: string;
  source_locator: string;
  licence: "unspecified";
  status: "active";
};

/** The five rows `si-2025` could not carry. Workbook row numbers in comments. */
export const SI_2025_R2_ADDITIONS: readonly Si2025R2Addition[] = [
  {
    // row 13 — Бурый уголь (импорт), 1816.29 kg CO2/t
    ...ARSO,
    factor_code: "arso_si_2025_lignite_tonne",
    factor_name: "Lignite (imported brown coal)",
    activity_type: "lignite",
    input_unit: "t",
    factor_value: "1816.29",
    output_unit: "kgCO2e",
    co2_value: "1816.29",
    gwp_basis: "AR5",
    wtt_included: false,
    licence: "unspecified",
    status: "active",
  },
  {
    // row 14 — Кокс, 3135.1 kg CO2/t
    ...ARSO,
    factor_code: "arso_si_2025_coke_tonne",
    factor_name: "Coke",
    activity_type: "coke",
    input_unit: "t",
    factor_value: "3135.1",
    output_unit: "kgCO2e",
    co2_value: "3135.1",
    gwp_basis: "AR5",
    wtt_included: false,
    licence: "unspecified",
    status: "active",
  },
  {
    // row 51 — Lignite, IPCC default 101 kg CO2/GJ
    ...IPCC,
    factor_code: "ipcc_2006_lignite",
    factor_name: "Lignite — IPCC default",
    activity_type: "lignite",
    input_unit: "GJ",
    factor_value: "101",
    output_unit: "kgCO2e",
    co2_value: "101",
    gwp_basis: "AR5",
    wtt_included: false,
    licence: "unspecified",
    status: "active",
  },
  {
    // row 52 — Coke oven coke and lignite coke, IPCC default 107 kg CO2/GJ
    ...IPCC,
    factor_code: "ipcc_2006_coke_oven_coke",
    factor_name: "Coke oven coke and lignite coke — IPCC default",
    activity_type: "coke",
    input_unit: "GJ",
    factor_value: "107",
    output_unit: "kgCO2e",
    co2_value: "107",
    gwp_basis: "AR5",
    wtt_included: false,
    licence: "unspecified",
    status: "active",
  },
  {
    // row 41 — HFC-125, 3170 kg CO2e/kg (AR5 GWP-100)
    ...DESNZ,
    factor_code: "desnz_2026_r125",
    factor_name: "HFC-125 (R-125)",
    activity_type: "r125",
    input_unit: "kg",
    factor_value: "3170",
    output_unit: "kgCO2e",
    co2_value: null,
    gwp_basis: "AR5",
    wtt_included: false,
    licence: "unspecified",
    status: "active",
  },
];

/** The activity types this revision prices that `legacy-v1` never did. */
export const SI_2025_R2_ONLY_ACTIVITY_TYPES = [
  ...new Set(SI_2025_R2_ADDITIONS.map((r) => r.activity_type)),
] as const;

/** VAL-031's key inside a set — the same seven components 0009 derived with. */
export function si2025R2FactorId(row: {
  source_name: string;
  source_version: string;
  activity_type: string;
  geography: string;
  input_unit: string;
  applicable_year: number | null;
}): string {
  return derivedId(
    SI_2025_R2.code,
    row.source_name,
    row.source_version,
    row.activity_type,
    row.geography,
    row.input_unit,
    row.applicable_year ?? "any",
  );
}
