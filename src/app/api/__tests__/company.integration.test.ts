// T-21 integration tests — the register / company / company-plan /
// company-governance route handlers run against a real Postgres via the T-13
// harness. Covers the phase-D invariants for the write endpoints:
//   • session-guard (PATTERN 3): identity (userId / companyId) comes ONLY from
//     getSession(), never a client parameter — no session → 401;
//   • POST /api/register creates a company + links the profile (userId from the
//     session), 1:1 with the old signUp (a company failure does not fail it);
//   • PATCH /api/company whitelists EXACTLY {name,industry,country,nace_code,
//     headcount} — an attempt to smuggle `plan`/`stripe_customer_id` is ignored;
//   • POST /api/company/plan validates the PlanId (garbage rejected, DB untouched);
//   • PATCH /api/company/governance writes governance_data;
//   • responses are the OLD snake_case company shape (note #44) via toDbCompany.
//
// `getSession` is mocked so a test controls the identity; `@/server/db` is mocked
// to the harness pool so the routes read the same Postgres the fixtures write to.
// `describeIntegration` is `describe.skip` with no DB, so this file is a green
// no-op in a DB-less CI.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getSessionMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  getSession: () => getSessionMock(),
}));

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return {
    get db() {
      return harness.getTestDb();
    },
  };
});

import { PATCH as companyPATCH } from "@/app/api/company/route";
import { PATCH as governancePATCH } from "@/app/api/company/governance/route";
import { POST as planPOST } from "@/app/api/company/plan/route";
import { POST as registerPOST } from "@/app/api/register/route";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { auditLog, companies, profiles } from "@/server/db/schema";
import type { DbCompany } from "@/server/db/types";

/** Build a DbSession whose company projection matches a harness company row. */
function sessionFor(
  company: { id: string; name: string },
  userId = "u1",
  plan = "trial",
) {
  const dbCompany: DbCompany = {
    id: company.id,
    name: company.name,
    industry: "Manufacturing",
    nace_code: "C25",
    country: "Slovenia",
    country_code: "SI",
    headcount: 40,
    plan,
    reporting_year: "2024",
    currency: "EUR",
  };
  return {
    userId,
    email: "u@example.com",
    name: "U Owner",
    company: dbCompany,
    // esg_admin membership that production getSession() always resolves (§8, §14.1).
    membership: {
      companyId: dbCompany.id,
      role: "esg_admin" as const,
      status: "active" as const,
      hasIndependentApprover: true,
      activeMemberCount: 1,
    },
  };
}

