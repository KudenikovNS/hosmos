/**
 * PATCH / DELETE /api/members/:userId — change a member's role/status, or soft-
 * remove them (USERS-ROLES T2.1, §13.3 / D9 / §4.3).
 *
 * PATTERN 3 (session-guard): the acting user and company come ONLY from
 * `getSession()`. The `:userId` path segment is the TARGET's identifier, never the
 * actor's identity — the two must not be conflated. The target is always pinned to
 * `session.company.id`, so a foreign member is a 403, not a cross-tenant write.
 *
 * Order of checks (§13.5): 401 (no session) → 404 (no company) → 403 (missing
 * `members.manage`) → 422 (body validation). Authentication precedes validation,
 * so a garbage body with no session is a 401, never a 422 leak.
 *
 * D9 (§13.3): demoting / suspending / removing the LAST active `esg_admin`, or an
 * admin changing their OWN role/status, is a 403 FORBIDDEN — an access rule, not a
 * form error (not 422). The guard runs in a transaction in `updateMembership`.
 *
 * Every successful mutation writes exactly one `audit_log` row (`entity:'member'`,
 * `actorRole` snapshotted from the session, §11.1); a refusal writes NONE.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight are CORS-tagged.
 *
 * Response: `ActionResult<MemberMutation>`.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { logAudit } from "@/server/db/audit";
import { updateMembership, type MemberStatus } from "@/server/db/members";
import type { CompanyRole } from "@/shared/roles";

/** The six company roles (mirrors `company_members_role_check`). */
const ROLES: readonly CompanyRole[] = [
  "esg_admin",
  "data_owner",
  "contributor",
  "reviewer",
  "approver",
  "auditor",
];

/** The three membership statuses a PATCH may set (mirrors the status CHECK). */
const STATUSES: readonly MemberStatus[] = ["active", "suspended", "removed"];

type Ctx = { params: Promise<{ userId: string }> };

export const PATCH = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "members.manage");
  if (forbidden) return apiResult(req, forbidden);

  const body = (await req.json().catch(() => null)) as {
    role?: unknown;
    status?: unknown;
  } | null;
  if (!body || typeof body !== "object")
    return apiResult(req, { ok: false, error: "VALIDATION" });

  // At least one of role/status must be present and valid; anything else is 422.
  let role: CompanyRole | undefined;
  if (body.role !== undefined) {
    if (!(ROLES as readonly string[]).includes(body.role as string))
      return apiResult(req, { ok: false, error: "VALIDATION" });
    role = body.role as CompanyRole;
  }
  let status: MemberStatus | undefined;
  if (body.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(body.status as string))
      return apiResult(req, { ok: false, error: "VALIDATION" });
    status = body.status as MemberStatus;
  }
  if (role === undefined && status === undefined)
    return apiResult(req, { ok: false, error: "VALIDATION" });

  const { userId } = await ctx.params;

  const result = await updateMembership(db, {
    companyId: company.id,
    actorUserId: session.userId,
    targetUserId: userId,
    role,
    status,
  });
  // Any business refusal (self / last_admin / not_found) is a 403 (§13.3).
  if (!result.ok) return apiResult(req, { ok: false, error: "FORBIDDEN" });

  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "member",
    entityId: userId,
    action: "update",
    summary: { targetUserId: userId, role, status },
  });
  return apiResult(req, { ok: true, data: result.membership });
});

export const DELETE = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "members.manage");
  if (forbidden) return apiResult(req, forbidden);

  const { userId } = await ctx.params;

  // Soft removal (§4.3): status='removed', removed_at=now(). Same D9 guard —
  // removing the last active admin, or oneself, is a 403.
  const result = await updateMembership(db, {
    companyId: company.id,
    actorUserId: session.userId,
    targetUserId: userId,
    status: "removed",
  });
  // Any business refusal (self / last_admin / not_found) is a 403 (§13.3).
  if (!result.ok) return apiResult(req, { ok: false, error: "FORBIDDEN" });

  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "member",
    entityId: userId,
    action: "delete",
    summary: { targetUserId: userId },
  });
  return apiResult(req, { ok: true, data: result.membership });
});

export const OPTIONS = optionsHandler;
