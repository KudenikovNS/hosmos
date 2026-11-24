// [LOCAL-DB] Membership resolver + company-switch service (USERS-ROLES T1.2a).
//
// Proves the D10 resolver (§8.2) end-to-end against a real Postgres BEFORE any
// consumer (getSession/routes) switches onto it. Covers all six §8.2 edge cases,
// the two aggregate member counters, and the ≤3-query resolve budget. Gated by
// `describeIntegration`, so it is a green no-op when Postgres is unreachable.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import type { CompanyRole } from "@/shared/roles";

import {
  countMembers,
  listMemberships,
  resolveActiveMembership,
  switchCompany,
} from "../members";
import { companies, companyMembers, profiles } from "../schema";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertMembership,
  insertPaidCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "./harness";

// ─── Query-counting proxy — the resolve budget guard (§8.3, ≤3) ───────────────
// Wraps a Drizzle handle and counts every query-initiating call (select/update/
// insert/delete/execute). The resolver receives the proxy, so the test can assert
// exactly how many round-trips a resolve costs (and that the self-heal UPDATE did
// NOT run on the already-synced path).
function countingDb(base: ReturnType<typeof getTestDb>) {
  let queries = 0;
  const tracked = new Set(["select", "update", "insert", "delete", "execute"]);
  const proxy = new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        tracked.has(prop) &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          queries += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { db: proxy, queries: () => queries };
}

/** Insert a membership with an explicit `created_at`, the D10 tie-breaker. */
async function memberAt(
  companyId: string,
  userId: string,
  createdAt: Date,
  opts: {
    role?: CompanyRole;
    status?: "active" | "suspended" | "removed";
  } = {},
) {
  const db = getTestDb();
  const [row] = await db
    .insert(companyMembers)
    .values({
      companyId,
      userId,
      role: opts.role ?? "contributor",
      status: opts.status ?? "active",
      acceptedAt: new Date(),
      createdAt,
    })
    .returning();
  return row;
}

