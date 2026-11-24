/**
 * better-auth catch-all route handler (PG-IMPL-SPEC §3.3 — task T-10).
 *
 * Verified against the official better-auth docs for ^1.6.23:
 *   - https://www.better-auth.com/docs/integrations/next
 *   `toNextJsHandler` is imported from `better-auth/next-js` and returns
 *   `{ GET, POST, PATCH, PUT, DELETE }`; the App Router idiom is to
 *   destructure the verbs the auth API uses (GET + POST) from it.
 *
 * Mounting this at `app/api/auth/[...all]/route.ts` exposes the full better-auth
 * surface under `/api/auth/*`: `/sign-in/email`, `/sign-up/email`, `/sign-out`,
 * `/get-session`, `/verify-email`, `/reset-password`, `/forget-password`, etc.
 * The `auth` instance (T-9) owns all behaviour; this file only wires it to Next.
 */
import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/server/auth";
import { corsPreflightResponse, withCors } from "@/shared/api/cors";

// better-auth core does not set `Access-Control-Allow-Origin` on its GET/POST
// responses (only the preflight is CORS-tagged below), so a cross-origin login
// (front-dev → prod-API) would fail to read the response. Wrap both verbs in
// `withCors` so the actual auth responses carry the allowlisted origin +
// credentials headers too (#40). Same-origin prod (BACKEND_URL=self) is a no-op.
const { GET: authGet, POST: authPost } = toNextJsHandler(auth);

export async function GET(request: Request): Promise<Response> {
  return withCors(await authGet(request), request.headers.get("origin"));
}

export async function POST(request: Request): Promise<Response> {
  return withCors(await authPost(request), request.headers.get("origin"));
}

/**
 * CORS preflight for the cross-origin front-dev → prod-API scenario (§3.5, ОВ-4).
 *
 * A credentialed `POST /api/auth/sign-in/email` with a JSON body is a
 * non-simple request, so browsers fire an `OPTIONS` preflight first. better-auth
 * only exports GET/POST, so without this the preflight would 405. `OPTIONS`
 * answers it with 204 + CORS headers, but only for origins on the ALLOWED_ORIGINS
 * allowlist (T-18 helper); for same-origin prod (BACKEND_URL=self) no preflight
 * is issued at all, and CSRF is covered by better-auth `trustedOrigins` (T-9).
 */
export function OPTIONS(request: Request): Response {
  return corsPreflightResponse(request.headers.get("origin"));
}
