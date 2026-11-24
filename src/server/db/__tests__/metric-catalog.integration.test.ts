/**
 * [LOCAL-DB] T1.4 — the VSME metric catalogue (141 rows, MIG-3/DM-20/К-26).
 *
 * Risk R-2 in one sentence: a metric silently dropped by a regeneration is
 * invisible for two whole stages and then surfaces as a disclosure that cannot
 * be entered. Nothing in the application reads `metric_catalog` yet, so the only
 * thing that can hold the seed honest right now is a test that restates the
 * catalogue's shape INDEPENDENTLY of the file that produced it.
 *
 * Hence the two halves of this suite:
 *
 *   1. THE CATALOGUE IS COMPLETE AND WELL-FORMED. Counts, the density of
 *      `VSME-001…141`, the domains of `standard` / `pillar` / `value_type` /
 *      `requirement_type`, and — the one that catches the interesting failure —
 *      the set of `disclosure_code` compared against a LITERAL B1…B11 + C1…C9
 *      written out below. A regeneration that loses every row of one disclosure
 *      keeps all the other invariants intact; only the literal list notices.
 *
 *   2. PRODUCTION LOOKS LIKE THIS, AND PRODUCTION NEVER SEEDS. `deploy.yml`
 *      ships neither `seed.ts` nor `tsx` (О-13), so the catalogue reaches the
 *      server inside `drizzle/0004_data_model.sql` or not at all. Two checks
 *      cover that: the generated SQL block's `metric_key` set is compared with
 *      `vsme-metrics.json` (seed and migration cannot drift apart in silence),
 *      and the block itself is EXECUTED — against a temporary table that shadows
 *      `metric_catalog` for the duration of one transaction — to prove that the
 *      migration ALONE yields 141 rows and that running it twice still yields
 *      141. That temp-table shadow is what makes the proof independent of
 *      whether `db:seed` has ever run against this database.
 *
 * Gated by `describeIntegration`, so it is a green no-op without Postgres. The
 * pure JSON-vs-SQL comparison needs no database and deliberately sits outside
 * the gate: seed/migration drift is a risk on every commit, not only where
 * Postgres happens to be running.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DATA_TYPES } from "@/shared/enums";

import { VSME_METRICS } from "../seed-data/vsme-metrics";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  setupSchema,
} from "./harness";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SQL_FILE = path.join(REPO_ROOT, "drizzle/0004_data_model.sql");

// ─── The catalogue, restated ─────────────────────────────────────────────────

/**
 * Every VSME disclosure, written out by hand from the standard (Basic B1…B11 +
 * Comprehensive C1…C9) — NOT derived from the seed. This is the single check
 * that survives a regeneration dropping a whole disclosure: the counts would
 * merely shift, `metric_key` would merely be shorter, but a missing code is
 * unmistakable.
 */
const DISCLOSURE_CODES = [
  "B1",
  "B2",
  "B3",
  "B4",
  "B5",
  "B6",
  "B7",
  "B8",
  "B9",
  "B10",
  "B11",
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "C6",
  "C7",
  "C8",
  "C9",
] as const;

const PILLARS = ["general", "environmental", "social", "governance"] as const;

/**
 * О-19 — three values, not the two of §4.13. «Добровольно» is not «условно»: a
 * conditional datapoint becomes owed once its condition holds, a voluntary one
 * never does.
 */
const REQUIREMENT_TYPES = ["mandatory", "conditional", "voluntary"] as const;

/**
 * The exact split across those three, pinned. Every other assertion here still
 * passes if a regeneration reshuffles 25 metrics from `voluntary` into
 * `conditional` — this is the one that notices, and the same numbers are
 * asserted inside `scripts/gen-vsme-metrics.mjs` so the two derivations of the
 * catalogue cannot drift apart in silence.
 */
const REQUIREMENT_TYPE_COUNTS: Record<string, number> = {
  mandatory: 44,
  conditional: 72,
  voluntary: 25,
};

