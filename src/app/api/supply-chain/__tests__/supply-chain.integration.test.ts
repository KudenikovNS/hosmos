// T2.3 integration tests — the Supply Chain write/delete route runs against a REAL
// Postgres via the T-13 harness. Proves §Q5 (suppliers persist) + §Q6 (audit) + the
// server-side entitlement close (§7.3) + the cross-tenant DELETE guard + D7
// (disclosure only — no footprint effect):
//   • trial company (supplyChain=false) → 402 PLAN_REQUIRED on POST (UI bypass blocked);
//   • a supplyChain-entitled plan (pro) → create persists ONE supply_chain_data row +
//     ONE audit_log row;
//   • GET lists ONLY the session company's suppliers (tenant isolation on read);
//   • identity (company/user) comes ONLY from the session, never the body;
//   • an update-in-place edits the same row (action='update');
//   • DELETE of ANOTHER company's supplier id → 404 NO_DATA, the row survives (no
//     cross-tenant delete);
//   • a bad enum (riskLevel) → 422 VALIDATION, nothing written;
//   • a negative spend → 422 VALIDATION;
//   • persisting suppliers writes NOTHING to scope3_results / scope3_spend (D7).
//
// `getSession` is mocked so a test controls identity; `@/server/db` is mocked to the
// harness pool so route + service read the same Postgres the fixtures write to.
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

import {
  DELETE as scDELETE,
  GET as scGET,
  POST as scPOST,
} from "@/app/api/supply-chain/route";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  auditLog,
  scope3Results,
  scope3Spend,
  supplyChainData,
} from "@/server/db/schema";
import { eq } from "drizzle-orm";
import type { DbCompany, DbSession } from "@/server/db/types";
import type { PlanId } from "@/shared/plans";

