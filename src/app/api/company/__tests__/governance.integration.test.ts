// T4.1 integration tests — the governance write route runs against a REAL Postgres
// via the T-13 harness. Proves §Q6 (audit) at the `governance` boundary:
//   • a valid save on an entitled plan → exactly ONE audit_log row (entity
//     'governance', action 'update', entityId = company.id, identity from the
//     session — PATTERN 3), summary a compact {items, checked} count;
//   • a plan denial (trial → 402 PLAN_REQUIRED) → zero audit rows;
//   • a bad body (non-object governance_data → 422 VALIDATION) → zero audit rows.
//
// `getSession` is mocked so a test controls identity; `@/server/db` points at the
// harness pool so route + service share the same Postgres the fixtures write to.
// `describeIntegration` self-skips with no DB — a green no-op in a DB-less CI.
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
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { auditLog } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import type { DbCompany, DbSession } from "@/server/db/types";
import type { PlanId } from "@/shared/plans";

/** Insert a company on `plan` + a real user/profile, and build the DbSession. */
async function setupSession(plan: PlanId): Promise<DbSession> {
  const company = await insertCompany({
    plan,
    countryCode: "SI",
    reportingYear: "2024",
    headcount: 10,
  });
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

const patch = (body: unknown) =>
  new Request("http://api.example.com/api/company/governance", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const validGov = {
  governance_data: {
    boardOversight: true,
    ethicsPolicy: true,
    antiBribery: false,
  },
};

describeIntegration(
  "T4.1 PATCH /api/company/governance (audit at the governance boundary)",
  () => {
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

    it("valid save (starter) → exactly ONE audit_log row (governance / update)", async () => {
      const session = await setupSession("starter");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      const res = await governancePATCH(patch(validGov));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(audits).toHaveLength(1);
      expect(audits[0].entity).toBe("governance");
      expect(audits[0].action).toBe("update");
      expect(audits[0].entityId).toBe(companyId);
      expect(audits[0].companyId).toBe(companyId);
      expect(audits[0].userId).toBe(session.userId);
      // 3 items, 2 checked (boardOversight + ethicsPolicy true, antiBribery false).
      expect(audits[0].summary).toMatchObject({ items: 3, checked: 2 });
    });

    it("trial company (governanceParams=false) → 402 PLAN_REQUIRED, zero audit rows", async () => {
      const session = await setupSession("trial");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      const res = await governancePATCH(patch(validGov));
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ ok: false, error: "PLAN_REQUIRED" });

      expect(
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.companyId, companyId)),
      ).toHaveLength(0);
    });

    it("bad body (non-object governance_data) → 422 VALIDATION, zero audit rows", async () => {
      const session = await setupSession("starter");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      const res = await governancePATCH(patch({ governance_data: "nope" }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });

      expect(
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.companyId, companyId)),
      ).toHaveLength(0);
    });

    it("unauthenticated → 401", async () => {
      getSessionMock.mockResolvedValue(null);
      const res = await governancePATCH(patch(validGov));
      expect(res.status).toBe(401);
    });
  },
);
