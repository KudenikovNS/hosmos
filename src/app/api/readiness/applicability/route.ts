/**
 * PUT /api/readiness/applicability — declare a datapoint not applicable or
 * omitted as sensitive (with a reason), or withdraw that decision.
 *
 * Body: `{ revision_id, metric_key, status: 'not_applicable' |
 * 'sensitive_omitted' | null, reason?: string }`. Guard order §0.2:
 * 401 → 404 → 403 (`data.write`) → 422. A locked revision refuses with the
 * same shape VAL-106 uses for its period fields: the decision is part of what
 * the locked report was built on.
 */
import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { decideApplicability } from "@/server/readiness/applicability";

const STATUSES = ["not_applicable", "sensitive_omitted"] as const;

export const PUT = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.write");
  if (forbidden) return apiResult(req, forbidden);

  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return apiValidationDetail(req, { field: "body" });
  const revisionId = body.revision_id;
  const metricKey = body.metric_key;
  const status = body.status;
  if (typeof revisionId !== "string")
    return apiValidationDetail(req, { field: "revision_id" });
  if (typeof metricKey !== "string")
    return apiValidationDetail(req, { field: "metric_key" });
  if (status !== null && !STATUSES.includes(status as never))
    return apiValidationDetail(req, { field: "status" });

  const outcome = await decideApplicability(db, company.id, session.userId, {
    revisionId,
    metricKey,
    status: status as (typeof STATUSES)[number] | null,
    reason: typeof body.reason === "string" ? body.reason : null,
  });
  if (!outcome.ok) {
    if (outcome.reason === "no_revision")
      return apiValidationDetail(req, { field: "revision_id" });
    if (outcome.reason === "unknown_metric")
      return apiValidationDetail(req, { field: "metric_key" });
    if (outcome.reason === "reason_required")
      return apiValidationDetail(req, { field: "reason" });
    return apiValidationDetail(req, { rule: "VAL-106" });
  }
  return apiResult(req, { ok: true, data: { ok: true } });
});

export const OPTIONS = optionsHandler;
