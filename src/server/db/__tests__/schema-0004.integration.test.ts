/**
 * [LOCAL-DB] T1.2 — the Phase-1 data model (`drizzle/0004_data_model.sql`).
 *
 * Nothing in the application reads these 20 tables yet, so there is no
 * behaviour to test through a route. What CAN go wrong at this stage is exactly
 * two things, and this suite is built around them:
 *
 *   1. A FORGOTTEN COLUMN. 195 Data-Dictionary fields (К-1…К-10) were mapped
 *      onto 353 columns across 20 tables by hand. A field that never made it
 *      into the DDL would surface three stages later as a missing API field, at
 *      which point fixing it costs a migration on a live database. So
 *      `EXPECTED_COLUMNS` below restates spec §4 INDEPENDENTLY — transcribed
 *      from the spec, not copied from `schema.ts` — and is compared for exact
 *      set equality against `information_schema.columns`. Exact, not "contains":
 *      a column nobody meant to add is drift too. The oracle carries the TYPE
 *      and the NULLABILITY of every column, not just its name: a `numeric` that
 *      becomes `double precision`, or a NOT NULL quietly relaxed, is the same
 *      class of defect as a missing column and just as expensive to find later.
 *
 *   2. A COPY-PASTED MIXIN. The D23 lifecycle columns are declared once, in
 *      `../lifecycle.ts`, and spread into four tables. The tempting check —
 *      "grep proves `previous_version_id` appears only once in schema.ts" — is
 *      worthless: a copy-paste with a renamed variable passes it. The check
 *      here is POSITIVE and made against the database: all 20 mixin columns
 *      must exist on all four input tables with the same type and the same
 *      nullability. The single documented exception is `metric_key`, which
 *      DM-18 narrows to NOT NULL on `disclosure_record`.
 *
 * Plus the structural guarantees the design leans on: every actor FK points at
 * `profiles` (DM-13); the eight partial/expression indexes really exist —
 * declared in BOTH files (R-1 pair, name AND predicate on both sides), present
 * in `pg_indexes` with their predicate/expression intact, and where they are
 * unique, proven by a constraint violation; the three CHECKs rendered from
 * `@/shared/enums` really carry the enum's values; and `calculation` /
 * `report_render` refuse to let a revision be deleted out from under them
 * (AC-8) without that costing tenant deletion.
 *
 * The R-1 pair check needs no database and deliberately runs outside
 * `describeIntegration`: schema.ts/`.sql` drift is a real risk on every commit,
 * not only on machines with Postgres.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  APPLICABILITY_STATUSES,
  FACTOR_STATUSES,
  WORKFLOW_STATUSES,
} from "@/shared/enums";

import {
  calculation,
  companies,
  factorSet,
  legalEntity,
  reportRevision,
  reportingPeriod,
  unitConversion,
  validationResult,
} from "../schema";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "./harness";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SQL_FILE = path.join(REPO_ROOT, "drizzle/0004_data_model.sql");
const SCHEMA_FILE = path.join(REPO_ROOT, "src/server/db/schema.ts");

// ─── The spec, restated ──────────────────────────────────────────────────────

/** One column of the oracle: `information_schema` type + nullability. */
type Col = { name: string; type: string; nullable: boolean };

/** Reads better than `true` at the end of a `col(…)` call. */
const NULLABLE = true;

/** `col(name, type)` is NOT NULL; `col(name, type, NULLABLE)` is not. */
const col = (name: string, type: string, nullable = false): Col => ({
  name,
  type,
  nullable,
});

/** The 20 lifecycle-mixin columns, spec §4.8 (DM-11), in the spec's order. */
const MIXIN_COLUMNS = [
  "id",
  "company_id",
  "revision_id",
  "legal_entity_id",
  "facility_id",
  "asset_id",
  "metric_key",
  "year_month",
  "unit",
  "state",
  "approved_by",
  "approved_at",
  "notes",
  "previous_version_id",
  "superseded_by_id",
  "change_reason",
  "is_deleted",
  "actor_id",
  "actor_role",
  "created_at",
] as const;

/** `information_schema` type + nullability of each mixin column (spec §4.8). */
const MIXIN_SHAPE: Record<string, { type: string; nullable: boolean }> = {
  id: { type: "uuid", nullable: false },
  company_id: { type: "uuid", nullable: false },
  revision_id: { type: "uuid", nullable: false },
  legal_entity_id: { type: "uuid", nullable: false },
  facility_id: { type: "uuid", nullable: true },
  asset_id: { type: "uuid", nullable: true },
  metric_key: { type: "text", nullable: true }, // NOT NULL on disclosure_record
  year_month: { type: "text", nullable: true },
  unit: { type: "text", nullable: true },
  state: { type: "text", nullable: false },
  approved_by: { type: "uuid", nullable: true },
  approved_at: { type: "timestamp with time zone", nullable: true },
  notes: { type: "text", nullable: true },
  previous_version_id: { type: "uuid", nullable: true },
  superseded_by_id: { type: "uuid", nullable: true },
  change_reason: { type: "text", nullable: true },
  is_deleted: { type: "boolean", nullable: false },
  actor_id: { type: "uuid", nullable: false },
  actor_role: { type: "text", nullable: true },
  created_at: { type: "timestamp with time zone", nullable: false },
};

/** The four input tables the mixin is spread into (spec §4.9–4.12). */
const INPUT_TABLES = [
  "emission_activity",
  "purchased_energy_activity",
  "contractual_instrument",
  "disclosure_record",
] as const;

/** The mixin as oracle rows — spread into three of the four input tables. */
const MIXIN_SPEC: readonly Col[] = MIXIN_COLUMNS.map((name) =>
  col(name, MIXIN_SHAPE[name].type, MIXIN_SHAPE[name].nullable),
);

/** …and the fourth: DM-18 narrows `metric_key` to NOT NULL there. */
const DISCLOSURE_MIXIN_SPEC: readonly Col[] = MIXIN_SPEC.map((c) =>
  c.name === "metric_key" ? col(c.name, c.type) : c,
);

/**
 * Every column of spec §4, per table — the DD parity oracle. Transcribed from
 * the spec section named beside each table; the only addition is
 * `report_render.language` (О-14), marked where it appears.
 */