/**
 * О-20 — Cyrillic and Cyrillic Supplement. `title` and `disclosure_title` are
 * the workbook author's Russian by DM-20's own definition; the `*_en` columns
 * are what the `en` renderer (О-14, REN-2) prints, so a single Cyrillic
 * character in one of them is a Russian label in an English VSME report.
 */
const CYRILLIC = /[Ѐ-ӿԀ-ԯ]/;

const EXPECTED_KEYS = Array.from(
  { length: 141 },
  (_, i) => `VSME-${String(i + 1).padStart(3, "0")}`,
);

type CatalogRow = {
  metric_key: string;
  standard: string;
  pillar: string;
  module: string;
  disclosure_code: string;
  requirement_type: string;
  value_type: string;
  sort_order: number;
  title: string;
  title_en: string | null;
  disclosure_title_en: string | null;
};

// ─── The generated block of 0004, read as text ───────────────────────────────

/** The `metric_catalog` block `scripts/gen-reference-sql.mjs` writes into 0004. */
function metricCatalogBlock(): string {
  const migration = readFileSync(SQL_FILE, "utf8");
  const begin = migration.indexOf("-- >>> BEGIN GENERATED: metric_catalog");
  const end = migration.indexOf("-- <<< END GENERATED: metric_catalog");
  expect(
    begin,
    "0004_data_model.sql has no generated metric_catalog block — production " +
      "would come up with an EMPTY catalogue (О-13). Run `node scripts/gen-reference-sql.mjs`.",
  ).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return migration.slice(begin, end);
}

/** Every `'VSME-nnn'` literal the generated block inserts. */
function keysInMigration(): string[] {
  return [...metricCatalogBlock().matchAll(/'(VSME-\d{3})'/g)].map((m) => m[1]);
}

// ─── Seed ↔ migration (no database needed) ───────────────────────────────────
describe("T1.4 the metric catalogue travels with the migration (О-13)", () => {
  it("inserts exactly the metric_key set of vsme-metrics.json, once each", () => {
    const inMigration = keysInMigration();
    // Once each: the first column of every VALUES tuple is the key, so a
    // duplicate here would mean a duplicated row in the migration.
    expect(new Set(inMigration).size).toBe(inMigration.length);
    expect([...inMigration].sort()).toEqual(
      VSME_METRICS.map((m) => m.metric_key).sort(),
    );
  });

  it("is idempotent by construction (ON CONFLICT DO NOTHING)", () => {
    expect(metricCatalogBlock()).toContain(
      "ON CONFLICT (metric_key) DO NOTHING;",
    );
  });

  it("carries the 141 records the seed carries", () => {
    expect(VSME_METRICS).toHaveLength(141);
    expect(keysInMigration()).toHaveLength(141);
  });

  it("inserts the English title columns production renders from (О-20)", () => {
    // Production never seeds, so a column missing from the generated INSERT is a
    // column that is NULL forever on the server — and the `en` VSME report then
    // has no label to print at all.
    const columnList = /INSERT INTO metric_catalog \(\s*([^)]+)\)/.exec(
      metricCatalogBlock(),
    );
    expect(columnList).not.toBeNull();
    const columns = columnList![1].split(",").map((c) => c.trim());
    expect(columns).toContain("title_en");
    expect(columns).toContain("disclosure_title_en");
  });

  it("has an English title on every record in the JSON itself (О-20)", () => {
    for (const m of VSME_METRICS) {
      expect(m.title_en?.trim(), m.metric_key).toBeTruthy();
      expect(m.disclosure_title_en?.trim(), m.metric_key).toBeTruthy();
      expect(CYRILLIC.test(m.title_en), m.metric_key).toBe(false);
      expect(CYRILLIC.test(m.disclosure_title_en), m.metric_key).toBe(false);
    }
  });
});

