// SEC-CSRF unit tests — the Origin guard on mutating routes (T2.4 review, Medium
// #1). Pure (no DB): exercises `requireTrustedOrigin` directly and through the
// `apiRoute` wrapper that every `/api/*` handler is built on. The invariant under
// test is "absent Origin → trusted; present-but-untrusted → 403 FORBIDDEN".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NextRequest } from "next/server";

import { apiJson, apiRoute, requireTrustedOrigin } from "../handler";

const HOST = "api.example.com";
const SELF_ORIGIN = `http://${HOST}`;
const ATTACKER_ORIGIN = "https://attacker.example";
const ALLOWED_ORIGIN = "http://front.example.com";

/** Build a Request with an explicit method/origin (and always our own Host). */
function req(
  method: string,
  origin?: string,
  { badHost = false }: { badHost?: boolean } = {},
): NextRequest {
  const headers: Record<string, string> = { host: HOST };
  if (badHost) headers.host = "other.example.com";
  if (origin !== undefined) headers.origin = origin;
  return new Request(`http://${HOST}/api/x`, {
    method,
    headers,
  }) as NextRequest;
}

// A trivial route that echoes 200; the guard (in apiRoute) runs before it.
const okRoute = apiRoute(async (r) =>
  apiJson(r, { ok: true, data: null }, 200),
);

let prevOrigins: string | undefined;
beforeEach(() => {
  prevOrigins = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = ALLOWED_ORIGIN;
});
afterEach(() => {
  if (prevOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = prevOrigins;
  vi.restoreAllMocks();
});

describe("requireTrustedOrigin", () => {
  it("POST from a foreign origin (not same-origin, not allowlisted) is untrusted", () => {
    expect(requireTrustedOrigin(req("POST", ATTACKER_ORIGIN))).toBe(false);
  });

  it("POST whose Origin host matches Host (same-origin) is trusted", () => {
    expect(requireTrustedOrigin(req("POST", SELF_ORIGIN))).toBe(true);
  });

  it("POST from an allowlisted Origin is trusted", () => {
    expect(requireTrustedOrigin(req("POST", ALLOWED_ORIGIN))).toBe(true);
  });

  it("POST with NO Origin is trusted (absent → trusted)", () => {
    expect(requireTrustedOrigin(req("POST"))).toBe(true);
  });

  it("safe methods (GET) are never guarded, even from an attacker origin", () => {
    expect(requireTrustedOrigin(req("GET", ATTACKER_ORIGIN))).toBe(true);
    expect(requireTrustedOrigin(req("HEAD", ATTACKER_ORIGIN))).toBe(true);
    expect(requireTrustedOrigin(req("OPTIONS", ATTACKER_ORIGIN))).toBe(true);
  });

  it("a malformed Origin on a POST is untrusted", () => {
    expect(requireTrustedOrigin(req("POST", "not-a-url"))).toBe(false);
  });

  it("same-origin match is by Host, not by request URL (mismatched Host → untrusted)", () => {
    // Origin === request URL host, but the Host header says otherwise → not trusted.
    expect(
      requireTrustedOrigin(req("POST", SELF_ORIGIN, { badHost: true })),
    ).toBe(false);
  });
});

describe("apiRoute Origin guard (end to end)", () => {
  it("POST with Origin: https://attacker.example → 403 FORBIDDEN", async () => {
    const res = await okRoute(req("POST", ATTACKER_ORIGIN));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("POST with a same-origin Origin passes the guard (not 403)", async () => {
    const res = await okRoute(req("POST", SELF_ORIGIN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: null });
  });

  it("POST with an allowlisted Origin passes the guard (not 403)", async () => {
    const res = await okRoute(req("POST", ALLOWED_ORIGIN));
    expect(res.status).toBe(200);
  });

  it("POST with NO Origin passes the guard (absent → trusted)", async () => {
    const res = await okRoute(req("POST"));
    expect(res.status).toBe(200);
  });

  it("GET with Origin: https://attacker.example passes (safe method not guarded)", async () => {
    const res = await okRoute(req("GET", ATTACKER_ORIGIN));
    expect(res.status).toBe(200);
  });

  it("POST with a malformed Origin → 403 FORBIDDEN", async () => {
    const res = await okRoute(req("POST", "not-a-url"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("guards the mutation BEFORE the handler runs (fn never invoked on a blocked POST)", async () => {
    const fn = vi.fn(async (r: NextRequest) => apiJson(r, { ok: true }, 200));
    const guarded = apiRoute(fn);
    const res = await guarded(req("POST", ATTACKER_ORIGIN));
    expect(res.status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });
});
