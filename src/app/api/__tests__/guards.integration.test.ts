// T3.2 integration tests — the capability guard on the mutating/data routes runs
// against a REAL Postgres via the T-13 harness. This suite proves the GUARD
// COMPOSITION ORDER (§7.1) and the capability MATRIX (§6.2) end to end, at the
// route boundary — not the pure `effectiveCapabilities` unit (that lives in
// `shared/roles`), but the actual HTTP outcome each role gets on each route class.
//
// The order under test is strictly:
//   401 UNAUTHENTICATED  (no session)            — before ANY body validation
//   404 COMPANY_NOT_FOUND(session, no company)
//   403 FORBIDDEN        (role lacks capability)  — BEFORE the paid-feature gate
//   402 PLAN_REQUIRED    (plan lacks the feature)
//   422 VALIDATION       (body rejected)
//
// The two load-bearing properties:
//   • 401 opens the door before 422 — otherwise the "422 vs 403" difference is a
//     probing oracle for a foreign API's body shape (§7.1).
//   • 403 opens before 402 — a role that can never perform the action is refused
//     outright, never shown an upgrade CTA it cannot use (the brief's explicit rule).
//
// T3.8 RE-POINTED THE data.write CASES FROM `/api/people` ONTO `/api/supply-chain`.
// The people route died with the wide-table stack, but what these cases prove is a
// property of the GUARD COMPOSITION, not of people data — and supply-chain is the
// same route SHAPE: `data.write` (403) → `requireFeature(..., {mutation:true})`
// (402) → server-side body validation (422). Every expectation below is unchanged;
// only the route the guard runs on is. On `pro` the plan carries `supplyChain`, so
// the "capability holder clears 403" case still lands on 422, exactly as before.
//
// `getSession` is mocked so each test controls the acting role; `@/server/db` is
// mocked to the harness pool so `requireFeature` reads the same Postgres the
// fixtures write. `describeIntegration` self-skips with no DB — a green no-op in a
// DB-less CI.
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

