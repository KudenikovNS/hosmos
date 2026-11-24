/**
 * POST / GET /api/invitations — issue a company invitation, or list the session
 * company's invitations (USERS-ROLES T2.3, §9.1–9.7 / §13.4 / D7 / D8).
 *
 * PATTERN 3 (session-guard): the company and the acting user come ONLY from
 * `getSession()`. The request carries NO `companyId`, so there is no way to issue
 * into — or read — another tenant's invitations (isolation is structural).
 *
 * Order of guards (§7.1, with the seat exception): 401 (no session) → 404 (no
 * company) → 403 (missing `members.manage`) → 402 (`requireSeat`, PLAN_REQUIRED) →
 * 422 (body validation). The 403 membership guard runs BEFORE the 402 seat guard
 * on purpose: a role that cannot manage members is never offered a paid upgrade CTA.
 *
 * The POST response carries `inviteUrl` with the RAW single-use token — this is the
 * ONLY place, and the only time, the raw token is exposed (§0.5 / §9.7). It is
 * mailed best-effort (`sendMail` no-ops without SMTP and never blocks creation) and
 * shown once in the UI; it is never persisted or logged.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight are CORS-tagged.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { escapeHtml, sendMail } from "@/server/auth/mailer";
import { requireSeat } from "@/server/auth/seats";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { logAudit } from "@/server/db/audit";
import {
  buildInviteUrl,
  issueInvitation,
  listInvitations,
} from "@/server/db/invitations";
import type { CompanyRole } from "@/shared/roles";

/** The six company roles (mirrors `company_invitations_role_check`). */
const ROLES: readonly CompanyRole[] = [
  "esg_admin",
  "data_owner",
  "contributor",
  "reviewer",
  "approver",
  "auditor",
];

/** A pragmatic email shape check — one `@`, a dot in the domain, no whitespace. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // 403 BEFORE 402 (§7.1): the role gate precedes the seat gate.
  const forbidden = requireCapability(session, "members.manage");
  if (forbidden) return apiResult(req, forbidden);

  const denied = await requireSeat(db, session);
  if (denied) return apiResult(req, denied);

  // 422 last — validation is the cheapest gate to leak, so it runs after access.
  const body = (await req.json().catch(() => null)) as {
    email?: unknown;
    role?: unknown;
  } | null;
  if (!body || typeof body !== "object")
    return apiResult(req, { ok: false, error: "VALIDATION" });
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim()))
    return apiResult(req, { ok: false, error: "VALIDATION" });
  if (!(ROLES as readonly string[]).includes(body.role as string))
    return apiResult(req, { ok: false, error: "VALIDATION" });

  const email = body.email;
  const role = body.role as CompanyRole;

  const result = await issueInvitation(db, {
    companyId: company.id,
    email,
    role,
    invitedBy: session.userId,
  });
  // Any business refusal (already_member / suspended / duplicate) is a 422 (§9.6).
  if (!result.ok) return apiResult(req, { ok: false, error: "VALIDATION" });

  const inviteUrl = buildInviteUrl(result.rawToken);

  // Best-effort mail (§9.7): the invitation is already created, so a mail failure
  // never fails the request — the admin can copy the link from the response/UI.
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
    summary: { email: result.row.email, role: result.row.role },
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

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "members.manage");
  if (forbidden) return apiResult(req, forbidden);

  const invitations = await listInvitations(db, company.id);
  return apiResult(req, { ok: true, data: invitations });
});

export const OPTIONS = optionsHandler;
