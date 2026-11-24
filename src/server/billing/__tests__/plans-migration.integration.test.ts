/**
 * [LOCAL-DB] T1.8 + T5.8 — the migrations that shape `plans.features`, proved
 * against the THREE database states production can actually be in (О-13,
 * MIG-6, О-15).
 *
 * `deploy.yml` ships `.next/standalone`, `scripts/migrate.mjs` and `drizzle/`
 * and runs the migrator. It never ships `seed.ts` or `tsx`. The `plans` seed in
 * `drizzle/0001_billing.sql:96-108` is a COMMENTED-OUT psql fallback. So on the
 * server the table is in one of:
 *
 *   1. EMPTY — nobody ever ran the commented fallback (the realistic case, and
 *      the one that makes a bare `UPDATE … WHERE id = …` a silent no-op);
 *   2. OLD — the fallback was applied by hand once, so the rows carry the 13
 *      pre-T1.8 keys and none of the six new ones;
 *   3. NEW — 0004 already ran (a redeploy, or `db:migrate` twice).
 *
 * All three must end at the SAME four rows, and a repeat run must change
 * nothing. That is what this suite executes: the two migrations that touch
 * `plans.features`, verbatim from the files, against a TEMP table that shadows
 * `public.plans` for one transaction (`pg_temp` is searched before `public`).
 * The shadow is what makes the proof independent of whether `db:seed` has
 * already populated the real table in this shared warm database — i.e. it
 * observes "migrated but never seeded", which is precisely the production path.
 *
 * ── WHY "THE MIGRATION" HERE IS TWO FILES (T5.8, О-15) ──────────────────────
 * `shadow.migrate()` applies 0004's generated `plans` block AND
 * `drizzle/0006_retire_report_gating.sql`, in journal order, because that is
 * what `db:migrate` does and the two disagree about the same rows: 0004 ADDS the
 * six PG-1 keys (merging into whatever is there), 0006 DELETES the two retired
 * report-gating ones. Running only the first against the OLD 13-key fixture
 * would leave both of those standing and the convergence claim below would be
 * false — which is exactly the production state О-15 is
 * about, and exactly why the retirement had to be a migration rather than a code
 * edit. Note also what this arrangement proves for free: every idempotency and
 * convergence assertion in this file now runs 0006 one, two and three times.
 *
 * Gated by `describeIntegration`, so it is a green no-op without Postgres.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PLAN_SEED } from "@/server/billing/plan-catalog";
import type { PlanFeaturesConfig } from "@/server/db/types";
import { PLAN_FEATURES, type PlanId } from "@/shared/plans";

import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  setupSchema,
} from "../../db/__tests__/harness";
import { LEGACY_PLAN_ROWS, RETIRED_REPORT_KEYS } from "./legacy-plan-rows";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SQL_FILE = path.join(REPO_ROOT, "drizzle/0004_data_model.sql");
const RETIRE_SQL_FILE = path.join(
  REPO_ROOT,
  "drizzle/0006_retire_report_gating.sql",
);
/** Партия 9 — the `simplifiedEsrs` flag, the third statement over `plans`. */
const ESRS_SQL_FILE = path.join(
  REPO_ROOT,
  "drizzle/0021_plans_simplified_esrs.sql",
);

const NEW_KEYS = [
  "maxLegalEntities",
  "maxFacilities",
  "vsmeComprehensive",
  "consolidatedReports",
  "reportFormats",
  "maxUploadMb",
] as const;

const PLAN_IDS = ["trial", "starter", "pro", "enterprise"] as const;

/**
 * The pre-T1.8 rows, READ from the commented psql fallback in
 * `drizzle/0001_billing.sql` — the only shape production could have got without
 * running `db:seed` (see `./legacy-plan-rows` on why they are parsed, not
 * pasted).
 */
const OLD_ROWS = LEGACY_PLAN_ROWS;

/** The generated `plans` block of 0004, as text. */
function plansBlock(): string {
  const migration = readFileSync(SQL_FILE, "utf8");
  const begin = migration.indexOf("-- >>> BEGIN GENERATED: plans");
  const end = migration.indexOf("-- <<< END GENERATED: plans");
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return migration.slice(begin, end);
}

/**
 * 0006 verbatim — the whole file is one `UPDATE plans` that subtracts the
 * retired keys (О-15). The key NAMES are not written here: `RETIRED_REPORT_KEYS`
 * is parsed off this very statement, so the assertion is that it names two of
 * them and that the statement really is an unfiltered UPDATE.
 */
function retireBlock(): string {
  const migration = readFileSync(RETIRE_SQL_FILE, "utf8");
  expect(migration).toContain("UPDATE plans SET features = features -");
  expect(migration, "an UPDATE with a WHERE would skip some plans").not.toMatch(
    /UPDATE plans[^;]*\bWHERE\b/,
  );
  expect(RETIRED_REPORT_KEYS).toHaveLength(2);
  return migration;
}

