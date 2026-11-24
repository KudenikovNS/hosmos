// =============================================================================
// Server-side entitlement guards (§7.2, §9) — the SECURITY boundary for paid
// features. The client `usePlan`/`FeatureGate` gate is UX only; anything that
// mutates or reads paid data must call a guard here, because a client can POST
// straight to the API in the bypass of the UI (the real SEC gap this closes).
//
// Style: guards RETURN a Result (`{ ok:false, error:"PLAN_REQUIRED" }` on deny,
// `null` on allow) rather than throwing — matching the route convention where
// expected errors are returned to `apiResult` and `apiRoute` only catches the
// unexpected. A route does: `const denied = await requireFeature(...); if
// (denied) return apiResult(req, denied);` → HTTP 402.
//
// `server-only` guards against client bundling (this touches `db`).
// =============================================================================

import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { companySubscription } from "@/server/db/schema";
import type { PlanFeaturesConfig } from "@/server/db/types";
import {
  getPlanFeaturesFromDb,
  loadPlanFeatures,
} from "@/server/billing/entitlements";
import type { PlanFeatures, PlanId } from "@/shared/plans";

/** The (non-null) session shape guards operate on. */
type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/** Deny result — shape-compatible with `apiResult` (`PLAN_REQUIRED` → 402). */
type PlanRequired = { ok: false; error: "PLAN_REQUIRED" };
const DENIED: PlanRequired = { ok: false, error: "PLAN_REQUIRED" };

/** Guard outcome: `null` allows, `PlanRequired` denies (return it to `apiResult`). */
export type GuardResult = PlanRequired | null;

/** Effective entitlements resolved from subscription status + `DOWNGRADE_MODE`. */
export interface Entitlements {
  /** Features granted for READING (in `readonly` these are the lapsed paid plan). */
  features: PlanFeatures;
  /** Features granted for WRITING (in `readonly`/`locked` downgraded to trial). */
  writeFeatures: PlanFeatures;
  mode: "active" | "locked" | "readonly";
}

/**
 * `DOWNGRADE_MODE` (§9, §12) — how strict the guard is once a subscription is NOT
 * active. `locked` gates read AND write; `readonly` gates only write (read stays
 * on the lapsed paid plan). Default `readonly` (§12): any value but `locked`.
 */
function downgradeMode(): "locked" | "readonly" {
  return process.env.DOWNGRADE_MODE === "locked" ? "locked" : "readonly";
}

/** A trial that has passed its `trial_ends_at` (NULL = open-ended, never expires — ОВ-2). */
function isTrialExpired(trialEndsAt: Date | null): boolean {
  if (!trialEndsAt) return false;
  return trialEndsAt.getTime() <= Date.now();
}

/**
 * Truthiness of a feature value, matching `canAccessFeature` (booleans as-is,
 * numbers non-zero, arrays non-empty). Numeric limits use `requireWithinLimit`.
 */
function hasFeature(
  features: PlanFeatures,
  key: keyof PlanFeaturesConfig,
): boolean {
  const val = features[key];
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (Array.isArray(val)) return val.length > 0;
  return Boolean(val);
}

/**
 * Resolve the effective read/write entitlements for a session (§9). Reads the
 * company's `company_subscription` row and applies `DOWNGRADE_MODE` on a lapse.
 *
 * Layer-A degradation (§7 note, Р-3): the subscription table is not back-filled
 * until layer C, so when there is NO subscription row we trust the denormalized
 * `company.plan` as an active subscription — otherwise every company would read
 * as trial and the guard would break onboarding. Features are resolved from the
 * DB catalogue (`loadPlanFeatures`, same source as `/api/session` — §7.4), so the
 * client cannot forge a plan.
 */
export async function getEntitlements(session: Session): Promise<Entitlements> {
  const map = await loadPlanFeatures(); // warm the catalogue cache
  const featuresFor = (plan: PlanId): PlanFeatures =>
    map.get(plan) ?? getPlanFeaturesFromDb(plan);
  const trial = featuresFor("trial");

  const company = session.company;
  if (!company) {
    // No company on the session → safest floor (trial), treated as active.
    return { features: trial, writeFeatures: trial, mode: "active" };
  }

  const companyPlan = (company.plan as PlanId) || "trial";

  // A company can accumulate rows (e.g. cancel → expire → re-subscribe leaves the
  // old lapsed row in place, T-C1). Pick ONE deterministically: prefer the single
  // LIVE row (the partial-unique index guarantees ≤1 of trialing/active/past_due);
  // if none is live, fall back to the most recent row so `readonly` can still read
  // the last paid plan (§9). Without this ordering `.limit(1)` could grab a stale
  // `cancelled` row and wrongly downgrade a paying customer.
  const [sub] = await db
    .select()
    .from(companySubscription)
    .where(eq(companySubscription.companyId, company.id))
    .orderBy(
      desc(
        sql`(${companySubscription.status} IN ('trialing','active','past_due'))`,
      ),
      desc(companySubscription.createdAt),
    )
    .limit(1);

  // No subscription row yet → degrade to company.plan as an active subscription.
  if (!sub) {
    const f = featuresFor(companyPlan);
    return { features: f, writeFeatures: f, mode: "active" };
  }

  // Active, or trialing still within its term → full paid features (read + write).
  const isActive =
    sub.status === "active" ||
    (sub.status === "trialing" && !isTrialExpired(sub.trialEndsAt));
  if (isActive) {
    const f = featuresFor(sub.planId as PlanId);
    return { features: f, writeFeatures: f, mode: "active" };
  }

  // Lapsed (expired / past_due / expired trial) → apply DOWNGRADE_MODE (§9).
  if (downgradeMode() === "locked") {
    // Gate read AND write: trial features for both.
    return { features: trial, writeFeatures: trial, mode: "locked" };
  }
  // readonly: read the LAST PAID plan (subscription.plan_id); write only trial.
  return {
    features: featuresFor(sub.planId as PlanId),
    writeFeatures: trial,
    mode: "readonly",
  };
}

