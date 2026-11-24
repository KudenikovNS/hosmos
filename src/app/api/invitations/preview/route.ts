/**
 * GET /api/invitations/preview?token=… — the PUBLIC invitation preview
 * (USERS-ROLES T2.4, §9.4 / §9.5 / §0.6 / §0.8).
 *
 * NO session (a recipient previews before logging in), but still CORS-tagged and
 * with an OPTIONS preflight (PATTERN 2, §0.8). It hashes the raw token and looks
 * up a LIVE invitation, returning EXACTLY four fields — `companyName`, `role`,
 * `invitedByName`, `expiresAt` — and nothing else (§9.4): a leaked token must not
 * reveal `companyId`, member lists, plan, or any other company data.
 *
 * Every unusable token — missing, expired, already accepted, revoked, or simply
 * unknown — returns the SAME opaque `{ok:false,error:"VALIDATION"}` (422, §9.5).
 * Distinguishing them would turn this public endpoint into a token-enumeration
 * oracle; the real reason is recorded only in the server log.
 */
import { createHash } from "node:crypto";

import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { db } from "@/server/db";
import { previewInvitation } from "@/server/db/invitations";

export const GET = apiRoute(async (req) => {
  const token = new URL(req.url).searchParams.get("token");
  // A missing token is indistinguishable from a bad one (§9.5) — same 422.
  if (!token) return apiResult(req, { ok: false, error: "VALIDATION" });

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const preview = await previewInvitation(db, tokenHash);
  if (!preview) {
    console.info(
      "GET /api/invitations/preview: no live invitation for the presented token",
    );
    return apiResult(req, { ok: false, error: "VALIDATION" });
  }

  return apiResult(req, { ok: true, data: preview });
});

export const OPTIONS = optionsHandler;
