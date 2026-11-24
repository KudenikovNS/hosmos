// =============================================================================
// Golden-analogue for layer A (§6.4): the plan catalogue reconstructed from the
// DB seed rows must deep-equal `PLAN_FEATURES`, and must drive identical
// feature-lock decisions.
//
// DB-FREE by design (plan T-A2, Р-2): it runs the pure builder over `PLAN_SEED`
// — the exact rows the seed writes — instead of hitting Postgres, so `npm test`
// is green without Docker. The real DB seed is verified separately under
// [LOCAL-DB] (`db:seed` → `SELECT count(*)`).
// =============================================================================

import { describe, expect, it } from "vitest";

import { PLAN_SEED, planRowsToFeatures } from "@/server/billing/plan-catalog";
import {
  canAccessFeature,
  PLAN_FEATURES,
  type PlanFeatures,
  type PlanId,
} from "@/shared/plans";

import { RETIRED_REPORT_KEYS } from "./legacy-plan-rows";

// The matrix "restored from the seed rows" — the moral equivalent of what the
// server resolver builds from `plans` + `plan_prices` at runtime.
const fromDb = planRowsToFeatures(PLAN_SEED.plans, PLAN_SEED.prices);

const PLAN_IDS = Object.keys(PLAN_FEATURES) as PlanId[];
const FEATURE_KEYS = Object.keys(PLAN_FEATURES.trial) as (keyof PlanFeatures)[];

// ─── О-15 (T5.8): what this file no longer asserts, and why ─────────────────
//
// Two suites stood here: "report locks match the constant" and "required-plan
// resolution matches the constant". Both read the pre-Phase-1 gate — a plan sold
// you a LIST of reporting frameworks — through the two helpers that walked it,
// and all of it is gone together. Nothing replaces them with a `reportFormats`
// twin: `reportFormats` is an ordinary array feature and is already covered, key
// by key, by the round-trip and the `canAccessFeature` sweep below
// (`FEATURE_KEYS` is derived from `PLAN_FEATURES.trial`, so it picked the key up
// the moment T1.8 added it). What DOES need saying by name is that the retired
// keys have left the catalogue — the last two tests in this file.

