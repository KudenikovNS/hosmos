// T2.1 integration tests — the member-management routes run against a REAL Postgres
// via the T-13 harness. Proves §13.3 + D9 + §4.3 + the audit contract (§Q6/§11.1):
//   • tenant isolation: GET lists ONLY the session company's members (no leak); a
//     PATCH/DELETE of a member of ANOTHER company → 403 (never a cross-tenant write);
//   • last-admin (D9): with ONE active esg_admin, demote/suspend/remove → 403; with
//     TWO active esg_admins all three are allowed;
//   • self-guard: an admin removing themselves or changing their own role → 403;
//   • audit: each successful mutation writes exactly ONE audit_log row
//     (entity='member', actor_role='esg_admin'); each refusal writes NONE;
//   • capability: a contributor on PATCH → 403 (no members.manage);
//   • order of checks: no session + garbage body → 401 (auth precedes validation).
//
// All scenarios run on a PAID company (`insertPaidCompany`) so 2+ members never hit
// the seat cap before the role logic (Q1). `getSession` is mocked so a test controls
// identity; `@/server/db` is mocked to the harness pool so route + service share one
// Postgres. `describeIntegration` self-skips with no DB — a green no-op in DB-less CI.
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

import { GET as membersGET } from "@/app/api/members/route";
import {
  DELETE as memberDELETE,
  PATCH as memberPATCH,
} from "@/app/api/members/[userId]/route";
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
import { auditLog, companyMembers } from "@/server/db/schema";
import type { DbCompany, DbSession } from "@/server/db/types";
import type { CompanyRole } from "@/shared/roles";
import { eq } from "drizzle-orm";

type Company = Awaited<ReturnType<typeof insertPaidCompany>>;

function dbCompany(company: Company): DbCompany {
  return {
    id: company.id,
    name: company.name,
    industry: "Manufacturing",
    nace_code: "C25",
    country: "Slovenia",
    country_code: "SI",
    headcount: 10,
    plan: company.plan ?? "starter",
    reporting_year: "2024",
    currency: "EUR",
  };
}

/** Build a DbSession for `userId` acting in `company` with `role`. */
function sessionFor(
  userId: string,
  email: string,
  name: string,
  company: Company,
  role: CompanyRole,
): DbSession {
  return {
    userId,
    email,
    name,
    company: dbCompany(company),
    membership: {
      companyId: company.id,
      role,
      status: "active",
      hasIndependentApprover: true,
      activeMemberCount: 1,
    },
  };
}