/** Statuses that count as a LIVE subscription (≤1 per company by partial index). */
const LIVE_SUB_STATUSES = ["trialing", "active", "past_due"] as const;

/**
 * The live subscription's UI-facing state (T-C3). Serialised on `/api/session` so
 * the settings billing UI can show renewal/cancel/downgrade status. `null` when the
 * company has no live subscription (never subscribed, or fully lapsed). Dates are
 * ISO strings — this crosses the JSON wire and is consumed client-side.
 */
export interface SubscriptionState {
  status: (typeof LIVE_SUB_STATUSES)[number];
  period: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  pendingPlanId: string | null;
}

/**
 * Read a company's single LIVE (`trialing|active|past_due`) subscription for the UI,
 * or `null` when none is live. Separate from `getEntitlements` (which may fall back
 * to the most-recent lapsed row for READ access) because the UI wants the ACTIVE row
 * only — a lapsed company shows `subscription: null` and is driven by `mode` instead.
 */
export async function getLiveSubscription(
  companyId: string,
): Promise<SubscriptionState | null> {
  const [sub] = await db
    .select({
      status: companySubscription.status,
      period: companySubscription.period,
      cancelAtPeriodEnd: companySubscription.cancelAtPeriodEnd,
      currentPeriodEnd: companySubscription.currentPeriodEnd,
      pendingPlanId: companySubscription.pendingPlanId,
    })
    .from(companySubscription)
    .where(
      and(
        eq(companySubscription.companyId, companyId),
        inArray(companySubscription.status, [...LIVE_SUB_STATUSES]),
      ),
    )
    .limit(1);
  if (!sub) return null;
  return {
    status: sub.status as SubscriptionState["status"],
    period: sub.period,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    currentPeriodEnd: sub.currentPeriodEnd
      ? sub.currentPeriodEnd.toISOString()
      : null,
    pendingPlanId: sub.pendingPlanId,
  };
}

/**
 * Require a boolean/collection feature. `mutation:true` checks `writeFeatures`
 * (a write action), otherwise `features` (a read). Deny → `PLAN_REQUIRED` (402).
 */
export async function requireFeature(
  session: Session,
  key: keyof PlanFeaturesConfig,
  opts?: { mutation?: boolean },
): Promise<GuardResult> {
  const ent = await getEntitlements(session);
  const source = opts?.mutation ? ent.writeFeatures : ent.features;
  return hasFeature(source, key) ? null : DENIED;
}

/**
 * PG-2 — require the plan to sell the render FORMAT being asked for (T5.7).
 *
 * `reportFormats` is a LIST, not a boolean, so it cannot go through
 * `requireFeature` (which would read a non-empty list as "allowed" and let a
 * trial company render xlsx). Trial sells `['pdf']`; every paid plan adds
 * `'xlsx'`.
 *
 * IT READS `writeFeatures`, like `requireWithinLimit` and unlike a plain read.
 * Producing a render creates a row and a file, so it is a write in the sense
 * `DOWNGRADE_MODE` means: a lapsed subscription in `readonly` may still LIST and
 * DOWNLOAD the renders it already made (those go through `data.read` and no
 * format gate at all), but it may not mint new paid artefacts until it is
 * current again.
 *
 * The value can only be a non-empty array here — `planRowsToFeatures` overlays
 * the stored config onto `PLAN_FEATURES`, so a catalogue row that predates this
 * key still resolves to the code default (see `plan-catalog.ts`).
 */
export async function requireReportFormat(
  session: Session,
  format: string,
): Promise<GuardResult> {
  const ent = await getEntitlements(session);
  return ent.writeFeatures.reportFormats.includes(format) ? null : DENIED;
}

// `requireReport(session, reportId)` stood here until T5.8 (О-15). It read
// `features.reports`, the pre-Phase-1 "which reporting frameworks did you buy"
// list, and its last caller went with the legacy `/reports` page in T3.8. A
// second, almost-identically-named gate beside `requireReportFormat` is a
// standing invitation to call the wrong one, so it is deleted rather than kept
// unused: `reportFormats` (above) is now the ONE tariff gate a render answers to.

/**
 * Require a numeric quota (a creation action) to have room: `currentCount >=
 * limit && limit !== -1` → `PLAN_REQUIRED` (`-1` = unlimited). Uses `writeFeatures`
 * (creating counts as a write). Exported for the limit endpoints of T-A6.
 *
 * `maxLegalEntities` / `maxFacilities` are the Phase-1 organisation limits
 * (PG-1/PG-2, T1.8) and reuse this one mechanism rather than growing a second:
 * it already understands `-1`, already reads `writeFeatures`, and already returns
 * the 402 shape. Note that `maxLegalEntities` is a DIFFERENT axis from
 * `maxCompanies` (see the `PlanFeatures` comment) — a caller must name the one it
 * means. Values are guaranteed numeric by the `planRowsToFeatures` overlay, so no
 * `undefined` can reach the comparison here.
 */
export async function requireWithinLimit(
  session: Session,
  limit:
    "maxTeamMembers" | "maxCompanies" | "maxLegalEntities" | "maxFacilities",
  currentCount: number,
): Promise<GuardResult> {
  const ent = await getEntitlements(session);
  const max = ent.writeFeatures[limit];
  if (max === -1) return null; // unlimited
  return currentCount >= max ? DENIED : null;
}