// Local re-implementation of the plans.ts lock helper that reads an arbitrary
// `PlanFeatures` object (the shipped helper hard-reads `PLAN_FEATURES`). Proving
// it agrees on the DB-restored features == proving the locks are unchanged.
function canAccessFeatureOn(
  features: PlanFeatures,
  feature: keyof PlanFeatures,
): boolean {
  const val = features[feature];
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

describe("entitlements snapshot — DB catalogue == PLAN_FEATURES (§6.4)", () => {
  it("seeds exactly 4 plans and 8 prices (§5.3)", () => {
    expect(PLAN_SEED.plans).toHaveLength(4);
    expect(PLAN_SEED.prices).toHaveLength(8);
    expect([...fromDb.keys()].sort()).toEqual([...PLAN_IDS].sort());
  });

  it.each(PLAN_IDS)("plan %s round-trips deep-equal to PLAN_FEATURES", (id) => {
    expect(fromDb.get(id)).toEqual(PLAN_FEATURES[id]);
  });

  it("every plan carries an integrations config (Ф-1)", () => {
    for (const plan of PLAN_SEED.plans) {
      expect(Array.isArray(plan.features.integrations)).toBe(true);
    }
    // And the reconstructed contract keeps it non-empty for each tier.
    for (const id of PLAN_IDS) {
      expect(fromDb.get(id)!.integrations.length).toBeGreaterThan(0);
    }
  });

  // ── The T1.8 / PG-1 organisation limits ────────────────────────────────────
  //
  // The six fields added by T1.8, each with what it gates and what its absence
  // from a stored row would do. `FEATURE_KEYS` above is derived from
  // `PLAN_FEATURES.trial`, so the round-trip test already covers them — this one
  // states them BY NAME, because the failure they guard against is a key that
  // silently is not in `plans.features` at all, and a derived list cannot notice
  // a key that is missing from both sides.
  const PG1_KEYS = [
    // PG-2: legal entities inside ONE tenant. A separate axis from
    // `maxCompanies` (tenants per user) — both stay in force. Missing ⇒
    // `currentCount >= undefined` is false ⇒ the limit allows everything.
    "maxLegalEntities",
    // PG-2 + F1: facilities. On starter/trial >3 INCLUDED facilities is a hard
    // 402 at `approved → locked`. Missing ⇒ the F1 gate never fires.
    "maxFacilities",
    // PG-6 / AC-14: the Comprehensive VSME module, gated independently of the
    // entity/facility counts. Missing ⇒ falsy for EVERY plan ⇒ pro and
    // enterprise are blocked from a module they paid for.
    "vsmeComprehensive",
    // PG-2: `reporting_basis='consolidated'`. Missing ⇒ falsy ⇒ no plan can
    // consolidate.
    "consolidatedReports",
    // PG-2: allowed render formats. Missing ⇒ `undefined.includes(fmt)` ⇒
    // TypeError ⇒ HTTP 500 on render, not a 402.
    "reportFormats",
    // EV-0: evidence upload ceiling in MB (flat 20 in Phase 1). Missing ⇒ the
    // size check compares against NaN and never rejects.
    "maxUploadMb",
  ] as const;

  it("stores all six PG-1 organisation limits in plans.features", () => {
    for (const plan of PLAN_SEED.plans) {
      for (const key of PG1_KEYS) {
        expect(plan.features, `${plan.id}.${key}`).toHaveProperty(key);
      }
    }
  });

  it("round-trips each PG-1 limit back to PLAN_FEATURES, never to undefined", () => {
    for (const id of PLAN_IDS) {
      const features = fromDb.get(id)!;
      for (const key of PG1_KEYS) {
        expect(features[key], `${id}.${key}`).toBeDefined();
        expect(features[key], `${id}.${key}`).toEqual(PLAN_FEATURES[id][key]);
      }
    }
  });

  it("keeps maxCompanies and maxLegalEntities as two independent numbers", () => {
    // R-5: conflating the two axes gives either a hole in the limit or a false
    // 402. Enterprise is where they visibly disagree.
    const enterprise = fromDb.get("enterprise")!;
    expect(enterprise.maxCompanies).toBe(-1); // unlimited tenants
    expect(enterprise.maxLegalEntities).toBe(10); // a real ceiling per tenant
  });

  it("prices are minor-unit EUR (monthly = price×100, annual = ×10)", () => {
    for (const id of PLAN_IDS) {
      const monthly = PLAN_SEED.prices.find(
        (p) => p.planId === id && p.period === "monthly",
      )!;
      const annual = PLAN_SEED.prices.find(
        (p) => p.planId === id && p.period === "annual",
      )!;
      expect(monthly.currency).toBe("EUR");
      expect(monthly.amountMinor).toBe(PLAN_FEATURES[id].price * 100);
      expect(annual.amountMinor).toBe(monthly.amountMinor * 10);
    }
  });

  it("feature locks match the constant on DB-restored features", () => {
    for (const id of PLAN_IDS) {
      const features = fromDb.get(id)!;
      for (const key of FEATURE_KEYS) {
        expect(canAccessFeatureOn(features, key)).toBe(
          canAccessFeature(id, key),
        );
      }
    }
  });

  // ── О-15: the retired gate is gone from BOTH sides ────────────────────────
  //
  // The seed rows are what `db:seed` writes and what 0004 inserts; the restored
  // matrix is what `getEntitlements` hands a guard. A key surviving in either
  // would be a gate that still exists at runtime while no code may read it, so
  // both are checked — and `PLAN_FEATURES` itself is checked too, because that
  // is what a stale catalogue row overlays onto.
  it("neither the seed rows nor the restored matrix carry a retired report key", () => {
    for (const key of RETIRED_REPORT_KEYS) {
      for (const plan of PLAN_SEED.plans) {
        expect(plan.features, `seed ${plan.id}.${key}`).not.toHaveProperty(key);
      }
      for (const id of PLAN_IDS) {
        expect(fromDb.get(id)!, `db ${id}.${key}`).not.toHaveProperty(key);
        expect(PLAN_FEATURES[id], `const ${id}.${key}`).not.toHaveProperty(key);
      }
    }
  });

  it("gates the render by FORMAT instead — the one report entitlement left", () => {
    // PG-2, and the whole of what replaced the framework list: trial sells pdf,
    // every paid plan adds xlsx.
    expect(fromDb.get("trial")!.reportFormats).toEqual(["pdf"]);
    for (const id of ["starter", "pro", "enterprise"] as PlanId[]) {
      expect(fromDb.get(id)!.reportFormats, id).toEqual(["pdf", "xlsx"]);
    }
  });
});
