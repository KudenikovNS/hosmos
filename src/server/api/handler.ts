/**
 * Route-handler helpers for `app/api/*` (PG-PLAN T-19, PATTERN 2 / §4.1).
 *
 * Every `/api/*` handler shares two cross-cutting concerns; centralising them
 * here keeps the routes thin and gives T-20/T-21 a single place to reuse:
 *
 *   PATTERN 2 — CORS on EVERY response (ОВ-4, §3.5). Cross-origin dev (front-dev
 *   on localhost → prod API) needs `Access-Control-Allow-Origin: <origin>` +
 *   `Allow-Credentials` on responses AND an `OPTIONS` preflight. `withCors` only
 *   sets the header when the request `origin` is in `ALLOWED_ORIGINS`, so prod
 *   same-origin is never affected (the header is simply absent). Handlers wrap
 *   their responses with `apiJson`/`apiResult` and export `OPTIONS = optionsHandler`.
 *
 *   Status mapping. The transport contract is `ActionResult<T>`/`ReportResult<T>`
 *   ({ok:true,data} | {ok:false,error}); the client discriminates on `ok`, but the
 *   HTTP status is still set from the error code (caches, logs, RSC fetch):
 *     UNAUTHENTICATED → 401; COMPANY_NOT_FOUND / NO_DATA / NO_MONTHLY_DATA → 404;
 *     FACTORS_UNAVAILABLE / FACTORS_AMBIGUOUS → 503; VALIDATION → 422;
 *     PERSIST_FAILED / UNKNOWN → 500.
 *
 * `apiRoute` wraps a handler so any thrown error degrades to a CORS-tagged
 * `{ok:false,error:"UNKNOWN"}` 500 (details stay in the server log) — the same
 * failure contract the old server actions had.
 */
import { NextResponse, type NextRequest } from "next/server";

import {
  corsPreflightResponse,
  isAllowedOrigin,
  withCors,
} from "@/shared/api/cors";

/** Every error code any `/api/*` handler can return, plus the input-validation code. */
type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "COMPANY_NOT_FOUND"
  | "NO_MONTHLY_DATA"
  | "NO_DATA"
  | "FACTORS_UNAVAILABLE"
  | "FACTORS_AMBIGUOUS"
  | "PERSIST_FAILED"
  | "VALIDATION"
  | "PLAN_REQUIRED"
  | "FORBIDDEN"
  | "LENGTH_REQUIRED"
  | "RATE_LIMITED"
  | "CONCURRENT_MODIFICATION"
  | "UNKNOWN";

/** ActionResult/ReportResult-shaped result any handler can hand to `apiResult`. */
export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; error: ApiErrorCode };

/** Map an error code to its HTTP status (§4.1). Unknown codes are treated as 500. */
const ERROR_STATUS: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  COMPANY_NOT_FOUND: 404,
  NO_MONTHLY_DATA: 404,
  NO_DATA: 404,
  FACTORS_UNAVAILABLE: 503,
  // 503 Service Unavailable — the ONE code §12.1 adds for the data model, and it
  // shares its status with FACTORS_UNAVAILABLE because it is the same kind of
  // fact: the factor library cannot answer this question right now. CALC-2 finds
  // several factors that tie on every rung of the ladder, so the calculation
  // REFUSES rather than picking the first row (which would make a signed report
  // depend on SQL row order). Not a 422: the request is well-formed and the
  // caller can fix nothing — an admin must correct the factor SET. The body
  // lists the colliding candidates (`FactorsAmbiguousError.payload`).
  FACTORS_AMBIGUOUS: 503,
  VALIDATION: 422,
  CONCURRENT_MODIFICATION: 409,
  // 402 Payment Required — the exact signal for a feature-entitlement gate (§7.1):
  // the client renders an upgrade CTA rather than a hard-forbidden error.
  PLAN_REQUIRED: 402,
  // 403 Forbidden — the role lacks a capability (§6.4). Distinct from 402: an
  // upgrade CTA cannot help someone whose ROLE (not plan) denies the action.
  FORBIDDEN: 403,
  // 411 Length Required — a body whose SIZE must be known before it is read.
  // Only the evidence upload uses it: its plan cap can only be enforced ahead of
  // the parser against a declared `Content-Length`, and `req.formData()` buffers
  // the whole body before any streaming check can fire (see /api/documents).
  LENGTH_REQUIRED: 411,
  // 429 Too Many Requests — the throttle on the one PUBLIC, unauthenticated
  // write in the app (`/api/leads`). Distinct from 403: nothing is forbidden,
  // the caller is simply early, and the client says "try again in a few minutes"
  // rather than showing a validation error against a form that was correct.
  RATE_LIMITED: 429,
  PERSIST_FAILED: 500,
  UNKNOWN: 500,
};

