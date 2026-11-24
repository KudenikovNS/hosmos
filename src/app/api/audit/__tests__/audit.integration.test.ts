// T4.2a integration tests — the audit-trail READ route runs against a REAL
// Postgres via the T-13 harness. Proves the Data Sources "Activity Log" is
// served from the real `audit_log`, session-scoped and honest:
//   • unauthenticated → 401 UNAUTHENTICATED;
//   • rows come back newest-first, scoped to the SESSION company (a second
//     company's rows never leak — cross-tenant isolation on read);
//   • `limit` is clamped: 1000 → at most 100; 0 / "abc" / absent → default 20;
//   • userName/userEmail resolve from the joined profile, and a null-user row
//     (FK set-null) still returns without error (userName undefined).
//
// `getSession` is mocked so a test controls identity; `@/server/db` is mocked to
// the harness pool so route + service read the same Postgres the fixtures write.
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

import { GET as auditGET } from "@/app/api/audit/route";
import {
  DELETE as goalsDELETE,
  POST as goalsPOST,
} from "@/app/api/goals/route";
import { POST as supplyChainPOST } from "@/app/api/supply-chain/route";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { listAuditLog, logAudit } from "@/server/db/audit";
import { auditLog, companyMembers } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import type { DbCompany, DbMembership, DbSession } from "@/server/db/types";
import type { PlanId } from "@/shared/plans";
import type { CompanyRole } from "@/shared/roles";

/** Insert a company + a real user/profile, and build the DbSession. */
async function setupSession(): Promise<DbSession> {
  const company = await insertCompany({
    plan: "pro",
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
    // esg_admin membership that production getSession() always resolves (§8, §14.1);
    // esg_admin holds `audit.read`, so these read expectations stand unchanged.
    membership: {
      companyId: dbCompany.id,
      role: "esg_admin",
      status: "active",
      hasIndependentApprover: true,
      activeMemberCount: 1,
    },
  };
}

/** Insert one audit_log row with an explicit createdAt (to control ordering). */
async function insertAudit(row: {
  companyId: string;
  userId?: string | null;
  entity: string;
  action?: string;
  createdAt: Date;
  summary?: Record<string, unknown>;
}) {
  await getTestDb()
    .insert(auditLog)
    .values({
      companyId: row.companyId,
      userId: row.userId ?? null,
      entity: row.entity,
      action: row.action ?? "update",
      summary: row.summary ?? {},
      createdAt: row.createdAt,
    });
}

const get = (query = "") =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new Request(`http://api.example.com/api/audit${query}`) as any;

describeIntegration(
  "T4.2a /api/audit (session-guarded audit-trail read)",
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

    it("unauthenticated → 401 UNAUTHENTICATED", async () => {
      getSessionMock.mockResolvedValue(null);
      const res = await auditGET(get());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "UNAUTHENTICATED" });
    });

    it("returns the session company's rows newest-first, scoped (cross-tenant isolation)", async () => {
      const session = await setupSession();
      const companyId = session.company!.id;

      // Three rows for the session company, inserted out of chronological order.
      // `entity` is a free `text` column and these rows are written directly, not
      // through a route: 'people' stays on purpose after T3.8 deleted that feature,
      // because a journal outliving its subject is exactly what an audit trail does
      // (`AuditEntity` still lists it for the same reason).
      await insertAudit({
        companyId,
        userId: session.userId,
        entity: "people",
        action: "create",
        createdAt: new Date("2026-01-01T10:00:00Z"),
      });
      await insertAudit({
        companyId,
        userId: session.userId,
        entity: "goals",
        action: "update",
        createdAt: new Date("2026-03-01T10:00:00Z"),
      });
      await insertAudit({
        companyId,
        userId: session.userId,
        entity: "company",
        action: "update",
        createdAt: new Date("2026-02-01T10:00:00Z"),
      });

      // A SECOND company with its own row — must never appear on this session.
      const other = await setupSession();
      await insertAudit({
        companyId: other.company!.id,
        userId: other.userId,
        entity: "supply_chain",
        action: "create",
        createdAt: new Date("2026-04-01T10:00:00Z"),
      });

      getSessionMock.mockResolvedValue(session);
      const res = await auditGET(get());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Only the session company's 3 rows, newest first.
      expect(body.data).toHaveLength(3);
      expect(body.data.map((r: { entity: string }) => r.entity)).toEqual([
        "goals",
        "company",
        "people",
      ]);
      // The other company's supply_chain row did not leak.
      expect(
        body.data.some((r: { entity: string }) => r.entity === "supply_chain"),
      ).toBe(false);
    });

    it("clamps limit: 1000 → at most 100; 0 / abc / absent → default 20", async () => {
      const session = await setupSession();
      const companyId = session.company!.id;

      // Seed 105 rows so both the cap (100) and the default (20) are observable.
      const base = Date.parse("2026-01-01T00:00:00Z");
      for (let i = 0; i < 105; i++) {
        await insertAudit({
          companyId,
          userId: session.userId,
          entity: "goals",
          createdAt: new Date(base + i * 60_000),
        });
      }
      getSessionMock.mockResolvedValue(session);

      const capped = await (await auditGET(get("?limit=1000"))).json();
      expect(capped.data).toHaveLength(100); // clamped to MAX_LIMIT

      const zero = await (await auditGET(get("?limit=0"))).json();
      expect(zero.data).toHaveLength(20); // ≤ 0 → default

      const nan = await (await auditGET(get("?limit=abc"))).json();
      expect(nan.data).toHaveLength(20); // non-numeric → default

      const absent = await (await auditGET(get())).json();
      expect(absent.data).toHaveLength(20); // absent → default
    });

    it("resolves userName/userEmail from the profile; a null-user row still returns", async () => {
      const session = await setupSession();
      const companyId = session.company!.id;

      await insertAudit({
        companyId,
        userId: session.userId,
        entity: "people",
        action: "create",
        createdAt: new Date("2026-01-01T10:00:00Z"),
      });
      // A row whose user was removed (FK set null) — must still come back.
      await insertAudit({
        companyId,
        userId: null,
        entity: "company",
        action: "update",
        createdAt: new Date("2026-02-01T10:00:00Z"),
      });

      getSessionMock.mockResolvedValue(session);
      const body = await (await auditGET(get())).json();
      expect(body.data).toHaveLength(2);

      const [nullRow, userRow] = body.data as Array<{
        entity: string;
        userName?: string;
        userEmail?: string;
      }>;
      // newest first → the null-user 'company' row, then the 'people' row.
      expect(nullRow.entity).toBe("company");
      expect(nullRow.userName).toBeUndefined();
      expect(nullRow.userEmail).toBeUndefined();

      expect(userRow.entity).toBe("people");
      expect(userRow.userEmail).toBe(session.email);
    });
  },
);