describeIntegration("T1.4 metric_catalog (141 VSME metrics)", () => {
  let rows: CatalogRow[];

  beforeAll(async () => {
    await setupSchema();
    const db = getTestDb();
    rows = [
      ...(await db.execute<CatalogRow>(sql`
        SELECT metric_key, standard, pillar, module, disclosure_code,
               requirement_type, value_type, sort_order,
               title, title_en, disclosure_title_en
        FROM metric_catalog
        WHERE standard = 'vsme'  -- 0019 adds the simplified-ESRS rows beside these
        ORDER BY sort_order
      `)),
    ];
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // ── Completeness ───────────────────────────────────────────────────────────
  it("holds exactly 141 rows, 70 basic + 71 comprehensive", () => {
    expect(rows).toHaveLength(141);
    expect(rows.filter((r) => r.module === "basic")).toHaveLength(70);
    expect(rows.filter((r) => r.module === "comprehensive")).toHaveLength(71);
  });

  it("covers VSME-001…141 with no gaps and no duplicates", () => {
    const keys = rows.map((r) => r.metric_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^VSME-\d{3}$/);
    expect([...keys].sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it("has a dense, unique sort_order 1…141", () => {
    const orders = rows.map((r) => r.sort_order);
    expect(new Set(orders).size).toBe(orders.length);
    expect([...orders].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 141 }, (_, i) => i + 1),
    );
  });

  // ── Domains ────────────────────────────────────────────────────────────────
  it("seeds only the VSME standard (the 223 ESRS/GRI rows are Phase 4, К-26)", () => {
    expect([...new Set(rows.map((r) => r.standard))]).toEqual(["vsme"]);
  });

  it("gives every row a valid, non-empty pillar", () => {
    for (const r of rows) {
      expect(r.pillar, r.metric_key).toBeTruthy();
      expect(PILLARS, r.metric_key).toContain(r.pillar);
    }
    // Not one of the four may be missing entirely: `pillar` is the axis the
    // Phase-4 catalogue extension is organised on (К-26).
    expect([...new Set(rows.map((r) => r.pillar))].sort()).toEqual(
      [...PILLARS].sort(),
    );
  });

  it("gives every row one of the 12 DataType values", () => {
    for (const r of rows)
      expect(DATA_TYPES, r.metric_key).toContain(r.value_type);
  });

  it("gives every row a requirement_type of mandatory, conditional or voluntary", () => {
    for (const r of rows)
      expect(REQUIREMENT_TYPES, r.metric_key).toContain(r.requirement_type);
  });

  it("splits 44 mandatory / 72 conditional / 25 voluntary (О-19)", () => {
    const actual: Record<string, number> = {};
    for (const r of rows)
      actual[r.requirement_type] = (actual[r.requirement_type] ?? 0) + 1;
    expect(actual).toEqual(REQUIREMENT_TYPE_COUNTS);
  });

  // ── The English titles the renderer prints (О-20) ──────────────────────────
  it("carries a non-empty title_en and disclosure_title_en on all 141 rows", () => {
    for (const r of rows) {
      expect(r.title_en?.trim(), r.metric_key).toBeTruthy();
      expect(r.disclosure_title_en?.trim(), r.metric_key).toBeTruthy();
    }
  });

  it("keeps every *_en value free of Cyrillic — an `en` report never prints Russian", () => {
    for (const r of rows) {
      expect(CYRILLIC.test(r.title_en ?? ""), `${r.metric_key} title_en`).toBe(
        false,
      );
      expect(
        CYRILLIC.test(r.disclosure_title_en ?? ""),
        `${r.metric_key} disclosure_title_en`,
      ).toBe(false);
    }
  });

  it("keeps title as DM-20's «Показатель / поле», a different column from title_en", () => {
    // The point of О-20 is that the two are DIFFERENT columns, and the Cyrillic
    // check above cannot see it: repointing `title` at the English column would
    // leave every other assertion here green. What it WOULD do is make all 141
    // rows agree. In the workbook exactly 22 do — the metrics whose «Показатель
    // / поле» the author happened to write in English (the 15 Scope 3
    // categories, Scope 1/2, GHG intensity, the two nature-oriented areas and
    // the two gender ratios) — so that number is the pin.
    expect(rows.filter((r) => r.title === r.title_en)).toHaveLength(22);
  });

  it("agrees on one disclosure_title_en per disclosure_code", () => {
    const perCode = new Map<string, Set<string>>();
    for (const r of rows) {
      const seen = perCode.get(r.disclosure_code) ?? new Set<string>();
      seen.add(r.disclosure_title_en ?? "");
      perCode.set(r.disclosure_code, seen);
    }
    for (const [code, titles] of perCode)
      expect([...titles], code).toHaveLength(1);
  });

  it("covers every disclosure B1…B11 and C1…C9 — compared to a literal list", () => {
    expect([...new Set(rows.map((r) => r.disclosure_code))].sort()).toEqual(
      [...DISCLOSURE_CODES].sort(),
    );
  });

  // ── Seed idempotency ───────────────────────────────────────────────────────
  it("survives a repeated seed without duplicating or losing a metric_key", async () => {
    const db = getTestDb();
    const before = rows.map((r) => r.metric_key).sort();

    // The upsert `seed.ts` runs, verbatim in shape: same keys, ON CONFLICT on
    // `metric_key`. Running it against an already-seeded table must be a no-op
    // in cardinality and in key set.
    for (const m of VSME_METRICS) {
      await db.execute(sql`
        INSERT INTO metric_catalog (
          metric_key, standard, pillar, module, disclosure_code,
          disclosure_title, disclosure_title_en, paragraph, requirement_type,
          title, title_en, description, unit, applicability_condition,
          value_type, breakdown_dimensions, guidance, sort_order, is_active
        ) VALUES (
          ${m.metric_key}, ${m.standard}, ${m.pillar}, ${m.module},
          ${m.disclosure_code}, ${m.disclosure_title},
          ${m.disclosure_title_en}, ${m.paragraph}, ${m.requirement_type},
          ${m.title}, ${m.title_en}, ${m.description}, ${m.unit},
          ${m.applicability_condition}, ${m.value_type},
          ${JSON.stringify(m.breakdown_dimensions)}::jsonb, ${m.guidance},
          ${m.sort_order}, ${m.is_active}
        )
        ON CONFLICT (metric_key) DO UPDATE SET title = excluded.title
      `);
    }

    const after = [
      ...(await db.execute<{ metric_key: string }>(
        sql`SELECT metric_key FROM metric_catalog WHERE standard = 'vsme' ORDER BY sort_order`,
      )),
    ].map((r) => r.metric_key);
    expect(after).toHaveLength(141);
    expect([...after].sort()).toEqual(before);
  });

  // ── The production path: migrate, never seed ───────────────────────────────
  it("is populated by the MIGRATION alone — 141 rows before any seed runs", async () => {
    const db = getTestDb();
    const block = metricCatalogBlock();

    // A TEMP table shadows `public.metric_catalog` for this session (pg_temp is
    // searched before public), so the block below runs against an empty copy of
    // the real table regardless of what the seed has already done to the real
    // one. That is the only way to observe "migrated but never seeded" from
    // inside a suite that shares one warm database.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`CREATE TEMP TABLE metric_catalog
              (LIKE public.metric_catalog INCLUDING ALL) ON COMMIT DROP`,
      );
      const count = async () =>
        (
          await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM pg_temp.metric_catalog`,
          )
        )[0].n;

      expect(await count()).toBe(0);
      await tx.execute(sql.raw(block));
      expect(await count()).toBe(141);

      // A second `db:migrate` must not double the catalogue.
      await tx.execute(sql.raw(block));
      expect(await count()).toBe(141);

      const migrated = [
        ...(await tx.execute<{ metric_key: string; module: string }>(
          sql`SELECT metric_key, module FROM pg_temp.metric_catalog`,
        )),
      ];
      expect(migrated.filter((r) => r.module === "basic")).toHaveLength(70);
      expect(migrated.filter((r) => r.module === "comprehensive")).toHaveLength(
        71,
      );
      expect(migrated.map((r) => r.metric_key).sort()).toEqual(
        VSME_METRICS.map((m) => m.metric_key).sort(),
      );
    });
  });
});
