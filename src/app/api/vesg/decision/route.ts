/**
 * PUT /api/vesg/decision — confirm (or un-confirm) one MANUAL requirement of
 * the VESG checklist, with a note (0022). Body: `{ requirement, confirmed,
 * note? }`. Guard order §0.2: 401 → 404 → 403 (`data.write`) → 422.
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
import { VESG_KIND } from "@/server/vesg/evaluate";
import { decideVesg, isVesgRequirement } from "@/server/vesg/vesg";

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
  const requirement = body.requirement;
  // Only the manual items are stored; an automatic one is judged from data and
  // a confirmation of it would be a second, contradictable source.
  if (!isVesgRequirement(requirement) || VESG_KIND[requirement] !== "manual")
    return apiValidationDetail(req, { field: "requirement" });
  if (typeof body.confirmed !== "boolean")
    return apiValidationDetail(req, { field: "confirmed" });
  if (
    body.note !== undefined &&
    body.note !== null &&
    typeof body.note !== "string"
  )
    return apiValidationDetail(req, { field: "note" });

  await decideVesg(db, company.id, session.userId, {
    requirement,
    confirmed: body.confirmed,
    note: typeof body.note === "string" ? body.note : null,
  });
  return apiResult(req, { ok: true, data: { ok: true } });
});

export const OPTIONS = optionsHandler;
