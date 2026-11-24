// =============================================================================
// T1.8 — `planRowsToFeatures` over an OLD-SHAPE `plans` row, and the 0004 data
// migration that back-fills it. DB-FREE on purpose (both halves).
//
// ── The failure this file exists to prevent ─────────────────────────────────
// `getEntitlements` prefers the DB catalogue, and the catalogue on the server is
// whatever `plans.features` happens to hold — a JSONB blob written by an older
// deploy, or (0001_billing.sql:96-108 is a COMMENTED-OUT fallback and `db:seed`
// never runs there) nothing at all. Before T1.8 the builder was
// `{id,name,price,...row.features}`: a row missing a key produced `undefined`,
// and `undefined` is not a closed gate, it is an OPEN one —
//
//   • `currentCount >= undefined` → false → `requireWithinLimit` allows every
//     creation, so PG-1/PG-2 are dead and the F1 lock gate never returns 402
//     (AC-12/AC-13 pass locally and are false in production);
//   • `vsmeComprehensive` → undefined → falsy for EVERY plan, so PG-6 blocks
//     pro and enterprise customers from the module they paid for;
//   • `reportFormats.includes(fmt)` → TypeError → HTTP 500 on render (T5.7);
//   • `maxUploadMb` → a NaN comparison on the upload ceiling (T4.1).
//
// None of it is visible under [LOCAL-DB], which seeds a clean database from
// `PLAN_SEED` every time. So the proof has to be a row written by hand in the
// OLD shape, and it lives here.
// =============================================================================

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PLAN_SEED,
  planRowsToFeatures,
  type PlanSeedRow,
} from "@/server/billing/plan-catalog";
import type { PlanFeaturesConfig } from "@/server/db/types";
import { PLAN_FEATURES, type PlanId } from "@/shared/plans";

import { LEGACY_PLAN_ROWS, RETIRED_REPORT_KEYS } from "./legacy-plan-rows";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SQL_FILE = path.join(REPO_ROOT, "drizzle/0004_data_model.sql");

/**
 * Keys that reached `plans.features` by a migration LATER than 0004 — each with
 * the file that carries it. 0004 is shipped and is not rewritten for them
 * (`gen-reference-sql.mjs` strips the same list), so the "0004 equals the seed"
 * assertions below compare against the seed WITHOUT these keys.
 */
const KEYS_AFTER_0004: Record<string, string> = {
  simplifiedEsrs: "drizzle/0021_plans_simplified_esrs.sql",
};

/** A seed config as 0004 alone would have written it. */
function asOf0004(features: PlanFeaturesConfig): PlanFeaturesConfig {
  const copy = { ...features } as Record<string, unknown>;
  for (const key of Object.keys(KEYS_AFTER_0004)) delete copy[key];
  return copy as PlanFeaturesConfig;
}

/** The six keys T1.8 adds (PG-1). Written out; see plans.test.ts for the values. */
const NEW_KEYS = [
  "maxLegalEntities",
  "maxFacilities",
  "vsmeComprehensive",
  "consolidatedReports",
  "reportFormats",
  "maxUploadMb",
] as const;

// ─── The old shape, verbatim ─────────────────────────────────────────────────

/**
 * `plans.features` exactly as production holds it: READ from the psql fallback
 * in `drizzle/0001_billing.sql`, which is the ONLY description of those rows
 * that ever reached the server (see `./legacy-plan-rows`). Not derived from
 * `PLAN_FEATURES` by deleting keys — a derived fixture would follow the code
 * forward and stop being "old" the moment the code moves.
 */
const OLD_SHAPE_JSON = Object.fromEntries(
  LEGACY_PLAN_ROWS.map((row) => [row.id, row.json]),
) as Record<PlanId, string>;

const PLAN_IDS = Object.keys(OLD_SHAPE_JSON) as PlanId[];

/** `plans` rows in the pre-T1.8 shape — 13 keys, none of the six new ones. */
const OLD_SHAPE_ROWS: PlanSeedRow[] = PLAN_SEED.plans.map((p) => ({
  ...p,
  // The cast is the whole point: the stored JSONB is NOT type-checked at
  // runtime, and `PlanFeaturesConfig` describes what the code WANTS to find
  // there, not what an old deploy actually wrote.
  features: JSON.parse(OLD_SHAPE_JSON[p.id]) as PlanFeaturesConfig,
}));

/** One stored config as it looks AFTER 0006 has run against the row (О-15). */
function afterRetirement(features: PlanFeaturesConfig): PlanFeaturesConfig {
  const copy = { ...features } as Record<string, unknown>;
  for (const key of RETIRED_REPORT_KEYS) delete copy[key];
  return copy as PlanFeaturesConfig;
}

