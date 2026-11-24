#!/usr/bin/env node
/**
 * ONE-OFF GENERATOR — NOT part of the application runtime (plan T1.4/T1.5, О-13).
 *
 * Renders the Phase-1 reference data from `src/server/db/seed-data/*` into the
 * `-- === REFERENCE DATA ===` section of `drizzle/0004_data_model.sql`.
 *
 *   npx tsx scripts/gen-reference-sql.mjs
 *
 * (tsx, not bare node: the factor blocks read `src/server/db/seed-data/*.ts`
 * directly, which is the whole point — the migration and `seed.ts` must be two
 * renderings of ONE source, not two transcriptions of it.)
 *
 * ── Why the migration and not the seed ──────────────────────────────────────
 * `deploy.yml` ships `.next/standalone`, `scripts/migrate.mjs` and `drizzle/` to
 * the server and runs the migrator. It never ships `src/server/db/seed.ts`, and
 * `tsx` is a devDependency that never reaches the server either. A reference
 * table that exists only in the seed is therefore a table that is EMPTY in
 * production, forever. So the rows travel inside the migration, exactly as
 * `0002_data_integrity.sql` already does for `currencies`, and `seed.ts` stays a
 * thin wrapper over the same `seed-data/*` files so the two cannot disagree.
 * `metric-catalog.integration.test.ts` compares the two key sets and goes red if
 * they ever do.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * One entry in `BLOCKS` per reference table. Each renders an idempotent
 * `INSERT … ON CONFLICT … DO NOTHING;` wrapped in BEGIN/END marker comments, and
 * the whole marked region at the tail of 0004 is rewritten from the registry on
 * every run — so re-running never duplicates a block and never disturbs the DDL
 * above it.
 *
 * ── Order matters inside the section ────────────────────────────────────────
 * `emission_factor.factor_set_id` is a NOT NULL FK, so the `factor_set` block
 * has to precede the `emission_factor` block. The registry order IS the emitted
 * order; do not reshuffle it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLAN_SEED } from "../src/server/billing/plan-catalog.ts";
import {
  legacyFactorRows,
  LEGACY_FACTOR_SET,
} from "../src/server/db/seed-data/factor-set-v1.ts";
import { unitConversionRows } from "../src/server/db/seed-data/unit-conversions.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MIGRATION = path.join(REPO, "drizzle/0004_data_model.sql");

/** `plans.features` keys carried by a LATER migration than 0004. */
const KEYS_AFTER_0004 = ["simplifiedEsrs"];
const omitLaterKeys = (features) =>
  Object.fromEntries(
    Object.entries(features).filter(([key]) => !KEYS_AFTER_0004.includes(key)),
  );
const SECTION_MARKER = "-- === REFERENCE DATA (owners:";
const BEGIN = (id) => `-- >>> BEGIN GENERATED: ${id}`;
const END = (id) => `-- <<< END GENERATED: ${id}`;

// ─── SQL literals ────────────────────────────────────────────────────────────
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const text = (v) => (v === null || v === undefined ? "NULL" : quote(v));
const jsonb = (v) =>
  v === null || v === undefined ? "NULL" : `${quote(JSON.stringify(v))}::jsonb`;
const int = (v) => {
  if (!Number.isInteger(v)) throw new Error(`not an integer: ${v}`);
  return String(v);
};
const bool = (v) => {
  if (typeof v !== "boolean") throw new Error(`not a boolean: ${v}`);
  return v ? "true" : "false";
};

/**
 * `INSERT INTO <table> (<cols>) VALUES …  ON CONFLICT <target> <action>;`
 * `columns` is `[name, render]` pairs, so the column list and the value order
 * cannot drift apart.
 *
 * `action` defaults to `DO NOTHING` — the right conflict resolution for a
 * catalogue that is only ever ADDED to. A table whose EXISTING rows must be
 * brought forward by the migration (`plans`, T1.8) passes a `DO UPDATE …`
 * instead; it still has to be idempotent, which is why it is a parameter and
 * not a second copy of this function.
 */