/** HTTP status for an error code (falls back to 500 for anything unmapped). */
export function statusForError(code: string): number {
  return ERROR_STATUS[code as ApiErrorCode] ?? 500;
}

/**
 * Shape check for a path/body identifier that will be compared against a `uuid`
 * column.
 *
 * Not cosmetic: Postgres rejects a malformed uuid literal with a driver error,
 * so `where(eq(table.id, "nope"))` is a 500 rather than the 422 the caller
 * deserves. Every route that takes an id from the wire runs it through here
 * first. The pattern accepts any RFC-4122 variant/version, including the nil
 * uuid — validating the VERSION would reject ids the database happily stores.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a uuid-shaped string (safe to compare to a uuid column). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** The request's `Origin` header (used for the per-response CORS decision). */
function originOf(req: Request): string | null {
  return req.headers.get("origin");
}

/**
 * Methods for which the CSRF Origin guard is a no-op. GET/HEAD/OPTIONS are (by
 * contract) side-effect-free reads and OPTIONS preflight, so cross-site abuse of
 * them changes no state — the guard only cares about state-changing methods.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF Origin guard (T2.4 review, Medium #1).
 *
 * Every mutating `/api/*` route authenticates by session cookie ALONE, and the
 * cookie is `sameSite:"none"` on purpose (front-dev on localhost → prod API,
 * auth/index.ts). There is no CSRF token and `req.json()` parses the body
 * regardless of `Content-Type`, so an attacker page can POST with a
 * CORS-safelisted `Content-Type: text/plain` — no preflight fires and CORS does
 * NOT stop the request reaching us (CORS only blocks READING the response, which
 * a CSRF attack does not need). A logged-in victim could thus be driven into a
 * cross-site mutation (e.g. POST /api/invitations/accept). This guard closes that.
 *
 * Invariant: **absent Origin → trusted; present-but-untrusted → rejected.**
 * WHY it is safe to trust an absent Origin: `Origin` is a Fetch "forbidden"
 * request header — page JS can neither set nor strip it — and the browser ALWAYS
 * attaches it to a cross-origin request and to any same-origin non-GET request.
 * So a browser-driven CSRF attack ALWAYS carries `Origin: <attacker>`. A request
 * with no Origin is therefore not a browser cross-site attack (it is a test, a
 * signed webhook, a cron call, or another non-browser client) and is let through
 * — which is also why this guard breaks none of those. A PRESENT Origin is
 * trusted only when it is same-origin (`URL(origin).host === Host`) or in the
 * CORS allowlist; anything else — including an Origin that fails to parse — is
 * rejected.
 */
export function requireTrustedOrigin(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return true;

  const origin = originOf(req);
  // Absent Origin ⇒ not a browser cross-site attack (see invariant) ⇒ trusted.
  if (!origin) return true;

  try {
    // Same-origin: the browser sent our own Host as the Origin's host.
    if (new URL(origin).host === req.headers.get("host")) return true;
  } catch {
    // A malformed Origin can never be same-origin — treat as untrusted.
    return false;
  }
  // Otherwise trust only the explicit CORS allowlist (same source as CORS).
  return isAllowedOrigin(origin);
}

