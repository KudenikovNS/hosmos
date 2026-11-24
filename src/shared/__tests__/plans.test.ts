import { describe, it, expect } from "vitest";
import {
  minPlanFor,
  canAccessFeature,
  getPlanFeatures,
  PLAN_FEATURES,
} from "@/shared/plans";
import type { PlanId } from "@/shared/plans";

// T-A5 (§13.2/§13.4): `minPlanFor(feature)` returns the cheapest plan (by
// PLAN_ORDER) whose feature matrix grants `feature`. Drives the required-plan
// badge on FeatureGate, so it must stay consistent with `canAccessFeature`.
// (It was once described as the boolean-feature analogue of a per-report-ID
// twin; that twin and the framework list it read were retired in T5.8/О-15, and
// `minPlanFor` is now the only one of the pair.)
describe("minPlanFor", () => {
  it("returns the cheapest plan that grants each paid feature", () => {
    expect(minPlanFor("scope3")).toBe("starter");
    expect(minPlanFor("socialParams")).toBe("starter");
    expect(minPlanFor("governanceParams")).toBe("starter");
    expect(minPlanFor("dataExport")).toBe("starter");
    expect(minPlanFor("scope3Full")).toBe("pro");
    expect(minPlanFor("supplyChain")).toBe("pro");
    expect(minPlanFor("goals")).toBe("pro");
    expect(minPlanFor("apiAccess")).toBe("enterprise");
  });

  it("returns trial for features every plan already grants", () => {
    // Non-empty array / non-zero number on trial → accessible from the lowest
    // tier. (The two retired report-gating keys used to be the examples here;
    // T5.8/О-15 removed both, and `reportFormats` is the array feature that
    // survives — trial sells `['pdf']`, so the ARRAY is non-empty on every
    // plan and `canAccessFeature` says trial. WHICH format you may ask for is
    // `requireReportFormat`'s question, not `minPlanFor`'s.)
    expect(minPlanFor("reportFormats")).toBe("trial");
    expect(minPlanFor("maxUploadMb")).toBe("trial");
  });

  it("agrees with canAccessFeature: the result grants, the tier below does not", () => {
    const order: PlanId[] = ["trial", "starter", "pro", "enterprise"];
    for (const feature of Object.keys(
      PLAN_FEATURES.trial,
    ) as (keyof typeof PLAN_FEATURES.trial)[]) {
      const min = minPlanFor(feature);
      expect(canAccessFeature(min, feature)).toBe(true);
      const idx = order.indexOf(min);
      if (idx > 0) {
        expect(canAccessFeature(order[idx - 1], feature)).toBe(false);
      }
    }
  });
});

// =============================================================================
// T1.8 / PG-1 — the Phase-1 organisation limits.
//
// The pricing matrix is transcribed here from the SPEC table (§11, PG-1), not
// read back out of `PLAN_FEATURES`, so this is a real oracle: an edit to the
// constant that changes a tier's entitlement has to be made twice, deliberately,
// or it goes red. 4 plans × 6 new fields = 24 assertions.
// =============================================================================

/**
 * DATA-MODEL-PHASE1-SPEC §11 PG-1, verbatim:
 *
 * | plan       | maxLegalEntities | maxFacilities | VSME module     | consolidation | formats    |
 * |------------|------------------|---------------|-----------------|---------------|------------|
 * | trial      | 1                | 3             | Basic           | no            | pdf        |
 * | starter    | 1                | 3             | Basic           | no            | pdf, xlsx  |
 * | pro        | 3                | 15            | + Comprehensive | yes           | pdf, xlsx  |
 * | enterprise | 10               | −1            | + Comprehensive | yes           | pdf, xlsx  |
 *
 * `maxUploadMb` is not in that table — EV-0 sets it at a flat default of 20 MB
 * for Phase 1, per plan so a tier can be lifted later without a schema change.
 */
const PG1: Record<
  PlanId,
  {
    maxLegalEntities: number;
    maxFacilities: number;
    vsmeComprehensive: boolean;
    consolidatedReports: boolean;
    reportFormats: string[];
    maxUploadMb: number;
  }
> = {
  trial: {
    maxLegalEntities: 1,
    maxFacilities: 3,
    vsmeComprehensive: false,
    consolidatedReports: false,
    reportFormats: ["pdf"],
    maxUploadMb: 20,
  },
  starter: {
    maxLegalEntities: 1,
    maxFacilities: 3,
    vsmeComprehensive: false,
    consolidatedReports: false,
    reportFormats: ["pdf", "xlsx"],
    maxUploadMb: 20,
  },
  pro: {
    maxLegalEntities: 3,
    maxFacilities: 15,
    vsmeComprehensive: true,
    consolidatedReports: true,
    reportFormats: ["pdf", "xlsx"],
    maxUploadMb: 20,
  },
  enterprise: {
    maxLegalEntities: 10,
    maxFacilities: -1,
    vsmeComprehensive: true,
    consolidatedReports: true,
    reportFormats: ["pdf", "xlsx"],
    maxUploadMb: 20,
  },
};