import { GET as auditGET } from "@/app/api/audit/route";
import { POST as checkoutPOST } from "@/app/api/billing/checkout/route";
import { PATCH as governancePATCH } from "@/app/api/company/governance/route";
import { POST as planPOST } from "@/app/api/company/plan/route";
import { PATCH as companyPATCH } from "@/app/api/company/route";
import { GET as goalsGET } from "@/app/api/goals/route";
import { POST as scope3POST } from "@/app/api/scope3-spend/route";
import {
  GET as supplyChainGET,
  POST as supplyChainPOST,
} from "@/app/api/supply-chain/route";
import {
  closeTestDb,
  describeIntegration,
  insertCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import type { DbCompany, DbSession } from "@/server/db/types";
import type { PlanId } from "@/shared/plans";
import { effectiveCapabilities, type CompanyRole } from "@/shared/roles";

type CompanyRow = { id: string; plan: string | null };

/** Project a harness company row into the narrow DbCompany the session carries. */
function dbCompanyFor(company: CompanyRow): DbCompany {
  return {
    id: company.id,
    name: "Acme",
    industry: "Manufacturing",
    nace_code: "C25",
    country: "Slovenia",
    country_code: "SI",
    headcount: 10,
    plan: company.plan ?? "trial",
    reporting_year: "2024",
    currency: "EUR",
  };
}

/**
 * A production-faithful session for `userId` acting as `role` in `company`. The
 * `capabilities` are resolved exactly as `getSession()` does — from the matrix via
 * `effectiveCapabilities` (approversCount=1, so no D13 self-approval grant) — so the
 * route's `requireCapability` reads the real effective set, not a hand-picked list.
 */
function sessionFor(
  company: CompanyRow,
  role: CompanyRole,
  userId: string,
): DbSession {
  return {
    userId,
    email: "actor@example.com",
    name: "Actor",
    company: dbCompanyFor(company),
    membership: {
      companyId: company.id,
      role,
      status: "active",
      hasIndependentApprover: true,
      activeMemberCount: 1,
    },
    capabilities: effectiveCapabilities(role, 1),
  };
}

/** Insert a company on `plan` + a member with `role`; return the session + ids. */
async function actor(
  plan: PlanId,
  role: CompanyRole,
): Promise<{ session: DbSession; companyId: string }> {
  const company = await insertCompany({ plan, countryCode: "SI" });
  const { user } = await insertUserWithProfile({ companyId: company.id, role });
  return { session: sessionFor(company, role, user.id), companyId: company.id };
}

const jsonReq = (path: string, method: string, body: unknown) =>
  new Request(`http://api.example.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const getReq = (path: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new Request(`http://api.example.com${path}`) as any;

/** A body that is DEFINITELY invalid for every write route (proves 401 ≺ 422). */
const GARBAGE = { nonsense: "not-a-valid-body", headcount: -999, plan: 42 };

describeIntegration("T3.2 capability guards on mutating/data routes", () => {
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

  // ─── 401 before 422 — authentication opens the door before body validation ───
  it("no session + a deliberately invalid body → 401, NOT 422 (no probing oracle)", async () => {
    getSessionMock.mockResolvedValue(null);
    // A body that would fail validation IF it ever reached it — it must not.
    const res = await supplyChainPOST(
      jsonReq("/api/supply-chain", "POST", GARBAGE),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "UNAUTHENTICATED" });
  });

  it("no session on a company.manage route + invalid body → 401, not 422/403", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await companyPATCH(jsonReq("/api/company", "PATCH", GARBAGE));
    expect(res.status).toBe(401);
  });

  // ─── 404 — session with no company (capability is uncomputable) ───────────────
  it("signed-in session with no company → 404, before the capability check", async () => {
    const { user } = await insertUserWithProfile(); // no companyId → no membership
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: user.name,
      company: null,
      membership: null,
      capabilities: [],
    } satisfies DbSession);
    const res = await supplyChainPOST(
      jsonReq("/api/supply-chain", "POST", GARBAGE),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "COMPANY_NOT_FOUND" });
  });

  // ─── company.manage — 403 NOT 402, even when the plan also would not help ─────
  it("contributor → PATCH /api/company → 403, and explicitly NOT 402", async () => {
    // Enterprise plan (the highest) — the tariff can NEVER be the blocker here, so
    // a 402 would be the "offer an upgrade that won't help" anti-pattern (§7.1).
    const { session } = await actor("enterprise", "contributor");
    getSessionMock.mockResolvedValue(session);
    const res = await companyPATCH(
      jsonReq("/api/company", "PATCH", { name: "Hijack" }),
    );
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(402);
    expect(await res.json()).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("contributor → PATCH /api/company/governance on TRIAL → 403 NOT 402 (403 precedes the 402 feature gate)", async () => {
    // Governance is DUAL-gated: company.manage (403) then governanceParams (402).
    // On trial the plan ALSO lacks governanceParams — but the role check fires
    // first, so the contributor sees 403, never the upgrade CTA (the order proof).
    const { session } = await actor("trial", "contributor");
    getSessionMock.mockResolvedValue(session);
    const res = await governancePATCH(
      jsonReq("/api/company/governance", "PATCH", { governance_data: {} }),
    );
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(402);
  });

  it("esg_admin → PATCH /api/company is NOT forbidden (the capability holder passes the gate)", async () => {
    const { session } = await actor("starter", "esg_admin");
    getSessionMock.mockResolvedValue(session);
    const res = await companyPATCH(
      jsonReq("/api/company", "PATCH", { name: "New Name" }),
    );
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  // ─── billing.manage — a contributor on Enterprise is still refused ────────────
  it("contributor on Enterprise → POST /api/company/plan → 403 (tariff cannot save a role that lacks billing.manage)", async () => {
    const { session } = await actor("enterprise", "contributor");
    getSessionMock.mockResolvedValue(session);
    const res = await planPOST(
      jsonReq("/api/company/plan", "POST", { plan: "pro" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("contributor on Enterprise → POST /api/billing/checkout → 403 (billing.manage)", async () => {
    const { session } = await actor("enterprise", "contributor");
    getSessionMock.mockResolvedValue(session);
    const res = await checkoutPOST(
      jsonReq("/api/billing/checkout", "POST", {
        plan: "pro",
        period: "monthly",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("esg_admin → POST /api/company/plan is NOT forbidden (billing.manage holder passes)", async () => {
    const { session } = await actor("starter", "esg_admin");
    getSessionMock.mockResolvedValue(session);
    const res = await planPOST(
      jsonReq("/api/company/plan", "POST", { plan: "pro" }),
    );
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  // ─── 403 ≺ 402 — the ordering proof on a route with BOTH gates (scope3) ───────
  // scope3-spend POST is gated by data.write (403) then requireFeature('scope3')
  // (402). Trial lacks `scope3`, so the SAME route + SAME plan yields different
  // codes purely by ROLE — which is the whole point of the ordering.
  it("reviewer on TRIAL → POST /api/scope3-spend → 403 (no data.write; capability fails BEFORE the absent feature)", async () => {
    const { session } = await actor("trial", "reviewer");
    getSessionMock.mockResolvedValue(session);
    const res = await scope3POST(
      jsonReq("/api/scope3-spend", "POST", { commodityKey: "x" }),
    );
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(402);
  });

  it("contributor on TRIAL → POST /api/scope3-spend → 402 (data.write PASSES; the plan lacks scope3) — proves 403→402", async () => {
    // NOTE: the brief's illustration said "Starter", but per plans.ts Starter
    // INCLUDES scope3 (it would pass the feature gate → 200). Trial is the plan
    // that actually lacks scope3, so it is the correct fixture for the 402 proof.
    const { session } = await actor("trial", "contributor");
    getSessionMock.mockResolvedValue(session);
    const res = await scope3POST(
      jsonReq("/api/scope3-spend", "POST", { commodityKey: "x" }),
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ ok: false, error: "PLAN_REQUIRED" });
  });

  // ─── data.write class — reviewer/auditor cannot write company data ────────────
  it("reviewer → POST /api/supply-chain → 403 (reviewer deliberately does not write, §6.2)", async () => {
    const { session } = await actor("pro", "reviewer");
    getSessionMock.mockResolvedValue(session);
    const res = await supplyChainPOST(
      jsonReq("/api/supply-chain", "POST", GARBAGE),
    );
    expect(res.status).toBe(403);
  });

  it("contributor → POST /api/supply-chain is NOT forbidden (data.write holder clears 403)", async () => {
    // pro includes supplyChain, so the capability holder passes BOTH gates and is
    // stopped only by the invalid body — i.e. it reached 422, never 403/402.
    const { session } = await actor("pro", "contributor");
    getSessionMock.mockResolvedValue(session);
    const res = await supplyChainPOST(
      jsonReq("/api/supply-chain", "POST", GARBAGE),
    );
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(422);
  });

  // ─── audit.read class — contributor is deliberately WITHOUT the audit journal ─
  it("contributor → GET /api/audit → 403 (contributor has no audit.read, §6.2)", async () => {
    const { session } = await actor("pro", "contributor");
    getSessionMock.mockResolvedValue(session);
    const res = await auditGET(getReq("/api/audit"));
    expect(res.status).toBe(403);
  });

  // ─── D4 — auditor: read EVERYTHING, write NOTHING ─────────────────────────────
  it("auditor → POST /api/supply-chain → 403 (no data.write)", async () => {
    const { session } = await actor("pro", "auditor");
    getSessionMock.mockResolvedValue(session);
    const res = await supplyChainPOST(
      jsonReq("/api/supply-chain", "POST", GARBAGE),
    );
    expect(res.status).toBe(403);
  });

  it("auditor → POST /api/scope3-spend → 403 (no data.write)", async () => {
    const { session } = await actor("pro", "auditor");
    getSessionMock.mockResolvedValue(session);
    const res = await scope3POST(
      jsonReq("/api/scope3-spend", "POST", { commodityKey: "x" }),
    );
    expect(res.status).toBe(403);
  });

  it("auditor → GET /api/supply-chain → 200 (data.read)", async () => {
    const { session } = await actor("pro", "auditor");
    getSessionMock.mockResolvedValue(session);
    const res = await supplyChainGET(getReq("/api/supply-chain"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("auditor → GET /api/goals → 200 (data.read)", async () => {
    const { session } = await actor("pro", "auditor");
    getSessionMock.mockResolvedValue(session);
    const res = await goalsGET(getReq("/api/goals"));
    expect(res.status).toBe(200);
  });

  it("auditor → GET /api/audit → 200 (audit.read — the auditor's whole purpose)", async () => {
    const { session } = await actor("pro", "auditor");
    getSessionMock.mockResolvedValue(session);
    const res = await auditGET(getReq("/api/audit"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
