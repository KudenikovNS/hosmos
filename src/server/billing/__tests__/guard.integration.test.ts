// T-A4 integration tests — the server-side entitlement guards run against a REAL
// Postgres via the T-13 harness. Proves the SEC close (§7.3): a client that POSTs
// straight to the API in the bypass of the UI is stopped server-side.
//   • governance write: trial → 402, starter → passes;
//   • getEntitlements degrades to company.plan (mode='active') with no sub row.
//
// TRIMMED IN T3.8. Five cases opened this file: they drove the `scope3` write gate
// through `POST /api/emissions/save`, feeding it 12 activity months typed by
// `MonthlyActivity` and asserting `SCOPE3_FIELD_CATEGORY` mapped a flights /
// freight / waste field to the entitlement. That route, that type and that field
// map were the wide-table stack and were deleted; a save payload no endpoint
// accepts is not a guard test, so the cases went with them (О-9) along with their
// `zeroMonth` / `months` / `savePayload` helpers. The SUITE stays — the governance
// gate and the whole `getEntitlements`/`getLiveSubscription` half never touched
// emissions. The scope-3 write gate itself keeps its coverage on the surviving
// call site: `guards.integration.test.ts` proves trial → 402 / contributor → 403
// on `POST /api/scope3-spend`.
//
// `getSession` is mocked so a test controls the identity; `@/server/db` is mocked
// to the harness pool so the guard/route read the same Postgres the fixtures
// write to. `describeIntegration` self-skips with no DB, so this file is a green
// no-op in a DB-less CI. `server-only` is neutralised for vitest's node env.
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

import { PATCH as governancePATCH } from "@/app/api/company/governance/route";
import { getEntitlements, getLiveSubscription } from "@/server/billing/guard";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { companySubscription } from "@/server/db/schema";
import type { DbCompany, DbSession } from "@/server/db/types";
import type { PlanId } from "@/shared/plans";

/** Insert a company on `plan` plus a real user/profile, and build the DbSession. */
async function setupSession(plan: PlanId): Promise<DbSession> {
  const company = await insertCompany({ plan, countryCode: "SI" });
  const { user } = await insertUserWithProfile({ companyId: company.id });
  const dbCompany: DbCompany = {
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
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    company: dbCompany,
    // esg_admin membership that production getSession() always resolves (§8, §14.1).
    membership: {
      companyId: dbCompany.id,
      role: "esg_admin",
      status: "active",
      hasIndependentApprover: true,
      activeMemberCount: 1,
    },
  };
}

const request = (path: string, body: unknown) =>
  new Request(`http://api.example.com${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describeIntegration("T-A4 server-side entitlement guards", () => {
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

  // ─── company/governance gate ───────────────────────────────────────────────
  it("trial company → 402 PLAN_REQUIRED on a governance write", async () => {
    getSessionMock.mockResolvedValue(await setupSession("trial"));

    const res = await governancePATCH(
      request("/api/company/governance", {
        governance_data: { hasPolicy: true },
      }),
    );

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ ok: false, error: "PLAN_REQUIRED" });
  });

  it("starter company → governance write passes the guard (200)", async () => {
    getSessionMock.mockResolvedValue(await setupSession("starter"));

    const res = await governancePATCH(
      request("/api/company/governance", {
        governance_data: { hasPolicy: true },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  // ─── getEntitlements degradation (no subscription row) ──────────────────────
  it("getEntitlements degrades to company.plan as active with no subscription row", async () => {
    const ent = await getEntitlements(await setupSession("pro"));

    expect(ent.mode).toBe("active");
    expect(ent.features.id).toBe<PlanId>("pro");
    expect(ent.writeFeatures.id).toBe<PlanId>("pro");
    // Paid features are granted (read + write) — degradation trusts company.plan.
    expect(ent.features.scope3).toBe(true);
    expect(ent.writeFeatures.scope3).toBe(true);
  });

  // ─── multi-row selection (cancel → re-subscribe leaves a stale row) ──────────
  it("prefers the live active row over a stale cancelled row (no wrong downgrade)", async () => {
    // A paying customer who once cancelled: an old `cancelled` row plus a fresh
    // `active` one. The guard must read the ACTIVE row, not downgrade to lapsed.
    const session = await setupSession("pro");
    const companyId = session.company!.id;
    await getTestDb()
      .insert(companySubscription)
      .values([
        {
          companyId,
          planId: "pro",
          period: "monthly",
          status: "cancelled",
          currentPeriodEnd: new Date(Date.now() - 86_400_000),
        },
        {
          companyId,
          planId: "pro",
          period: "monthly",
          status: "active",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      ]);

    const ent = await getEntitlements(session);
    expect(ent.mode).toBe("active");
    expect(ent.features.id).toBe<PlanId>("pro");
    expect(ent.writeFeatures.scope3).toBe(true);
  });

  it("getLiveSubscription returns ISO-string dates (JSON-safe) or null when none is live", async () => {
    const session = await setupSession("pro");
    const companyId = session.company!.id;
    // No live row yet → null.
    expect(await getLiveSubscription(companyId)).toBeNull();

    const end = new Date(Date.now() + 20 * 86_400_000);
    await getTestDb().insert(companySubscription).values({
      companyId,
      planId: "pro",
      period: "annual",
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: end,
    });

    const live = await getLiveSubscription(companyId);
    expect(live).toEqual({
      status: "active",
      period: "annual",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: end.toISOString(), // ISO string, never a raw Date
      pendingPlanId: null,
    });
    expect(typeof live!.currentPeriodEnd).toBe("string");
  });

  it("with only a lapsed row, readonly mode reads the last paid plan", async () => {
    // company.plan is already 'trial' after expiry; readonly must still surface the
    // lapsed subscription's plan for READ (write drops to trial). §9.
    const session = await setupSession("trial");
    await getTestDb()
      .insert(companySubscription)
      .values({
        companyId: session.company!.id,
        planId: "pro",
        period: "monthly",
        status: "expired",
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
      });

    const ent = await getEntitlements(session);
    // DOWNGRADE_MODE defaults to readonly: read = last paid (pro), write = trial.
    expect(ent.mode).toBe("readonly");
    expect(ent.features.id).toBe<PlanId>("pro");
    expect(ent.writeFeatures.id).toBe<PlanId>("trial");
  });
});