async function readProfile(userId: string) {
  const db = getTestDb();
  const [row] = await db
    .select({
      companyId: profiles.companyId,
      activeCompanyId: profiles.activeCompanyId,
      updatedAt: profiles.updatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return row;
}

describeIntegration("T1.2a — membership resolver & switch service", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  // ── §8.2 case 5: valid active_company_id → chosen, NO self-heal write ───────
  it("valid active_company_id is chosen and does NOT trigger a self-heal UPDATE", async () => {
    const co = await insertPaidCompany({ name: "Alpha" });
    const { user } = await insertUserWithProfile({
      companyId: co.id,
      role: "esg_admin",
    });

    const before = await readProfile(user.id);
    const { db, queries } = countingDb(getTestDb());
    const resolved = await resolveActiveMembership(db, user.id);
    const after = await readProfile(user.id);

    expect(resolved).toEqual({
      companyId: co.id,
      companyName: "Alpha",
      role: "esg_admin",
      status: "active",
    });
    // Budget: profile + memberships only — no UPDATE on the synced path.
    expect(queries()).toBe(2);
    // Proof the self-heal did NOT fire: updated_at unchanged, columns intact.
    expect(after.updatedAt?.getTime()).toBe(before.updatedAt?.getTime());
    expect(after.activeCompanyId).toBe(co.id);
    expect(after.companyId).toBe(co.id);
  });

  // ── §8.2 case 1: stale active_company_id → first active + heal writes both ──
  it("invalid active_company_id resolves to the first active membership and heals both columns", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const ghost = await insertPaidCompany({ name: "Ghost" }); // no membership here
    const { user } = await insertUserWithProfile({
      companyId: alpha.id,
      role: "contributor",
    });
    // Point the profile at a company the user is NOT an active member of.
    await getTestDb()
      .update(profiles)
      .set({ activeCompanyId: ghost.id })
      .where(eq(profiles.id, user.id));

    const { db, queries } = countingDb(getTestDb());
    const resolved = await resolveActiveMembership(db, user.id);
    const after = await readProfile(user.id);

    expect(resolved?.companyId).toBe(alpha.id);
    // Budget: profile + memberships + the self-heal UPDATE.
    expect(queries()).toBe(3);
    // Self-heal wrote BOTH columns to the resolved company (D11).
    expect(after.activeCompanyId).toBe(alpha.id);
    expect(after.companyId).toBe(alpha.id);
  });

  // ── §8.2 case 3: suspended membership is skipped, next active is taken ──────
  it("skips a suspended membership and resolves the next active one", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const beta = await insertPaidCompany({ name: "Beta" });
    const { user } = await insertUserWithProfile(); // no company yet
    // Older membership is SUSPENDED, newer one is ACTIVE.
    await memberAt(alpha.id, user.id, new Date("2024-01-01T00:00:00Z"), {
      role: "esg_admin",
      status: "suspended",
    });
    await memberAt(beta.id, user.id, new Date("2024-02-01T00:00:00Z"), {
      role: "contributor",
      status: "active",
    });
    // active_company_id points at the SUSPENDED company.
    await getTestDb()
      .update(profiles)
      .set({ activeCompanyId: alpha.id })
      .where(eq(profiles.id, user.id));

    const resolved = await resolveActiveMembership(getTestDb(), user.id);

    expect(resolved?.companyId).toBe(beta.id); // suspended alpha skipped
    const after = await readProfile(user.id);
    expect(after.activeCompanyId).toBe(beta.id); // healed to the active one
    expect(after.companyId).toBe(beta.id);
  });

  // ── §8.2 case 4: no active memberships → null ──────────────────────────────
  it("returns null when the user has no active membership", async () => {
    const { user } = await insertUserWithProfile(); // profile, no company

    const resolved = await resolveActiveMembership(getTestDb(), user.id);
    expect(resolved).toBeNull();
  });

  it("returns null when the user has no profile at all", async () => {
    const resolved = await resolveActiveMembership(
      getTestDb(),
      "00000000-0000-0000-0000-000000000000",
    );
    expect(resolved).toBeNull();
  });

  // ── §8.2 case 2: company deleted → SET NULL + membership cascade → next ─────
  it("resolves the next active company after the active one is deleted (SET NULL + cascade)", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const beta = await insertPaidCompany({ name: "Beta" });
    const { user } = await insertUserWithProfile({
      companyId: alpha.id,
      role: "esg_admin",
    });
    await memberAt(beta.id, user.id, new Date("2024-03-01T00:00:00Z"), {
      role: "contributor",
      status: "active",
    });

    // Delete Alpha: ON DELETE CASCADE removes its membership, SET NULL clears the
    // profile's active_company_id / company_id (both pointed at Alpha).
    await getTestDb().delete(companies).where(eq(companies.id, alpha.id));

    const afterDelete = await readProfile(user.id);
    expect(afterDelete.activeCompanyId).toBeNull(); // SET NULL fired

    const resolved = await resolveActiveMembership(getTestDb(), user.id);
    expect(resolved?.companyId).toBe(beta.id); // next active membership

    const healed = await readProfile(user.id);
    expect(healed.activeCompanyId).toBe(beta.id);
    expect(healed.companyId).toBe(beta.id);
  });

  // ── §8.2 case 6: two active memberships → stable choice across calls ────────
  it("makes a stable choice across repeated resolves with two active memberships", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const beta = await insertPaidCompany({ name: "Beta" });
    const { user } = await insertUserWithProfile({
      companyId: alpha.id,
      role: "esg_admin",
    });
    await memberAt(beta.id, user.id, new Date("2024-04-01T00:00:00Z"), {
      role: "approver",
      status: "active",
    });
    // Valid pointer at Beta — the non-first membership.
    await getTestDb()
      .update(profiles)
      .set({ activeCompanyId: beta.id })
      .where(eq(profiles.id, user.id));

    const first = await resolveActiveMembership(getTestDb(), user.id);
    const second = await resolveActiveMembership(getTestDb(), user.id);
    const third = await resolveActiveMembership(getTestDb(), user.id);

    expect(first?.companyId).toBe(beta.id);
    expect(second?.companyId).toBe(beta.id);
    expect(third?.companyId).toBe(beta.id);
  });

  // ── countMembers — aggregate approvers/members counters ────────────────────
  it("counts approvers=0, members=2 for esg_admin + contributor; approver bumps approvers", async () => {
    const co = await insertPaidCompany();
    await insertUserWithProfile({ companyId: co.id, role: "esg_admin" });
    const { user: contrib } = await insertUserWithProfile();
    await insertMembership(co.id, contrib.id, { role: "contributor" });

    expect(await countMembers(getTestDb(), co.id)).toEqual({
      approvers: 0,
      members: 2,
    });

    // Add an ACTIVE approver → approvers becomes 1.
    const { user: appr } = await insertUserWithProfile();
    await insertMembership(co.id, appr.id, { role: "approver" });
    expect(await countMembers(getTestDb(), co.id)).toEqual({
      approvers: 1,
      members: 3,
    });

    // A SUSPENDED approver is counted in NEITHER tally.
    const { user: susp } = await insertUserWithProfile();
    await insertMembership(co.id, susp.id, {
      role: "approver",
      status: "suspended",
    });
    expect(await countMembers(getTestDb(), co.id)).toEqual({
      approvers: 1,
      members: 3,
    });
  });

  // ── listMemberships — active memberships joined with company name ──────────
  it("lists active memberships with company name, oldest first", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const beta = await insertPaidCompany({ name: "Beta" });
    const { user } = await insertUserWithProfile();
    await memberAt(alpha.id, user.id, new Date("2024-01-01T00:00:00Z"), {
      role: "esg_admin",
    });
    await memberAt(beta.id, user.id, new Date("2024-02-01T00:00:00Z"), {
      role: "approver",
    });
    // A removed membership must not appear.
    const gamma = await insertPaidCompany({ name: "Gamma" });
    await memberAt(gamma.id, user.id, new Date("2024-03-01T00:00:00Z"), {
      status: "removed",
    });

    const list = await listMemberships(getTestDb(), user.id);
    expect(list).toEqual([
      { companyId: alpha.id, companyName: "Alpha", role: "esg_admin" },
      { companyId: beta.id, companyName: "Beta", role: "approver" },
    ]);
  });

  // ── switchCompany — R8 single writer; refusal is null ──────────────────────
  it("switchCompany writes both columns for a valid target and refuses (null) otherwise", async () => {
    const alpha = await insertPaidCompany({ name: "Alpha" });
    const beta = await insertPaidCompany({ name: "Beta" });
    const other = await insertPaidCompany({ name: "Other" }); // no membership
    const { user } = await insertUserWithProfile({
      companyId: alpha.id,
      role: "esg_admin",
    });
    await insertMembership(beta.id, user.id, { role: "contributor" });

    // Valid switch → both columns updated, resolved membership returned.
    const ok = await switchCompany(getTestDb(), user.id, beta.id);
    expect(ok).toEqual({
      companyId: beta.id,
      companyName: "Beta",
      role: "contributor",
      status: "active",
    });
    const afterOk = await readProfile(user.id);
    expect(afterOk.activeCompanyId).toBe(beta.id);
    expect(afterOk.companyId).toBe(beta.id);

    // No active membership in `other` → refusal, no write.
    const refused = await switchCompany(getTestDb(), user.id, other.id);
    expect(refused).toBeNull();
    const afterRefuse = await readProfile(user.id);
    expect(afterRefuse.activeCompanyId).toBe(beta.id); // unchanged
    expect(afterRefuse.companyId).toBe(beta.id);

    // A suspended membership is not switchable either.
    const gamma = await insertPaidCompany({ name: "Gamma" });
    await insertMembership(gamma.id, user.id, { status: "suspended" });
    expect(await switchCompany(getTestDb(), user.id, gamma.id)).toBeNull();
  });
});
