// [LOCAL-DB] T1.3 — company-membership listing + active-company switch route
// handlers, run against a real Postgres via the T0.2 harness.
//
// Proves the phase-D invariants for the two new endpoints:
//   • PATTERN 3 session-guard: identity comes ONLY from getSession() — no session
//     → 401 on both routes;
//   • GET /api/companies echoes the session's resolved memberships + active id;
//   • POST /api/companies/switch is the ONE place companyId is read from the body
//     (§0.1); a switch to a company where the membership is suspended / removed /
//     absent is a REFUSAL → 403 FORBIDDEN (never 404, never a silent 200);
//   • a successful switch writes BOTH profile company columns to the target (D11,
//     verified by a direct SELECT) and the next resolveSessionContext() — what
//     getSession() delegates to — returns the new company id + RECALCULATED
//     capabilities;
//   • OPTIONS on both paths answers the CORS preflight.
//
// `getSession` is mocked so a test controls the identity; the real
// `resolveSessionContext` is kept (importActual) to assert the post-switch session.
// `@/server/db` is mocked to the harness pool so the routes read the same Postgres
// the fixtures write to. `describeIntegration` is `describe.skip` with no DB, so
// this file is a green no-op in a DB-less CI.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getSessionMock = vi.fn();
vi.mock("@/server/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/session")>(
    "@/server/auth/session",
  );
  return { ...actual, getSession: () => getSessionMock() };
});

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  // testDbModule()'s `db` getter is safe to read during collection: with no DB it
  // hands back an inert stand-in instead of throwing, so importing the real
  // session/auth graph (which reads `db` at import time) doesn't fail the suite —
  // it self-skips via describeIntegration. See harness.ts.
  return harness.testDbModule();
});

import {
  GET as companiesGET,
  OPTIONS as companiesOPTIONS,
} from "@/app/api/companies/route";
import {
  POST as switchPOST,
  OPTIONS as switchOPTIONS,
} from "@/app/api/companies/switch/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertMembership,
  insertPaidCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { profiles } from "@/server/db/schema";