/**
 * JSON response with an explicit status, CORS applied for the request origin.
 * Use for raw-value endpoints (e.g. `/api/session` → `DbSession | null`, or a
 * bare error body with a chosen status).
 */
export function apiJson(
  req: Request,
  body: unknown,
  status = 200,
): NextResponse {
  return withCors(NextResponse.json(body, { status }), originOf(req));
}

/**
 * A NON-JSON 200: a byte stream with caller-chosen headers, CORS applied.
 *
 * The `ApiResult` envelope cannot carry a file, and an evidence download is a
 * file (EV-0/EV-6) — but PATTERN 2 says CORS goes on EVERY response, not only on
 * the JSON ones. Routing the binary answer through here is what keeps that true
 * without exporting `originOf`: a route that built its own `NextResponse` would
 * be the one response in the app with no `Vary: Origin`.
 */
export function apiStream(
  req: Request,
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): NextResponse {
  return withCors(
    new NextResponse(body as unknown as BodyInit, { status: 200, headers }),
    originOf(req),
  );
}

/**
 * Response for an `ApiResult`-shaped value: the body IS the `{ok,...}` object and
 * the status is derived from the error code (ok → 200). Use for the endpoints the
 * client reads via `ok` (reports, and the write endpoints in T-20/T-21).
 */
export function apiResult<T>(req: Request, result: ApiResult<T>): NextResponse {
  const status = result.ok ? 200 : statusForError(result.error);
  return apiJson(req, result, status);
}

/**
 * A `VALIDATION` (422) response that carries WHY, in the API-1 payload shape
 * `{ok:false, error:"VALIDATION", ...detail}`.
 *
 * `ApiResult` deliberately has no room for a detail field — it is the transport
 * contract the client discriminates on (`ok`), and widening it would let every
 * route invent its own error body. But API-1 requires two refusals to name
 * their cause: a blocking rule set (`{rules:[{code,message,scope}]}`, used by
 * the org/period writes and by the revision transitions of T2.6) and a business
 * refusal that has counts to show (DM-4's undeletable entity). Both are still
 * `{ok:false, error:"VALIDATION"}` to any reader that only looks at those two
 * fields; the extra keys are additive. Routes with nothing to add keep using
 * `apiResult`.
 */
export function apiValidationDetail(
  req: Request,
  detail: Record<string, unknown>,
): NextResponse {
  return apiJson(
    req,
    { ok: false, error: "VALIDATION", ...detail },
    statusForError("VALIDATION"),
  );
}

/**
 * Wrap a route handler so a thrown error becomes a CORS-tagged `UNKNOWN` 500
 * (details logged, not leaked) — mirroring the old actions' catch-all. Success
 * and expected-error responses are produced inside `fn` via apiJson/apiResult.
 */
export function apiRoute<Args extends unknown[] = []>(
  fn: (req: NextRequest, ...args: Args) => Promise<NextResponse>,
): (req: NextRequest, ...args: Args) => Promise<NextResponse> {
  return async (req, ...args) => {
    // CSRF Origin guard (T2.4 Medium #1): reject a cross-site mutation BEFORE the
    // handler runs (and before the body is parsed). Covers every current AND
    // future route, since all of them go through this wrapper.
    if (!requireTrustedOrigin(req)) {
      return apiJson(req, { ok: false, error: "FORBIDDEN" }, 403);
    }
    try {
      return await fn(req, ...args);
    } catch (e) {
      console.error("api route error:", e);
      return apiJson(req, { ok: false, error: "UNKNOWN" }, 500);
    }
  };
}

/** Standard `OPTIONS` preflight handler for a route file: `export const OPTIONS = optionsHandler`. */
export function optionsHandler(req: NextRequest): Response {
  return corsPreflightResponse(originOf(req));
}