function insertBlock({
  table,
  columns,
  rows,
  conflict,
  action = "DO NOTHING",
}) {
  const names = columns.map(([name]) => name);
  const values = rows.map(
    (row) => `  (${columns.map(([, render]) => render(row)).join(", ")})`,
  );
  return [
    `INSERT INTO ${table} (`,
    `  ${names.join(", ")}`,
    `) VALUES`,
    values.join(",\n"),
    // An empty `conflict` means the bare `ON CONFLICT DO NOTHING`, which needs no
    // arbiter — the only form available when the unique constraint is a
    // hand-written COALESCE expression index (`unit_conversion`).
    ["ON CONFLICT", conflict, `${action};`].filter(Boolean).join(" "),
  ].join("\n");
}

// ─── Blocks ──────────────────────────────────────────────────────────────────
const readJson = (rel) =>
  JSON.parse(readFileSync(path.join(REPO, rel), "utf8"));

const BLOCKS = [
  {
    id: "metric_catalog",
    owner: "T1.4",
    render() {
      const metrics = readJson("src/server/db/seed-data/vsme-metrics.json");
      if (metrics.length !== 141)
        throw new Error(
          `vsme-metrics.json holds ${metrics.length} records, expected 141 ` +
            `(MIG-3) — regenerate it with scripts/gen-vsme-metrics.mjs`,
        );
      const sql = insertBlock({
        table: "metric_catalog",
        conflict: "(metric_key)",
        rows: metrics,
        columns: [
          ["metric_key", (m) => text(m.metric_key)],
          ["standard", (m) => text(m.standard)],
          ["pillar", (m) => text(m.pillar)],
          ["module", (m) => text(m.module)],
          ["disclosure_code", (m) => text(m.disclosure_code)],
          ["disclosure_title", (m) => text(m.disclosure_title)],
          ["disclosure_title_en", (m) => text(m.disclosure_title_en)],
          ["paragraph", (m) => text(m.paragraph)],
          ["requirement_type", (m) => text(m.requirement_type)],
          ["title", (m) => text(m.title)],
          ["title_en", (m) => text(m.title_en)],
          ["description", (m) => text(m.description)],
          ["unit", (m) => text(m.unit)],
          ["applicability_condition", (m) => text(m.applicability_condition)],
          ["value_type", (m) => text(m.value_type)],
          ["breakdown_dimensions", (m) => jsonb(m.breakdown_dimensions)],
          ["guidance", (m) => text(m.guidance)],
          ["sort_order", (m) => int(m.sort_order)],
          ["is_active", (m) => bool(m.is_active)],
        ],
      });
      return {
        comment: [
          `-- DM-20 / MIG-3 — the VSME metric catalogue, ${metrics.length} rows, generated from`,
          "-- `src/server/db/seed-data/vsme-metrics.json` (itself generated from the two",
          "-- workbooks by `scripts/gen-vsme-metrics.mjs`). The 223 ESRS/GRI rows of the same",
          "-- catalogue are Phase 4 (К-26) and are deliberately NOT here.",
          "-- DO NOT EDIT BY HAND: rerun `node scripts/gen-reference-sql.mjs`.",
        ].join("\n"),
        sql,
      };
    },
  },
  {
    id: "factor_set",
    owner: "T1.5",
    render: () => ({
      comment: [
        "-- DM-21 / MIG-4 — the Phase-1 factor set. `status='active'` because a period may",
        "-- only pin an ACTIVE set, and `reporting_period.factor_set_id` is NOT NULL: with",
        "-- no row here production cannot create a reporting period at all (О-13).",
        "-- The id is fixed (UUIDv5 of the code) so the emission_factor block below can",
        "-- reference it as a literal and the seed writes the very same row.",
        "-- DO NOT EDIT BY HAND: rerun `npx tsx scripts/gen-reference-sql.mjs`.",
      ].join("\n"),
      sql: insertBlock({
        table: "factor_set",
        conflict: "(code)",
        rows: [LEGACY_FACTOR_SET],
        columns: [
          ["id", (s) => quote(s.id)],
          ["code", (s) => text(s.code)],
          ["name", (s) => text(s.name)],
          ["description", (s) => text(s.description)],
          ["status", (s) => text(s.status)],
          ["published_at", (s) => quote(s.published_at)],
        ],
      }),
    }),
  },
  {
    id: "emission_factor",
    owner: "T1.5",
    render() {
      const factors = legacyFactorRows();
      // The legacy set is 440 rows and the count is derived from the arrays, not
      // written down — but a block that silently rendered 0 rows would emit
      // `VALUES` with nothing after it and take production down at migrate time.
      if (factors.length === 0)
        throw new Error("legacyFactorRows() produced no rows");
      return {
        comment: [
          `-- DM-22 / MIG-4 — the ${factors.length} factors of set 'legacy-v1', normalised onto the`,
          "-- CALC-2 resolve key (activity_type, geography, input_unit, applicable_year) by",
          "-- `src/server/db/seed-data/legacy-normalisation.ts`. `ON CONFLICT DO NOTHING` has",
          "-- no arbiter named on purpose: both the primary key and the VAL-031 unique index",
          "-- `emission_factor_resolution_key` must be a no-op on a re-run.",
          "-- `source_url`/`licence` are the literal 'unspecified' (MIG-4) — absent in the",
          "-- source and said out loud rather than guessed.",
          "-- DO NOT EDIT BY HAND: rerun `npx tsx scripts/gen-reference-sql.mjs`.",
        ].join("\n"),
        sql: insertBlock({
          table: "emission_factor",
          conflict: "",
          rows: factors,
          columns: [
            ["id", (f) => quote(f.id)],
            ["factor_set_id", () => quote(LEGACY_FACTOR_SET.id)],
            ["factor_code", (f) => text(f.factor_code)],
            ["factor_name", (f) => text(f.factor_name)],
            ["source_name", (f) => text(f.source_name)],
            ["source_version", (f) => text(f.source_version)],
            [
              "applicable_year",
              (f) =>
                f.applicable_year === null ? "NULL" : int(f.applicable_year),
            ],
            ["geography", (f) => text(f.geography)],
            ["activity_type", (f) => text(f.activity_type)],
            ["input_unit", (f) => text(f.input_unit)],
            ["factor_value", (f) => quote(f.factor_value)],
            ["output_unit", (f) => text(f.output_unit)],
            ["gwp_basis", (f) => text(f.gwp_basis)],
            ["wtt_included", (f) => bool(f.wtt_included)],
            ["biogenic_treatment", (f) => text(f.biogenic_treatment)],
            [
              "rf_included",
              (f) => (f.rf_included === null ? "NULL" : bool(f.rf_included)),
            ],
            ["source_url", (f) => text(f.source_url)],
            ["licence", (f) => text(f.licence)],
            ["status", (f) => text(f.status)],
          ],
        }),
      };
    },
  },
  {
    id: "unit_conversion",
    owner: "T1.5",
    render() {
      const conversions = unitConversionRows();
      if (conversions.length === 0)
        throw new Error("unitConversionRows() produced no rows");
      return {
        comment: [
          `-- DM-23 / MIG-5 — ${conversions.length} conversions (D7). A NULL activity_context is a`,
          "-- universal physical conversion; a non-null one is contextual and is tried FIRST",
          "-- by CALC-3. Without these, an activity row whose unit differs from its factor's",
          "-- input_unit fails with `failed_unit` and the whole run fails with it.",
          "-- The id is a UUIDv5 of (from, to, context) so a re-run is a no-op on the PK as",
          "-- well as on the COALESCE unique index, which ON CONFLICT cannot name.",
          "-- DO NOT EDIT BY HAND: rerun `npx tsx scripts/gen-reference-sql.mjs`.",
        ].join("\n"),
        sql: insertBlock({
          table: "unit_conversion",
          conflict: "",
          rows: conversions,
          columns: [
            ["id", (c) => quote(c.id)],
            ["from_unit", (c) => text(c.from_unit)],
            ["to_unit", (c) => text(c.to_unit)],
            ["multiplier", (c) => quote(c.multiplier)],
            ["activity_context", (c) => text(c.activity_context)],
            ["source", (c) => text(c.source)],
            ["notes", (c) => text(c.notes)],
          ],
        }),
      };
    },
  },
  {
    id: "plans",
    owner: "T1.8",
    render() {
      // The six PG-1 keys, written out rather than derived: a `PLAN_FEATURES`
      // edit that drops one would still render four perfectly valid rows, and
      // the only thing that would notice on production is a dead plan limit.
      const PG1_KEYS = [
        "maxLegalEntities",
        "maxFacilities",
        "vsmeComprehensive",
        "consolidatedReports",
        "reportFormats",
        "maxUploadMb",
      ];
      if (PLAN_SEED.plans.length !== 4)
        throw new Error(
          `PLAN_SEED holds ${PLAN_SEED.plans.length} plans, expected 4`,
        );
      for (const plan of PLAN_SEED.plans) {
        for (const key of PG1_KEYS) {
          if (!(key in plan.features))
            throw new Error(`plan '${plan.id}' has no PG-1 key '${key}'`);
        }
      }
      return {
        comment: [
          "-- PG-1 / T1.8 — the plan catalogue, carried by the MIGRATION because production",
          "-- never seeds (О-13): `deploy.yml` ships neither `seed.ts` nor `tsx`, and the",
          "-- `plans` seed in 0001_billing.sql:96-108 is a COMMENTED-OUT psql fallback that",
          "-- nobody ran. So on the server `plans` may hold the OLD 13-key rows — or no rows",
          "-- at all. Both must end up here, which is why this is an UPSERT and not an",
          "-- UPDATE: `UPDATE … WHERE id = …` against an empty table is a silent no-op and",
          "-- the six new keys would never arrive, leaving `maxLegalEntities`/`maxFacilities`",
          "-- undefined (every limit open), `vsmeComprehensive` false on pro/enterprise too",
          "-- (PG-6 blocking everyone) and `reportFormats` undefined (`.includes` → 500).",
          "-- `plans.features || excluded.features` keeps every key already in the row and",
          "-- writes the code's values over the ones it does name, so a re-run is a no-op;",
          "-- `name`/`sort_order` are deliberately NOT overwritten (an operator rename of a",
          "-- plan label is not this migration's business). Values come from `PLAN_SEED`,",
          "-- which is derived 1:1 from `PLAN_FEATURES` — one source, two renderings.",
          "-- DO NOT EDIT BY HAND: rerun `npx tsx scripts/gen-reference-sql.mjs`.",
        ].join("\n"),
        sql: insertBlock({
          table: "plans",
          conflict: "(id)",
          action:
            "DO UPDATE SET features = plans.features || excluded.features",
          rows: PLAN_SEED.plans,
          columns: [
            ["id", (p) => text(p.id)],
            ["name", (p) => text(p.name)],
            ["sort_order", (p) => int(p.sortOrder)],
            // Keys that arrived AFTER 0004 travel with their own migration
            // (`simplifiedEsrs` → 0021) and are stripped here so that a rerun
            // leaves the shipped 0004 block byte-identical; `plan-catalog.test`
            // names the same list.
            ["features", (p) => jsonb(omitLaterKeys(p.features))],
          ],
        }),
      };
    },
  },
];

// ─── Splice ──────────────────────────────────────────────────────────────────
const original = readFileSync(MIGRATION, "utf8");
if (!original.includes(SECTION_MARKER))
  throw new Error(
    `${path.relative(REPO, MIGRATION)} has no "${SECTION_MARKER}…" marker — ` +
      "the reference-data section it appends into is gone (T1.2, О-13).",
  );

// Everything from the first BEGIN marker onwards is ours; rebuild it wholesale.
const firstBegin = original.search(/^-- >>> BEGIN GENERATED: /m);
const head = (
  firstBegin < 0 ? original : original.slice(0, firstBegin)
).replace(/\s*$/, "\n");

const rendered = BLOCKS.map(({ id, owner, render }) => {
  const { comment, sql } = render();
  return [`${BEGIN(id)} (owner ${owner})`, comment, sql, END(id)].join("\n");
});

writeFileSync(MIGRATION, `${head}\n${rendered.join("\n\n")}\n`, "utf8");
console.log(
  `${path.relative(REPO, MIGRATION)}: wrote ${rendered.length} generated block(s) — ` +
    BLOCKS.map((b) => b.id).join(", "),
);