// ─── T1.5: `actor_role` on every audit entry ─────────────────────────────────
// The audit row records the actor's company role AT THE TIME of the action — a
// SNAPSHOT taken from the session's active membership, not a foreign key. These
// cases prove: (1) the write helper and a representative sample of the mutation
// routes stamp the role; (2) a historical row with no role stays valid/null; (3)
// the KEY property — changing the user's role LATER does not rewrite the journal.

// T3.8: the "a mutation route stamps the actor role" cases used to POST to
// `/api/people`, which died with the wide-table stack. They are re-pointed onto
// `/api/supply-chain` — a surviving write route that logs one `audit_log` row per
// call in exactly the same way (`entity:'supply_chain'`, create). Nothing about
// the actor-role snapshot under test is people-specific; only the plan fixture
// moved from `starter` to `pro`, because `supplyChain` is a pro entitlement.

/** Supply-chain POST body (mirrors supply-chain.integration.test — a valid supplier). */
const supplyChainBody = {
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

/** Goals POST body (mirrors goals.integration.test — a valid goal). */
const goalsBody = {
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

const supplyChainPost = (body: unknown) =>
  new Request("http://api.example.com/api/supply-chain", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const goalsPost = (body: unknown) =>
  new Request("http://api.example.com/api/goals", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const goalsDel = (query = "") =>
  new Request(`http://api.example.com/api/goals${query}`, {
    method: "DELETE",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

/**
 * A company (on `plan`) + a member with `role`, and the DbSession whose active
 * `membership.role` the routes read for the audit snapshot. The `company_members`
 * row carries the same role, so the KEY test can mutate it independently.
 */
async function setupRoleSession(
  plan: PlanId,
  role: CompanyRole = "esg_admin",
): Promise<{ session: DbSession; companyId: string; userId: string }> {
  const company = await insertCompany({
    plan,
    countryCode: "SI",
    reportingYear: "2024",
  });
  const { user } = await insertUserWithProfile({ companyId: company.id, role });
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
  const membership: DbMembership = {
    companyId: company.id,
    role,
    status: "active",
    hasIndependentApprover: false,
    activeMemberCount: 1,
  };
  const session: DbSession = {
    userId: user.id,
    email: user.email,
    name: user.name,
    company: dbCompany,
    membership,
  };
  return { session, companyId: company.id, userId: user.id };
}

describeIntegration(
  "T1.5 audit_log.actor_role (role snapshot on write)",
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

    it("logAudit writes actorRole; listAuditLog returns it as a string", async () => {
      const { session, companyId, userId } = await setupRoleSession(
        "starter",
        "data_owner",
      );
      const db = getTestDb();

      await logAudit(db, {
        companyId,
        userId,
        actorRole: session.membership!.role,
        entity: "goals",
        action: "create",
        summary: { title: "x" },
      });

      const [row] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(row.actorRole).toBe("data_owner");

      const listed = await listAuditLog(db, companyId, 20);
      expect(listed).toHaveLength(1);
      expect(listed[0].actorRole).toBe("data_owner");
      expect(typeof listed[0].actorRole).toBe("string");
    });

    it("a historical row written WITHOUT actor_role stays valid and reads as null", async () => {
      const { companyId, userId } = await setupRoleSession("starter");
      const db = getTestDb();

      // insertAudit never sets actor_role — the pre-T1.5 shape.
      await insertAudit({
        companyId,
        userId,
        entity: "company",
        action: "update",
        createdAt: new Date("2026-01-01T10:00:00Z"),
      });

      const [row] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(row.actorRole).toBeNull();

      const listed = await listAuditLog(db, companyId, 20);
      expect(listed[0].actorRole).toBeNull();
    });

    it("POST /api/supply-chain stamps the actor role from the session (esg_admin)", async () => {
      const { session, companyId } = await setupRoleSession("pro", "esg_admin");
      getSessionMock.mockResolvedValue(session);
      const db = getTestDb();

      const res = await supplyChainPOST(supplyChainPost(supplyChainBody));
      expect(res.status).toBe(200);

      const [row] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(row.entity).toBe("supply_chain");
      expect(row.actorRole).toBe("esg_admin");
    });

    it("POST + DELETE /api/goals both stamp the actor role (create & delete paths)", async () => {
      const { session, companyId } = await setupRoleSession("pro", "esg_admin");
      getSessionMock.mockResolvedValue(session);
      const db = getTestDb();

      const created = await goalsPOST(goalsPost(goalsBody));
      expect(created.status).toBe(200);
      const goalId = (await created.json()).data.id as string;

      const deleted = await goalsDELETE(goalsDel(`?id=${goalId}`));
      expect(deleted.status).toBe(200);

      const rows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(rows.map((r) => r.action).sort()).toEqual(["create", "delete"]);
      expect(rows.every((r) => r.actorRole === "esg_admin")).toBe(true);
    });

    it("KEY: changing the user's role AFTER the action leaves the snapshot unchanged", async () => {
      const { session, companyId, userId } = await setupRoleSession(
        "pro",
        "esg_admin",
      );
      getSessionMock.mockResolvedValue(session);
      const db = getTestDb();

      // 1. Mutate → one audit row, actor_role captured as 'esg_admin'.
      await supplyChainPOST(supplyChainPost(supplyChainBody));
      const [before] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(before.actorRole).toBe("esg_admin");
      const rowId = before.id;

      // 2. The user is DEMOTED in company_members — the live membership changes.
      await db
        .update(companyMembers)
        .set({ role: "auditor" })
        .where(eq(companyMembers.userId, userId));
      const [member] = await db
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.userId, userId));
      expect(member.role).toBe("auditor"); // the role really moved

      // 3. Re-read the SAME audit row → still the snapshot, NOT the new live role.
      const [after] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.id, rowId));
      expect(after.actorRole).toBe("esg_admin"); // a snapshot, not an FK

      const listed = await listAuditLog(db, companyId, 20);
      expect(listed.find((r) => r.id === rowId)!.actorRole).toBe("esg_admin");
    });
  },
);