/** A bare GET/OPTIONS request; `origin` drives the per-response CORS decision. */
const request = (path: string, origin?: string) =>
  new Request(`http://api.example.com${path}`, {
    headers: origin ? { origin } : undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

/** A JSON POST request (the switch route reads req.json()). */
const jsonRequest = (path: string, body: unknown) =>
  new Request(`http://api.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

/** Build the mock session for a user from the context getSession() would resolve. */
async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

describeIntegration("T1.3 companies / switch route handlers", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  // ─── GET /api/companies ────────────────────────────────────────────────────
  it("GET /api/companies → 401 with no session (PATTERN 3 guard)", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await companiesGET(request("/api/companies"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "UNAUTHENTICATED" });
  });

  it("GET /api/companies lists both memberships with the right activeCompanyId", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const beta = await insertPaidCompany({ name: "Beta" });
    // Active company is Alpha (insertUserWithProfile stamps active_company_id).
    const { user } = await insertUserWithProfile({
      companyId: alpha.id,
      role: "esg_admin",
    });
    await insertMembership(beta.id, user.id, { role: "auditor" });

    getSessionMock.mockResolvedValue(await sessionFor(user.id));

    const res = await companiesGET(request("/api/companies"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.activeCompanyId).toBe(alpha.id);
    const ids = body.data.companies.map(
      (c: { companyId: string }) => c.companyId,
    );
    expect(ids).toHaveLength(2);
    expect(ids).toContain(alpha.id);
    expect(ids).toContain(beta.id);
  });

  // ─── POST /api/companies/switch — guards ───────────────────────────────────
  it("POST /api/companies/switch → 401 with no session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await switchPOST(
      jsonRequest("/api/companies/switch", { companyId: "whatever" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "UNAUTHENTICATED" });
  });

  it("POST /api/companies/switch → 422 when companyId is not a string", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const { user } = await insertUserWithProfile({ companyId: alpha.id });
    getSessionMock.mockResolvedValue(await sessionFor(user.id));

    const res = await switchPOST(
      jsonRequest("/api/companies/switch", { companyId: 123 }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });
  });

  // ─── POST /api/companies/switch — the three refusals are 403, not 404/200 ──
  it("POST /api/companies/switch → 403 when the target membership is suspended", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const beta = await insertPaidCompany({ name: "Beta" });
    const { user } = await insertUserWithProfile({ companyId: alpha.id });
    await insertMembership(beta.id, user.id, { status: "suspended" });
    getSessionMock.mockResolvedValue(await sessionFor(user.id));

    const res = await switchPOST(
      jsonRequest("/api/companies/switch", { companyId: beta.id }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "FORBIDDEN" });

    // The active company is unchanged — a refusal writes nothing.
    const [row] = await getTestDb()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    expect(row.activeCompanyId).toBe(alpha.id);
  });

  it("POST /api/companies/switch → 403 when the target membership is removed", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const beta = await insertPaidCompany({ name: "Beta" });
    const { user } = await insertUserWithProfile({ companyId: alpha.id });
    await insertMembership(beta.id, user.id, { status: "removed" });
    getSessionMock.mockResolvedValue(await sessionFor(user.id));

    const res = await switchPOST(
      jsonRequest("/api/companies/switch", { companyId: beta.id }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("POST /api/companies/switch → 403 when there is no membership at all", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const beta = await insertPaidCompany({ name: "Beta" });
    const { user } = await insertUserWithProfile({ companyId: alpha.id });
    // No membership in beta whatsoever.
    getSessionMock.mockResolvedValue(await sessionFor(user.id));

    const res = await switchPOST(
      jsonRequest("/api/companies/switch", { companyId: beta.id }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  // ─── POST /api/companies/switch — success (D11 + recalculated capabilities) ─
  it("POST /api/companies/switch succeeds, writes BOTH company columns (D11), and the next session recalculates capabilities", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const beta = await insertPaidCompany({ name: "Beta" });
    // Solo esg_admin in Alpha (so its capabilities carry the D13 data.approve
    // grant); a plain auditor in Beta (a clearly different capability set).
    const { user } = await insertUserWithProfile({
      companyId: alpha.id,
      role: "esg_admin",
    });
    await insertMembership(beta.id, user.id, { role: "auditor" });
    getSessionMock.mockResolvedValue(await sessionFor(user.id));

    const res = await switchPOST(
      jsonRequest("/api/companies/switch", { companyId: beta.id }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { companyId: beta.id },
    });

    // D11 — a direct SELECT shows BOTH columns point at the target company.
    const [row] = await getTestDb()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    expect(row.activeCompanyId).toBe(beta.id);
    expect(row.companyId).toBe(beta.id);

    // The next session resolves the new company + RECALCULATED capabilities: the
    // auditor set (no company.manage), not the esg_admin set it had in Alpha.
    const ctx = await resolveSessionContext(getTestDb(), user.id);
    expect(ctx.company?.id).toBe(beta.id);
    expect(ctx.capabilities).toContain("audit.read");
    expect(ctx.capabilities).not.toContain("company.manage");
    expect(ctx.capabilities).not.toContain("data.approve");
  });

  // ─── OPTIONS preflight (PATTERN 2) ─────────────────────────────────────────
  it("OPTIONS on both paths answers the CORS preflight", async () => {
    const origin = "http://front.example.com";
    const prev = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = origin;
    try {
      for (const [handler, path] of [
        [companiesOPTIONS, "/api/companies"],
        [switchOPTIONS, "/api/companies/switch"],
      ] as const) {
        const res = handler(request(path, origin));
        expect(res.status).toBe(204);
        expect(res.headers.get("Access-Control-Allow-Methods")).toContain(
          "OPTIONS",
        );
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      }
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = prev;
    }
  });
});
