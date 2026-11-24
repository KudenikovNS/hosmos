/**
 * POST /api/invitations/:id/resend — re-send a company invitation (USERS-ROLES
 * T2.3, §9.6 / §13.4).
 *
 * PATTERN 3 (session-guard): the company comes ONLY from `getSession()`; the `:id`
 * segment is pinned to `session.company.id` inside the service, so a foreign
 * invitation is a 403, never a cross-tenant write.
 *
 * Order of guards (§7.1): 401 (no session) → 404 (no company) → 403 (missing
 * `members.manage`). The service revokes the old row THEN creates a new one in one
 * transaction (sidestepping the partial unique index, §9.6): the old raw token is
 * now unusable and a NEW one-time `inviteUrl` is returned — the ONLY place the new
 * raw token is exposed. Mail is best-effort (§9.7); a successful resend writes one
 * `audit_log` row (`entity:'invitation'`, `action:'create'`, §11.1).
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight are CORS-tagged.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { escapeHtml, sendMail } from "@/server/auth/mailer";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { logAudit } from "@/server/db/audit";
import { buildInviteUrl, resendInvitation } from "@/server/db/invitations";

type Ctx = { params: Promise<{ id: string }> };

export const POST = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "members.manage");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;

  const result = await resendInvitation(db, company.id, id, session.userId);
  // Foreign/gone id → not_found → 403 (never leaks another tenant's invitation).
  if (!result.ok) return apiResult(req, { ok: false, error: "FORBIDDEN" });

  const inviteUrl = buildInviteUrl(result.rawToken);

  // Best-effort mail (§9.7): the new invitation is already created.
  try {
    await sendMail({
      to: result.row.email,
      subject: `You've been invited to join ${company.name}`,
      text: `You've been invited to join ${company.name}. Accept the invitation:\n\n${inviteUrl}`,
      html: `<p>You've been invited to join ${escapeHtml(company.name)}.</p><p><a href="${inviteUrl}">Accept the invitation</a></p>`,
    });
  } catch (e) {
    console.error("invitation email failed (invitation was created):", e);
  }

  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "invitation",
    entityId: result.row.id,
    action: "create",
    summary: { email: result.row.email, role: result.row.role, resendOf: id },
  });

  return apiResult(req, {
    ok: true,
    data: {
      id: result.row.id,
      email: result.row.email,
      role: result.row.role,
      expiresAt: result.row.expiresAt,
      inviteUrl,
    },
  });
});

export const OPTIONS = optionsHandler;
