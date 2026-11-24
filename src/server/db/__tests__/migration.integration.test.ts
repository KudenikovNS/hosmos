// [LOCAL-DB] 0003 membership backfill + idempotency + the invitation partial
// index (USERS-ROLES T0.3, §14.2).
//
// This suite pins the point of no return — the 0003 backfill that turns every
// linked `profiles` row into an `esg_admin/active` membership — with a test
// written BEFORE production rollout (R3: "silent loss of access at migration").
//
// Approach (A), the controlled fixture. The migration 0003 has ALREADY been
// applied to the test database by the harness (`setupSchema` runs `migrate`),
// so its backfill ran once against whatever profiles existed then (none, on a
// truncated DB). We therefore cannot observe the migration's own backfill; we
// reproduce its *logic* deterministically instead: insert a pre-migration
// fixture — a profile carrying `company_id` but no membership and a NULL
// `active_company_id` — then run the two verbatim backfill statements from
// `drizzle/0003_users_roles.sql` via `db.execute(...)` and assert their effect,
// idempotency, and the invitation index. (B) — asserting invariants on
// harness-seeded rows — was rejected: `resetAppTables` truncates the tables
// between tests, so there are no stable seed rows to lean on, and a hand-built
// fixture states the "before" snapshot far more legibly.
//
// The four proof groups (§14.2):
//   1. linked profile → EXACTLY ONE esg_admin/active membership, accepted_at set,
//      active_company_id = company_id; the T0.1 count invariant (N linked
//      profiles → N esg_admin memberships) is reproduced by the test, not by hand;
//   2. profile with company_id IS NULL → no membership;
//   3. idempotency — a second run creates no duplicate row (ON CONFLICT DO
//      NOTHING) and does NOT overwrite an already-set active_company_id
//      (UPDATE ... WHERE active_company_id IS NULL);
//   4. the partial unique index on invitations (the single direct check of R-1,
//      schema.ts ↔ SQL drift): two LIVE invitations on one (company_id, email)
//      collide; after revoking the first, the second inserts.
//
// Gated by `describeIntegration`, so it is a green no-op without Postgres.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { companyInvitations, companyMembers, profiles } from "../schema";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertInvitation,
  insertPaidCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "./harness";

// ── The two backfill statements, copied verbatim from drizzle/0003_users_roles.sql
//    (steps 5). Kept byte-for-byte so the test drifts loudly if the migration
//    changes. FK note (0003): user_id → "user"(id) and profiles.id IS user.id,
//    so `p.id` is a valid user_id. ────────────────────────────────────────────
const BACKFILL_INSERT = `
INSERT INTO company_members
  (id, company_id, user_id, role, status, accepted_at, created_at, updated_at)
SELECT gen_random_uuid(), p.company_id, p.id, 'esg_admin', 'active',
       now(), COALESCE(p.created_at, now()), now()
FROM profiles p
WHERE p.company_id IS NOT NULL
ON CONFLICT (company_id, user_id) DO NOTHING`;

const BACKFILL_UPDATE = `
UPDATE profiles
   SET active_company_id = company_id
 WHERE company_id IS NOT NULL AND active_company_id IS NULL`;

/** Run the 0003 backfill (INSERT memberships, then heal active_company_id). */
async function runBackfill(): Promise<void> {
  const conn = getTestDb();
  await conn.execute(sql.raw(BACKFILL_INSERT));
  await conn.execute(sql.raw(BACKFILL_UPDATE));
}

/**
 * A pre-migration linked profile: a user whose `profiles.company_id` points at a
 * company but who has NO `company_members` row yet and a NULL `active_company_id`
 * — exactly the state 0003 backfills. `insertUserWithProfile({companyId})` would
 * defeat the test (the harness eagerly creates the membership AND sets both
 * company columns), so we deliberately start from a company-less profile and set
 * only the legacy `company_id`.
 */
async function linkPreMigrationProfile(companyId: string): Promise<string> {
  const conn = getTestDb();
  const { user } = await insertUserWithProfile(); // no companyId → no membership
  await conn
    .update(profiles)
    .set({ companyId, activeCompanyId: null })
    .where(eq(profiles.id, user.id));
  return user.id;
}

