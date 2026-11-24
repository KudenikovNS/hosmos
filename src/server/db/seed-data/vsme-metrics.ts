/**
 * The VSME metric catalogue (MIG-3, DM-20) — 141 records, as DATA IN THE TREE.
 *
 * This module is the only typed handle on `./vsme-metrics.json`, which is the
 * COMMITTED output of `scripts/gen-vsme-metrics.mjs` (a one-off generator that
 * reads the two workbooks). Nothing at runtime opens an .xlsx: the generator is
 * run by hand when a workbook revision arrives, its output is reviewed in the
 * diff, and from then on the JSON is the source of truth for BOTH consumers —
 * `seed.ts` (idempotent upsert) and `scripts/gen-reference-sql.mjs`, which
 * renders the same rows into the `-- === REFERENCE DATA ===` section of
 * `drizzle/0004_data_model.sql` so production, which never runs the seed, still
 * gets the catalogue (О-13). `metric-catalog.integration.test.ts` compares those
 * two derivations key for key.
 *
 * The 223 ESRS/GRI rows of the wider catalogue (К-26) are Phase 4 and are not
 * here; every record below carries `standard: "vsme"`.
 */
import type { DataType } from "@/shared/enums";

import metrics from "./vsme-metrics.json";

/** One `metric_catalog` row (DM-20), column names verbatim. */
export type VsmeMetric = {
  metric_key: string;
  standard: "vsme";
  pillar: "general" | "environmental" | "social" | "governance";
  module: "basic" | "comprehensive";
  disclosure_code: string;
  disclosure_title: string;
  /**
   * О-20 — the English half of the bilingual «Раскрытие», i.e. the section
   * heading the VSME renderer prints. Non-null for all 141 rows; nullable in the
   * DDL only because the Phase-4 ESRS/GRI rows (К-26) may not have one.
   */
  disclosure_title_en: string;
  paragraph: string | null;
  requirement_type: "mandatory" | "conditional" | "voluntary";
  title: string;
  /** О-20 — «Indicator / disclosure title (English)», the renderer's label. */
  title_en: string;
  description: string | null;
  unit: string | null;
  applicability_condition: string | null;
  value_type: DataType;
  /**
   * Non-null only for the metrics the workbook marks "breakdown if obtainable"
   * (B3 §29). DM-19: such a metric's whole value lives in
   * `disclosure_record.value_json` as `{total, breakdown: {…}}`.
   */
  breakdown_dimensions: {
    if_obtainable: boolean;
    dimensions: string[];
    source: string;
  } | null;
  guidance: string | null;
  sort_order: number;
  is_active: boolean;
};

/**
 * The 141 VSME metrics in `sort_order`. The assertion is a cast, not a check —
 * the checks live where they can fail loudly: the generator refuses to write a
 * file that violates them, and `metric-catalog.integration.test.ts` re-derives
 * every one of them from the seeded table.
 */
export const VSME_METRICS = metrics as VsmeMetric[];
