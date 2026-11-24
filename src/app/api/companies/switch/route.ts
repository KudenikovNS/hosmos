/**
 * POST /api/companies/switch — change the user's active company (USERS-ROLES T1.3,
 * §13.2). On success the client invalidates its entire query cache (another
 * company's data must not linger).
 *
 * PATTERN 3 (session-guard): the acting user comes ONLY from `getSession()` — no
 * session → 401. This is the SINGLE endpoint where `companyId` is taken from the
 * request BODY (§0.1): everywhere else identity is session-derived, but here the
 * body deliberately carries the TARGET company. It is validated as a non-empty
 * string (else 422 VALIDATION).
 *
 * `switchCompany` (T1.2a) is the sole writer of both profile company columns (D11);
 * it returns `null` when the user has no ACTIVE membership in the target company
 * (suspended / removed / never a member). That refusal maps to 403 FORBIDDEN — a
 * ROLE/access denial, distinct from 404 (the company might well exist) and never a
 * silent 200.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight are CORS-tagged.
 *
 * Response: `ActionResult<{ companyId }>`.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { switchCompany } from "@/server/db/members";

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });

  const body = (await req.json().catch(() => null)) as {
    companyId?: unknown;
  } | null;
  const companyId = body?.companyId;
  if (typeof companyId !== "string" || companyId === "")
    return apiResult(req, { ok: false, error: "VALIDATION" });

  // `null` = no active membership in the target company → a role/access refusal.
  const switched = await switchCompany(db, session.userId, companyId);
  if (!switched) return apiResult(req, { ok: false, error: "FORBIDDEN" });

  return apiResult(req, { ok: true, data: { companyId } });
});

export const OPTIONS = optionsHandler;
