// =============================================================================
// Plan definitions & access control
// =============================================================================

export type PlanId = "trial" | "starter" | "pro" | "enterprise";

export interface PlanFeatures {
  id: PlanId;
  name: string;
  /**
   * MONTHLY list price in EUR. The annual price is 10× this (§5.2), and the
   * annual figure is the one the public page quotes: ТЗ первой лендинговой
   * страницы v1.0 (15.08.2026) §7 fixes Starter €300, Pro €1 000, Enterprise
   * €2 000 a year excl. VAT — hence 30 / 100 / 200 here. `content.test.ts` on
   * the landing asserts the two sources agree; change both or neither.
   */
  price: number;
  scope3: boolean;
  scope3Full: boolean; // all 15 categories
  socialParams: boolean;
  governanceParams: boolean;
  supplyChain: boolean;
  goals: boolean;
  integrations: string[]; // allowed tiers
  maxCompanies: number;
  maxTeamMembers: number;
  dataExport: boolean;
  apiAccess: boolean;

  // ─── Phase-1 organisation limits (DATA-MODEL PG-1, T1.8) ───────────────────
  // `maxCompanies` above is NOT replaced or restated by `maxLegalEntities`: the
  // two are ORTHOGONAL axes and BOTH stay in force.
  //   • `maxCompanies`      — how many TENANT companies one user may own/join
  //                           (the multi-company axis of USERS-ROLES);
  //   • `maxLegalEntities`  — how many legal entities may exist INSIDE one
  //                           tenant (the org tree of the reporting model; the
  //                           parent company occupies one of these slots — PG-2).
  // Conflating them yields either a hole in the limit or a false 402, so a guard
  // must pick the axis it actually means. `-1` = unlimited, as everywhere else.
  maxLegalEntities: number;
  maxFacilities: number;
  /** Comprehensive VSME module (PG-6): without it a `comprehensive` metric 422s. */
  vsmeComprehensive: boolean;
  /** `reporting_basis='consolidated'` allowed (PG-2). */
  consolidatedReports: boolean;
  /**
   * Render formats allowed for this plan (PG-2). Phase 1: pdf, xlsx (К-22).
   *
   * THE ONLY REPORT GATE THERE IS (О-15, T5.8). Until T5.8 this interface also
   * carried a list of allowed report IDs and a monthly render quota, from the
   * pre-Phase-1 product where a "report" was a framework you subscribed to
   * (`gri`, `esrs`, `cdp`, …) and producing one drew on an allowance. Phase 1
   * renders ONE pack — VSME Basic — and gates the FORMAT of it, so those two
   * keys had no consumer left after the legacy `/reports` page died in T3.8.
   * They are gone from here, from `plans.features`
   * (`drizzle/0006_retire_report_gating.sql`) and from the guards. Two
   * near-homonymous gates ("may this plan have this report" vs. "may this plan
   * have this FORMAT of the report") are not kept side by side on the chance one
   * becomes useful again: they diverge silently, and the wrong one being
   * consulted is invisible until a customer is charged for the wrong thing.
   */
  reportFormats: string[];
  /** Evidence upload ceiling in MB (EV-0; default 20). */
  maxUploadMb: number;
  /**
   * The simplified-ESRS layer (партия 9, 07.09.2026): the 50 `standard='esrs'`
   * datapoints of `metric_catalog` (0019) may be ANSWERED, the readiness hub
   * shows them as a second block, and the report carries the ESRS
   * cross-reference appendix. Gated like `vsmeComprehensive` — a module, not a
   * quota: a value against an ESRS metric on a plan without it is a 422, never
   * a 402 (`server/inventory/disclosures.ts`). Carried to `plans.features` by
   * `drizzle/0021_plans_simplified_esrs.sql`.
   */
  simplifiedEsrs: boolean;
}

