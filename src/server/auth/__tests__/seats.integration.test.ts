// [LOCAL-DB] T2.2 — seat usage, the seat guard, and downgrade side-effects (§10).
//
// What this pins:
//   • getSeatUsage(db, companyId) = (active ∪ suspended members) + (LIVE invites).
//     `suspended` HOLDS a seat, `removed` does not; a live invitation holds a seat,
//     an EXPIRED one does not. This is the [review T0.1] rule: the count is NOT
//     narrowed to status='active' (that would undercount and reopen suspend→invite).
//   • requireSeat(db, session) reuses requireWithinLimit → PLAN_REQUIRED (402) at
//     the limit. The Q1 case (trial: maxTeamMembers=1) denies at ONE member — the
//     product decision that team work is paid, pinned as SOLVED, not a bug.
//   • A live invitation consumes a seat: at the limit the next add is 402; revoking
//     the invitation frees the seat.
//   • Downgrade below the member count NEVER evicts people: the company_members
//     snapshot is byte-identical before/after; pending invitations are revoked;
//     the session reports seats.overLimit; exactly one audit row is written.
//
// `getSession` is mocked so a test controls the identity; `@/server/db` is mocked to
// the harness pool so the routes/guards read the SAME Postgres the fixtures write.
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

import { POST as planPOST } from "@/app/api/company/plan/route";
import { GET as sessionGET } from "@/app/api/session/route";
import {
  getSeatUsage,
  requireSeat,
  revokePendingInvitations,
} from "@/server/auth/seats";
import { resolveSessionContext } from "@/server/auth/session";
import { resetPlanFeaturesCache } from "@/server/billing/entitlements";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertInvitation,
  insertMembership,
  insertPaidCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  companyInvitations,
  companyMembers,
  plans,
} from "@/server/db/schema";

/** A bare GET/OPTIONS request (the session route reads only headers). */
const request = (path: string) =>
  new Request(`http://api.example.com${path}`) as unknown as Parameters<
    typeof sessionGET
  >[0];

