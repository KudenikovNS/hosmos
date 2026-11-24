// =============================================================================
// Emission-factor lists — `factor_set` / `emission_factor` (spec §4.14,
// DM-21/DM-22) plus the methodology identifier of `reporting_period` (К-19).
//
// NOT DB tables and NOT CHECK constraints — see the rationale in `./index.ts`
// (F6, spec §0.8). `factor_set.status` is the one exception: the spec gives it
// a CHECK because factor-set release is a lifecycle.
// =============================================================================

import { enumGuard } from "./guard";

/**
 * `emission_factor.source_name` (spec DM-22). OPEN LIST — the spec says so
 * outright ("открытый список"). Custom factors (`factors.custom` capability)
 * write `supplier` or `custom`.
 *
 * The workbook's DD gloss names a longer set (DEFRA, AIB, IEA, EEA,
 * EPA/eGRID, MRIO, Ecoinvent). The SPEC wins: its six are the Phase-1 list, and
 * the rest arrive as data when a factor set needs them.
 */
export const FACTOR_SOURCES = [
  "DEFRA",
  "IEA",
  "ADEME",
  "EPA",
  "supplier",
  "custom",
] as const;
export type FactorSource = (typeof FACTOR_SOURCES)[number];
export const isFactorSource = enumGuard(FACTOR_SOURCES);

/**
 * `factor_set.status` and `emission_factor.status` (spec DM-21/DM-22) — the
 * workbook's three FactorStatus values (ENUM-088…090) in sheet order.
 *
 * EXCEPTION to §0.8: CHECK-backed on `factor_set` (release lifecycle — a period
 * pins a set, and only an `active` set may be pinned).
 */
export const FACTOR_STATUSES = ["draft", "active", "archived"] as const;
export type FactorStatus = (typeof FACTOR_STATUSES)[number];
export const isFactorStatus = enumGuard(FACTOR_STATUSES);

/**
 * `emission_factor.gwp_basis` (spec DM-22) — the IPCC assessment report whose
 * GWP values the factor uses. Part of `factor_snapshot`, so a locked revision
 * reproduces the basis it was calculated under (CALC-7).
 */
export const GWP_BASES = ["AR5", "AR6"] as const;
export type GWPBasis = (typeof GWP_BASES)[number];
export const isGWPBasis = enumGuard(GWP_BASES);

/**
 * `emission_factor.biogenic_treatment` (spec DM-22, DD gloss "Fossil/biogenic
 * treatment"). Drives CALC-4: a biogenic factor sends the result to
 * `biogenic_co2_result`, OUTSIDE the fossil total (VAL-017).
 */
export const BIOGENIC_TREATMENTS = ["fossil", "biogenic"] as const;
export type BiogenicTreatment = (typeof BIOGENIC_TREATMENTS)[number];
export const isBiogenicTreatment = enumGuard(BIOGENIC_TREATMENTS);

/**
 * `reporting_period.methodology_version` — К-19: a text identifier, NOT an FK.
 * There is no methodology entity in Phase 1 (it arrives with the report engine
 * in Phase 4), so the "dictionary" of that text column is this constant.
 *
 * One value today, which is the honest state of affairs: every Phase-1 period
 * is calculated under the same methodology. A second entry appears only when a
 * genuinely different one ships — and because the value is pinned per period,
 * old periods keep reproducing under the one they were closed with.
 *
 * THE LITERAL ITSELF IS OURS, NOT THE SPEC'S. К-19 gives
 * `'GHGP-2015/VSME-2024.1'` as an EXAMPLE ("например") of what the text column
 * might hold, not as a mandated value. It is worth saying because this string
 * lands on every `reporting_period` row and then into every `factor_snapshot`
 * beneath it (CALC-7), so it reads like a standard identifier. Changing it is a
 * data migration over historical periods, not a constant edit — settle on the
 * spelling now rather than after the first period is locked.
 */
export const METHODOLOGY_VERSIONS = ["GHGP-2015/VSME-2024.1"] as const;
export type MethodologyVersion = (typeof METHODOLOGY_VERSIONS)[number];
export const isMethodologyVersion = enumGuard(METHODOLOGY_VERSIONS);
