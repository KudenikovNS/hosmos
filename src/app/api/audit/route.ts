/**
 * Audit-trail read route (§Q6, DATA-INTEGRITY-PLAN T4.2a).
 *
 * GET /api/audit[?limit=] — the session company's real activity audit trail
 *   (the `audit_log` rows written at every mutation boundary in T4.1), newest
 *   first. This replaces the hardcoded, fabricated "Audit Trail" the Data
 *   Sources page used to render — nothing is shown as provenance that the app
 *   did not actually record.
 *
 *   Identity comes ONLY from `getSession()` (PATTERN 3): no session →
 *   UNAUTHENTICATED, no company → COMPANY_NOT_FOUND. This is a READ, so there
 *   is NO entitlement gate (mirrors `/api/goals` GET). `limit` is parsed from
 *   the query string, defaulting to 20 and clamped to [1, 100] — a non-numeric
 *   or ≤ 0 value falls back to the default, > 100 is floored to 100 — so an
 *   unbounded limit never reaches the DB.
 *
 * Response: `ActionResult<AuditLogRow[]>`.
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { listAuditLog } from "@/server/db/audit";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Parse `?limit`: default 20; a non-numeric or ≤ 0 → default; > 100 → 100. */
function parseLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) — reading the audit trail requires `audit.read`; a contributor
  // is deliberately without it (§6.2), so this is stricter than the generic read.
  const forbidden = requireCapability(session, "audit.read");
  if (forbidden) return apiResult(req, forbidden);

  const limit = parseLimit(new URL(req.url).searchParams.get("limit"));
  const rows = await listAuditLog(db, company.id, limit);
  return apiResult(req, { ok: true, data: rows });
});

export const OPTIONS = optionsHandler;