/** A JSON POST (the plan route reads req.json()). */
const jsonRequest = (path: string, body: unknown) =>
  new Request(`http://api.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof planPOST>[0];

/** The session getSession() would resolve for a user, built off the harness pool. */
async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

/** Snapshot every company_members row for a company, ordered, for equality checks. */
async function memberSnapshot(companyId: string) {
  const rows = await getTestDb()
    .select()
    .from(companyMembers)
    .where(eq(companyMembers.companyId, companyId));
  return rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
}

describeIntegration("T2.2 seats — usage, guard, downgrade", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
    resetPlanFeaturesCache();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  // ─── getSeatUsage: exactly what holds a seat (§10.1, [review T0.1]) ──────────
  it("counts active ∪ suspended members + live invitations; excludes removed and expired", async () => {
    const company = await insertPaidCompany(); // starter, maxTeamMembers=5
    const active = await insertUserWithProfile();
    const suspended = await insertUserWithProfile();
    const removed = await insertUserWithProfile();
    await insertMembership(company.id, active.user.id, { status: "active" });
    await insertMembership(company.id, suspended.user.id, {
      status: "suspended",
    });
    await insertMembership(company.id, removed.user.id, { status: "removed" });

    // one LIVE invitation (default expiry now+7d) and one already EXPIRED
    await insertInvitation(company.id, { email: "live@example.com" });
    await insertInvitation(company.id, {
      email: "old@example.com",
      expiresAt: new Date(Date.now() - 60_000),
    });

    // active + suspended (2) + live invite (1) = 3. removed and expired don't count.
    expect(await getSeatUsage(getTestDb(), company.id)).toBe(3);
  });

  it("revokePendingInvitations frees the seats those invitations held", async () => {
    const company = await insertPaidCompany();
    await insertInvitation(company.id, { email: "a@example.com" });
    await insertInvitation(company.id, { email: "b@example.com" });
    expect(await getSeatUsage(getTestDb(), company.id)).toBe(2);

    const revoked = await revokePendingInvitations(getTestDb(), company.id);
    expect(revoked).toBe(2);
    expect(await getSeatUsage(getTestDb(), company.id)).toBe(0);
  });

  // ─── Q1: trial (maxTeamMembers=1) denies at ONE member — SOLVED, not a bug ───
  it("Q1: on a trial company one member already exhausts the seat → PLAN_REQUIRED", async () => {
    const company = await insertCompany({ plan: "trial" }); // maxTeamMembers=1
    const owner = await insertUserWithProfile({ companyId: company.id }); // 1 active member
    const session = await sessionFor(owner.user.id);

    expect(await getSeatUsage(getTestDb(), company.id)).toBe(1);
    expect(await requireSeat(getTestDb(), session)).toEqual({
      ok: false,
      error: "PLAN_REQUIRED",
    });
  });

  // ─── A live invitation holds a seat up to the limit; revoke frees it ─────────
  // No plan has maxTeamMembers=2, so we set an effective limit of 2 on the plan
  // catalogue for this one scenario (restored in finally) — the mechanism itself
  // is limit-agnostic; this pins the exact "1 member, 1st invite ok, 2nd → 402".
  it("at the limit a live invitation blocks the next add; revoking it frees the seat", async () => {
    const company = await insertCompany({ plan: "starter" });
    const owner = await insertUserWithProfile({ companyId: company.id }); // 1 member
    const session = await sessionFor(owner.user.id);

    const [row] = await getTestDb()
      .select()
      .from(plans)
      .where(eq(plans.id, "starter"));
    const originalFeatures = row.features;
    try {
      await getTestDb()
        .update(plans)
        .set({ features: { ...originalFeatures, maxTeamMembers: 2 } })
        .where(eq(plans.id, "starter"));
      resetPlanFeaturesCache();

      // 1 member, limit 2 → room for one more: the 1st invitation is allowed.
      expect(await requireSeat(getTestDb(), session)).toBeNull();
      await insertInvitation(company.id, { email: "first@example.com" });

      // 1 member + 1 live invite = 2 = limit → the 2nd add is denied (402).
      expect(await getSeatUsage(getTestDb(), company.id)).toBe(2);
      expect(await requireSeat(getTestDb(), session)).toEqual({
        ok: false,
        error: "PLAN_REQUIRED",
      });

      // Revoking the invitation frees its seat → adding is allowed again.
      await revokePendingInvitations(getTestDb(), company.id);
      expect(await requireSeat(getTestDb(), session)).toBeNull();
    } finally {
      await getTestDb()
        .update(plans)
        .set({ features: originalFeatures })
        .where(eq(plans.id, "starter"));
      resetPlanFeaturesCache();
    }
  });

  // ─── Downgrade below the member count: nobody is evicted (§10.3) ─────────────
  it("POST /api/company/plan downgrade over-seat: memberships untouched, invites revoked, over-seat, one audit row", async () => {
    const company = await insertPaidCompany(); // starter (5)
    // Owner + two more active members = 3 members (> trial's limit of 1).
    const owner = await insertUserWithProfile({ companyId: company.id });
    const m2 = await insertUserWithProfile();
    const m3 = await insertUserWithProfile();
    await insertMembership(company.id, m2.user.id, { status: "active" });
    await insertMembership(company.id, m3.user.id, { status: "suspended" });
    await insertInvitation(company.id, { email: "pending@example.com" });

    const session = await sessionFor(owner.user.id);
    getSessionMock.mockResolvedValue(session);

    const before = await memberSnapshot(company.id);

    const res = await planPOST(
      jsonRequest("/api/company/plan", { plan: "trial" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { plan: "trial" } });

    // 1. NOT ONE membership deleted or changed — byte-identical snapshot.
    expect(await memberSnapshot(company.id)).toEqual(before);

    // 2. Every live invitation revoked.
    const invites = await getTestDb()
      .select()
      .from(companyInvitations)
      .where(eq(companyInvitations.companyId, company.id));
    expect(invites.length).toBe(1);
    expect(invites[0].revokedAt).not.toBeNull();

    // 3. The session reports the over-seat state (limit 1, 3 members).
    getSessionMock.mockResolvedValue(await sessionFor(owner.user.id));
    const sessionRes = await sessionGET(request("/api/session"));
    const body = (await sessionRes.json()) as {
      seats: { used: number; limit: number; overLimit: boolean };
    };
    expect(body.seats.limit).toBe(1);
    expect(body.seats.used).toBe(3);
    expect(body.seats.overLimit).toBe(true);

    // 4. Exactly one company audit row recording the downgrade.
    const audit = await getTestDb()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.companyId, company.id), eq(auditLog.entity, "company")),
      );
    expect(audit.length).toBe(1);
    const summary = audit[0].summary as Record<string, unknown>;
    expect(summary.plan_downgrade).toBe(true);
    expect(summary.invitations_revoked).toBe(1);
    expect(audit[0].actorRole).toBe("esg_admin");
  });
});