export const PLAN_FEATURES: Record<PlanId, PlanFeatures> = {
  trial: {
    id: "trial",
    name: "Trial",
    price: 0,
    scope3: false,
    scope3Full: false,
    socialParams: false,
    governanceParams: false,
    supplyChain: false,
    goals: false,
    integrations: ["starter"],
    maxCompanies: 1,
    maxTeamMembers: 1,
    dataExport: false,
    apiAccess: false,
    // PG-1: trial mirrors the Starter limits (the pricing PDF does not describe
    // trial separately).
    maxLegalEntities: 1,
    maxFacilities: 3,
    vsmeComprehensive: false,
    consolidatedReports: false,
    reportFormats: ["pdf"],
    maxUploadMb: 20,
    simplifiedEsrs: false,
  },
  starter: {
    id: "starter",
    name: "Starter",
    price: 30,
    scope3: true,
    scope3Full: false,
    socialParams: true,
    governanceParams: true,
    supplyChain: false,
    goals: false,
    integrations: ["starter"],
    maxCompanies: 1,
    maxTeamMembers: 5,
    dataExport: true,
    apiAccess: false,
    // PG-1 / F1: >3 included facilities on Starter is a HARD gate at
    // `approved → locked` (402), not a soft `excluded_by_plan` stamp.
    maxLegalEntities: 1,
    maxFacilities: 3,
    vsmeComprehensive: false,
    consolidatedReports: false,
    reportFormats: ["pdf", "xlsx"],
    maxUploadMb: 20,
    simplifiedEsrs: false,
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: 100,
    scope3: true,
    scope3Full: true,
    socialParams: true,
    governanceParams: true,
    supplyChain: true,
    goals: true,
    integrations: ["starter", "pro"],
    maxCompanies: 3,
    maxTeamMembers: 15,
    dataExport: true,
    apiAccess: false,
    maxLegalEntities: 3,
    maxFacilities: 15,
    vsmeComprehensive: true,
    consolidatedReports: true,
    reportFormats: ["pdf", "xlsx"],
    maxUploadMb: 20,
    simplifiedEsrs: true,
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    price: 200,
    scope3: true,
    scope3Full: true,
    socialParams: true,
    governanceParams: true,
    supplyChain: true,
    goals: true,
    integrations: ["starter", "pro", "enterprise"],
    maxCompanies: -1,
    maxTeamMembers: -1,
    dataExport: true,
    apiAccess: true,
    // PG-1: 10 legal entities is a real ceiling on Enterprise (the pricing PDF
    // caps it); only the facility count is unlimited.
    maxLegalEntities: 10,
    maxFacilities: -1,
    vsmeComprehensive: true,
    consolidatedReports: true,
    reportFormats: ["pdf", "xlsx"],
    maxUploadMb: 20,
    simplifiedEsrs: true,
  },
};

export function getPlanFeatures(
  planId: string | null | undefined,
): PlanFeatures {
  return PLAN_FEATURES[(planId as PlanId) || "trial"] || PLAN_FEATURES.trial;
}

// Badge color per plan (single source of truth — matches the Badge variants).
export type PlanBadgeVariant = "gray" | "blue" | "violet" | "yellow";

export function getPlanBadgeVariant(plan: PlanId): PlanBadgeVariant {
  switch (plan) {
    case "trial":
      return "gray";
    case "pro":
      return "violet";
    case "enterprise":
      return "yellow";
    default:
      return "blue"; // starter
  }
}

export function canAccessFeature(
  plan: PlanId,
  feature: keyof PlanFeatures,
): boolean {
  const features = PLAN_FEATURES[plan] || PLAN_FEATURES.trial;
  const val = features[feature];
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

// The two report-ID lookups ("may this plan open this framework", "which plan
// would") lived here until T5.8 (О-15) and are gone with the key they read —
// see the comment on `reportFormats`. Nothing replaced them: a Phase-1 report is
// gated by FORMAT (`requireReportFormat`, PG-2) and stamped by COVERAGE
// (`planCoverage`, D14), and neither is a lookup of a report ID.

// Plan hierarchy for upgrade comparison (index = sort order). Exported so the
// subscription-transition route (T-C2) can compare upgrade/downgrade direction.
export const PLAN_ORDER: PlanId[] = ["trial", "starter", "pro", "enterprise"];

// The cheapest plan (by PLAN_ORDER) whose matrix grants `feature`. Drives the
// required-plan badge on `<FeatureGate>`; stays consistent with
// `canAccessFeature` by construction.
export function minPlanFor(feature: keyof PlanFeatures): PlanId {
  for (const plan of PLAN_ORDER) {
    if (canAccessFeature(plan, feature)) return plan;
  }
  return "enterprise";
}