const PG1_PLANS = Object.keys(PG1) as PlanId[];
const PG1_FIELDS = Object.keys(PG1.trial) as (keyof (typeof PG1)["trial"])[];

describe("PG-1 organisation limits (T1.8)", () => {
  it.each(PG1_PLANS)("plan %s matches the PG-1 row on all six fields", (id) => {
    for (const field of PG1_FIELDS) {
      expect(PLAN_FEATURES[id][field], `${id}.${field}`).toEqual(
        PG1[id][field],
      );
    }
  });

  it("keeps maxCompanies and maxLegalEntities as separate axes (R-5)", () => {
    // The two are NOT the same number and must never be collapsed:
    // `maxCompanies` counts TENANTS per user, `maxLegalEntities` counts legal
    // entities INSIDE one tenant. Enterprise is where the difference is loudest
    // — unlimited tenants, but a hard ceiling of 10 legal entities each.
    expect(PLAN_FEATURES.enterprise.maxCompanies).toBe(-1);
    expect(PLAN_FEATURES.enterprise.maxLegalEntities).toBe(10);
    // …and pro is the other way round: fewer tenants than the entity ceiling
    // would suggest if the two were one field.
    expect(PLAN_FEATURES.pro.maxCompanies).toBe(3);
    expect(PLAN_FEATURES.pro.maxFacilities).toBe(15);
  });

  it("uses -1 for unlimited only where PG-1 says so", () => {
    // Exactly one of the new numeric limits is unlimited in the whole matrix.
    const unlimited = PG1_PLANS.filter(
      (id) => PLAN_FEATURES[id].maxFacilities === -1,
    );
    expect(unlimited).toEqual(["enterprise"]);
    // No plan gets unlimited legal entities — 10 is a real Enterprise ceiling.
    for (const id of PG1_PLANS) {
      expect(PLAN_FEATURES[id].maxLegalEntities, id).toBeGreaterThan(0);
    }
  });

  it("gates the Comprehensive module strictly above Starter (PG-6 / AC-14)", () => {
    expect(minPlanFor("vsmeComprehensive")).toBe("pro");
    expect(minPlanFor("consolidatedReports")).toBe("pro");
    // …and independently of the entity/facility limits (AC-14): trial and
    // starter share the SAME limits but neither gets the module, while pro
    // raises both at once — so the module cannot be inferred from the counts.
    expect(PLAN_FEATURES.trial.maxFacilities).toBe(
      PLAN_FEATURES.starter.maxFacilities,
    );
    expect(PLAN_FEATURES.starter.vsmeComprehensive).toBe(false);
  });

  it("gives every plan a non-empty reportFormats array (no .includes on undefined)", () => {
    for (const id of PG1_PLANS) {
      expect(Array.isArray(PLAN_FEATURES[id].reportFormats), id).toBe(true);
      expect(PLAN_FEATURES[id].reportFormats, id).toContain("pdf");
    }
    // xlsx is the paid-tier addition; trial is pdf-only (К-22: the EFRAG Excel
    // export itself is Phase 4, this is only the format allow-list).
    expect(PLAN_FEATURES.trial.reportFormats).not.toContain("xlsx");
  });
});

describe("getPlanFeatures fallback", () => {
  it("falls back to trial for an unknown, empty or missing plan id", () => {
    expect(getPlanFeatures("does-not-exist")).toBe(PLAN_FEATURES.trial);
    expect(getPlanFeatures(null)).toBe(PLAN_FEATURES.trial);
    expect(getPlanFeatures(undefined)).toBe(PLAN_FEATURES.trial);
    expect(getPlanFeatures("")).toBe(PLAN_FEATURES.trial);
    // Still resolves a real plan for a real id (the fallback is not a blanket).
    expect(getPlanFeatures("pro")).toBe(PLAN_FEATURES.pro);
  });

  it("returns the PG-1 trial row on that fallback, not a bare object", () => {
    // The floor has to be a COMPLETE contract: a caller reading
    // `getPlanFeatures(x).reportFormats.includes(...)` must never see undefined.
    const fallback = getPlanFeatures("nope");
    for (const field of PG1_FIELDS) {
      expect(fallback[field], field).toEqual(PG1.trial[field]);
    }
  });
});