/** A JSON request carrying a body + method (the write endpoints read req.json()). */
const jsonRequest = (path: string, method: string, body: unknown) =>
  new Request(`http://api.example.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describeIntegration("T-21 company/register route handlers", () => {
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

  // ─── POST /api/register ────────────────────────────────────────────────────
  it("POST /api/register → 401 with no session (PATTERN 3 guard)", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await registerPOST(
      jsonRequest("/api/register", "POST", { company: "Acme" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "UNAUTHENTICATED" });
  });

  it("POST /api/register creates a company and links the profile (userId from session)", async () => {
    const db = getTestDb();
    // The user just signed up via better-auth: a user + unlinked profile exist.
    const { user, profile } = await insertUserWithProfile();
    expect(profile.companyId).toBeNull();
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: "Jane Owner",
      company: null,
    });

    const res = await registerPOST(
      jsonRequest("/api/register", "POST", { company: "Acme Manufacturing" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.data.companyId).toBe("string");

    // The company row exists and the profile is now linked to it.
    const [companyRow] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, body.data.companyId))
      .limit(1);
    expect(companyRow.name).toBe("Acme Manufacturing");
    const [profileRow] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    expect(profileRow.companyId).toBe(body.data.companyId);
    expect(profileRow.fullName).toBe("Jane Owner");
  });

  it("POST /api/register with no company name links nothing but still succeeds (company error does not break registration)", async () => {
    const { user } = await insertUserWithProfile();
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: "No Co",
      company: null,
    });

    const res = await registerPOST(jsonRequest("/api/register", "POST", {}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.companyId).toBeNull();

    const db = getTestDb();
    const [profileRow] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    expect(profileRow.companyId).toBeNull();
  });

  // ─── PATCH /api/company (whitelist) ────────────────────────────────────────
  it("PATCH /api/company → 401 with no session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await companyPATCH(
      jsonRequest("/api/company", "PATCH", { name: "X" }),
    );
    expect(res.status).toBe(401);
  });

  it("PATCH /api/company applies ONLY the whitelisted fields (plan / stripe smuggling ignored) and returns snake_case", async () => {
    const db = getTestDb();
    const company = await insertCompany({ name: "Old", plan: "trial" });
    // A successful profile write logs an audit row (§Q6) whose userId FKs
    // profiles — so the acting user must be a real profile, not a bare "u1".
    const { user } = await insertUserWithProfile({ companyId: company.id });
    getSessionMock.mockResolvedValue(sessionFor(company, user.id));

    const res = await companyPATCH(
      jsonRequest("/api/company", "PATCH", {
        name: "New Name",
        industry: "Tech",
        nace_code: "J62",
        headcount: 7,
        // These must NOT leak through the whitelist:
        plan: "enterprise",
        status: "churned",
        monthly_price: "9999",
        stripe_customer_id: "sk_evil",
        governance_data: { hacked: true },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Whitelisted fields applied:
    expect(body.data.name).toBe("New Name");
    expect(body.data.industry).toBe("Tech");
    expect(body.data.nace_code).toBe("J62");
    expect(body.data.headcount).toBe(7);
    // snake_case shape (note #44): nace_code present, not naceCode.
    expect(body.data).not.toHaveProperty("naceCode");
    // Non-whitelisted fields untouched in the response …
    expect(body.data.plan).toBe("trial");
    // … and in the database.
    const [row] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, company.id))
      .limit(1);
    expect(row.plan).toBe("trial");
    expect(row.status).toBe("active");
    expect(row.stripeCustomerId).toBeNull();
    expect(row.governanceData).toEqual({});
  });

  it("PATCH /api/company rejects a negative headcount (422 VALIDATION)", async () => {
    const company = await insertCompany({ name: "Co" });
    getSessionMock.mockResolvedValue(sessionFor(company));
    const res = await companyPATCH(
      jsonRequest("/api/company", "PATCH", { headcount: -5 }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });
  });

  // ─── PATCH /api/company — default currency (T2.5, §Q3-FX/D8) ────────────────
  it("PATCH /api/company persists a valid default currency + writes an audit row (identity from session)", async () => {
    const db = getTestDb();
    const company = await insertCompany({ name: "Co", currency: "EUR" });
    const { user } = await insertUserWithProfile({ companyId: company.id });
    getSessionMock.mockResolvedValue(sessionFor(company, user.id));

    const res = await companyPATCH(
      jsonRequest("/api/company", "PATCH", {
        currency: "USD",
        // A body companyId must be IGNORED — identity comes from the session.
        companyId: "00000000-0000-0000-0000-000000000000",
        id: "00000000-0000-0000-0000-000000000000",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.currency).toBe("USD");

    // Persisted on the SESSION company (not the smuggled body id).
    const [row] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, company.id))
      .limit(1);
    expect(row.currency).toBe("USD");

    // One audit row for the update, scoped to the session company + user.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.companyId, company.id));
    expect(audits).toHaveLength(1);
    expect(audits[0].entity).toBe("company");
    expect(audits[0].action).toBe("update");
    expect(audits[0].userId).toBe(user.id);
    expect((audits[0].summary as { currency?: string }).currency).toBe("USD");
  });

  it("PATCH /api/company lowercase currency is normalised to the seeded uppercase code", async () => {
    const db = getTestDb();
    const company = await insertCompany({ name: "Co", currency: "EUR" });
    const { user } = await insertUserWithProfile({ companyId: company.id });
    getSessionMock.mockResolvedValue(sessionFor(company, user.id));

    const res = await companyPATCH(
      jsonRequest("/api/company", "PATCH", { currency: "gbp" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.currency).toBe("GBP");
    const [row] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, company.id))
      .limit(1);
    expect(row.currency).toBe("GBP");
  });

  it("PATCH /api/company rejects a currency not in the seeded set (422) and leaves the DB + audit untouched", async () => {
    const db = getTestDb();
    const company = await insertCompany({ name: "Co", currency: "EUR" });
    getSessionMock.mockResolvedValue(sessionFor(company));

    const res = await companyPATCH(
      jsonRequest("/api/company", "PATCH", { currency: "ZZZ" }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });

    const [row] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, company.id))
      .limit(1);
    expect(row.currency).toBe("EUR");
    // A validation failure writes NO audit row.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.companyId, company.id));
    expect(audits).toHaveLength(0);
  });

  // ─── POST /api/company/plan ────────────────────────────────────────────────
  it("POST /api/company/plan changes to a valid PlanId and stamps plan_start", async () => {
    const db = getTestDb();
    const company = await insertCompany({ name: "Co", plan: "trial" });
    getSessionMock.mockResolvedValue(sessionFor(company));

    const res = await planPOST(
      jsonRequest("/api/company/plan", "POST", { plan: "pro" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { plan: "pro" } });

    const [row] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, company.id))
      .limit(1);
    expect(row.plan).toBe("pro");
    expect(row.planStart).toBe(new Date().toISOString().split("T")[0]);
  });

  it("POST /api/company/plan rejects an unknown PlanId (422) and leaves the DB untouched", async () => {
    const db = getTestDb();
    const company = await insertCompany({ name: "Co", plan: "trial" });
    getSessionMock.mockResolvedValue(sessionFor(company));

    const res = await planPOST(
      jsonRequest("/api/company/plan", "POST", { plan: "hacker" }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });

    const [row] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, company.id))
      .limit(1);
    expect(row.plan).toBe("trial");
    expect(row.planStart).toBeNull();
  });

  // ─── PATCH /api/company/governance ─────────────────────────────────────────
  it("PATCH /api/company/governance persists governance_data and returns snake_case", async () => {
    const db = getTestDb();
    const company = await insertCompany({ name: "Co" });
    // governanceParams requires a paid plan (T-A4 guard) — grant starter here.
    // The successful write now logs an audit row (§Q6, T4.1) whose userId FKs
    // profiles — so the acting user must be a real profile, not a bare "u1".
    const { user } = await insertUserWithProfile({ companyId: company.id });
    getSessionMock.mockResolvedValue(sessionFor(company, user.id, "starter"));

    const res = await governancePATCH(
      jsonRequest("/api/company/governance", "PATCH", {
        governance_data: { hasPolicy: true, hasBoard: false },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.governance_data).toEqual({
      hasPolicy: true,
      hasBoard: false,
    });

    const [row] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, company.id))
      .limit(1);
    expect(row.governanceData).toEqual({ hasPolicy: true, hasBoard: false });
  });

  it("PATCH /api/company/governance → 404 COMPANY_NOT_FOUND when the session has no company", async () => {
    getSessionMock.mockResolvedValue({
      userId: "u1",
      email: "u@example.com",
      name: "U",
      company: null,
    });
    const res = await governancePATCH(
      jsonRequest("/api/company/governance", "PATCH", { governance_data: {} }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "COMPANY_NOT_FOUND" });
  });
});
