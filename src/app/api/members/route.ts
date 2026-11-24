/**
 * GET /api/members — list the session company's members (USERS-ROLES T2.1, §13.3).
 *
 * PATTERN 3 (session-guard): the company comes ONLY from `getSession()` — the
 * request carries NO `companyId`, so there is no way to read another tenant's
 * roster (isolation is structural, not a filter that could be bypassed).
 *
 * Order of checks (§13.5): 401 (no session) → 404 (no company) → 403 (missing
 * `data.read`). The list is `active`+`suspended` members strictly under
 * `session.company.id`.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight are CORS-tagged.
 *
 * Response: `ActionResult<MemberListItem[]>`.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { listCompanyMembers } from "@/server/db/members";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const members = await listCompanyMembers(db, company.id);
  return apiResult(req, { ok: true, data: members });
});

export const OPTIONS = optionsHandler;