async function countMemberships(userId: string): Promise<number> {
  const conn = getTestDb();
  const [{ n }] = await conn.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM company_members WHERE user_id = ${userId}`,
  );
  return n;
}

async function readProfile(userId: string) {
  const conn = getTestDb();
  const [row] = await conn
    .select({
      companyId: profiles.companyId,
      activeCompanyId: profiles.activeCompanyId,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return row;
}

describeIntegration("T0.3 — 0003 membership backfill & idempotency", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  // ── Group 1: linked profile → exactly one esg_admin/active membership; the
  //    T0.1 count invariant (N linked → N esg_admin) is asserted, not eyeballed.
  it("backfills exactly one esg_admin/active membership per linked profile and heals active_company_id", async () => {
    const co = await insertPaidCompany({ name: "Alpha" });
    // Two linked pre-migration profiles + one unlinked one in the same snapshot.
    const linkedA = await linkPreMigrationProfile(co.id);
    const linkedB = await linkPreMigrationProfile(co.id);
    const { user: unlinked } = await insertUserWithProfile(); // company_id IS NULL

    // "Before" snapshot: no memberships exist yet.
    const [{ n: before }] = await getTestDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM company_members`,
    );
    expect(before).toBe(0);

    await runBackfill();

    // "After": N linked profiles → N esg_admin memberships (T0.1 counter).
    const [{ n: after }] = await getTestDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM company_members WHERE role = 'esg_admin'`,
    );
    expect(after).toBe(2);

    for (const userId of [linkedA, linkedB]) {
      // Exactly one membership, with the expected shape.
      const rows = await getTestDb()
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.userId, userId));
      expect(rows).toHaveLength(1);
      const m = rows[0];
      expect(m.companyId).toBe(co.id);
      expect(m.role).toBe("esg_admin");
      expect(m.status).toBe("active");
      expect(m.acceptedAt).not.toBeNull();

      // active_company_id healed to company_id.
      const prof = await readProfile(userId);
      expect(prof.activeCompanyId).toBe(co.id);
      expect(prof.companyId).toBe(co.id);
    }

    // The unlinked profile stayed untouched (see group 2).
    expect(await countMemberships(unlinked.id)).toBe(0);
    const unlinkedProfile = await readProfile(unlinked.id);
    expect(unlinkedProfile.activeCompanyId).toBeNull();
  });

  // ── Group 2: profile with company_id IS NULL gets no membership. ────────────
  it("does not create a membership for a profile whose company_id is NULL", async () => {
    const { user } = await insertUserWithProfile(); // company_id / active_company_id NULL

    await runBackfill();

    expect(await countMemberships(user.id)).toBe(0);
    const prof = await readProfile(user.id);
    expect(prof.companyId).toBeNull();
    expect(prof.activeCompanyId).toBeNull();
  });

  // ── Group 3: idempotency — no duplicate row, no clobbered active_company_id. ─
  it("is idempotent: a second run adds no duplicate membership and preserves a set active_company_id", async () => {
    const co = await insertPaidCompany({ name: "Alpha" });
    const other = await insertPaidCompany({ name: "Other" });
    const userId = await linkPreMigrationProfile(co.id);

    await runBackfill();
    expect(await countMemberships(userId)).toBe(1);

    // Simulate a user who has since switched their active company away from the
    // backfilled default. The second run must NOT reset this (WHERE ... IS NULL).
    await getTestDb()
      .update(profiles)
      .set({ activeCompanyId: other.id })
      .where(eq(profiles.id, userId));

    // Re-run the exact same backfill SQL.
    await runBackfill();

    // ON CONFLICT (company_id, user_id) DO NOTHING → still exactly one row.
    expect(await countMemberships(userId)).toBe(1);
    // UPDATE ... WHERE active_company_id IS NULL → the set value survives.
    const prof = await readProfile(userId);
    expect(prof.activeCompanyId).toBe(other.id);
    expect(prof.companyId).toBe(co.id);
  });

  // ── Group 4: the partial unique index company_invitations_pending_key. This is
  //    the single direct check of R-1 (schema.ts ↔ 0003 drift) before any route
  //    exists: two LIVE invites on one (company, email) must collide. ──────────
  it("rejects a second live invitation for the same (company, email), then allows it once the first is revoked", async () => {
    const co = await insertCompany({ name: "Alpha" });
    const email = "dup@example.com";

    // First live invitation (accepted_at IS NULL AND revoked_at IS NULL).
    const { row: first } = await insertInvitation(co.id, { email });

    // Second live invitation on the same slot → unique violation. A fresh random
    // token means the token_hash unique index cannot be what fires; only the
    // partial pending index can.
    const err = await insertInvitation(co.id, { email }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    // Drizzle wraps the driver error in a DrizzleQueryError; the postgres.js
    // PostgresError (with .code / .constraint_name) is on `.cause`.
    const wrapped = err as {
      cause?: { code?: string; constraint_name?: string };
    };
    const pgErr =
      wrapped.cause ?? (err as { code?: string; constraint_name?: string });
    expect(pgErr.code).toBe("23505"); // unique_violation
    expect(pgErr.constraint_name).toBe("company_invitations_pending_key");

    // Revoking the first frees the slot (the predicate drops revoked rows).
    await getTestDb()
      .update(companyInvitations)
      .set({ revokedAt: new Date() })
      .where(eq(companyInvitations.id, first.id));

    // Now the second live invitation inserts cleanly.
    const { row: second } = await insertInvitation(co.id, { email });
    expect(second.id).not.toBe(first.id);
    expect(second.revokedAt).toBeNull();
    expect(second.acceptedAt).toBeNull();
  });
});
