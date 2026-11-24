// T-19 PATTERN 2 unit tests — the route-handler helpers. Pure (no DB): pins the
// ActionErrorCode → HTTP status mapping (§4.1) and the CORS behaviour (every
// response CORS-tagged for an allowed origin, untouched otherwise; OPTIONS
// preflight). server-only is not imported by handler.ts, so no mock needed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NextRequest } from "next/server";

import {
  apiJson,
  apiResult,
  apiRoute,
  optionsHandler,
  statusForError,
} from "../handler";

const DEV_ORIGIN = "http://localhost:3000";

function req(origin?: string): NextRequest {
  const headers = origin ? { origin } : undefined;
  return new Request("http://api.example.com/api/x", {
    headers,
  }) as NextRequest;
}

let prevOrigins: string | undefined;
beforeEach(() => {
  prevOrigins = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = DEV_ORIGIN;
});
afterEach(() => {
  if (prevOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = prevOrigins;
});

describe("statusForError", () => {
  it("maps each ActionErrorCode to its HTTP status (§4.1)", () => {
    expect(statusForError("UNAUTHENTICATED")).toBe(401);
    expect(statusForError("COMPANY_NOT_FOUND")).toBe(404);
    expect(statusForError("NO_DATA")).toBe(404);
    expect(statusForError("NO_MONTHLY_DATA")).toBe(404);
    expect(statusForError("FACTORS_UNAVAILABLE")).toBe(503);
    // CALC-2 refuses a non-deterministic factor resolve (§12.1, T5.1).
    expect(statusForError("FACTORS_AMBIGUOUS")).toBe(503);
    expect(statusForError("VALIDATION")).toBe(422);
    expect(statusForError("CONCURRENT_MODIFICATION")).toBe(409);
    expect(statusForError("PERSIST_FAILED")).toBe(500);
    expect(statusForError("UNKNOWN")).toBe(500);
    expect(statusForError("something-unmapped")).toBe(500);
  });
});

describe("apiJson", () => {
  it("returns the body as JSON with the given status", async () => {
    const res = apiJson(req(), { hello: "world" }, 200);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("tags an allowed origin with CORS headers (concrete origin, credentials)", () => {
    const res = apiJson(req(DEV_ORIGIN), null, 200);
    expect(res.headers.get("access-control-allow-origin")).toBe(DEV_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("leaves a same-origin / unknown-origin response untouched (no ACAO:*)", () => {
    expect(
      apiJson(req(), null, 200).headers.get("access-control-allow-origin"),
    ).toBeNull();
    expect(
      apiJson(req("http://evil.example"), null, 200).headers.get(
        "access-control-allow-origin",
      ),
    ).toBeNull();
  });
});

describe("apiResult", () => {
  it("ok → 200 with the result object as body", async () => {
    const res = apiResult(req(), { ok: true, data: { n: 1 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { n: 1 } });
  });

  it("error → status from the code, body is the {ok:false,error} object", async () => {
    const res = apiResult(req(), { ok: false, error: "NO_DATA" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "NO_DATA" });
  });
});

describe("apiRoute", () => {
  it("degrades a thrown error to a CORS-tagged UNKNOWN 500", async () => {
    const handler = apiRoute(async () => {
      throw new Error("boom");
    });
    const res = await handler(req(DEV_ORIGIN));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "UNKNOWN" });
    expect(res.headers.get("access-control-allow-origin")).toBe(DEV_ORIGIN);
  });
});

describe("optionsHandler", () => {
  it("answers a preflight with 204 + Allow-Methods and CORS for an allowed origin", () => {
    const res = optionsHandler(req(DEV_ORIGIN));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-origin")).toBe(DEV_ORIGIN);
  });
});
