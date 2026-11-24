/**
 * GET /api/companies — the user's company memberships + the active one (USERS-ROLES
 * T1.3, §13.2). Powers the company switcher (§4.5): the list to choose from and the
 * id currently highlighted.
 *
 * PATTERN 3 (session-guard): identity comes ONLY from `getSession()` (never a client
 * parameter) — no session → 401. The two payload fields are read straight off the
 * session `getSession()` already resolved (T1.2b): `companies` is `session.memberships`
 * and `activeCompanyId` is `session.company?.id`. Nothing is recomputed here.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight are CORS-tagged.
 *
 * Response: `ActionResult<{ companies: DbMembershipSummary[]; activeCompanyId }>`.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { getSession } from "@/server/auth/session";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });

  const companies = session.memberships ?? [];
  const activeCompanyId = session.company?.id ?? null;
  return apiResult(req, { ok: true, data: { companies, activeCompanyId } });
});

export const OPTIONS = optionsHandler;