const EXPECTED_COLUMNS: Record<string, readonly Col[]> = {
  // §4.13 DM-20
  metric_catalog: [
    col("metric_key", "text"),
    col("standard", "text"),
    col("pillar", "text"),
    col("module", "text"),
    col("disclosure_code", "text"),
    col("disclosure_title", "text", NULLABLE),
    // О-20 — the standard's English wording, what the `en` renderer prints
    col("disclosure_title_en", "text", NULLABLE),
    col("paragraph", "text", NULLABLE),
    col("requirement_type", "text"),
    col("title", "text"),
    col("title_en", "text", NULLABLE),
    col("description", "text", NULLABLE),
    col("unit", "text", NULLABLE),
    col("applicability_condition", "text", NULLABLE),
    col("value_type", "text"),
    col("breakdown_dimensions", "jsonb", NULLABLE),
    col("guidance", "text", NULLABLE),
    col("sort_order", "integer"),
    col("is_active", "boolean"),
    // 0017 — Slovene headings (official, Recommendation (EU) 2025/1710 SL) and
    // datapoint titles (0018); ADDED at the end by ALTER, hence listed last.
    col("disclosure_title_sl", "text", NULLABLE),
    col("title_sl", "text", NULLABLE),
    // 0019 — the simplified-ESRS mapping from the expert's checklist.
    col("esrs_reference", "text", NULLABLE),
    col("esrs_applicability", "text", NULLABLE),
    col("client_data_source", "text", NULLABLE),
    col("regulatory_status", "text", NULLABLE),
    col("official_source", "text", NULLABLE),
  ],
  // §4.14 DM-21
  factor_set: [
    col("id", "uuid"),
    col("code", "text"),
    col("name", "text"),
    col("description", "text", NULLABLE),
    col("status", "text"),
    col("published_at", "timestamp with time zone", NULLABLE),
    col("created_at", "timestamp with time zone"),
  ],
  // §4.14 DM-22 — the 24 DD fields + id + factor_set_id + `supplier_name`
  emission_factor: [
    col("id", "uuid"),
    col("factor_set_id", "uuid"),
    col("factor_code", "text"),
    col("factor_name", "text"),
    col("source_name", "text"),
    col("source_version", "text"),
    // 0007 — beyond the DD, deliberately and for the same class of reason as
    // `report_render.language`: CALC-2's top rung is "the SUPPLIER'S own
    // factor", and until this column existed the table could not say whose,
    // so the rung matched any supplier-sourced row and priced one seller's
    // electricity with another's number.
    col("supplier_name", "text", NULLABLE),
    col("publication_date", "date", NULLABLE),
    col("applicable_year", "integer", NULLABLE),
    col("geography", "text"),
    col("activity_type", "text"),
    col("input_unit", "text"),
    col("factor_value", "numeric"),
    col("output_unit", "text"),
    col("co2_value", "numeric", NULLABLE),
    col("ch4_value", "numeric", NULLABLE),
    col("n2o_value", "numeric", NULLABLE),
    col("gwp_basis", "text", NULLABLE),
    col("wtt_included", "boolean"),
    col("biogenic_treatment", "text", NULLABLE),
    col("rf_included", "boolean", NULLABLE),
    col("valid_from", "date", NULLABLE),
    col("valid_to", "date", NULLABLE),
    col("source_url", "text", NULLABLE),
    col("source_locator", "text", NULLABLE),
    col("licence", "text", NULLABLE),
    col("status", "text"),
  ],
  // §4.15 DM-23
  unit_conversion: [
    col("id", "uuid"),
    col("from_unit", "text"),
    col("to_unit", "text"),
    col("multiplier", "numeric"),
    col("activity_context", "text", NULLABLE),
    col("factor_set_id", "uuid", NULLABLE), // 0010
    col("source", "text", NULLABLE),
    col("notes", "text", NULLABLE),
  ],
  // §4.2 DM-2 — the 18 Phase-1 DD fields + id/company_id/timestamps
  legal_entity: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("name", "text"),
    col("registration_number", "text", NULLABLE),
    col("vat_number", "text", NULLABLE),
    col("registered_address", "text", NULLABLE),
    col("country", "character", NULLABLE),
    col("nace_code", "text", NULLABLE),
    col("reporting_currency", "character", NULLABLE),
    col("employee_count", "integer", NULLABLE),
    col("average_fte", "numeric", NULLABLE),
    col("turnover", "numeric", NULLABLE),
    col("group_structure_type", "text", NULLABLE),
    col("parent_legal_entity_id", "uuid", NULLABLE),
    col("consolidation_method", "text", NULLABLE),
    col("ownership_percentage", "numeric", NULLABLE),
    col("effective_from", "date", NULLABLE),
    col("effective_to", "date", NULLABLE),
    col("exclusion_reason", "text", NULLABLE),
    col("created_at", "timestamp with time zone", NULLABLE),
    col("updated_at", "timestamp with time zone", NULLABLE),
  ],
  // §4.3 DM-5 — the 14 Phase-1 DD fields, names 1:1
  facility: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("legal_entity_id", "uuid"),
    col("facility_name", "text"),
    col("facility_type", "text", NULLABLE),
    col("address", "text", NULLABLE),
    col("country", "character", NULLABLE),
    col("postal_code", "text", NULLABLE),
    col("latitude", "numeric", NULLABLE),
    col("longitude", "numeric", NULLABLE),
    col("tenure", "text", NULLABLE),
    col("control_status", "text", NULLABLE),
    col("floor_area", "numeric", NULLABLE),
    col("opening_date", "date", NULLABLE),
    col("closing_date", "date", NULLABLE),
    col("included_in_boundary", "boolean"),
    col("boundary_classification", "text", NULLABLE),
    col("created_at", "timestamp with time zone", NULLABLE),
    col("updated_at", "timestamp with time zone", NULLABLE),
  ],
  // §4.4 DM-6
  asset: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("legal_entity_id", "uuid"),
    col("facility_id", "uuid", NULLABLE),
    col("name", "text"),
    col("asset_type", "text"),
    col("identifier", "text", NULLABLE),
    col("notes", "text", NULLABLE),
    col("created_at", "timestamp with time zone", NULLABLE),
    col("updated_at", "timestamp with time zone", NULLABLE),
  ],
  // §4.5 DM-7 — 9 DD fields + reporting_basis (К-13); no period_status (К-4)
  reporting_period: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("period_name", "text"),
    col("start_date", "date"),
    col("end_date", "date"),
    col("reporting_year", "integer"),
    col("base_year", "integer", NULLABLE),
    col("reporting_basis", "text"),
    col("methodology_version", "text"),
    col("factor_set_id", "uuid"),
    col("comparative_period_id", "uuid", NULLABLE),
    col("created_by", "uuid", NULLABLE),
    col("created_at", "timestamp with time zone", NULLABLE),
    col("updated_at", "timestamp with time zone", NULLABLE),
  ],
  // §4.6 DM-8
  period_scope: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("period_id", "uuid"),
    col("legal_entity_id", "uuid"),
    col("status", "text"),
    col("exclusion_reason", "text", NULLABLE),
    col("updated_by", "uuid", NULLABLE),
    col("updated_at", "timestamp with time zone", NULLABLE),
  ],
  // §4.7 DM-10 — all 8 DD `validation_approval` fields land here or in the
  // mixin; + `reviewed_by`/`locked_by` (О-16)
  report_revision: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("period_id", "uuid"),
    col("revision_no", "integer"),
    col("status", "text"),
    col("is_current", "boolean"),
    col("assigned_to", "uuid", NULLABLE),
    col("review_comment", "text", NULLABLE),
    col("reviewed_by", "uuid", NULLABLE),
    col("reviewed_at", "timestamp with time zone", NULLABLE),
    col("approved_by", "uuid", NULLABLE),
    col("approved_at", "timestamp with time zone", NULLABLE),
    col("change_reason", "text", NULLABLE),
    col("seeded_from_revision_id", "uuid", NULLABLE),
    col("submitted_by", "uuid", NULLABLE),
    col("submitted_at", "timestamp with time zone", NULLABLE),
    col("locked_by", "uuid", NULLABLE),
    col("locked_at", "timestamp with time zone", NULLABLE),
    col("frozen_scope", "jsonb", NULLABLE),
    col("created_by", "uuid"),
    col("created_at", "timestamp with time zone"),
  ],
  // §4.9 DM-15 — mixin + body (40 DD fields via К-6 + 6 refrigerant fields К-5)
  emission_activity: [
    ...MIXIN_SPEC,
    col("activity_category", "text"),
    col("source_name", "text"),
    col("activity_type", "text"),
    col("activity_value", "numeric"),
    col("method", "text"),
    col("biogenic_flag", "boolean", NULLABLE),
    col("refrigerant_added", "numeric", NULLABLE),
    col("refrigerant_recovered", "numeric", NULLABLE),
    col("equipment_capacity", "numeric", NULLABLE),
    col("opening_stock", "numeric", NULLABLE),
    col("closing_stock", "numeric", NULLABLE),
    col("leakage_rate", "numeric", NULLABLE),
  ],
  // §4.10 DM-16 — mixin + body (32 DD fields via К-6)
  purchased_energy_activity: [
    ...MIXIN_SPEC,
    col("energy_type", "text"),
    col("supplier", "text", NULLABLE),
    col("meter_asset_id", "uuid", NULLABLE),
    col("consumption", "numeric"),
    col("renewable_share", "numeric", NULLABLE),
    col("location_factor_id", "uuid", NULLABLE),
    col("market_factor_id", "uuid", NULLABLE),
  ],
  // §4.11 DM-17 — mixin + the 10 DD fields, names 1:1
  contractual_instrument: [
    ...MIXIN_SPEC,
    col("instrument_type", "text"),
    col("certificate_id", "text", NULLABLE),
    col("covered_volume", "numeric", NULLABLE),
    col("production_country", "character", NULLABLE),
    col("technology", "text", NULLABLE),
    col("generation_period_start", "date", NULLABLE),
    col("generation_period_end", "date", NULLABLE),
    col("cancellation_date", "date", NULLABLE),
    col("quality_criteria_status", "text", NULLABLE),
    col("residual_mix_volume", "numeric", NULLABLE),
  ],
  // §4.12 DM-18 — mixin (metric_key narrowed) + the typed value columns
  disclosure_record: [
    ...DISCLOSURE_MIXIN_SPEC,
    col("value_type", "text"),
    col("value_numeric", "numeric", NULLABLE),
    col("value_text", "text", NULLABLE),
    col("value_boolean", "boolean", NULLABLE),
    col("value_date", "date", NULLABLE),
    col("value_json", "jsonb", NULLABLE),
  ],
  // §4.16 DM-24 — the 11 DD evidence fields split by К-8
  document: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("file_name", "text"),
    col("file_type", "text"),
    col("mime", "text", NULLABLE),
    col("storage_key", "text"),
    col("size_bytes", "bigint", NULLABLE),
    col("file_hash", "character"),
    col("issuer", "text", NULLABLE),
    col("document_date", "date", NULLABLE),
    col("coverage_start", "date", NULLABLE),
    col("coverage_end", "date", NULLABLE),
    col("confidentiality", "text"),
    col("retention_date", "date", NULLABLE),
    col("uploaded_by", "uuid"),
    col("uploaded_at", "timestamp with time zone"),
  ],
  // §4.16 DM-25
  evidence_link: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("document_id", "uuid"),
    col("linked_object_type", "text"),
    col("linked_object_id", "uuid"),
    col("created_by", "uuid", NULLABLE),
    col("created_at", "timestamp with time zone", NULLABLE),
  ],
  // §4.17 DM-27 — the 9 DD fields + the К-16 override pair
  dq_assessment: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("object_type", "text"),
    col("object_id", "uuid"),
    col("reliability_score", "integer", NULLABLE),
    col("temporal_score", "integer", NULLABLE),
    col("geographical_score", "integer", NULLABLE),
    col("technology_score", "integer", NULLABLE),
    col("completeness_score", "numeric", NULLABLE),
    col("coverage_score", "numeric", NULLABLE),
    col("quality_tier", "text", NULLABLE),
    col("estimate_uncertainty", "numeric", NULLABLE),
    col("quality_comment", "text", NULLABLE),
    col("is_overridden", "boolean"),
    col("override_reason", "text", NULLABLE),
    col("assessed_by", "uuid", NULLABLE),
    col("assessed_at", "timestamp with time zone", NULLABLE),
  ],
  // §4.18 DM-28
  validation_result: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("rule_code", "text"),
    col("scope", "text"),
    col("object_type", "text", NULLABLE),
    col("object_id", "uuid", NULLABLE),
    col("revision_id", "uuid", NULLABLE),
    col("passed", "boolean"),
    col("severity", "text"),
    col("blocking", "boolean"),
    col("message", "text"),
    col("evaluated_at", "timestamp with time zone"),
  ],
  // §4.19 DM-29 — the 14 DD fields + К-20/К-25 additions
  calculation: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("revision_id", "uuid"),
    col("run_id", "uuid"),
    col("activity_table", "text"),
    col("activity_row_id", "uuid"),
    col("method_code", "text"),
    col("formula_version", "text"),
    col("input_value", "numeric"),
    col("input_unit", "text"),
    col("conversion_factor", "numeric"),
    col("factor_id", "uuid", NULLABLE),
    col("factor_snapshot", "jsonb"),
    col("scope", "text"),
    col("scope3_category", "text", NULLABLE),
    col("reporting_basis", "text", NULLABLE),
    col("co2e_result", "numeric"),
    col("biogenic_co2_result", "numeric", NULLABLE),
    col("rounding_rule", "text"),
    col("calculated_at", "timestamp with time zone"),
    col("calculation_status", "text"),
  ],
  // §4.20 DM-30 + `language` (О-14 — the one column the plan adds to the spec)
  report_render: [
    col("id", "uuid"),
    col("company_id", "uuid"),
    col("revision_id", "uuid"),
    col("pack_code", "text"),
    col("format", "text"),
    col("language", "text"),
    col("storage_key", "text"),
    col("file_hash", "character"),
    col("coverage_claim", "text"),
    col("completeness_note", "text", NULLABLE),
    col("excluded_by_plan", "jsonb"),
    col("disclaimer_text", "text"),
    col("calc_run_id", "uuid"),
    col("rendered_by", "uuid"),
    col("rendered_at", "timestamp with time zone"),
  ],
};

