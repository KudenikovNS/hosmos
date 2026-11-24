// [LOCAL-DB] getSession() active-company enrichment (USERS-ROLES T1.2b, §8.2).
//
// Proves the T1.2b cut-over end-to-end against a real Postgres: the session now
// sources its company from the D10 resolver (not `profiles.company_id`) and gains
// `membership` / `capabilities` / `memberships`. The identity half of getSession
// (better-auth `auth.api.getSession`) is untouched and untested here — this suite
// exercises the pure `resolveSessionContext(client, userId)` helper against the
// shared harness, exactly as the T1.2a resolver suite does with `db` as an arg.
//
// `getSession` (the module) is `server-only`; the marker package throws at import
// under vitest, so it is stubbed to an empty module. The resolver helpers imported
// transitively (`@/server/db`, `@/server/auth`) are lazy at import time, so no
// database connection is opened by loading the module — the helper is driven with
// the harness `getTestDb()` client instead.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveSessionContext } from "../session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertPaidCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";

describeIntegration("T1.2b — getSession active-company enrichment", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  // ── An "old-style" user (profile.company_id + a backfill/harness membership) ──
  // resolves the SAME company id as before, an esg_admin membership, and — with no
  // independent approver in the company — the D13 compensating `data.approve` grant.
  it("resolves the same company + esg_admin membership + compensating data.approve grant", async () => {
    const co = await insertPaidCompany({ name: "Alpha" });
    const { user } = await insertUserWithProfile({
      companyId: co.id,
      role: "esg_admin",
    });

    const ctx = await resolveSessionContext(getTestDb(), user.id);

    // `company` is the SAME id the old `profiles.company_id` path returned, still
    // projected to the DbCompany field set (non-null `plan`).
    expect(ctx.company?.id).toBe(co.id);
    expect(ctx.company?.name).toBe("Alpha");
    expect(typeof ctx.company?.plan).toBe("string");

    expect(ctx.membership).toEqual({
      companyId: co.id,
      role: "esg_admin",
      status: "active",
      hasIndependentApprover: false,
      activeMemberCount: 1,
    });

    // Solo admin, no approver → the compensating grant fires (D13).
    expect(ctx.capabilities).toContain("data.approve");
    expect(ctx.capabilities).toContain("company.manage");

    expect(ctx.memberships).toEqual([
      { companyId: co.id, companyName: "Alpha", role: "esg_admin" },
    ]);
  });

  // ── Add an active approver to the same company → the grant is withdrawn ───────
  it("withdraws the compensating grant once an active approver joins the company", async () => {
    const co = await insertPaidCompany({ name: "Alpha" });
    const { user: admin } = await insertUserWithProfile({
      companyId: co.id,
      role: "esg_admin",
    });
    // A second, independent approver in the SAME company.
    await insertUserWithProfile({ companyId: co.id, role: "approver" });

    const ctx = await resolveSessionContext(getTestDb(), admin.id);

    expect(ctx.membership).toEqual({
      companyId: co.id,
      role: "esg_admin",
      status: "active",
      hasIndependentApprover: true,
      activeMemberCount: 2,
    });
    // An independent approver exists → esg_admin no longer carries data.approve.
    expect(ctx.capabilities).not.toContain("data.approve");
  });

  // ── A user with no active membership → empty session context ─────────────────
  it("returns null company/membership and empty capabilities for a user with no membership", async () => {
    const { user } = await insertUserWithProfile(); // profile, no company

    const ctx = await resolveSessionContext(getTestDb(), user.id);

    expect(ctx.company).toBeNull();
    expect(ctx.membership).toBeNull();
    expect(ctx.capabilities).toEqual([]);
    expect(ctx.memberships).toEqual([]);
  });
});
