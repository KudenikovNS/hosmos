// =============================================================================
// F1 — THE STARTER HARD GATE (PG-3, VAL-105), as FACTS rather than as a refusal.
//
// The tariff PDF has exactly one place where a plan limit BLOCKS instead of
// stamping: a Starter/Trial customer with more includable facilities than the
// plan allows cannot bring a report to `Locked` (§11.3, F1). Everywhere else
// D14/PG-4 applies — the entity that does not fit is listed in
// `report_render.excluded_by_plan` and the claim drops to `partial`, and the
// product keeps working.
//
// WHY THIS IS A LEAF MODULE AND NOT PART OF THE TRANSITION SERVICE. Two callers
// must agree on the number, and they cannot import each other:
//   • `@/server/validation/evaluators/periods` — VAL-105, which is what WRITES
//     the result the UI renders ("you have 4 sites, Starter allows 3");
//   • `@/server/revisions/transition` — the `approved → locked` precondition,
//     which turns that same result into the 402 `PLAN_REQUIRED`.
// The evaluator cannot reach for `@/server/billing/*`: that module carries
// `server-only` and touches the `db` SINGLETON, while an evaluator is handed the
// transaction it must read inside (and is imported by the DB-less registry unit
// test). So the plan matrix is read here, from the `plans` catalogue through the
// caller's handle, with `PLAN_FEATURES` as the fallback — the same two sources,
// in the same order, as `getPlanFeaturesFromDb`.
//
// WHOSE PLAN, AND WHY NOT THE SUBSCRIPTION. §11.3 says "план компании", and the
// company's plan is what this reads. `getEntitlements` additionally downgrades a
// LAPSED subscription to trial for writes; applying that here would mean a
// billing hiccup silently re-decides whether last quarter's report may be
// closed, which is not what F1 is about. The subscription gates BUYING features;
// F1 gates a claim of completeness.
// =============================================================================
import { and, count, eq, inArray } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import { companies, facility, periodScope, plans } from "@/server/db/schema";
import { PLAN_FEATURES, type PlanId } from "@/shared/plans";

/**
 * The plans on which F1 is a HARD gate (§11.3). Deliberately a list of two and
 * not "any plan with a finite limit": on `pro` an over-limit facility is a
 * soft stamp (PG-4/D14 — `excluded_by_plan`, forced `partial`), and turning it
 * into a refusal here would block a paying customer from closing a report that
 * the tariff says they may close, merely with a `partial` coverage claim.
 */
const HARD_GATED_PLANS: readonly PlanId[] = ["trial", "starter"];

/** Unlimited, in the `PlanFeatures` numeric-limit convention. */
const UNLIMITED = -1;

/** What F1 has to say about one period. */
export interface FacilityGateVerdict {
  /** The company's plan (from `companies.plan`; `trial` when unset). */
  readonly plan: PlanId;
  /** Does F1 apply at all — i.e. is the plan one of the hard-gated two? */
  readonly applies: boolean;
  /** `maxFacilities` of that plan (`-1` = unlimited). */
  readonly limit: number;
  /** Includable facilities of the period's INCLUDED entities (see below). */
  readonly facilities: number;
  /** May this period be locked? `false` is the 402 and the failed VAL-105. */
  readonly passed: boolean;
}

/** The company's plan, defaulting to `trial` exactly as `getEntitlements` does. */
async function planOf(db: DbClient, companyId: string): Promise<PlanId> {
  const [row] = await db
    .select({ plan: companies.plan })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return ((row?.plan as PlanId | null) || "trial") as PlanId;
}

/**
 * The two ORGANISATIONAL limits of a company's plan (`-1` = unlimited).
 *
 * Read from the `plans` catalogue first and from the code matrix second — the
 * same two sources, in the same order, as `getPlanFeaturesFromDb`.
 *
 * EXPORTED BECAUSE D14 NEEDS THE SAME NUMBERS (T5.7, REN-4). The soft
 * completeness stamp on a render (`report_render.excluded_by_plan`) and the F1
 * hard gate below are the two halves of one rule — "the plan decides how much of
 * the undertaking a report may cover" — and they must not read the plan matrix
 * through two different paths. Note WHOSE plan this is: the COMPANY's, not the
 * subscription's, for the reason in the module header. `@/server/billing/guard`
 * additionally downgrades a lapsed subscription for WRITES, which is the right
 * rule for buying a feature and the wrong one for a claim of completeness.
 */
export interface PlanOrgLimits {
  readonly plan: PlanId;
  readonly maxLegalEntities: number;
  readonly maxFacilities: number;
}

/** {@link PlanOrgLimits} for one company. */
export async function planOrgLimits(
  db: DbClient,
  companyId: string,
): Promise<PlanOrgLimits> {
  const plan = await planOf(db, companyId);
  const [row] = await db
    .select({ features: plans.features })
    .from(plans)
    .where(eq(plans.id, plan))
    .limit(1);
  const limit = (key: "maxLegalEntities" | "maxFacilities"): number => {
    const fromDb = row?.features?.[key];
    return typeof fromDb === "number" ? fromDb : PLAN_FEATURES[plan][key];
  };
  return {
    plan,
    maxLegalEntities: limit("maxLegalEntities"),
    maxFacilities: limit("maxFacilities"),
  };
}

/**
 * How many facilities the report would actually cover (§11.3's count).
 *
 * TWO CONDITIONS, ONE NUMBER, and both halves matter. `period_scope.status =
 * 'included'` is the PERIOD's decision (DM-8: the boundary is drawn per period),
 * `facility.included_in_boundary` is the REGISTRY's (DM-5: a site that is not
 * operational this year is not reported on). A facility counts only when both
 * say yes — so excluding a subsidiary, or flagging a site out of the registry,
 * are both legitimate ways for a Starter customer to come back under the limit,
 * and neither is a trick: what is left IS what the report will claim to cover.
 */
async function countIncludableFacilities(
  db: DbClient,
  companyId: string,
  periodId: string,
): Promise<number> {
  const included = await db
    .select({ legalEntityId: periodScope.legalEntityId })
    .from(periodScope)
    .where(
      and(
        eq(periodScope.companyId, companyId),
        eq(periodScope.periodId, periodId),
        eq(periodScope.status, "included"),
      ),
    );
  if (included.length === 0) return 0;

  const [row] = await db
    .select({ total: count() })
    .from(facility)
    .where(
      and(
        eq(facility.companyId, companyId),
        eq(facility.includedInBoundary, true),
        inArray(
          facility.legalEntityId,
          included.map((entry) => entry.legalEntityId),
        ),
      ),
    );
  return row?.total ?? 0;
}

/**
 * The whole F1 verdict for one period — the ONE computation behind both VAL-105
 * and the 402. An unlimited or non-gated plan passes without counting anything.
 */
export async function facilityGateVerdict(
  db: DbClient,
  companyId: string,
  periodId: string,
): Promise<FacilityGateVerdict> {
  const { plan, maxFacilities: limit } = await planOrgLimits(db, companyId);
  const applies = HARD_GATED_PLANS.includes(plan) && limit !== UNLIMITED;
  if (!applies) {
    return { plan, applies: false, limit, facilities: 0, passed: true };
  }
  const facilities = await countIncludableFacilities(db, companyId, periodId);
  return {
    plan,
    applies: true,
    limit,
    facilities,
    passed: facilities <= limit,
  };
}
