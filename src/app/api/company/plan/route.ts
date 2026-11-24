/**
 * POST /api/company/plan — change the company's plan (T-21, §4.2).
 *
 * Replaces the `changePlan` server action (the plan mutation moved out of the
 * browser's usePlan). No billing logic, exactly as before. The company comes ONLY
 * from `getSession()` (PATTERN 3). `newPlan` is validated against the known
 * PlanIds (`PLAN_FEATURES` hasOwnProperty — 1:1 with the old action) so garbage
 * never reaches the DB; an unknown id → VALIDATION (422). On success the company's
 * `plan` + `plan_start = today` are updated via the Drizzle `updateCompany`
 * service. Response: `ActionResult<{plan}>`. This validation is the SEC guarantee
 * that a client cannot set an arbitrary plan string.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { applyPlanDowngradeSeatEffects } from "@/server/auth/seats";
import { db } from "@/server/db";
import { updateCompany } from "@/server/db/company";
import { PLAN_FEATURES, type PlanId } from "@/shared/plans";

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) — changing the plan is a billing capability (§7.3).
  const forbidden = requireCapability(session, "billing.manage");
  if (forbidden) return apiResult(req, forbidden);

  const body = (await req.json().catch(() => ({}))) as { plan?: unknown };
  const newPlan = body.plan;
  if (
    typeof newPlan !== "string" ||
    !Object.prototype.hasOwnProperty.call(PLAN_FEATURES, newPlan)
  ) {
    console.error("POST /api/company/plan: unknown plan id", newPlan);
    return apiResult(req, { ok: false, error: "VALIDATION" });
  }
  const plan = newPlan as PlanId;
  const oldPlan = (company.plan as PlanId) ?? "trial";

  await updateCompany(db, company.id, {
    plan,
    planStart: new Date().toISOString().split("T")[0],
  });

  // T2.2 (§10.3): a seat downgrade into over-seat revokes pending invitations and
  // records an audit row. People are NEVER evicted — existing memberships stand;
  // the company just enters `overLimit`. Additive to the plan write above.
  await applyPlanDowngradeSeatEffects(db, {
    companyId: company.id,
    oldPlan,
    newPlan: plan,
    actorRole: session.membership?.role ?? null,
    userId: session.userId ?? null,
  });

  return apiResult(req, { ok: true, data: { plan } });
});

export const OPTIONS = optionsHandler;