/**
 * Every actor column of the model (DM-13). `approved_by`/`actor_id` come from
 * the mixin, the rest are named individually by §4. All must reference
 * `profiles` — the `audit_log.user_id` convention, valid because
 * `profiles.id` IS `user.id`.
 */
const ACTOR_COLUMNS: readonly (readonly [string, string])[] = [
  ["reporting_period", "created_by"],
  ["period_scope", "updated_by"],
  ["report_revision", "assigned_to"],
  ["report_revision", "reviewed_by"], // О-16
  ["report_revision", "approved_by"],
  ["report_revision", "submitted_by"],
  ["report_revision", "locked_by"], // О-16
  ["report_revision", "created_by"],
  ...INPUT_TABLES.flatMap(
    (t) =>
      [
        [t, "approved_by"],
        [t, "actor_id"],
      ] as const,
  ),
  ["document", "uploaded_by"],
  ["evidence_link", "created_by"],
  ["dq_assessment", "assessed_by"],
  ["report_render", "rendered_by"],
];

/**
 * The eight hand-authored partial/expression indexes (spec §4.21) — the R-1
 * pair, with BOTH sides pinned:
 *
 *   - `frag` matches `pg_indexes.indexdef` in the live database, i.e. what the
 *     `.sql` actually created. It carries the part `drizzle-kit` cannot emit —
 *     the reason the index is hand-authored at all — so a rename that dropped
 *     the predicate fails loudly.
 *
 *   - `schemaFrag` matches the DECLARATION in `schema.ts`, expression by
 *     expression. Checking only that the NAME appears in both files (which is
 *     all this used to do) misses exactly the failure R-1 exists to prevent:
 *     the `.sql` keeps its predicate, `schema.ts` loses or changes one, and the
 *     two quietly describe different indexes. Nothing in the toolchain compares
 *     them, so this regex is the comparison. It is deliberately literal — if a
 *     legitimate edit reformats a declaration, update the regex WITH the pair.
 */