/** Insert a company on `plan` + a real user/profile, and build the DbSession. */
async function setupSession(plan: PlanId): Promise<DbSession> {
  const company = await insertCompany({
    plan,
    countryCode: "SI",
    reportingYear: "2024",
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

const post = (body: unknown) =>
  new Request("http://api.example.com/api/supply-chain", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const del = (query = "") =>
  new Request(`http://api.example.com/api/supply-chain${query}`, {
    method: "DELETE",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const get = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new Request("http://api.example.com/api/supply-chain") as any;

const validBody = {
  supplierName: "Metal Parts GmbH",
  supplierCountry: "Germany",
  category: "raw_materials",
  spendEur: 125000,
  emissionsTco2e: 42.5,
  riskLevel: "high",
  tier: 1,
  esgScore: 78,
  certified: true,
  certification: "ISO 14001",
  notes: "Primary steel supplier",
};

describeIntegration(
  "T2.3 /api/supply-chain (session-guarded persist + delete + audit, disclosure only)",
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

    it("trial company (supplyChain=false) → 402 PLAN_REQUIRED on POST (UI bypass blocked)", async () => {
      getSessionMock.mockResolvedValue(await setupSession("trial"));

      const res = await scPOST(post(validBody));

      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ ok: false, error: "PLAN_REQUIRED" });
    });

    it("pro company → create persists a supplier row AND one audit_log row", async () => {
      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      const res = await scPOST(post(validBody));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });

      const rows = await db
        .select()
        .from(supplyChainData)
        .where(eq(supplyChainData.companyId, companyId));
      expect(rows).toHaveLength(1);
      expect(rows[0].supplierName).toBe("Metal Parts GmbH");
      expect(rows[0].supplierCountry).toBe("Germany");
      expect(rows[0].riskLevel).toBe("high");
      expect(Number(rows[0].spendEur)).toBe(125000);
      expect(Number(rows[0].emissionsTco2e)).toBe(42.5);
      expect(rows[0].esgScore).toBe(78);
      expect(rows[0].tier).toBe(1);
      expect(rows[0].certified).toBe(true);
      expect(rows[0].certification).toBe("ISO 14001");

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(audits).toHaveLength(1);
      expect(audits[0].entity).toBe("supply_chain");
      expect(audits[0].action).toBe("create");
      expect(audits[0].userId).toBe(session.userId);
    });

    it("GET lists ONLY the session company's suppliers (tenant isolation)", async () => {
      const other = await setupSession("pro");
      getSessionMock.mockResolvedValue(other);
      await scPOST(post({ ...validBody, supplierName: "OTHER co supplier" }));

      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      await scPOST(post({ ...validBody, supplierName: "MINE supplier" }));

      const res = await scGET(get());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].supplierName).toBe("MINE supplier");
    });

    it("takes company/user from the session, never the body (PATTERN 3)", async () => {
      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      await scPOST(
        post({
          ...validBody,
          companyId: crypto.randomUUID(),
          company_id: crypto.randomUUID(),
          userId: crypto.randomUUID(),
        }),
      );

      const rows = await db
        .select()
        .from(supplyChainData)
        .where(eq(supplyChainData.companyId, companyId));
      expect(rows).toHaveLength(1); // written under the SESSION company, not the body's
    });

    it("update-in-place edits the same supplier (action='update')", async () => {
      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      const created = await scPOST(post(validBody));
      const id = (await created.json()).data.id as string;

      const res = await scPOST(
        post({
          ...validBody,
          id,
          supplierName: "Metal Parts Group",
          riskLevel: "critical",
        }),
      );
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(supplyChainData)
        .where(eq(supplyChainData.companyId, companyId));
      expect(rows).toHaveLength(1); // updated in place, not a second row
      expect(rows[0].supplierName).toBe("Metal Parts Group");
      expect(rows[0].riskLevel).toBe("critical");

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(audits.map((a) => a.action).sort()).toEqual(["create", "update"]);
    });

    it("DELETE of another company's supplier id → 404 NO_DATA, no cross-tenant delete", async () => {
      const owner = await setupSession("pro");
      getSessionMock.mockResolvedValue(owner);
      const created = await scPOST(post(validBody));
      const ownerSupplierId = (await created.json()).data.id as string;
      const db = getTestDb();

      const attacker = await setupSession("pro");
      getSessionMock.mockResolvedValue(attacker);
      const res = await scDELETE(del(`?id=${ownerSupplierId}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "NO_DATA" });

      const survivors = await db
        .select()
        .from(supplyChainData)
        .where(eq(supplyChainData.id, ownerSupplierId));
      expect(survivors).toHaveLength(1);
      const attackerAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, attacker.company!.id));
      expect(attackerAudits).toHaveLength(0);
    });

    it("DELETE of an owned supplier removes it + writes a delete audit", async () => {
      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      const created = await scPOST(post(validBody));
      const id = (await created.json()).data.id as string;

      const res = await scDELETE(del(`?id=${id}`));
      expect(res.status).toBe(200);

      expect(
        await db
          .select()
          .from(supplyChainData)
          .where(eq(supplyChainData.companyId, companyId)),
      ).toHaveLength(0);
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(audits.map((a) => a.action)).toContain("delete");
    });

    it("rejects a bad enum (riskLevel) → 422, writes nothing", async () => {
      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      const res = await scPOST(post({ ...validBody, riskLevel: "bogus" }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });

      expect(
        await db
          .select()
          .from(supplyChainData)
          .where(eq(supplyChainData.companyId, companyId)),
      ).toHaveLength(0);
    });

    it("rejects a negative spend → 422", async () => {
      getSessionMock.mockResolvedValue(await setupSession("pro"));
      const res = await scPOST(post({ ...validBody, spendEur: -5 }));
      expect(res.status).toBe(422);
    });

    it("rejects an empty supplierName → 422", async () => {
      getSessionMock.mockResolvedValue(await setupSession("pro"));
      const res = await scPOST(post({ ...validBody, supplierName: "  " }));
      expect(res.status).toBe(422);
    });

    it("disclosure only (D7): persisting a supplier writes NOTHING to scope3", async () => {
      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      await scPOST(post(validBody));

      // No footprint leak: the supplier's spend/emissions never enter Scope-3.
      const results = await db
        .select()
        .from(scope3Results)
        .where(eq(scope3Results.companyId, companyId));
      expect(results).toHaveLength(0);
      const spend = await db
        .select()
        .from(scope3Spend)
        .where(eq(scope3Spend.companyId, companyId));
      expect(spend).toHaveLength(0);
    });

    it("unauthenticated → 401", async () => {
      getSessionMock.mockResolvedValue(null);
      const res = await scPOST(post(validBody));
      expect(res.status).toBe(401);
    });
  },
);