const patch = (userId: string, body: unknown) => ({
  req: new Request(`http://api.example.com/api/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any,
  ctx: { params: Promise.resolve({ userId }) },
});

const del = (userId: string) => ({
  req: new Request(`http://api.example.com/api/members/${userId}`, {
    method: "DELETE",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any,
  ctx: { params: Promise.resolve({ userId }) },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getReq = () => new Request("http://api.example.com/api/members") as any;

async function auditCount(companyId: string): Promise<number> {
  const rows = await getTestDb()
    .select()
    .from(auditLog)
    .where(eq(auditLog.companyId, companyId));
  return rows.length;
}

describeIntegration(
  "T2.1 /api/members (manage + last-admin guard + audit)",
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

    it("GET lists ONLY the session company's members (tenant isolation)", async () => {
      // Company A has its own member; company B's admin must never see them.
      const compA = await insertPaidCompany();
      await insertUserWithProfile({ companyId: compA.id, role: "esg_admin" });

      const compB = await insertPaidCompany();
      const { user: adminB } = await insertUserWithProfile({
        companyId: compB.id,
        role: "esg_admin",
      });
      const { user: memberB } = await insertUserWithProfile({});
      await insertMembership(compB.id, memberB.id, { role: "contributor" });

      getSessionMock.mockResolvedValue(
        sessionFor(adminB.id, adminB.email, adminB.name, compB, "esg_admin"),
      );

      const res = await membersGET(getReq());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      const ids = body.data.map((m: { userId: string }) => m.userId).sort();
      expect(ids).toEqual([adminB.id, memberB.id].sort());
    });

    it("GET returns active + suspended, but never removed members", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const { user: suspended } = await insertUserWithProfile({});
      await insertMembership(company.id, suspended.id, {
        role: "contributor",
        status: "suspended",
      });
      const { user: removed } = await insertUserWithProfile({});
      await insertMembership(company.id, removed.id, {
        role: "contributor",
        status: "removed",
      });

      getSessionMock.mockResolvedValue(
        sessionFor(admin.id, admin.email, admin.name, company, "esg_admin"),
      );

      const res = await membersGET(getReq());
      const body = await res.json();
      const ids = body.data.map((m: { userId: string }) => m.userId).sort();
      expect(ids).toEqual([admin.id, suspended.id].sort());
    });

    it("PATCH of a member of ANOTHER company → 403, no audit", async () => {
      const compA = await insertPaidCompany();
      const { user: memberA } = await insertUserWithProfile({
        companyId: compA.id,
        role: "contributor",
      });

      const compB = await insertPaidCompany();
      const { user: adminB } = await insertUserWithProfile({
        companyId: compB.id,
        role: "esg_admin",
      });

      getSessionMock.mockResolvedValue(
        sessionFor(adminB.id, adminB.email, adminB.name, compB, "esg_admin"),
      );

      const { req, ctx } = patch(memberA.id, { role: "reviewer" });
      const res = await memberPATCH(req, ctx);
      expect(res.status).toBe(403);
      expect(await auditCount(compB.id)).toBe(0);
      // A's member is untouched.
      const [row] = await getTestDb()
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.userId, memberA.id));
      expect(row.role).toBe("contributor");
    });

    it("DELETE of a member of ANOTHER company → 403, no audit", async () => {
      const compA = await insertPaidCompany();
      const { user: memberA } = await insertUserWithProfile({
        companyId: compA.id,
        role: "contributor",
      });

      const compB = await insertPaidCompany();
      const { user: adminB } = await insertUserWithProfile({
        companyId: compB.id,
        role: "esg_admin",
      });

      getSessionMock.mockResolvedValue(
        sessionFor(adminB.id, adminB.email, adminB.name, compB, "esg_admin"),
      );

      const { req, ctx } = del(memberA.id);
      const res = await memberDELETE(req, ctx);
      expect(res.status).toBe(403);
      expect(await auditCount(compB.id)).toBe(0);
      const [row] = await getTestDb()
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.userId, memberA.id));
      expect(row.status).toBe("active");
    });

    it("last admin (D9): with ONE active admin, demote/suspend/remove → 403, no audit", async () => {
      // One active esg_admin (the target) plus a SUSPENDED admin, proving a suspended
      // admin does NOT count as active and so cannot rescue the guard. The actor is a
      // different user WITH members.manage (its session role is esg_admin, independent
      // of DB status), so it is the last-admin rule — not the self rule — that fires.
      const company = await insertPaidCompany();
      const { user: soleAdmin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const { user: suspendedAdmin } = await insertUserWithProfile({});
      await insertMembership(company.id, suspendedAdmin.id, {
        role: "esg_admin",
        status: "suspended",
      });

      getSessionMock.mockResolvedValue(
        sessionFor(
          suspendedAdmin.id,
          suspendedAdmin.email,
          suspendedAdmin.name,
          company,
          "esg_admin",
        ),
      );

      const demote = patch(soleAdmin.id, { role: "contributor" });
      expect((await memberPATCH(demote.req, demote.ctx)).status).toBe(403);
      const suspend = patch(soleAdmin.id, { status: "suspended" });
      expect((await memberPATCH(suspend.req, suspend.ctx)).status).toBe(403);
      const remove = del(soleAdmin.id);
      expect((await memberDELETE(remove.req, remove.ctx)).status).toBe(403);

      expect(await auditCount(company.id)).toBe(0);
      // The sole admin is untouched.
      const [row] = await getTestDb()
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.userId, soleAdmin.id));
      expect(row.role).toBe("esg_admin");
      expect(row.status).toBe("active");
    });

    it("two active admins: demote / suspend / remove one is allowed, each audited", async () => {
      const company = await insertPaidCompany();
      const { user: admin1 } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const { user: admin2 } = await insertUserWithProfile({});
      await insertMembership(company.id, admin2.id, { role: "esg_admin" });

      getSessionMock.mockResolvedValue(
        sessionFor(admin1.id, admin1.email, admin1.name, company, "esg_admin"),
      );

      // Demote admin2 (admin1 remains) → allowed.
      const demote = patch(admin2.id, { role: "contributor" });
      const demoteRes = await memberPATCH(demote.req, demote.ctx);
      expect(demoteRes.status).toBe(200);
      let [row] = await getTestDb()
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.userId, admin2.id));
      expect(row.role).toBe("contributor");

      // Re-promote and suspend → allowed.
      const promote = patch(admin2.id, { role: "esg_admin" });
      expect((await memberPATCH(promote.req, promote.ctx)).status).toBe(200);
      const suspend = patch(admin2.id, { status: "suspended" });
      expect((await memberPATCH(suspend.req, suspend.ctx)).status).toBe(200);

      // Re-activate and remove → allowed, removed_at stamped.
      const reactivate = patch(admin2.id, { status: "active" });
      expect((await memberPATCH(reactivate.req, reactivate.ctx)).status).toBe(
        200,
      );
      const remove = del(admin2.id);
      expect((await memberDELETE(remove.req, remove.ctx)).status).toBe(200);
      [row] = await getTestDb()
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.userId, admin2.id));
      expect(row.status).toBe("removed");
      expect(row.removedAt).not.toBeNull();

      // Five successful mutations → five audit rows, all member/esg_admin.
      const audits = await getTestDb()
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, company.id));
      expect(audits).toHaveLength(5);
      for (const a of audits) {
        expect(a.entity).toBe("member");
        expect(a.actorRole).toBe("esg_admin");
        expect(a.userId).toBe(admin1.id);
      }
      expect(audits.filter((a) => a.action === "update")).toHaveLength(4);
      expect(audits.filter((a) => a.action === "delete")).toHaveLength(1);
    });

    it("self-guard: admin removing themselves → 403; changing own role → 403; no audit", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      // A second admin so the self-guard, not the last-admin rule, is what fires.
      const { user: admin2 } = await insertUserWithProfile({});
      await insertMembership(company.id, admin2.id, { role: "esg_admin" });

      getSessionMock.mockResolvedValue(
        sessionFor(admin.id, admin.email, admin.name, company, "esg_admin"),
      );

      const selfRole = patch(admin.id, { role: "contributor" });
      expect((await memberPATCH(selfRole.req, selfRole.ctx)).status).toBe(403);
      const selfDelete = del(admin.id);
      expect((await memberDELETE(selfDelete.req, selfDelete.ctx)).status).toBe(
        403,
      );

      expect(await auditCount(company.id)).toBe(0);
      // Still an active admin — nothing changed.
      const [row] = await getTestDb()
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.userId, admin.id));
      expect(row.role).toBe("esg_admin");
      expect(row.status).toBe("active");
    });

    it("a successful role change writes exactly one member/esg_admin audit row", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const { user: member } = await insertUserWithProfile({});
      await insertMembership(company.id, member.id, { role: "contributor" });

      getSessionMock.mockResolvedValue(
        sessionFor(admin.id, admin.email, admin.name, company, "esg_admin"),
      );

      const { req, ctx } = patch(member.id, { role: "reviewer" });
      const res = await memberPATCH(req, ctx);
      expect(res.status).toBe(200);
      const audits = await getTestDb()
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, company.id));
      expect(audits).toHaveLength(1);
      expect(audits[0].entity).toBe("member");
      expect(audits[0].action).toBe("update");
      expect(audits[0].actorRole).toBe("esg_admin");
    });

    it("contributor on PATCH → 403 (no members.manage), no audit", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const { user: contributor } = await insertUserWithProfile({});
      await insertMembership(company.id, contributor.id, {
        role: "contributor",
      });

      // Act AS the contributor.
      getSessionMock.mockResolvedValue(
        sessionFor(
          contributor.id,
          contributor.email,
          contributor.name,
          company,
          "contributor",
        ),
      );

      const { req, ctx } = patch(admin.id, { role: "reviewer" });
      const res = await memberPATCH(req, ctx);
      expect(res.status).toBe(403);
      expect(await auditCount(company.id)).toBe(0);
    });

    it("order of checks: no session + garbage body → 401 (auth precedes validation)", async () => {
      getSessionMock.mockResolvedValue(null);
      const { req, ctx } = patch("00000000-0000-0000-0000-000000000000", {
        role: "not-a-role",
        junk: true,
      });
      const res = await memberPATCH(req, ctx);
      expect(res.status).toBe(401);
    });

    it("PATCH with a garbage role (authenticated) → 422", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const { user: member } = await insertUserWithProfile({});
      await insertMembership(company.id, member.id, { role: "contributor" });

      getSessionMock.mockResolvedValue(
        sessionFor(admin.id, admin.email, admin.name, company, "esg_admin"),
      );

      const { req, ctx } = patch(member.id, { role: "sith_lord" });
      const res = await memberPATCH(req, ctx);
      expect(res.status).toBe(422);
      expect(await auditCount(company.id)).toBe(0);
    });
  },
);
