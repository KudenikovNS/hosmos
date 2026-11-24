// [LOCAL-DB] T1.4 — POST /api/register creates the owner membership (§13.1).
//
// Registration is a two-step flow: better-auth creates the account first, then
// this route creates the company and links the profile. T1.4 adds a THIRD step in
// the SAME try/catch: the registrant becomes the company's first member — its owner
// (esg_admin / active), with `accepted_at` stamped (a self-join, not an invite).
//
// The suite proves:
//   • with a company name → EXACTLY ONE company_members row, esg_admin / active,
//     accepted_at IS NOT NULL, and BOTH profile company columns point at the new
//     company (company_id = active_company_id = companyId, D11);
//   • the next resolveSessionContext() — what getSession() delegates to — reports
//     membership.role='esg_admin' with capabilities INCLUDING data.approve: the solo
//     owner is the independent approver (D13 grant — no invitees, no other approver);
//   • WITHOUT a company name → no membership, result `{companyId:null}` as before;
//   • a failed company step answers PERSIST_FAILED with nothing left behind, and
//     a retry completes it (BUG-004); a repeat never makes a second company (F11).
//
// `getSession` is mocked so a test controls the identity; the real
// `resolveSessionContext` is kept (importActual) to assert the post-registration
// session. `@/server/db` is mocked to the harness pool so the route reads the same
// Postgres the fixtures write to. `describeIntegration` is `describe.skip` with no
// DB, so this file is a green no-op in a DB-less CI.
import { eq } from "drizzle-orm";
import { PgDatabase } from "drizzle-orm/pg-core";
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

import { POST as registerPOST } from "@/app/api/register/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { companies, companyMembers, profiles } from "@/server/db/schema";

