/**
 * POST /api/billing/cron — the daily billing cron trigger (BILLING §5, T-D1).
 *
 * NOT a normal `apiRoute`: there is NO session and NO CORS. It is called by the
 * cPanel scheduler, not a browser, and self-guards on a shared secret — a
 * `Authorization: Bearer <BILLING_CRON_SECRET>` header that must match
 * `process.env.BILLING_CRON_SECRET`. A missing/wrong token (or an unset env)
 * returns a bare 401 and does NO work. On success it runs `runBillingCron` and
 * returns the `CronSummary` as JSON (200) for the scheduler's log.
 *
 * cPanel cron (daily at 03:00):
 *   0 3 * * * curl -sS -H "Authorization: Bearer <BILLING_CRON_SECRET>" \
 *     https://hosmos.eu/api/billing/cron -X POST
 */
import { timingSafeEqual } from "node:crypto";

import { runBillingCron } from "@/server/billing/cron";

/** Constant-time compare of two secrets (length-guarded so it can't throw). */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal lengths
  return timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.BILLING_CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // No configured secret → the endpoint is closed (never open by default).
  if (!expected || !secretMatches(token, expected)) {
    return new Response(null, { status: 401 });
  }

  const summary = await runBillingCron();
  return Response.json(summary);
}
