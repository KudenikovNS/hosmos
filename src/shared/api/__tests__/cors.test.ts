// T-18: CORS-helper для кросс-origin route handlers (PG-IMPL-SPEC §3.5, ОВ-4).
//
// Инварианты:
//  - при credentials НЕ ставим Access-Control-Allow-Origin: * — только конкретный
//    origin из allowlist (ALLOWED_ORIGINS);
//  - ставим Access-Control-Allow-Credentials: true и Vary: Origin;
//  - неизвестный origin / пустой allowlist → helper НЕ трогает ответ (same-origin
//    в проде не ломается);
//  - preflight отдаёт 204 с Allow-Methods/Allow-Headers.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  corsPreflightResponse,
  isAllowedOrigin,
  withCors,
} from "@/shared/api/cors";

let savedAllowed: string | undefined;

beforeEach(() => {
  savedAllowed = process.env.ALLOWED_ORIGINS;
});

afterEach(() => {
  if (savedAllowed === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = savedAllowed;
});

describe("isAllowedOrigin", () => {
  it("matches an origin listed in ALLOWED_ORIGINS (comma-separated, trimmed)", () => {
    process.env.ALLOWED_ORIGINS =
      "http://localhost:3000, https://app.example.com";
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin("https://app.example.com")).toBe(true);
  });

  it("rejects an origin outside the allowlist and any origin when unset", () => {
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
    delete process.env.ALLOWED_ORIGINS;
    expect(isAllowedOrigin("http://localhost:3000")).toBe(false);
  });
});

describe("withCors", () => {
  it("sets the specific origin + credentials (never *) for an allowed origin", () => {
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    const res = withCors(
      new Response("{}", { status: 200 }),
      "http://localhost:3000",
    );

    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("does not touch the response for a non-allowed origin (same-origin unaffected)", () => {
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    const res = withCors(
      new Response("{}", { status: 200 }),
      "https://evil.example.com",
    );

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("is a no-op when no origin is provided or the allowlist is empty", () => {
    delete process.env.ALLOWED_ORIGINS;
    const res = withCors(new Response("{}", { status: 200 }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns the same response instance (preserves NextResponse subtype)", () => {
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    const original = new Response("{}", { status: 200 });
    expect(withCors(original, "http://localhost:3000")).toBe(original);
  });
});

describe("corsPreflightResponse", () => {
  it("returns 204 with methods/headers and CORS for an allowed origin", () => {
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    const res = corsPreflightResponse("http://localhost:3000");

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "Content-Type",
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("still returns 204 for a disallowed origin but without allow-origin", () => {
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    const res = corsPreflightResponse("https://evil.example.com");

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
