// =============================================================================
// Contractual-instrument lists — Scope 2 market-based evidence
// (`contractual_instrument`, spec §4.11 / DM-17, D19).
//
// NOT DB tables and NOT CHECK constraints — see the rationale in `./index.ts`
// (F6, spec §0.8).
// =============================================================================

import { enumGuard } from "./guard";

/**
 * `contractual_instrument.instrument_type` — the workbook's six InstrumentType
 * values (ENUM-082…087) in sheet order, spelled as the spec's DM-17 literals.
 *
 * Mixed casing is deliberate and matches the spec's convention throughout:
 * established abbreviations keep their canonical form (compare `AR5` in
 * `GWP_BASES`, `DEFRA` in `FACTOR_SOURCES`), multi-word tokens are snake_case.
 * `GoO` is the workbook's "Guarantee of Origin".
 */
export const INSTRUMENT_TYPES = [
  "GoO",
  "REGO",
  "REC",
  "PPA",
  "green_tariff",
  "supplier_product",
] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];
export const isInstrumentType = enumGuard(INSTRUMENT_TYPES);

/**
 * `contractual_instrument.technology` (spec §4.11).
 *
 * OPEN LIST — spec and workbook name only the type; the DD gloss is
 * "Generation technology". The values are the generation categories a
 * Guarantee of Origin / REGO actually declares.
 */
export const GENERATION_TECHNOLOGIES = [
  "wind",
  "solar",
  "hydro",
  "biomass",
  "geothermal",
  "nuclear",
  "other",
] as const;
export type GenerationTechnology = (typeof GENERATION_TECHNOLOGIES)[number];
export const isGenerationTechnology = enumGuard(GENERATION_TECHNOLOGIES);

/**
 * `contractual_instrument.quality_criteria_status` (spec §4.11) — whether the
 * instrument meets the GHGP Scope 2 market-based quality criteria. DD gloss:
 * "Pass, fail or review".
 */
export const QUALITY_CRITERIA_STATUSES = ["pass", "fail", "review"] as const;
export type QualityCriteriaStatus = (typeof QUALITY_CRITERIA_STATUSES)[number];
export const isQualityCriteriaStatus = enumGuard(QUALITY_CRITERIA_STATUSES);
