/**
 * better-auth browser client (PG-IMPL-SPEC §3.3, §3.4 — task T-10).
 *
 * Verified against the official better-auth docs for ^1.6.23:
 *   - https://www.better-auth.com/docs/installation ("Create Client Instance")
 *   - https://www.better-auth.com/docs/integrations/next
 *   `createAuthClient` is imported from `better-auth/react` (the React build,
 *   which also provides `useSession`), and `baseURL` points at the auth server.
 *
 * `"use client"` — this runs in the browser: it owns the credentialed fetches to
 * `/api/auth/*` and (via better-auth/react) exposes React hooks like useSession.
 *
 * `baseURL` is `NEXT_PUBLIC_BACKEND_URL` (the only backend URL that ships to the
 * browser, §5.1). When it is unset (e.g. a local build without env, or prod
 * same-origin) it is `undefined`, and better-auth falls back to the current
 * origin — `createAuthClient` only records options, so import never throws.
 */
"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BACKEND_URL,
});
