// T2.2 integration tests — the Goals write/delete route runs against a REAL Postgres
// via the T-13 harness. Proves §Q5 (Goals persist) + §Q6 (audit) + the server-side
// entitlement close (§7.3) + the cross-tenant DELETE guard:
//   • trial company (goals=false) → 402 PLAN_REQUIRED on POST (UI bypass blocked);
//   • a goals-entitled plan (pro) → create persists ONE goals row + ONE audit_log row;
//   • GET lists ONLY the session company's goals (tenant isolation on read);
//   • identity (company/user) comes ONLY from the session, never the body;
//   • an update-in-place edits the same row (action='update');
//   • DELETE of ANOTHER company's goal id → 404 NO_DATA, the row survives (no
//     cross-tenant delete);
//   • a bad enum (category) → 422 VALIDATION, nothing written.
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
  DELETE as goalsDELETE,
  GET as goalsGET,
  POST as goalsPOST,
} from "@/app/api/goals/route";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { auditLog, goals } from "@/server/db/schema";
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
  new Request("http://api.example.com/api/goals", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const del = (query = "") =>
  new Request(`http://api.example.com/api/goals${query}`, {
    method: "DELETE",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const get = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new Request("http://api.example.com/api/goals") as any;

const validBody = {
  title: "Reduce Scope 1 by 30%",
  description: "Cut direct combustion emissions",
  category: "emissions",
  targetYear: "2030",
  targetValue: 130,
  currentValue: 142,
  unit: "tCO2e",
  baselineYear: "2024",
  baselineValue: 185,
  status: "on_track",
  sbtiAligned: true,
};

describeIntegration(
  "T2.2 /api/goals (session-guarded persist + delete + audit)",
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

    it("trial company (goals=false) → 402 PLAN_REQUIRED on POST (UI bypass blocked)", async () => {
      getSessionMock.mockResolvedValue(await setupSession("trial"));

      const res = await goalsPOST(post(validBody));

      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ ok: false, error: "PLAN_REQUIRED" });
    });

    it("pro company → create persists a goals row AND one audit_log row", async () => {
      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      const res = await goalsPOST(post(validBody));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });

      const rows = await db
        .select()
        .from(goals)
        .where(eq(goals.companyId, companyId));
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Reduce Scope 1 by 30%");
      expect(rows[0].category).toBe("emissions");
      expect(Number(rows[0].targetValue)).toBe(130);
      expect(Number(rows[0].baselineValue)).toBe(185);
      expect(rows[0].status).toBe("on_track");
      expect(rows[0].sbtiAligned).toBe(true);

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(audits).toHaveLength(1);
      expect(audits[0].entity).toBe("goals");
      expect(audits[0].action).toBe("create");
      expect(audits[0].userId).toBe(session.userId);
    });

    it("GET lists ONLY the session company's goals (tenant isolation)", async () => {
      // Another company's goal must never appear on this session's list.
      const other = await setupSession("pro");
      getSessionMock.mockResolvedValue(other);
      await goalsPOST(post({ ...validBody, title: "OTHER co goal" }));

      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      await goalsPOST(post({ ...validBody, title: "MINE goal" }));

      const res = await goalsGET(get());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe("MINE goal");
    });

    it("takes company/user from the session, never the body (PATTERN 3)", async () => {
      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      await goalsPOST(
        post({
          ...validBody,
          companyId: crypto.randomUUID(),
          company_id: crypto.randomUUID(),
          userId: crypto.randomUUID(),
        }),
      );

      const rows = await db
        .select()
        .from(goals)
        .where(eq(goals.companyId, companyId));
      expect(rows).toHaveLength(1); // written under the SESSION company, not the body's
    });

    it("update-in-place edits the same goal (action='update')", async () => {
      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      const created = await goalsPOST(post(validBody));
      const createdBody = await created.json();
      const id = createdBody.data.id as string;

      const res = await goalsPOST(
        post({
          ...validBody,
          id,
          title: "Reduce Scope 1 by 40%",
          status: "at_risk",
        }),
      );
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(goals)
        .where(eq(goals.companyId, companyId));
      expect(rows).toHaveLength(1); // updated in place, not a second row
      expect(rows[0].title).toBe("Reduce Scope 1 by 40%");
      expect(rows[0].status).toBe("at_risk");

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(audits.map((a) => a.action).sort()).toEqual(["create", "update"]);
    });

    it("DELETE of another company's goal id → 404 NO_DATA, no cross-tenant delete", async () => {
      // Company A creates a goal.
      const owner = await setupSession("pro");
      getSessionMock.mockResolvedValue(owner);
      const created = await goalsPOST(post(validBody));
      const ownerGoalId = (await created.json()).data.id as string;
      const db = getTestDb();

      // Company B tries to delete A's goal by id.
      const attacker = await setupSession("pro");
      getSessionMock.mockResolvedValue(attacker);
      const res = await goalsDELETE(del(`?id=${ownerGoalId}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "NO_DATA" });

      // A's goal is untouched.
      const survivors = await db
        .select()
        .from(goals)
        .where(eq(goals.id, ownerGoalId));
      expect(survivors).toHaveLength(1);
      // No delete audit under the attacker.
      const attackerAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, attacker.company!.id));
      expect(attackerAudits).toHaveLength(0);
    });

    it("DELETE of an owned goal removes it + writes a delete audit", async () => {
      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      const created = await goalsPOST(post(validBody));
      const id = (await created.json()).data.id as string;

      const res = await goalsDELETE(del(`?id=${id}`));
      expect(res.status).toBe(200);

      expect(
        await db.select().from(goals).where(eq(goals.companyId, companyId)),
      ).toHaveLength(0);
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(audits.map((a) => a.action)).toContain("delete");
    });

    it("rejects a bad enum (category) → 422, writes nothing", async () => {
      const session = await setupSession("pro");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      const res = await goalsPOST(post({ ...validBody, category: "bogus" }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });

      expect(
        await db.select().from(goals).where(eq(goals.companyId, companyId)),
      ).toHaveLength(0);
    });

    it("rejects an empty title → 422", async () => {
      getSessionMock.mockResolvedValue(await setupSession("pro"));
      const res = await goalsPOST(post({ ...validBody, title: "  " }));
      expect(res.status).toBe(422);
    });

    it("unauthenticated → 401", async () => {
      getSessionMock.mockResolvedValue(null);
      const res = await goalsPOST(post(validBody));
      expect(res.status).toBe(401);
    });
  },
);
