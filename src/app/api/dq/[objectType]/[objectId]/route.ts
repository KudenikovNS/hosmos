/**
 * GET / PUT /api/dq/[objectType]/[objectId] — the data-quality assessment of one
 * object (DATA-MODEL T4.3; DM-27, DQ-1…DQ-3, К-16, VAL-038, VAL-039, §12.2).
 *
 * See docs/decisions/app-api-dq-objectType-objectId-route.md for the full account.
 */
import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  isUuid,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import {
  assessmentTargetExists,
  getAssessment,
  needsReviewCapability,
  parseAssessment,
  putAssessment,
  serialiseAssessment,
} from "@/server/dq/assessments";
import { isObjectType, type ObjectType } from "@/shared/enums";

type Ctx = { params: Promise<{ objectType: string; objectId: string }> };

/** The two path segments, or `undefined` when they name nothing that could exist. */
async function targetOf(
  ctx: Ctx,
): Promise<{ objectType: ObjectType; objectId: string } | undefined> {
  const { objectType, objectId } = await ctx.params;
  // A non-uuid would reach Postgres as a malformed literal → 500 (isUuid), and
  // an unknown object type names no table at all. Both are `NO_DATA`: the path
  // is how this route identifies a resource, so a path that cannot identify one
  // describes something absent rather than a malformed body.
  if (!isObjectType(objectType) || !isUuid(objectId)) return undefined;
  return { objectType, objectId };
}

export const GET = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const target = await targetOf(ctx);
  if (!target) return apiResult(req, { ok: false, error: "NO_DATA" });

  // The OBJECT is checked for existence, not the assessment: "this row has no
  // assessment yet" and "this row is not yours" must not be the same answer.
  const exists = await assessmentTargetExists(
    db,
    company.id,
    target.objectType,
    target.objectId,
  );
  if (!exists) return apiResult(req, { ok: false, error: "NO_DATA" });

  const row = await getAssessment(
    db,
    company.id,
    target.objectType,
    target.objectId,
  );
  return apiResult(req, {
    ok: true,
    data: { assessment: row ? serialiseAssessment(row) : null },
  });
});

export const PUT = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.write");
  if (forbidden) return apiResult(req, forbidden);

  const target = await targetOf(ctx);
  if (!target) return apiResult(req, { ok: false, error: "NO_DATA" });

  const body = await req.json().catch(() => null);
  const parsed = parseAssessment(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  // DQ-2 — the override needs `data.review`, in BOTH directions (setting it and
  // clearing somebody else's). The current row is read for the second half; it
  // is a tenant-pinned read of the same object the write is about, so it leaks
  // nothing a `data.write` holder could not already fetch through GET.
  const current = await getAssessment(
    db,
    company.id,
    target.objectType,
    target.objectId,
  );
  if (needsReviewCapability(current, parsed.values)) {
    const unreviewable = requireCapability(session, "data.review");
    if (unreviewable) return apiResult(req, unreviewable);
  }

  const result = await putAssessment(
    db,
    { companyId: company.id, userId: session.userId },
    target.objectType,
    target.objectId,
    parsed.values,
  );
  if (!result.ok) {
    return result.error === "RULES"
      ? apiValidationDetail(req, { rules: result.rules })
      : apiResult(req, { ok: false, error: "NO_DATA" });
  }

  return apiResult(req, {
    ok: true,
    data: {
      assessment: serialiseAssessment(result.row),
      // VAL-038 travels here: an assessment saved with scores still empty is
      // recorded, returned and NOT refused (DQ-3). The client renders it as a
      // prompt to finish, not as a failure.
      warnings: result.warnings,
    },
  });
});

export const OPTIONS = optionsHandler;
