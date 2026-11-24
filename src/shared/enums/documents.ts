// =============================================================================
// Evidence lists — `document` + `evidence_link` (spec §4.16, DM-24/DM-25, D6,
// К-8) and the polymorphic object naming they share with `dq_assessment`
// (DM-27) and `validation_result` (DM-28).
//
// NOT DB tables and NOT CHECK constraints — see the rationale in `./index.ts`
// (F6, spec §0.8).
// =============================================================================

import { enumGuard } from "./guard";

/** `document.file_type` (spec DM-24). Broad buckets, not MIME — the exact MIME
 * lives in its own `document.mime` column. */
export const FILE_TYPES = ["pdf", "xlsx", "csv", "image", "other"] as const;
export type FileType = (typeof FILE_TYPES)[number];
export const isFileType = enumGuard(FILE_TYPES);

/**
 * `evidence_link.linked_object_type`, and the same vocabulary on
 * `dq_assessment.object_type` (DM-27) and `validation_result.object_type`
 * (DM-28) — the polymorphic pattern D23 uses instead of one join table per
 * target.
 *
 * The values are TABLE NAMES (spec DM-25 spells the seven out), so a link
 * resolves without a lookup table. That is exactly why this list must not drift
 * from `schema.ts`: adding a linkable table means adding its name here.
 */
export const OBJECT_TYPES = [
  "emission_activity",
  "purchased_energy_activity",
  "contractual_instrument",
  "disclosure_record",
  "legal_entity",
  "facility",
  "emission_factor",
] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];
export const isObjectType = enumGuard(OBJECT_TYPES);

/**
 * `document.confidentiality` (spec DM-24, DD gloss "Access classification").
 * Defaults to `internal` in the schema — an uploaded invoice is not public
 * until someone says so.
 */
export const CONFIDENTIALITIES = [
  "public",
  "internal",
  "confidential",
] as const;
export type Confidentiality = (typeof CONFIDENTIALITIES)[number];
export const isConfidentiality = enumGuard(CONFIDENTIALITIES);
