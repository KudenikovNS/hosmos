/**
 * DELETE /api/invitations/:id — revoke a company invitation (USERS-ROLES T2.3,
 * §9.1 / §13.4).
 *
 * PATTERN 3 (session-guard): the company comes ONLY from `getSession()`; the `:id`
 * segment is pinned to `session.company.id` inside the service, so a foreign
 * invitation is a 403, never a cross-tenant write.
 *
 * Order of guards (§7.1): 401 (no session) → 404 (no company) → 403 (missing
 * `members.manage`). Revocation stamps `revoked_at = now()`; a successful revoke
 * writes exactly one `audit_log` row (`entity:'invitation'`, `action:'delete'`,
 * `actorRole` snapshotted from the session, §11.1). A refusal writes NONE.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight are CORS-tagged.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { logAudit } from "@/server/db/audit";
import { revokeInvitation } from "@/server/db/invitations";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "members.manage");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;

  // Scoped to session.company.id inside the service: a foreign/gone id → false.
  const revoked = await revokeInvitation(db, company.id, id);
  if (!revoked) return apiResult(req, { ok: false, error: "FORBIDDEN" });

  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "invitation",
    entityId: id,
    action: "delete",
    summary: { invitationId: id },
  });

  return apiResult(req, { ok: true, data: { id } });
});

export const OPTIONS = optionsHandler;
