// =============================================================================
// Data-quality tiering (`dq_assessment`, spec §4.17) and the typed-value
// vocabulary of the metric catalog / disclosure records (spec §4.12, §4.13).
//
// NOT DB tables and NOT CHECK constraints — see the rationale in `./index.ts`
// (F6, spec §0.8). The CHECKs `dq_assessment` does carry are numeric RANGES
// (1–5, 0–100), not membership of these lists.
// =============================================================================

import { enumGuard } from "./guard";

/**
 * `dq_assessment.quality_tier` (spec DM-27) — the workbook's four QualityTier
 * values (ENUM-072…075) in sheet order. The workbook labels them "High /
 * primary", "Medium / calculated", "Low / proxy", "Estimate"; the wire literals
 * are the spec's.
 */
export const QUALITY_TIERS = [
  "high_primary",
  "medium_calculated",
  "low_proxy",
  "estimate",
] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];
export const isQualityTier = enumGuard(QUALITY_TIERS);

/**
 * `disclosure_record.value_type` and `metric_catalog.value_type` — EXACTLY 12
 * (spec DM-18/DM-20, workbook ENUM-020…031 in sheet order, S1).
 *
 * The count is load-bearing, which is why the unit test asserts it: DM-19 fans
 * these 12 onto six typed value columns (`value_numeric` / `value_text` /
 * `value_boolean` / `value_date` / `value_json`), and T1.4's generator derives
 * a `value_type` for all 141 seeded metrics from this list. A 13th value with
 * no column mapping would be an unwritable metric.
 */
export const DATA_TYPES = [
  "string",
  "text",
  "integer",
  "decimal",
  "percentage",
  "boolean",
  "date",
  "datetime",
  "enum",
  "multi_enum",
  "reference",
  "multi_reference",
] as const;
export type DataType = (typeof DATA_TYPES)[number];
export const isDataType = enumGuard(DATA_TYPES);
