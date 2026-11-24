/**
 * The react-query key of the session — in a module of its own, WITHOUT
 * `"use client"`.
 *
 * WHY. `useSession.ts` is a client module. A server component that imports a
 * value from a client module does not get the value: it gets a client
 * REFERENCE (a proxy object the RSC runtime serialises for the browser). The
 * app layout prefetches `/api/session` server-side with that key — so it was
 * prefetching under a proxy, not under `["session"]`: react-query logged
 * «queryKey needs to be an Array» on every server render, and the dehydrated
 * cache never matched the client's key, so the prefetch was wasted. A plain
 * module both sides can import is the fix; `useSession` re-exports it so the
 * client-side imports stay as they are.
 */
export const SESSION_QUERY_KEY = ["session"] as const;