/** The old rows as a database that has been migrated through 0006 holds them. */
const MIGRATED_OLD_ROWS: PlanSeedRow[] = OLD_SHAPE_ROWS.map((row) => ({
  ...row,
  features: afterRetirement(row.features),
}));

/**
 * `requireWithinLimit`'s comparison, restated (guard.ts is `server-only` and
 * needs a session + a database; the arithmetic does not). Returns true when the
 * guard would ALLOW the creation.
 */
function limitAllows(max: number, currentCount: number): boolean {
  if (max === -1) return true; // unlimited
  return !(currentCount >= max);
}

describe("T1.8 — an OLD-shape plans row yields code defaults, never undefined", () => {
  it("the fixture really is the old shape: 13 keys and not one of the new six", () => {
    for (const id of PLAN_IDS) {
      const parsed = JSON.parse(OLD_SHAPE_JSON[id]) as Record<string, unknown>;
      expect(Object.keys(parsed), id).toHaveLength(13);
      for (const key of NEW_KEYS) {
        expect(parsed, `${id}.${key}`).not.toHaveProperty(key);
      }
    }
  });

  it.each(PLAN_IDS)(
    "plan %s: every new key resolves to the code default, not undefined",
    (id) => {
      const features = planRowsToFeatures(OLD_SHAPE_ROWS, PLAN_SEED.prices).get(
        id,
      )!;

      for (const key of NEW_KEYS) {
        expect(features[key], `${id}.${key}`).toBeDefined();
        expect(features[key], `${id}.${key}`).toEqual(PLAN_FEATURES[id][key]);
      }

      // Stated as the three concrete production symptoms, not only as "defined":
      // a numeric limit, an array that `.includes` can be called on, and a
      // per-plan boolean rather than a blanket false.
      expect(typeof features.maxLegalEntities).toBe("number");
      expect(typeof features.maxFacilities).toBe("number");
      expect(typeof features.maxUploadMb).toBe("number");
      expect(Array.isArray(features.reportFormats)).toBe(true);
      expect(() => features.reportFormats.includes("pdf")).not.toThrow();
      expect(features.reportFormats).toContain("pdf");
      expect(features.vsmeComprehensive).toBe(
        PLAN_FEATURES[id].vsmeComprehensive,
      );
    },
  );

  it("does NOT collapse vsmeComprehensive to false for everyone (PG-6)", () => {
    const restored = planRowsToFeatures(OLD_SHAPE_ROWS, PLAN_SEED.prices);
    // The bug's signature: all four plans agreeing on `false`. Pro and
    // enterprise paid for the module and must keep it.
    expect(restored.get("pro")!.vsmeComprehensive).toBe(true);
    expect(restored.get("enterprise")!.vsmeComprehensive).toBe(true);
    expect(restored.get("trial")!.vsmeComprehensive).toBe(false);
    expect(restored.get("starter")!.vsmeComprehensive).toBe(false);
  });

  it("keeps requireWithinLimit's comparison a real gate on the old shape", () => {
    const restored = planRowsToFeatures(OLD_SHAPE_ROWS, PLAN_SEED.prices);

    // The regression, spelled out: with `undefined` the compare is false, so the
    // guard ALLOWS — a plan limit that silently does nothing.
    expect(limitAllows(undefined as unknown as number, 999)).toBe(true);

    // With the overlay it denies at the ceiling and allows below it.
    const starter = restored.get("starter")!;
    expect(limitAllows(starter.maxLegalEntities, 0)).toBe(true);
    expect(limitAllows(starter.maxLegalEntities, 1)).toBe(false);
    expect(limitAllows(starter.maxFacilities, 3)).toBe(false);

    // `-1` still means unlimited (enterprise facilities), and it is the ONLY
    // place in the new matrix where the guard is a no-op.
    expect(restored.get("enterprise")!.maxFacilities).toBe(-1);
    expect(limitAllows(restored.get("enterprise")!.maxFacilities, 10_000)).toBe(
      true,
    );
    expect(limitAllows(restored.get("enterprise")!.maxLegalEntities, 10)).toBe(
      false,
    );
  });

  it("converges: old-shape rows and current rows rebuild the same matrix", () => {
    // This is the unit-test twin of the [LOCAL-DB] proof that a migration over
    // an old database and over a fresh one end identically. The old rows are
    // taken THROUGH 0006 first, because that is the state a migrated server is
    // in — see the retired-key test below for what happens without it.
    const fromOld = planRowsToFeatures(MIGRATED_OLD_ROWS, PLAN_SEED.prices);
    const fromNew = planRowsToFeatures(PLAN_SEED.plans, PLAN_SEED.prices);
    for (const id of PLAN_IDS) {
      expect(fromOld.get(id), id).toEqual(fromNew.get(id));
      expect(fromOld.get(id), id).toEqual(PLAN_FEATURES[id]);
    }
  });

  // ── О-15: why retiring a key needs a MIGRATION and not just a code delete ──
  //
  // The overlay is `{...PLAN_FEATURES[id], ...row.features}`: the row wins
  // wherever it has an opinion, and it keeps having an opinion about a key the
  // code has forgotten. So deleting `reports` from `PlanFeatures` alone would
  // leave `getEntitlements().features.reports` alive and readable on every
  // server whose catalogue predates the change — a gate nothing may consult,
  // which is exactly the silent divergence О-15 exists to end. 0006 is what
  // makes the retirement real.
  it("a retired key survives the overlay until 0006 deletes it from the row", () => {
    expect(RETIRED_REPORT_KEYS, "0006 must name two keys").toHaveLength(2);

    const stale = planRowsToFeatures(OLD_SHAPE_ROWS, PLAN_SEED.prices).get(
      "pro",
    )! as unknown as Record<string, unknown>;
    for (const key of RETIRED_REPORT_KEYS) {
      expect(stale, key).toHaveProperty(key);
    }

    const migrated = planRowsToFeatures(
      MIGRATED_OLD_ROWS,
      PLAN_SEED.prices,
    ).get("pro")! as unknown as Record<string, unknown>;
    for (const key of RETIRED_REPORT_KEYS) {
      expect(migrated, key).not.toHaveProperty(key);
    }
    expect(migrated).toEqual(PLAN_FEATURES.pro);
  });

  it("the rows the seed writes carry neither retired key (О-15)", () => {
    for (const plan of PLAN_SEED.plans) {
      for (const key of RETIRED_REPORT_KEYS) {
        expect(plan.features, `${plan.id}.${key}`).not.toHaveProperty(key);
      }
    }
  });
});

