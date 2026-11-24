/**
 * GET /api/session — the current session (PG-PLAN T-19, §4.2).
 *
 * Replaces the Supabase server action `getSession`. Returns the SAME shape the
 * old action did — `DbSession | null` as raw JSON (NOT wrapped in ActionResult) —
 * because `useSession`'s queryFn consumes `DbSession | null` directly (T-22 will
 * repoint it at `apiFetch("/api/session")`). A logged-out caller is represented
 * by `null` with HTTP 200, which is the contract useSession expects (null = not
 * signed in); the 401 session-guard applies to the data endpoints that need a
 * company (dashboard/reports).
 *
 * PATTERN 3 (session-guard): the identity comes only from `getSession()` (which
 * reads the httpOnly cookie via better-auth) — never from a client parameter.
 * PATTERN 2 (CORS): the response and the OPTIONS preflight are CORS-tagged.
 *
 * T-A3 (§6.3): the body is additively extended to `DbSession & { features? }`.
 * When a session has a company we attach the server-resolved plan `features` as a
 * SIBLING of `DbSession` (never inside `DbCompany` — that shape is a strict 1:1
 * contract). Old consumers keep reading the unchanged `DbSession`; `usePlan` reads
 * `features` when present.
 *
 * T-C3 (§9): the `features` now come from `getEntitlements(session)` — the SAME
 * subscription-aware resolver the server guards enforce — so the client and server
 * agree on one matrix (an unknown plan still degrades to `trial`, never over-grants;
 * a lapsed company READS its last paid plan). We additionally surface `mode`
 * (`active|locked|readonly`, drives the readonly UI mirror) and the live
 * `subscription` state (renewal/cancel/downgrade) so the billing UI can render
 * transitions. The `features` SHAPE is unchanged for an active/degraded company.
 *
 * T1.3 (§13.5): the role context — `membership`, `capabilities`, `memberships` —
 * is surfaced as SIBLINGS of `DbSession`, the SAME additive technique as
 * `features`/`mode`/`subscription`. `getSession()` already resolves them (T1.2b),
 * so they are forwarded here, never recomputed. (`seats` arrives in T2.2.)
 */
import { apiJson, apiRoute, optionsHandler } from "@/server/api/handler";
import { getSession } from "@/server/auth/session";
import { getSeatUsage } from "@/server/auth/seats";
import { db } from "@/server/db";
import { getEntitlements, getLiveSubscription } from "@/server/billing/guard";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session?.company) return apiJson(req, session);

  // Resolve the effective read-tier features + mode from the subscription-aware
  // guard (one matrix, client & server agree), plus the live subscription for UI.
  const { features, mode } = await getEntitlements(session);
  const subscription = await getLiveSubscription(session.company.id);

  // T2.2 (§10.3): seat usage vs. the plan limit, surfaced as a SIBLING (same
  // additive technique). `limit` is the effective read-tier `maxTeamMembers`;
  // `overLimit` drives the over-seat banner (never true on an unlimited plan).
  // Best-effort: the seat count is auxiliary display data, so a count-query
  // failure degrades to "no seat data" rather than breaking the session response
  // that gates auth/routing.
  let seats: { used: number; limit: number; overLimit: boolean } | undefined;
  try {
    const used = await getSeatUsage(db, session.company.id);
    const limit = features.maxTeamMembers;
    seats = { used, limit, overLimit: limit !== -1 && used > limit };
  } catch (err) {
    console.error("GET /api/session: seat usage lookup failed", err);
  }

  // The role context resolved by getSession() (T1.2b), forwarded as siblings.
  const { membership, capabilities, memberships } = session;

  return apiJson(req, {
    ...session,
    features,
    mode,
    subscription,
    seats,
    membership,
    capabilities,
    memberships,
  });
});

export const OPTIONS = optionsHandler;
