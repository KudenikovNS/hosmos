/**
 * POST /api/invitations/accept — accept an invitation (USERS-ROLES T2.4, §9.1 /
 * §9.5 / §9.6 / §10.2 / Q4).
 *
 * Guard order: 401 (a session is required — the recipient must be logged in) →
 * `requireSeat` AGAIN on the INVITATION's company (402): between issuing and
 * accepting, the plan or seat count can change, and a race between two accepts is
 * only closed here plus by the conditional UPDATE inside the transaction. The seat
 * gate runs BEFORE any write, so a full company yields 402 with NOTHING created and
 * the invitation left unaccepted.
 *
 * Then `acceptInvitation` runs the whole effect in ONE transaction (profile
 * guarantee → membership upsert → active-company switch → audit); the one-time
 * property is owned by the DB (conditional UPDATE), so a double-click produces
 * exactly one membership. An account whose email differs from the invited email is
 * ALLOWED (security rests on the token's secrecy) and the divergence is recorded in
 * the audit summary (§9.6).
 *
 * Any unusable token — missing, expired, accepted, revoked, unknown, or lost to a
 * concurrent accept — returns the SAME opaque 422 (§9.5). PATTERN 2 (CORS) + OPTIONS.
 */
import { createHash } from "node:crypto";

import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireSeat } from "@/server/auth/seats";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import {
  acceptInvitation,
  findLiveInvitationForAccept,
} from "@/server/db/invitations";

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });

  const body = (await req.json().catch(() => null)) as {
    token?: unknown;
  } | null;
  const token =
    body && typeof body.token === "string" && body.token ? body.token : null;
  // A missing/blank token is indistinguishable from a bad one (§9.5) — same 422.
  if (!token) return apiResult(req, { ok: false, error: "VALIDATION" });

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const context = await findLiveInvitationForAccept(db, tokenHash);
  if (!context) {
    console.info(
      "POST /api/invitations/accept: no live invitation for the presented token",
    );
    return apiResult(req, { ok: false, error: "VALIDATION" });
  }

  // requireSeat re-run against the INVITATION's company (§10.2), NOT the accepter's
  // current one — build a seat-check session pointed at the invitation company.
  // Exclude THIS invitation from the count (Low #2): accept is seat-neutral, so
  // counting it would block the final invited member from the last seat.
  const seatSession = { ...session, company: context.company };
  const denied = await requireSeat(db, seatSession, context.invitationId);
  if (denied) return apiResult(req, denied); // 402 — nothing written, not accepted.

  const result = await acceptInvitation(db, {
    context,
    userId: session.userId,
    userEmail: session.email,
  });
  // A concurrent accept won the one-time race → the same opaque 422 (§9.5).
  if (!result.ok) return apiResult(req, { ok: false, error: "VALIDATION" });

  return apiResult(req, {
    ok: true,
    data: { companyId: result.companyId, role: result.role },
  });
});

export const OPTIONS = optionsHandler;