describe("T1.8 — the DB row still wins where it has an opinion (§6.2)", () => {
  it("overlays, not replaces: a stored value overrides the code default", () => {
    const rows: PlanSeedRow[] = PLAN_SEED.plans.map((p) =>
      p.id === "pro"
        ? {
            ...p,
            features: {
              ...p.features,
              maxFacilities: 99,
              reportFormats: ["pdf"],
            },
          }
        : p,
    );
    const pro = planRowsToFeatures(rows, PLAN_SEED.prices).get("pro")!;
    // The catalogue is the runtime source of truth: an operator raising a limit
    // in the DB must take effect without a deploy.
    expect(pro.maxFacilities).toBe(99);
    expect(pro.reportFormats).toEqual(["pdf"]);
    // …while everything the row does not mention still comes from the code.
    expect(pro.maxLegalEntities).toBe(PLAN_FEATURES.pro.maxLegalEntities);
  });

  it("takes id / name / price from the COLUMNS, not from the JSONB", () => {
    const rows: PlanSeedRow[] = [
      { ...PLAN_SEED.plans[2], name: "Pro (renamed)" },
    ];
    const pro = planRowsToFeatures(rows, PLAN_SEED.prices).get("pro")!;
    expect(pro.id).toBe("pro");
    expect(pro.name).toBe("Pro (renamed)");
    expect(pro.price).toBe(PLAN_FEATURES.pro.price);
  });

  it("gives an unknown plan id a COMPLETE trial-floor contract", () => {
    const rows = [
      {
        id: "legacy-gold",
        name: "Legacy Gold",
        features: {} as PlanFeaturesConfig,
      },
    ];
    const restored = planRowsToFeatures(rows, []);
    const gold = restored.get("legacy-gold" as unknown as PlanId)!;
    // Not a half-populated object: a caller must not get `undefined.includes`.
    for (const key of NEW_KEYS) {
      expect(gold[key], key).toEqual(PLAN_FEATURES.trial[key]);
    }
    expect(gold.name).toBe("Legacy Gold");
  });
});

// ─── The migration block, read as text (О-13: production migrates, never seeds) ─

/** The `plans` block `scripts/gen-reference-sql.mjs` writes into 0004. */
function plansBlock(): string {
  const migration = readFileSync(SQL_FILE, "utf8");
  const begin = migration.indexOf("-- >>> BEGIN GENERATED: plans");
  const end = migration.indexOf("-- <<< END GENERATED: plans");
  expect(
    begin,
    "0004_data_model.sql has no generated `plans` block — production would keep " +
      "the OLD 13-key rows forever and every PG-1 limit would be dead (О-13). " +
      "Run `npx tsx scripts/gen-reference-sql.mjs`.",
  ).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return migration.slice(begin, end);
}