type PlansSnapshot = { id: string; features: PlanFeaturesConfig }[];

/** What the body of a shadow run can do: apply the migration block, or any SQL. */
interface Shadow {
  /**
   * Apply 0004's generated `plans` block and then 0006, in journal order —
   * exactly what `db:migrate` does to this table (see the file header).
   */
  migrate(): Promise<void>;
  /** Run an arbitrary statement against the shadow table. */
  exec(statement: string): Promise<void>;
  /** Row count of the shadow table right now. */
  count(): Promise<number>;
}

describeIntegration(
  "T1.8/T5.8 — 0004+0006 over plans, empty / old / new (О-13, О-15)",
  () => {
    beforeAll(async () => {
      await setupSchema();
    });
    afterAll(async () => {
      await closeTestDb();
    });

    /**
     * Run `body` against a TEMP `plans` table that shadows the real one for the
     * duration of ONE transaction (`ON COMMIT DROP`), and return the resulting
     * rows ordered by id so two states can be compared directly. Everything the
     * body touches goes through the SAME transaction handle — a temp table is
     * session-scoped, so a second pooled connection would not see it.
     */
    async function inShadow(
      body: (shadow: Shadow) => Promise<void>,
    ): Promise<PlansSnapshot> {
      const block = plansBlock();
      const retire = retireBlock();
      const esrs = readFileSync(ESRS_SQL_FILE, "utf8");
      let snapshot: PlansSnapshot = [];
      await getTestDb().transaction(async (tx) => {
        await tx.execute(
          sql`CREATE TEMP TABLE plans (LIKE public.plans INCLUDING ALL) ON COMMIT DROP`,
        );
        await body({
          migrate: async () => {
            await tx.execute(sql.raw(block));
            await tx.execute(sql.raw(retire));
            await tx.execute(sql.raw(esrs));
          },
          exec: async (statement: string) => {
            await tx.execute(sql.raw(statement));
          },
          count: async () =>
            (
              await tx.execute<{ n: number }>(
                sql`SELECT count(*)::int AS n FROM pg_temp.plans`,
              )
            )[0].n,
        });
        snapshot = [
          ...(await tx.execute<{ id: string; features: PlanFeaturesConfig }>(
            sql`SELECT id, features FROM pg_temp.plans ORDER BY id`,
          )),
        ];
      });
      return snapshot;
    }

    /** Insert the pre-T1.8 rows into the shadow table. */
    const OLD_INSERT = `INSERT INTO plans (id, name, sort_order, features) VALUES ${OLD_ROWS.map(
      (r) => `('${r.id}', '${r.name}', ${r.sortOrder}, '${r.json}'::jsonb)`,
    ).join(", ")};`;

    function assertMatrix(rows: PlansSnapshot): void {
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.id)).toEqual([...PLAN_IDS].sort());
      for (const row of rows) {
        const id = row.id as PlanId;
        for (const key of NEW_KEYS) {
          expect(row.features, `${id}.${key}`).toHaveProperty(key);
          expect(row.features[key], `${id}.${key}`).toEqual(
            PLAN_FEATURES[id][key],
          );
        }
        // О-15: and neither retired key, whichever state the row started in.
        for (const key of RETIRED_REPORT_KEYS) {
          expect(row.features, `${id}.${key}`).not.toHaveProperty(key);
        }
        // The full stored config, not only the six: the point of the INSERT
        // branch is that an EMPTY table ends up with COMPLETE rows.
        expect(row.features, id).toEqual(
          PLAN_SEED.plans.find((p) => p.id === id)!.features,
        );
      }
    }

    // ── State 1: EMPTY (the production model) ────────────────────────────────
    it("state EMPTY: the migration alone creates four complete rows", async () => {
      const rows = await inShadow(async (shadow) => {
        // No seed, no hand-applied fallback — exactly what the server has.
        expect(await shadow.count(), "shadow table must start empty").toBe(0);
        await shadow.migrate();
        expect(await shadow.count()).toBe(4);
      });
      assertMatrix(rows);
    });

    // ── State 2: OLD 13-key rows ─────────────────────────────────────────────
    it("state OLD: the six new keys are merged into the existing rows", async () => {
      const rows = await inShadow(async (shadow) => {
        await shadow.exec(OLD_INSERT);
        expect(await shadow.count()).toBe(4);
        await shadow.migrate();
        expect(await shadow.count(), "no duplicate rows").toBe(4);
      });
      assertMatrix(rows);
    });

    it("state OLD: a key the migration does not name is PRESERVED, not dropped", async () => {
      // `features || excluded.features` is a MERGE, and that is the difference
      // between it and `features = excluded.features`: a key written by some
      // other deploy or a hand edit must survive the migration.
      const rows = await inShadow(async (shadow) => {
        await shadow.exec(OLD_INSERT);
        await shadow.exec(
          `UPDATE plans SET features = features || '{"legacyOnlyKey":"keep-me"}'::jsonb WHERE id = 'pro';`,
        );
        await shadow.migrate();
      });
      const pro = rows.find((r) => r.id === "pro")!;
      expect(
        (pro.features as unknown as Record<string, unknown>).legacyOnlyKey,
      ).toBe("keep-me");
      // …while the six new keys still landed on it.
      for (const key of NEW_KEYS) {
        expect(pro.features[key], key).toEqual(PLAN_FEATURES.pro[key]);
      }
    });

    // ── State 3: already NEW + idempotency ───────────────────────────────────
    it("state NEW: re-running the block changes nothing", async () => {
      const once = await inShadow(async (shadow) => {
        await shadow.migrate();
      });
      const thrice = await inShadow(async (shadow) => {
        await shadow.migrate();
        await shadow.migrate();
        await shadow.migrate();
        expect(await shadow.count()).toBe(4);
      });
      expect(thrice).toEqual(once);
      assertMatrix(thrice);
    });

    // ── Convergence — the headline claim ─────────────────────────────────────
    it("all three states converge on identical rows", async () => {
      const fromEmpty = await inShadow(async (s) => {
        await s.migrate();
      });
      const fromOld = await inShadow(async (s) => {
        await s.exec(OLD_INSERT);
        await s.migrate();
      });
      const fromNew = await inShadow(async (s) => {
        await s.migrate();
        await s.migrate();
      });
      expect(fromOld).toEqual(fromEmpty);
      expect(fromNew).toEqual(fromEmpty);
      assertMatrix(fromEmpty);
    });

    // ── 0006 by itself (О-15) ────────────────────────────────────────────────

    it("0006 removes BOTH retired keys from every plan, whatever else is stored", async () => {
      const rows = await inShadow(async (shadow) => {
        await shadow.exec(OLD_INSERT); // 13 keys, both retired ones present
        // Before: every row is gated by the framework list.
        const before = await shadow.count();
        expect(before).toBe(4);
        await shadow.migrate();
      });
      for (const row of rows) {
        for (const key of RETIRED_REPORT_KEYS) {
          expect(row.features, `${row.id}.${key}`).not.toHaveProperty(key);
        }
        // The keys 0006 does NOT name are untouched — `jsonb - 'key'` is a
        // surgical delete, not a rewrite.
        expect(row.features.scope3).toBe(
          PLAN_FEATURES[row.id as PlanId].scope3,
        );
      }
    });

    it("0006 is a no-op on a database that never had the keys", async () => {
      // The realistic production case: `plans` was created by 0004's own INSERT
      // from a `PLAN_SEED` that already lacked them, or the rows were seeded
      // after this commit. `jsonb - 'absent'` returns the object unchanged, so
      // "never had them" and "had them and lost them" are the same four rows.
      const neverHad = await inShadow(async (shadow) => {
        await shadow.migrate();
      });
      const hadThem = await inShadow(async (shadow) => {
        await shadow.exec(OLD_INSERT);
        await shadow.migrate();
      });
      expect(neverHad).toEqual(hadThem);
      assertMatrix(neverHad);
    });

    it("0006 run twice more changes nothing", async () => {
      const once = await inShadow(async (shadow) => {
        await shadow.exec(OLD_INSERT);
        await shadow.migrate();
      });
      const thrice = await inShadow(async (shadow) => {
        await shadow.exec(OLD_INSERT);
        await shadow.migrate();
        await shadow.exec(retireBlock());
        await shadow.exec(retireBlock());
        expect(await shadow.count()).toBe(4);
      });
      expect(thrice).toEqual(once);
    });

    // ── And the real table, after a real `db:migrate` ────────────────────────
    it("the REAL plans table carries all six keys on all four plans", async () => {
      const rows = [
        ...(await getTestDb().execute<{
          id: string;
          features: PlanFeaturesConfig;
        }>(sql`SELECT id, features FROM plans ORDER BY id`)),
      ];
      assertMatrix(rows);
    });

    it("the REAL plans table carries NEITHER retired key (О-15, 0000→0006)", async () => {
      // The acceptance criterion of T5.8 stated as SQL: after `db:migrate` (and
      // `db:seed`, which is what a warm developer database also gets), no plan
      // offers the pre-Phase-1 report gate any more.
      const rows = [
        ...(await getTestDb().execute<{ id: string; keys: string[] }>(
          sql`SELECT id, ARRAY(SELECT jsonb_object_keys(features)) AS keys
              FROM plans ORDER BY id`,
        )),
      ];
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        for (const key of RETIRED_REPORT_KEYS) {
          expect(row.keys, `${row.id}.${key}`).not.toContain(key);
        }
        // …and the gate that replaced them is there.
        expect(row.keys, row.id).toContain("reportFormats");
      }
    });
  },
);