/** A JSON POST request (the register route reads req.json()). */
const jsonRequest = (body: unknown) =>
  new Request("http://api.example.com/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describeIntegration("T1.4 register route — owner membership", () => {
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

  it("with a company name creates ONE esg_admin/active membership + links BOTH profile columns (D11)", async () => {
    // Step 1 (better-auth) already ran: the account + its bare profile exist.
    const { user } = await insertUserWithProfile();
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    const res = await registerPOST(jsonRequest({ company: "Acme Ltd" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const companyId = body.data.companyId as string;
    expect(companyId).toBeTruthy();

    // EXACTLY ONE membership row, esg_admin / active, accepted_at stamped.
    const members = await getTestDb()
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.userId, user.id));
    expect(members).toHaveLength(1);
    expect(members[0].companyId).toBe(companyId);
    expect(members[0].role).toBe("esg_admin");
    expect(members[0].status).toBe("active");
    expect(members[0].acceptedAt).not.toBeNull();

    // D11 — BOTH profile company columns point at the new company.
    const [profile] = await getTestDb()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    expect(profile.companyId).toBe(companyId);
    expect(profile.activeCompanyId).toBe(companyId);
    expect(profile.companyId).toBe(profile.activeCompanyId);
  });

  it("the next session resolves esg_admin with data.approve (solo owner is the D13 approver)", async () => {
    const { user } = await insertUserWithProfile();
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    const res = await registerPOST(jsonRequest({ company: "Acme Ltd" }));
    const { data } = await res.json();

    const ctx = await resolveSessionContext(getTestDb(), user.id);
    expect(ctx.company?.id).toBe(data.companyId);
    expect(ctx.membership?.role).toBe("esg_admin");
    // No invitees yet, no independent approver — the D13 grant hands data.approve
    // to the solo esg_admin so the company is never stuck without an approver.
    expect(ctx.membership?.hasIndependentApprover).toBe(false);
    expect(ctx.capabilities).toContain("data.approve");
  });

  it("without a company name creates no membership and returns {companyId:null}", async () => {
    const { user } = await insertUserWithProfile();
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    const res = await registerPOST(jsonRequest({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { companyId: null } });

    const members = await getTestDb()
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.userId, user.id));
    expect(members).toHaveLength(0);
  });

  it("a simulated company-insert failure is reported, and nothing is left behind (BUG-004)", async () => {
    const { user } = await insertUserWithProfile();
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    // Make the FIRST db write (the companies insert) throw, exactly like a real
    // DB error inside the company/membership block. The account already exists
    // and stays; the route must say the step failed so the form can offer a
    // retry. The write runs on the transaction's `tx`, so the spy sits on the
    // shared prototype rather than on the pool instance.
    const insertSpy = vi
      .spyOn(PgDatabase.prototype, "insert")
      .mockImplementationOnce(() => {
        throw new Error("simulated company insert failure");
      });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const res = await registerPOST(jsonRequest({ company: "Acme Ltd" }));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: "PERSIST_FAILED" });
    } finally {
      insertSpy.mockRestore();
      errSpy.mockRestore();
    }

    // Nothing was written — no membership leaked through.
    const members = await getTestDb()
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.userId, user.id));
    expect(members).toHaveLength(0);
  });

  it("a failure after the company row rolls the company back, and a retry then succeeds", async () => {
    const { user } = await insertUserWithProfile();
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    // Fail the SECOND write (the owner membership): the company row was
    // already inserted in the same transaction and must not survive.
    const realInsert = PgDatabase.prototype.insert;
    const insertSpy = vi
      .spyOn(PgDatabase.prototype, "insert")
      .mockImplementation(function (this: unknown, table: unknown) {
        if (table === companyMembers) {
          throw new Error("simulated membership insert failure");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realInsert as any).call(this, table);
      });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await registerPOST(jsonRequest({ company: "Rollback Ltd" }));
      expect(res.status).toBe(500);
    } finally {
      insertSpy.mockRestore();
      errSpy.mockRestore();
    }
    const orphans = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.name, "Rollback Ltd"));
    expect(orphans).toHaveLength(0);

    // The account is intact, so the form's retry completes the step.
    const retry = await (
      await registerPOST(jsonRequest({ company: "Rollback Ltd" }))
    ).json();
    expect(retry.ok).toBe(true);
    const ctx = await resolveSessionContext(getTestDb(), user.id);
    expect(ctx.company?.id).toBe(retry.data.companyId);
    expect(ctx.membership?.role).toBe("esg_admin");
  });

  // F11 (register-bypasses-max-companies): registration creates a company once
  // per account; a repeat hands back the existing one.
  it("a repeated call returns the existing company instead of creating a second", async () => {
    const { user } = await insertUserWithProfile();
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    const first = await (
      await registerPOST(jsonRequest({ company: "Acme Ltd" }))
    ).json();
    const second = await (
      await registerPOST(jsonRequest({ company: "Acme Again" }))
    ).json();

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: true,
      data: { companyId: first.data.companyId },
    });
    const members = await getTestDb()
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.userId, user.id));
    expect(members).toHaveLength(1);
  });

  it("concurrent calls still create a single company", async () => {
    const { user } = await insertUserWithProfile();
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    // Force the race instead of hoping for it: each call's companies insert
    // waits until the other call has reached its own (or 500 ms pass). Without
    // the account lock both calls pass the "no company yet" check and arrive
    // here together; with it the second call is still blocked on the lock, the
    // first proceeds after the timeout, and the second then finds its company.
    const realInsert = PgDatabase.prototype.insert;
    let arrived = 0;
    let releaseAll: () => void = () => {};
    const together = new Promise<void>((resolve) => (releaseAll = resolve));
    const arrive = () => {
      arrived += 1;
      if (arrived >= 2) releaseAll();
      return Promise.race([
        together,
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    };
    const insertSpy = vi
      .spyOn(PgDatabase.prototype, "insert")
      .mockImplementation(function (this: unknown, table: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const builder = (realInsert as any).call(this, table);
        if (table !== companies) return builder;
        return {
          values: (v: unknown) => {
            const query = builder.values(v);
            return { returning: () => arrive().then(() => query.returning()) };
          },
        } as never;
      });

    let bodies: { data: { companyId: string | null } }[];
    try {
      bodies = await Promise.all(
        ["A", "B"].map(async (name) =>
          (await registerPOST(jsonRequest({ company: name }))).json(),
        ),
      );
    } finally {
      insertSpy.mockRestore();
    }

    const ids = new Set(bodies.map((b) => b.data.companyId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
    const members = await getTestDb()
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.userId, user.id));
    expect(members).toHaveLength(1);
  });

  it("only a suspended membership: FORBIDDEN, and no company is created", async () => {
    const { user } = await insertUserWithProfile();
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: user.name,
    });
    await registerPOST(jsonRequest({ company: "Held Ltd" }));
    await getTestDb()
      .update(companyMembers)
      .set({ status: "suspended" })
      .where(eq(companyMembers.userId, user.id));

    const res = await registerPOST(jsonRequest({ company: "Escape Ltd" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "FORBIDDEN" });
    const created = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.name, "Escape Ltd"));
    expect(created).toHaveLength(0);
  });

  it("a removed membership does not count: the account can register its own company", async () => {
    const { user } = await insertUserWithProfile();
    getSessionMock.mockResolvedValue({
      userId: user.id,
      email: user.email,
      name: user.name,
    });
    const first = await (
      await registerPOST(jsonRequest({ company: "Old Ltd" }))
    ).json();
    await getTestDb()
      .update(companyMembers)
      .set({ status: "removed", removedAt: new Date() })
      .where(eq(companyMembers.userId, user.id));

    const second = await (
      await registerPOST(jsonRequest({ company: "New Ltd" }))
    ).json();

    expect(second.data.companyId).toBeTruthy();
    expect(second.data.companyId).not.toBe(first.data.companyId);
  });
});