/**
 * The `features` literal 0004 emits for one plan, parsed.
 *
 * ── WHY THE LITERAL IS COMPARED THROUGH 0006 AND NOT DIRECTLY (T5.8, О-15) ──
 * `0004_data_model.sql` was written when `PLAN_SEED` still carried the two
 * report-gating keys, and its literals still carry them. It is not regenerated
 * to match: 0004 is applied in production, and — this was verified against
 * `drizzle-orm/pg-core/dialect.js`, which compares each journal entry's `when`
 * against the newest `created_at` in `__drizzle_migrations` — the migrator picks
 * work by JOURNAL POSITION, never by file content. Editing 0004 would therefore
 * change nothing on any server that has run it, while silently making the local
 * database disagree with production. The delta lives in 0006 instead, so the
 * invariant this suite states is the composition: what 0004 INSERTS, minus what
 * 0006 DELETES, is what the seed writes.
 */
function literalOf(block: string, id: string): PlanFeaturesConfig {
  const literal = /'(\{[^']*\})'::jsonb/.exec(
    block.slice(block.indexOf(`('${id}', `)),
  );
  expect(literal, id).not.toBeNull();
  return JSON.parse(literal![1]) as PlanFeaturesConfig;
}

describe("партия 9 — keys added after 0004 travel with their own migration", () => {
  it.each(Object.entries(KEYS_AFTER_0004))(
    "%s is written by %s for all four plans, with the seed's values",
    (key, file) => {
      const migration = readFileSync(path.join(REPO_ROOT, file), "utf8");
      for (const plan of PLAN_SEED.plans) {
        const value = (plan.features as Record<string, unknown>)[key];
        expect(value, `${plan.id}.${key}`).toBeDefined();
        // `… || '{"key": value}'::jsonb … WHERE id IN (… 'plan' …)` — the plan
        // is named in the statement that writes ITS value.
        const statement = migration
          .split(";")
          .find(
            (part) =>
              part.includes(`"${key}": ${JSON.stringify(value)}`) &&
              part.includes(`'${plan.id}'`),
          );
        expect(statement, `${plan.id}.${key}`).toBeDefined();
      }
      expect(migration).not.toMatch(/^\s*(ALTER|CREATE|DROP)\b/m);
    },
  );
});

describe("T1.8 — plans.features travels with the migration (О-13)", () => {
  it("is an UPSERT, because production may have NO plans rows at all", () => {
    const block = plansBlock();
    // `UPDATE … WHERE id = …` would be a silent no-op on an empty table, and
    // the empty table is the REALISTIC production state: the 0001 seed is a
    // commented-out psql fallback and `db:seed` never runs on the server.
    expect(block).toContain("INSERT INTO plans (");
    expect(block).toContain(
      "ON CONFLICT (id) DO UPDATE SET features = plans.features || excluded.features;",
    );
    expect(block).not.toMatch(/^\s*UPDATE plans/m);
  });

  it("inserts all four plans with the full feature config", () => {
    const block = plansBlock();
    for (const plan of PLAN_SEED.plans) {
      expect(block, plan.id).toContain(`('${plan.id}', '${plan.name}',`);
      // The whole config, not only the six new keys: on an EMPTY `plans` table
      // the INSERT branch runs and the row is created from this literal alone.
      // Compared THROUGH 0006 — see `literalOf` on why 0004's literal is a
      // historical snapshot and not a live rendering of `PLAN_SEED`.
      expect(afterRetirement(literalOf(block, plan.id)), plan.id).toEqual(
        asOf0004(plan.features),
      );
    }
  });

  it("carries every one of the six new keys for every plan", () => {
    const block = plansBlock();
    for (const plan of PLAN_SEED.plans) {
      for (const key of NEW_KEYS) {
        expect(plan.features, `${plan.id}.${key}`).toHaveProperty(key);
      }
    }
    // …and the literals really are in the SQL, not merely in the object.
    for (const key of NEW_KEYS) {
      expect(block.match(new RegExp(`"${key}":`, "g")), key).toHaveLength(4);
    }
  });

  it("emits the same values the seed writes — one source, two renderings", () => {
    // `seed.ts` upserts `PLAN_SEED.plans`; the generator rendered that same
    // array into the SQL. So a migrate-only database (production) and a
    // seed-only one (local) cannot disagree — and rebuilding from the emitted
    // literals, THROUGH 0006, lands back on `PLAN_FEATURES`.
    const block = plansBlock();
    for (const id of PLAN_IDS) {
      const emitted = afterRetirement(literalOf(block, id));
      expect(emitted, id).toEqual(
        asOf0004(PLAN_SEED.plans.find((p) => p.id === id)!.features),
      );
      for (const key of NEW_KEYS) {
        expect(emitted[key], `${id}.${key}`).toEqual(PLAN_FEATURES[id][key]);
      }
    }
  });
});