const PAIRED_INDEXES: readonly {
  name: string;
  table: string;
  frag: RegExp;
  schemaFrag: RegExp;
}[] = [
  {
    name: "emission_activity_current_idx",
    table: "emission_activity",
    frag: /WHERE \(superseded_by_id IS NULL\)/i,
    schemaFrag:
      /index\("emission_activity_current_idx"\)\s*\.on\(t\.revisionId\)\s*\.where\(sql`\$\{t\.supersededById\} IS NULL`\)/,
  },
  {
    name: "purchased_energy_activity_current_idx",
    table: "purchased_energy_activity",
    frag: /WHERE \(superseded_by_id IS NULL\)/i,
    schemaFrag:
      /index\("purchased_energy_activity_current_idx"\)\s*\.on\(t\.revisionId\)\s*\.where\(sql`\$\{t\.supersededById\} IS NULL`\)/,
  },
  {
    name: "contractual_instrument_current_idx",
    table: "contractual_instrument",
    frag: /WHERE \(superseded_by_id IS NULL\)/i,
    schemaFrag:
      /index\("contractual_instrument_current_idx"\)\s*\.on\(t\.revisionId\)\s*\.where\(sql`\$\{t\.supersededById\} IS NULL`\)/,
  },
  {
    name: "disclosure_record_current_idx",
    table: "disclosure_record",
    frag: /WHERE \(superseded_by_id IS NULL\)/i,
    schemaFrag:
      /index\("disclosure_record_current_idx"\)\s*\.on\(t\.revisionId\)\s*\.where\(sql`\$\{t\.supersededById\} IS NULL`\)/,
  },
  {
    name: "report_revision_period_current_key",
    table: "report_revision",
    frag: /UNIQUE INDEX .* WHERE is_current/i,
    schemaFrag:
      /uniqueIndex\("report_revision_period_current_key"\)\s*\.on\(t\.periodId\)\s*\.where\(sql`\$\{t\.isCurrent\}`\)/,
  },
  {
    // О-18: the key is year-aware, and `applicable_year` is nullable (the 14
    // refrigerant factors leave it NULL). Both regexes pin the COALESCE — drop
    // it back to a plain UNIQUE and NULLs go distinct again, which is a
    // duplicate factor VAL-031 was written to forbid, not a formatting nit.
    // 0007 appended `COALESCE(supplier_name, '--')`: two DIFFERENT suppliers
    // answer two different questions for one (set, activity, geography, unit,
    // year), so a key blind to the supplier would report them to an admin as
    // duplicate factors — and, being nullable, the column needs its own
    // sentinel or the 440 supplier-less rows leave the key entirely.
    name: "emission_factor_resolution_key",
    table: "emission_factor",
    frag: /UNIQUE INDEX .*\(factor_set_id, source_name, source_version, activity_type, geography, input_unit, COALESCE\(applicable_year, '-1'::integer\), COALESCE\(supplier_name, '--'::text\)\)/i,
    schemaFrag:
      /uniqueIndex\("emission_factor_resolution_key"\)\s*\.on\(\s*t\.factorSetId,\s*t\.sourceName,\s*t\.sourceVersion,\s*t\.activityType,\s*t\.geography,\s*t\.inputUnit,\s*sql`COALESCE\(\$\{t\.applicableYear\}, -1\)`,\s*sql`COALESCE\(\$\{t\.supplierName\}, '--'\)`,\s*\)/,
  },
  {
    // 0010 appended `COALESCE(factor_set_id, <zero uuid>)`. Both regexes pin it:
    // without the fourth component a set-scoped conversion collides with the
    // shared row it overrides, and with the COALESCE dropped the nullable column
    // goes DISTINCT again and two SHARED rows for one pair become representable
    // — which is what lets `calc/units.ts` take the first match inside a rung.
    name: "unit_conversion_from_to_context_key",
    table: "unit_conversion",
    frag: /UNIQUE INDEX .*\(from_unit, to_unit, COALESCE\(activity_context, '--'::text\), COALESCE\(factor_set_id, '00000000-0000-0000-0000-000000000000'::uuid\)\)/i,
    schemaFrag:
      /uniqueIndex\("unit_conversion_from_to_context_key"\)\s*\.on\(\s*t\.fromUnit,\s*t\.toUnit,\s*sql`COALESCE\(\$\{t\.activityContext\}, '--'\)`,\s*sql`COALESCE\(\$\{t\.factorSetId\}, '00000000-0000-0000-0000-000000000000'::uuid\)`,\s*\)/,
  },
  {
    // О-17: `company_id` LEADS the key. Both regexes pin that, on both sides —
    // losing the tenant column is a cross-tenant collision, not a formatting nit.
    name: "validation_result_target_key",
    table: "validation_result",
    frag: /UNIQUE INDEX .*\(company_id, rule_code, COALESCE\(object_type, '--'::text\)/i,
    schemaFrag:
      /uniqueIndex\("validation_result_target_key"\)\s*\.on\(\s*t\.companyId,\s*t\.ruleCode,\s*sql`COALESCE\(\$\{t\.objectType\}, '--'\)`,\s*sql`COALESCE\(\$\{t\.objectId\}, '00000000-0000-0000-0000-000000000000'::uuid\)`,\s*sql`COALESCE\(\$\{t\.revisionId\}, '00000000-0000-0000-0000-000000000000'::uuid\)`,\s*\)/,
  },
];

/**
 * The three CHECKs whose value list is RENDERED from a `@/shared/enums`
 * constant by `inList()` in `schema.ts`, while the `.sql` writes the literals
 * out by hand. That is a drift channel with nothing watching it: add a workflow
 * status and `schema.ts` follows automatically, the migration does not. So the
 * constraint definition read back from Postgres — i.e. what the `.sql` created
 * — is compared against the constant itself.
 */
const ENUM_CHECKS: readonly {
  table: string;
  constraint: string;
  column: string;
  values: readonly string[];
}[] = [
  {
    table: "factor_set",
    constraint: "factor_set_status_check",
    column: "status",
    values: FACTOR_STATUSES,
  },
  {
    table: "period_scope",
    constraint: "period_scope_status_check",
    column: "status",
    values: APPLICABILITY_STATUSES,
  },
  {
    table: "report_revision",
    constraint: "report_revision_status_check",
    column: "status",
    values: WORKFLOW_STATUSES,
  },
];

/**
 * Plain b-tree indexes added because a table's ONLY read path had none
 * (`evidence_link`'s UNIQUE leads with `document_id`, so "which documents back
 * THIS row" was a seq scan; `report_render` is only ever read by revision).
 * Not part of the R-1 eight — `drizzle-kit` could emit these — but new, so
 * their existence is asserted.
 */
const READ_PATH_INDEXES: readonly (readonly [string, string])[] = [
  ["evidence_link_object_idx", "evidence_link"],
  ["report_render_revision_idx", "report_render"],
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
};

async function readColumns(): Promise<ColumnRow[]> {
  const rows = await getTestDb().execute<ColumnRow>(
    sql`SELECT table_name, column_name, data_type, is_nullable
          FROM information_schema.columns
         WHERE table_schema = 'public'`,
  );
  return [...rows];
}

function columnsOf(rows: ColumnRow[], table: string): ColumnRow[] {
  return rows.filter((r) => r.table_name === table);
}

/** Sort comparator so oracle and database are compared shape-for-shape. */
const byName = (a: Col, b: Col) => a.name.localeCompare(b.name);

/** Unwrap the postgres.js error Drizzle wraps in a DrizzleQueryError. */
function pgError(err: unknown): { code?: string; constraint_name?: string } {
  const wrapped = err as {
    cause?: { code?: string; constraint_name?: string };
    code?: string;
    constraint_name?: string;
  };
  return wrapped.cause ?? wrapped;
}

/** Run `fn`, expecting it to fail; return the unwrapped Postgres error. */
async function expectPgFailure(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; constraint_name?: string }> {
  const err = await fn().then(
    () => null,
    (e: unknown) => e,
  );
  expect(
    err,
    "expected the statement to be rejected by the database",
  ).not.toBeNull();
  return pgError(err);
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * The minimal chain a revision needs: company → profile → factor set → legal
 * entity → period (pinning the set) → revision. Returned so the behaviour
 * tests can hang rows off it.
 */
async function seedRevisionChain() {
  const conn = getTestDb();
  const company = await insertCompany();
  const { profile } = await insertUserWithProfile({ companyId: company.id });
  const [set] = await conn
    .insert(factorSet)
    .values({ code: `t1.2-${uniq()}`, name: "T1.2 test set", status: "active" })
    .returning();
  const [entity] = await conn
    .insert(legalEntity)
    .values({ companyId: company.id, name: "Root Ltd" })
    .returning();
  const [period] = await conn
    .insert(reportingPeriod)
    .values({
      companyId: company.id,
      periodName: "FY2025",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      reportingYear: 2025,
      methodologyVersion: "GHGP-2015/VSME-2024.1",
      factorSetId: set.id,
    })
    .returning();
  const [revision] = await conn
    .insert(reportRevision)
    .values({
      companyId: company.id,
      periodId: period.id,
      revisionNo: 1,
      createdBy: profile.id,
    })
    .returning();
  return { company, profile, set, entity, period, revision };
}

/** A complete `report_render` row; `overrides` bend it into the failing shape. */
function renderRow(
  companyId: string,
  revisionId: string,
  renderedBy: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    company_id: companyId,
    revision_id: revisionId,
    format: "pdf",
    language: "en",
    storage_key: `renders/${uniq()}.pdf`,
    file_hash: "0".repeat(64),
    coverage_claim: "full",
    excluded_by_plan: "[]",
    disclaimer_text: "Test render",
    calc_run_id: "11111111-1111-1111-1111-111111111111",
    rendered_by: renderedBy,
    ...overrides,
  };
}

/** Insert a `report_render` with raw SQL so invalid values reach Postgres. */
async function insertRender(row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  const values = cols.map((c) => row[c]);
  await getTestDb().execute(
    sql`INSERT INTO report_render (id, ${sql.raw(cols.join(", "))})
        VALUES (gen_random_uuid(), ${sql.join(
          values.map((v) => sql`${v}`),
          sql`, `,
        )})`,
  );
}

// ─── R-1 pair check — no database needed ─────────────────────────────────────

describe("T1.2 — the eight hand-authored indexes are declared as PAIRS (R-1)", () => {
  const sqlText = readFileSync(SQL_FILE, "utf8");
  const schemaText = readFileSync(SCHEMA_FILE, "utf8");

  it.each(PAIRED_INDEXES)(
    "$name is declared in both 0004_data_model.sql and schema.ts",
    ({ name }) => {
      expect(
        sqlText,
        `${name} missing from drizzle/0004_data_model.sql`,
      ).toContain(name);
      expect(
        schemaText,
        `${name} missing from src/server/db/schema.ts`,
      ).toContain(name);
    },
  );

  // The name check above proves both files still MENTION the index. It does not
  // prove they still describe the SAME one — and a predicate that drifted in
  // schema.ts is precisely the failure R-1 exists to prevent. The DB-side
  // `frag` assertions (further down, integration only) validate the `.sql`; this
  // is the schema.ts half, and it runs with no database.
  it.each(PAIRED_INDEXES)(
    "$name keeps its exact predicate/expression in schema.ts",
    ({ name, schemaFrag }) => {
      expect(
        schemaText,
        `${name}: the declaration in src/server/db/schema.ts no longer matches ` +
          `${schemaFrag}. Either it drifted from drizzle/0004_data_model.sql ` +
          `(R-1 — fix the declaration) or it was legitimately reformatted ` +
          `(update this regex together with the pair).`,
      ).toMatch(schemaFrag);
    },
  );

  it("keeps 0004 in place at idx 4 and never rewrites 0000–0003", () => {
    // The journal must OPEN with these five entries, in this order. Later
    // migrations are appended after them (T3.9 added `0005_drop_legacy`), which
    // is the point: 0004 stays where it is, and nothing may be inserted before
    // it or renumbered — a database that already ran 0004 must keep matching the
    // journal by position, since the migrator compares `when` timestamps rather
    // than file hashes (see drizzle/README.md).
    const journal = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    expect(journal.entries.slice(0, 5).map((e) => e.tag)).toEqual([
      "0000_baseline",
      "0001_billing",
      "0002_data_integrity",
      "0003_users_roles",
      "0004_data_model",
    ]);
    const own = journal.entries[4];
    expect(own.idx).toBe(4);
    expect(own.when).toBeGreaterThan(1784937600000); // after 0003

    // Whatever follows is STRICTLY INCREASING in both idx and `when` — the only
    // shape the migrator can apply in order (it walks `entries` and compares
    // `when`, so a later migration must sort later than an earlier one).
    //
    // NOT CONTIGUOUS, and that is deliberate rather than a relaxation of the
    // guard. `idx` is a slot number, not a position: a migration authored on a
    // branch takes its number when it is WRITTEN, so two branches in flight hold
    // two numbers and each must keep its own — renumbering one at merge time
    // would change its `when`, which is exactly what a database that already ran
    // it cannot survive (see the paragraph above). 0009 leaves `idx: 8` empty for
    // `0008_fx_rates` for that reason. What the migrator needs is order, and
    // order is what is asserted; drizzle reads every file by TAG off this
    // journal, so an unused number is not a missing file.
    journal.entries.slice(5).forEach((entry, i) => {
      const previous = journal.entries[4 + i];
      expect(entry.idx).toBeGreaterThan(previous.idx);
      expect(entry.when).toBeGreaterThan(previous.when);
    });

    // Every entry's file EXISTS — the invariant contiguity was standing in for,
    // and the one whose absence actually breaks `migrate()` (it throws
    // "No file … found"). Cheap, exact, and blind to gaps in the numbering.
    for (const entry of journal.entries) {
      const file = path.join(REPO_ROOT, "drizzle", `${entry.tag}.sql`);
      expect(`${entry.tag}: ${existsSync(file)}`).toBe(`${entry.tag}: true`);
    }
  });

  it("reserves the reference-data tail for T1.4/T1.5/T1.8 (О-13, MIG-6)", () => {
    expect(sqlText).toContain(
      "-- === REFERENCE DATA (owners: T1.4 metrics, T1.5 factors/units, T1.8 plans.features) ===",
    );
  });
});

// ─── Everything below needs the database ─────────────────────────────────────

describeIntegration("T1.2 — the 0004 Phase-1 data model", () => {
  let columns: ColumnRow[] = [];

  beforeAll(async () => {
    await setupSchema();
    columns = await readColumns();
  });
  beforeEach(async () => {
    await resetAppTables();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  // ── 1. Column parity with spec §4 — the guard against a forgotten DD field ─
  describe("column parity with spec §4", () => {
    it.each(Object.keys(EXPECTED_COLUMNS))(
      "%s carries exactly the columns the spec defines, typed as it defines them",
      (table) => {
        // Sorted `Col[]` on both sides, so ONE assertion reports a missing
        // column, an unexpected column, a changed type and a relaxed NOT NULL
        // alike — and prints the whole shape when it fails.
        const actual = columnsOf(columns, table)
          .map((c) => col(c.column_name, c.data_type, c.is_nullable === "YES"))
          .sort(byName);
        expect(actual, `table ${table} is missing from 0004`).not.toHaveLength(
          0,
        );
        expect(actual).toEqual([...EXPECTED_COLUMNS[table]].sort(byName));
      },
    );

    // NOT a database assertion — it sums the oracle against itself. Its only job
    // is to notice the oracle SHRINKING: deleting a table's entry, or a handful
    // of its columns, would otherwise silently disable the parity check above
    // (an absent expectation is a passing one). The real DD-parity guard is the
    // per-table comparison; this is the canary that keeps it loaded.
    it("keeps the oracle at 20 tables and 364 columns (canary, not a DB check)", () => {
      expect(Object.keys(EXPECTED_COLUMNS)).toHaveLength(20);
      const total = Object.values(EXPECTED_COLUMNS).reduce(
        (n, cols) => n + cols.length,
        0,
      );
      // 350 as transcribed from spec §4, + `report_render.language` (О-14),
      // + `report_revision.reviewed_by` and `locked_by` (О-16),
      // + `metric_catalog.title_en` and `disclosure_title_en` (О-20),
      // + `emission_factor.supplier_name` (0007),
      // + `unit_conversion.factor_set_id` (0010).
      expect(total).toBe(364);
    });

    it("leaves `companies` untouched (DM-1)", () => {
      // 0004 must not have added, renamed or dropped anything on the tenant
      // table: the reporting profile moved to `legal_entity` semantically, not
      // by DDL. These four are the columns О-10 keeps alive.
      const names = columnsOf(columns, "companies").map((c) => c.column_name);
      for (const c of ["nace_code", "country", "headcount", "reporting_year"]) {
        expect(names).toContain(c);
      }
      expect(names).not.toContain("legal_entity_id");
    });
  });

  // ── 2. The mixin really is ONE declaration (positive check, not a grep) ────
  describe("lifecycle mixin (DM-11) — identical on all four input tables", () => {
    it.each(INPUT_TABLES)("%s carries all 20 mixin columns", (table) => {
      const byName = new Map(
        columnsOf(columns, table).map((c) => [c.column_name, c]),
      );
      for (const name of MIXIN_COLUMNS) {
        const col = byName.get(name);
        expect(col, `${table}.${name} is missing`).toBeDefined();
        const expected = MIXIN_SHAPE[name];
        // DM-18: the one documented narrowing of the mixin.
        const nullable =
          table === "disclosure_record" && name === "metric_key"
            ? false
            : expected.nullable;
        expect(col!.data_type, `${table}.${name} type`).toBe(expected.type);
        expect(col!.is_nullable === "YES", `${table}.${name} nullability`).toBe(
          nullable,
        );
      }
    });

    it("agrees column-for-column across the four tables", () => {
      // Cross-check independent of MIXIN_SHAPE: whatever the mixin emits, it
      // must emit the SAME thing four times. A copy-paste that drifted on one
      // table fails here even if it matched the expected shape by accident.
      for (const name of MIXIN_COLUMNS) {
        const shapes = INPUT_TABLES.map((t) => {
          const col = columnsOf(columns, t).find(
            (c) => c.column_name === name,
          )!;
          const nullable =
            t === "disclosure_record" && name === "metric_key"
              ? "NO(DM-18)"
              : col.is_nullable;
          return `${col.data_type}/${nullable}`;
        });
        const normalised = shapes.map((s) => s.replace("NO(DM-18)", "YES"));
        expect(new Set(normalised).size, `${name} differs: ${shapes}`).toBe(1);
      }
    });
  });

  // ── 3. DM-13 — every actor FK lands on `profiles` ─────────────────────────
  describe("actor foreign keys (DM-13)", () => {
    it("every actor column references profiles", async () => {
      const rows = await getTestDb().execute<{
        table_name: string;
        column_name: string;
        referenced_table: string;
      }>(sql`
        SELECT kcu.table_name       AS table_name,
               kcu.column_name      AS column_name,
               ref.table_name       AS referenced_table
          FROM information_schema.referential_constraints rc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name   = rc.constraint_name
           AND kcu.constraint_schema = rc.constraint_schema
          JOIN information_schema.key_column_usage ref
            ON ref.constraint_name   = rc.unique_constraint_name
           AND ref.constraint_schema = rc.unique_constraint_schema
           AND ref.ordinal_position  = kcu.position_in_unique_constraint
         WHERE kcu.constraint_schema = 'public'
      `);
      const targets = new Map(
        [...rows].map((r) => [
          `${r.table_name}.${r.column_name}`,
          r.referenced_table,
        ]),
      );
      for (const [table, column] of ACTOR_COLUMNS) {
        const key = `${table}.${column}`;
        expect(targets.get(key), `${key} has no FK`).toBeDefined();
        expect(targets.get(key), `${key} must reference profiles`).toBe(
          "profiles",
        );
      }
      // 18 as specified by §4, + `reviewed_by`/`locked_by` (О-16).
      expect(ACTOR_COLUMNS).toHaveLength(20);
    });
  });

  // ── 3b. The CHECKs rendered from `@/shared/enums` still say what it says ───
  describe("enum-backed CHECK constraints (§0.8)", () => {
    it.each(ENUM_CHECKS)(
      "$constraint carries exactly the values of its enum constant",
      async ({ table, constraint, column, values }) => {
        const [row] = await getTestDb().execute<{ def: string }>(
          sql`SELECT pg_get_constraintdef(c.oid) AS def
                FROM pg_constraint c
               WHERE c.conname = ${constraint}
                 AND c.conrelid = ${sql.raw(`'${table}'`)}::regclass`,
        );
        expect(row, `${constraint} not found on ${table}`).toBeDefined();
        // `schema.ts` builds this list from the constant via `inList()`, the
        // `.sql` writes the literals by hand, and NOTHING compares the two.
        // Postgres normalises the CHECK to `col = ANY (ARRAY[…::text])`, so the
        // literals it reports are what the migration really created.
        const literals = [...row.def.matchAll(/'([^']*)'::text/g)].map(
          (m) => m[1],
        );
        expect(
          literals,
          `${constraint} and its enum constant have drifted — ` +
            `the .sql hardcodes the list, schema.ts renders it from ` +
            `@/shared/enums, and only this test connects them`,
        ).toEqual([...values]);
        expect(row.def).toContain(column);
      },
    );

    it("refuses a supplier-sourced factor that names no supplier (0007)", async () => {
      // CALC-2's top rung resolves on `supplier_name`, and a row that claims
      // supplier provenance without naming a supplier is on NO rung at all —
      // it is excluded from `site_country`/`global` precisely so it cannot
      // serve as a country average. Storing one would store a row nothing can
      // ever use, so the column refuses it at the door.
      const conn = getTestDb();
      const [set] = await conn.execute<{ id: string }>(
        sql`SELECT id FROM factor_set WHERE code = 'legacy-v1' LIMIT 1`,
      );
      // Ids are APP-generated everywhere in this schema (`appUuidPk`), so the
      // raw INSERT supplies one rather than leaning on a column default.
      const insert = (supplier: string | null) =>
        conn.execute(sql`
          INSERT INTO emission_factor
            (id, factor_set_id, factor_code, factor_name, source_name,
             source_version, geography, activity_type, input_unit,
             factor_value, supplier_name)
          VALUES (${randomUUID()}, ${set.id}, 'supplier_probe',
                  'Supplier probe', 'supplier', '2025 disclosure', 'SI',
                  'grid:grid_electricity', 'kWh', '0.100', ${supplier})
        `);

      const err = await expectPgFailure(() => insert(null));
      expect(err.code).toBe("23514"); // check_violation
      expect(err.constraint_name).toBe("emission_factor_supplier_name_check");

      // Named, and the same row is accepted — the constraint is about the
      // missing identity, not about supplier factors as such.
      await insert("Zelena Energija d.o.o.");
      await conn.execute(
        sql`DELETE FROM emission_factor WHERE factor_code = 'supplier_probe'`,
      );
    });
  });

  // ── 4. The eight indexes exist in the DATABASE with their predicate intact ─
  describe("partial/expression indexes (§4.21)", () => {
    it.each(PAIRED_INDEXES)(
      "$name exists on $table with its predicate",
      async ({ name, table, frag }) => {
        const [row] = await getTestDb().execute<{ indexdef: string }>(
          sql`SELECT indexdef FROM pg_indexes
               WHERE schemaname = 'public' AND tablename = ${table}
                 AND indexname = ${name}`,
        );
        expect(row, `${name} not found on ${table}`).toBeDefined();
        expect(row.indexdef).toMatch(frag);
      },
    );

    it.each(READ_PATH_INDEXES)(
      "%s exists on %s — the read path that had no index",
      async (name, table) => {
        const [row] = await getTestDb().execute<{ indexdef: string }>(
          sql`SELECT indexdef FROM pg_indexes
               WHERE schemaname = 'public' AND tablename = ${table}
                 AND indexname = ${name}`,
        );
        expect(row, `${name} not found on ${table}`).toBeDefined();
      },
    );

    // The four `*_current_idx` are non-unique — presence + predicate above is
    // the whole of their contract. The three unique ones enforce behaviour:

    it("rejects a second current revision of the same period", async () => {
      const { company, profile, period } = await seedRevisionChain();
      // A second revision of the same period, also is_current → the partial
      // unique index is the only thing that can reject it (revision_no differs,
      // so report_revision_period_no_key cannot fire).
      const err = await expectPgFailure(() =>
        getTestDb().insert(reportRevision).values({
          companyId: company.id,
          periodId: period.id,
          revisionNo: 2,
          isCurrent: true,
          createdBy: profile.id,
        }),
      );
      expect(err.code).toBe("23505");
      expect(err.constraint_name).toBe("report_revision_period_current_key");

      // Standing the first revision down frees the slot — the predicate drops
      // non-current rows, which is how a restatement supersedes its parent.
      await getTestDb().execute(
        sql`UPDATE report_revision SET is_current = false WHERE period_id = ${period.id}`,
      );
      const [second] = await getTestDb()
        .insert(reportRevision)
        .values({
          companyId: company.id,
          periodId: period.id,
          revisionNo: 2,
          createdBy: profile.id,
        })
        .returning();
      expect(second.isCurrent).toBe(true);
    });

    it("collapses a NULL activity_context into one unit_conversion slot", async () => {
      const conn = getTestDb();
      const from = `t12-${uniq()}`;
      await conn
        .insert(unitConversion)
        .values({ fromUnit: from, toUnit: "kWh", multiplier: "1" });
      // Same pair, context still NULL → COALESCE(...,'--') makes it a duplicate.
      const err = await expectPgFailure(() =>
        conn
          .insert(unitConversion)
          .values({ fromUnit: from, toUnit: "kWh", multiplier: "2" }),
      );
      expect(err.code).toBe("23505");
      expect(err.constraint_name).toBe("unit_conversion_from_to_context_key");
      // A contextual conversion of the same pair is a DIFFERENT row (D7).
      await conn.insert(unitConversion).values({
        fromUnit: from,
        toUnit: "kWh",
        multiplier: "10.55",
        activityContext: "natural_gas",
      });
    });

    it("keeps one validation_result per (rule, target) even with NULL targets", async () => {
      const { company, revision } = await seedRevisionChain();
      const conn = getTestDb();
      const base = {
        companyId: company.id,
        ruleCode: "VAL-101",
        scope: "revision" as const,
        revisionId: revision.id,
        passed: false,
        severity: "error",
        blocking: true,
        message: "тестовое сообщение",
      };
      await conn.insert(validationResult).values(base);
      // object_type/object_id are NULL on both rows: without the COALESCE
      // placeholders a plain UNIQUE would let this through (NULL ≠ NULL).
      const err = await expectPgFailure(() =>
        conn.insert(validationResult).values({ ...base, passed: true }),
      );
      expect(err.code).toBe("23505");
      expect(err.constraint_name).toBe("validation_result_target_key");
    });

    it("scopes that uniqueness to the tenant (О-17)", async () => {
      const conn = getTestDb();
      // The worst case the leading `company_id` exists for: a rule with NO
      // target at all — every target column NULL, so all three COALESCE
      // placeholders collapse to the same value. Without `company_id` in front
      // this shape is unique across the whole INSTALLATION, and company A's row
      // would block company B's upsert.
      const a = await insertCompany();
      const b = await insertCompany();
      const row = (companyId: string) => ({
        companyId,
        ruleCode: "VAL-201",
        scope: "reference_org" as const,
        objectType: null,
        objectId: null,
        revisionId: null,
        passed: false,
        severity: "error",
        blocking: false,
        message: "тестовое сообщение",
      });
      await conn.insert(validationResult).values(row(a.id));
      await conn.insert(validationResult).values(row(b.id));

      // …and within one company the slot is still exactly one row.
      const err = await expectPgFailure(() =>
        conn.insert(validationResult).values({ ...row(a.id), passed: true }),
      );
      expect(err.code).toBe("23505");
      expect(err.constraint_name).toBe("validation_result_target_key");
    });
  });

  // ── 4b. Deleting a revision cannot silently discard its artefacts (AC-8) ───
  describe("derived-artefact FK actions", () => {
    /** A minimal `calculation` row hanging off a revision. */
    const calcRow = (companyId: string, revisionId: string) => ({
      companyId,
      revisionId,
      runId: "22222222-2222-2222-2222-222222222222",
      activityTable: "emission_activity",
      activityRowId: "33333333-3333-3333-3333-333333333333",
      methodCode: "activity_factor",
      formulaVersion: "v1",
      inputValue: "100",
      inputUnit: "kWh",
      factorSnapshot: {},
      scope: "scope2",
      co2eResult: "42",
      roundingRule: "half_up",
      calculationStatus: "ok",
    });

    it("refuses to delete a revision that has calculations or renders", async () => {
      const { company, profile, revision } = await seedRevisionChain();
      const conn = getTestDb();
      await conn.insert(calculation).values(calcRow(company.id, revision.id));
      await insertRender(renderRow(company.id, revision.id, profile.id));

      // NO ACTION, not CASCADE: the results and the render of a locked revision
      // are what make it reproducible, and the render's bytes live behind
      // `storage_key`. Deleting the revision would orphan both — so it is
      // rejected, loudly, instead of succeeding quietly.
      const err = await expectPgFailure(() =>
        conn.delete(reportRevision).where(eq(reportRevision.id, revision.id)),
      );
      expect(err.code).toBe("23503"); // foreign_key_violation
    });

    it("still deletes the whole tenant in one statement", async () => {
      const { company, profile, revision } = await seedRevisionChain();
      const conn = getTestDb();
      await conn.insert(calculation).values(calcRow(company.id, revision.id));
      await insertRender(renderRow(company.id, revision.id, profile.id));

      // The price of NO ACTION would be a tenant that cannot be deleted. It is
      // not: `company_id … ON DELETE CASCADE` reaches `calculation` and
      // `report_render` directly, and a NO ACTION FK is verified at END OF
      // STATEMENT — by which time the referencing rows are gone too.
      await conn.delete(companies).where(eq(companies.id, company.id));
      const [{ n }] = await conn.execute<{ n: number }>(
        sql`SELECT (SELECT count(*) FROM calculation WHERE company_id = ${company.id})
                 + (SELECT count(*) FROM report_render WHERE company_id = ${company.id})
                 + (SELECT count(*) FROM report_revision WHERE company_id = ${company.id})
                 AS n`,
      );
      expect(Number(n)).toBe(0);
    });
  });

  // ── 5. The render constraints, including the D14 invariant DM-31 ──────────
  describe("report_render constraints", () => {
    it("accepts en and sl but rejects any other language (О-14)", async () => {
      const { company, profile, revision } = await seedRevisionChain();
      for (const language of ["en", "sl"]) {
        await insertRender(
          renderRow(company.id, revision.id, profile.id, { language }),
        );
      }
      const err = await expectPgFailure(() =>
        insertRender(
          renderRow(company.id, revision.id, profile.id, { language: "de" }),
        ),
      );
      expect(err.code).toBe("23514"); // check_violation
      expect(err.constraint_name).toBe("report_render_language_check");
    });

    it("forbids a full coverage claim when the plan excluded entities (DM-31/D14)", async () => {
      const { company, profile, revision } = await seedRevisionChain();
      const excluded = JSON.stringify([
        { type: "facility", id: "f-1", name: "Second plant" },
      ]);

      // The forbidden combination: something was dropped, yet the render calls
      // itself complete. The database — not the renderer — refuses it.
      const err = await expectPgFailure(() =>
        insertRender(
          renderRow(company.id, revision.id, profile.id, {
            excluded_by_plan: excluded,
            coverage_claim: "full",
          }),
        ),
      );
      expect(err.code).toBe("23514");
      expect(err.constraint_name).toBe(
        "report_render_coverage_claim_d14_check",
      );

      // The same exclusions with an honest `partial` claim are fine, and so is
      // a `full` claim when nothing was excluded.
      await insertRender(
        renderRow(company.id, revision.id, profile.id, {
          excluded_by_plan: excluded,
          coverage_claim: "partial",
          completeness_note: "Second plant omitted on the Starter plan",
        }),
      );
      await insertRender(
        renderRow(company.id, revision.id, profile.id, {
          coverage_claim: "full",
        }),
      );
    });
  });
});
