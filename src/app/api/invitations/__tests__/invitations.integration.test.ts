// [LOCAL-DB] T2.3 — issuing, listing, revoking and re-sending company invitations
// against a REAL Postgres via the T0.2 harness. Proves §9.1–9.7 / §7.1 / §4.4 / D7:
//
//   • guard order (§7.1): a `contributor` on a seat-exhausted company → 403 (the
//     capability gate fires BEFORE the seat gate); an `esg_admin` (has
//     members.manage) on a full trial (maxTeamMembers=1) → 402 PLAN_REQUIRED —
//     capability passes, the seat gate denies, proving 403 precedes 402;
//   • token secrecy (D7 / §0.5): the DB stores ONLY sha256(raw) hex — the value in
//     `token_hash` equals the sha256 of the raw token from the response, never the
//     raw token itself; there is NO `token` column on the table;
//   • the one-time raw token travels ONLY in the POST/resend `inviteUrl`; GET leaks
//     neither `token_hash` nor `inviteUrl` (asserted over the FULL response JSON);
//   • the partial unique index (§4.4): a second live invitation for the same
//     (company, email) → 422;
//   • resend (§9.6): the old row is revoked, a NEW live row + NEW token is created,
//     the old raw token maps to a revoked (unusable) row;
//   • membership rules (§9.6): an ACTIVE member of that email → 422; SUSPENDED →
//     422; REMOVED → the invitation IS created;
//   • best-effort mail (§9.7): `sendMail` is called EXACTLY once with the
//     `/invite/<raw>` link; when it throws, the invitation is STILL created;
//   • tenant isolation: DELETE / resend of ANOTHER company's invitation → 403.
//
// `getSession` is mocked so a test controls identity (built via the real
// `resolveSessionContext` so membership/capabilities/company are genuine);
// `@/server/db` is mocked to the harness pool so routes + guards + services share
// ONE Postgres; `sendMail` is a spy. `describeIntegration` self-skips with no DB.
import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getSessionMock = vi.fn();
vi.mock("@/server/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/session")>(
    "@/server/auth/session",
  );
  return { ...actual, getSession: () => getSessionMock() };
});

const sendMailMock = vi.fn();
vi.mock("@/server/auth/mailer", () => ({
  sendMail: (...args: unknown[]) => sendMailMock(...args),
  // The routes also import `escapeHtml` (Low #3 fix); the mock must mirror the
  // module's export surface. Real impl — the HTML-body assertions stay accurate.
  escapeHtml: (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;"),
}));

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  // testDbModule()'s `db` getter is safe to read during collection: with no DB it
  // hands back an inert stand-in instead of throwing, so importing the real
  // session/auth graph (which reads `db` at import time) doesn't fail the suite —
  // it self-skips via describeIntegration. See harness.ts.
  return harness.testDbModule();
});

import {
  GET as inviteGET,
  POST as invitePOST,
} from "@/app/api/invitations/route";
import { DELETE as inviteDELETE } from "@/app/api/invitations/[id]/route";
import { POST as inviteRESEND } from "@/app/api/invitations/[id]/resend/route";
import { POST as acceptPOST } from "@/app/api/invitations/accept/route";
import { GET as previewGET } from "@/app/api/invitations/preview/route";
import { GET as sessionGET } from "@/app/api/session/route";
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
import {
  auditLog,
  companyInvitations,
  companyMembers,
  profiles,
  user,
} from "@/server/db/schema";

/** Build the session `getSession()` would resolve for `userId`, off the harness pool. */
async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyReq = (r: Request) => r as any;

const postReq = (body: unknown) =>
  anyReq(
    new Request("http://api.example.com/api/invitations", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

const getReq = () =>
  anyReq(new Request("http://api.example.com/api/invitations"));

const idReq = (id: string, method: string) => ({
  req: anyReq(
    new Request(`http://api.example.com/api/invitations/${id}`, { method }),
  ),
  ctx: { params: Promise.resolve({ id }) },
});

/** SELECT the token_hash of the single invitation a test just created. */
async function tokenHashOf(id: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ tokenHash: companyInvitations.tokenHash })
    .from(companyInvitations)
    .where(eq(companyInvitations.id, id));
  return row.tokenHash;
}

async function invitationRow(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(companyInvitations)
    .where(eq(companyInvitations.id, id));
  return row;
}

describeIntegration(
  "T2.3 /api/invitations (issue / list / revoke / resend)",
  () => {
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

    it("issues an invitation: DB stores ONLY sha256(raw), no token column; response carries the one-time inviteUrl; mail sent once", async () => {
      const company = await insertPaidCompany(); // starter, maxTeamMembers=5
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      getSessionMock.mockResolvedValue(await sessionFor(admin.id));

      const res = await invitePOST(
        postReq({ email: "Newbie@Example.com", role: "contributor" }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.email).toBe("newbie@example.com"); // normalised
      expect(body.data.role).toBe("contributor");
      expect(typeof body.data.inviteUrl).toBe("string");

      // The raw token lives ONLY in the inviteUrl; the DB stores its sha256.
      const raw = body.data.inviteUrl.split("/invite/")[1];
      expect(raw).toBeTruthy();
      const storedHash = await tokenHashOf(body.data.id);
      expect(storedHash).toBe(createHash("sha256").update(raw).digest("hex"));
      expect(storedHash).not.toBe(raw);

      // There is NO raw-token column on the table — only token_hash.
      const cols = await getTestDb().execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'company_invitations'`,
      );
      const columnNames = cols.map((c) => c.column_name);
      expect(columnNames).toContain("token_hash");
      expect(columnNames).not.toContain("token");

      // Mail is best-effort but IS attempted exactly once, with the /invite/<raw> link.
      expect(sendMailMock).toHaveBeenCalledTimes(1);
      const mailArg = sendMailMock.mock.calls[0][0] as {
        to: string;
        text: string;
        html?: string;
      };
      expect(mailArg.to).toBe("newbie@example.com");
      expect(mailArg.text).toContain(`/invite/${raw}`);

      // Exactly one audit row (entity='invitation', action='create').
      const audits = await getTestDb()
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, company.id));
      expect(audits).toHaveLength(1);
      expect(audits[0].entity).toBe("invitation");
      expect(audits[0].action).toBe("create");
      expect(audits[0].actorRole).toBe("esg_admin");
    });

    it("GET leaks neither token_hash nor inviteUrl (checked over the FULL response JSON)", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const { rawToken } = await insertInvitation(company.id, {
        email: "listed@example.com",
      });
      const storedHash = createHash("sha256").update(rawToken).digest("hex");

      getSessionMock.mockResolvedValue(await sessionFor(admin.id));

      const res = await inviteGET(getReq());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(1);

      const fullJson = JSON.stringify(body);
      expect(fullJson).not.toContain("token_hash");
      expect(fullJson).not.toContain("tokenHash");
      expect(fullJson).not.toContain("inviteUrl");
      expect(fullJson).not.toContain(storedHash);
      expect(fullJson).not.toContain(rawToken);
      // The safe fields ARE present.
      expect(body.data[0].email).toBe("listed@example.com");
    });

    it("guard order (§7.1): a contributor on a seat-exhausted company → 403, NOT 402", async () => {
      // Trial company (maxTeamMembers=1) whose ONLY member is a contributor: the seat
      // is exhausted, so a seat-first order would answer 402 — the correct order gives
      // 403 (the role has no members.manage).
      const company = await insertCompany({ plan: "trial" });
      const { user: contributor } = await insertUserWithProfile({
        companyId: company.id,
        role: "contributor",
      });
      getSessionMock.mockResolvedValue(await sessionFor(contributor.id));

      const res = await invitePOST(
        postReq({ email: "x@example.com", role: "contributor" }),
      );
      expect(res.status).toBe(403);
      // Nothing created.
      const rows = await getTestDb().select().from(companyInvitations);
      expect(rows).toHaveLength(0);
    });

    it("guard order (§7.1): an esg_admin on a full trial company → 402 PLAN_REQUIRED (capability ok, seat denies)", async () => {
      const company = await insertCompany({ plan: "trial" }); // maxTeamMembers=1
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      }); // the one member exhausts the seat
      getSessionMock.mockResolvedValue(await sessionFor(admin.id));

      const res = await invitePOST(
        postReq({ email: "x@example.com", role: "contributor" }),
      );
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toBe("PLAN_REQUIRED");
      const rows = await getTestDb().select().from(companyInvitations);
      expect(rows).toHaveLength(0);
    });

    it("a second LIVE invitation for the same (company, email) → 422 (partial unique index)", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      getSessionMock.mockResolvedValue(await sessionFor(admin.id));

      const first = await invitePOST(
        postReq({ email: "dup@example.com", role: "contributor" }),
      );
      expect(first.status).toBe(200);

      const second = await invitePOST(
        postReq({ email: "dup@example.com", role: "reviewer" }),
      );
      expect(second.status).toBe(422);

      const rows = await getTestDb().select().from(companyInvitations);
      expect(rows).toHaveLength(1); // the collision created nothing
    });

    it("resend (§9.6): revokes the old row, creates a NEW live row + NEW token; the old raw token maps to a revoked (unusable) row", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      getSessionMock.mockResolvedValue(await sessionFor(admin.id));

      const created = await (
        await invitePOST(
          postReq({ email: "resend@example.com", role: "contributor" }),
        )
      ).json();
      const oldId = created.data.id;
      const oldRaw = created.data.inviteUrl.split("/invite/")[1];

      const { req, ctx } = idReq(oldId, "POST");
      const res = await inviteRESEND(req, ctx);
      expect(res.status).toBe(200);
      const resent = await res.json();
      const newId = resent.data.id;
      const newRaw = resent.data.inviteUrl.split("/invite/")[1];

      expect(newId).not.toBe(oldId);
      expect(newRaw).not.toBe(oldRaw);

      // Old row: revoked. New row: live.
      const oldRow = await invitationRow(oldId);
      expect(oldRow.revokedAt).not.toBeNull();
      const newRow = await invitationRow(newId);
      expect(newRow.revokedAt).toBeNull();
      expect(newRow.acceptedAt).toBeNull();

      // The old raw token now hashes to a REVOKED row — it can no longer be accepted.
      const oldHash = createHash("sha256").update(oldRaw).digest("hex");
      expect(oldRow.tokenHash).toBe(oldHash);
    });

    it("an ACTIVE member of that email → 422; SUSPENDED → 422; REMOVED → the invitation IS created", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      getSessionMock.mockResolvedValue(await sessionFor(admin.id));

      // ACTIVE member with a known email.
      const activeUser = await insertUserWithProfile({
        user: { email: "active-member@example.com" },
      });
      await insertMembership(company.id, activeUser.user.id, {
        role: "contributor",
        status: "active",
      });
      expect(
        (
          await invitePOST(
            postReq({
              email: "active-member@example.com",
              role: "contributor",
            }),
          )
        ).status,
      ).toBe(422);

      // SUSPENDED member.
      const suspendedUser = await insertUserWithProfile({
        user: { email: "suspended-member@example.com" },
      });
      await insertMembership(company.id, suspendedUser.user.id, {
        role: "contributor",
        status: "suspended",
      });
      expect(
        (
          await invitePOST(
            postReq({
              email: "suspended-member@example.com",
              role: "contributor",
            }),
          )
        ).status,
      ).toBe(422);

      // REMOVED member → an invitation is allowed.
      const removedUser = await insertUserWithProfile({
        user: { email: "removed-member@example.com" },
      });
      await insertMembership(company.id, removedUser.user.id, {
        role: "contributor",
        status: "removed",
      });
      expect(
        (
          await invitePOST(
            postReq({
              email: "removed-member@example.com",
              role: "contributor",
            }),
          )
        ).status,
      ).toBe(200);

      const rows = await getTestDb()
        .select()
        .from(companyInvitations)
        .where(eq(companyInvitations.companyId, company.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe("removed-member@example.com");
    });

    it("best-effort mail (§9.7): sendMail throwing does NOT prevent the invitation from being created", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      getSessionMock.mockResolvedValue(await sessionFor(admin.id));
      sendMailMock.mockRejectedValueOnce(new Error("SMTP down"));

      const res = await invitePOST(
        postReq({ email: "besteffort@example.com", role: "contributor" }),
      );
      expect(res.status).toBe(200);
      expect(sendMailMock).toHaveBeenCalledTimes(1);

      const rows = await getTestDb()
        .select()
        .from(companyInvitations)
        .where(eq(companyInvitations.companyId, company.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe("besteffort@example.com");
    });

    it("revoke: DELETE of the session company's invitation → 200, revoked_at stamped, one audit row", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const { row } = await insertInvitation(company.id, {
        email: "revoke-me@example.com",
      });
      getSessionMock.mockResolvedValue(await sessionFor(admin.id));

      const { req, ctx } = idReq(row.id, "DELETE");
      const res = await inviteDELETE(req, ctx);
      expect(res.status).toBe(200);

      const after = await invitationRow(row.id);
      expect(after.revokedAt).not.toBeNull();

      const audits = await getTestDb()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.companyId, company.id),
            eq(auditLog.entity, "invitation"),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe("delete");
    });

    it("tenant isolation: DELETE of ANOTHER company's invitation → 403, the row is untouched", async () => {
      const compA = await insertPaidCompany();
      const { row: inviteA } = await insertInvitation(compA.id, {
        email: "a@example.com",
      });

      const compB = await insertPaidCompany();
      const { user: adminB } = await insertUserWithProfile({
        companyId: compB.id,
        role: "esg_admin",
      });
      getSessionMock.mockResolvedValue(await sessionFor(adminB.id));

      const { req, ctx } = idReq(inviteA.id, "DELETE");
      const res = await inviteDELETE(req, ctx);
      expect(res.status).toBe(403);

      const after = await invitationRow(inviteA.id);
      expect(after.revokedAt).toBeNull(); // never touched
    });

    it("tenant isolation: resend of ANOTHER company's invitation → 403, no new row, original untouched", async () => {
      const compA = await insertPaidCompany();
      const { row: inviteA } = await insertInvitation(compA.id, {
        email: "a@example.com",
      });

      const compB = await insertPaidCompany();
      const { user: adminB } = await insertUserWithProfile({
        companyId: compB.id,
        role: "esg_admin",
      });
      getSessionMock.mockResolvedValue(await sessionFor(adminB.id));

      const { req, ctx } = idReq(inviteA.id, "POST");
      const res = await inviteRESEND(req, ctx);
      expect(res.status).toBe(403);

      const after = await invitationRow(inviteA.id);
      expect(after.revokedAt).toBeNull(); // original untouched
      const all = await getTestDb().select().from(companyInvitations);
      expect(all).toHaveLength(1); // no new row created
    });
  },
);

// ─── T2.4 — public preview + transactional accept ────────────────────────────
// Build the session `getSession()` resolves for a REAL user (identity taken from
// the row, context resolved off the harness pool) — unlike `sessionFor`, the
// email reflects the actual user so accept can record an email divergence (§9.6).
async function sessionForUser(u: { id: string; email: string; name: string }) {
  const ctx = await resolveSessionContext(getTestDb(), u.id);
  return { userId: u.id, email: u.email, name: u.name, ...ctx };
}

const previewReq = (token: string | null) =>
  anyReq(
    new Request(
      token === null
        ? "http://api.example.com/api/invitations/preview"
        : `http://api.example.com/api/invitations/preview?token=${encodeURIComponent(token)}`,
    ),
  );

const acceptReq = (body: unknown) =>
  anyReq(
    new Request("http://api.example.com/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

const sessionReq = () =>
  anyReq(new Request("http://api.example.com/api/session"));

/** All membership rows of a company for one user (to assert "exactly one"). */
async function membershipsOf(companyId: string, userId: string) {
  return getTestDb()
    .select()
    .from(companyMembers)
    .where(
      and(
        eq(companyMembers.companyId, companyId),
        eq(companyMembers.userId, userId),
      ),
    );
}

describeIntegration(
  "T2.4 /api/invitations (public preview + transactional accept)",
  () => {
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

    it("preview returns EXACTLY the four public fields — companyName, role, invitedByName, expiresAt — and nothing else (§9.4)", async () => {
      const company = await insertPaidCompany({ name: "Acme Preview Co" });
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const { row, rawToken } = await insertInvitation(company.id, {
        email: "preview@example.com",
        role: "reviewer",
      });
      // Give the invitation an inviter so `invitedByName` is a real (non-null) name.
      await getTestDb()
        .update(companyInvitations)
        .set({ invitedBy: admin.id })
        .where(eq(companyInvitations.id, row.id));

      const res = await previewGET(previewReq(rawToken));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Exactly four keys — asserted over the WHOLE object, not cherry-picked (§9.4).
      expect(Object.keys(body.data).sort()).toEqual([
        "companyName",
        "expiresAt",
        "invitedByName",
        "role",
      ]);
      expect(body.data.companyName).toBe("Acme Preview Co");
      expect(body.data.role).toBe("reviewer");
      expect(body.data.invitedByName).toBe(admin.name);

      // Nothing that would leak company internals (§0.6) — checked over full JSON.
      const fullJson = JSON.stringify(body);
      expect(fullJson).not.toContain(company.id);
      expect(fullJson).not.toContain("companyId");
      expect(fullJson).not.toContain("invitationId");
      expect(fullJson).not.toContain("token");
    });

    it("every unusable token (missing / expired / accepted / revoked / unknown) → a BYTE-IDENTICAL 422 (§9.5)", async () => {
      const company = await insertPaidCompany();

      // expired
      const { rawToken: expiredRaw } = await insertInvitation(company.id, {
        email: "expired@example.com",
        expiresAt: new Date(Date.now() - 60_000),
      });
      // accepted
      const { row: acceptedRow, rawToken: acceptedRaw } =
        await insertInvitation(company.id, { email: "accepted@example.com" });
      await getTestDb()
        .update(companyInvitations)
        .set({ acceptedAt: new Date() })
        .where(eq(companyInvitations.id, acceptedRow.id));
      // revoked
      const { row: revokedRow, rawToken: revokedRaw } = await insertInvitation(
        company.id,
        { email: "revoked@example.com" },
      );
      await getTestDb()
        .update(companyInvitations)
        .set({ revokedAt: new Date() })
        .where(eq(companyInvitations.id, revokedRow.id));

      const tokens = [
        "this-token-does-not-exist",
        expiredRaw,
        acceptedRaw,
        revokedRaw,
      ];
      const results: { status: number; body: string }[] = [];
      for (const t of tokens) {
        const res = await previewGET(previewReq(t));
        results.push({ status: res.status, body: await res.text() });
      }

      // Compared BETWEEN each other (not against a literal): same status + bytes.
      for (const r of results) expect(r.status).toBe(422);
      expect(results[1].body).toBe(results[0].body);
      expect(results[2].body).toBe(results[0].body);
      expect(results[3].body).toBe(results[0].body);
    });

    it("accept creates the membership AND a profile (Q4) for a user who had none; the audit write succeeds (no FK error); the session then shows the new company active", async () => {
      const company = await insertPaidCompany({ name: "Joined Co" });
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const { rawToken } = await insertInvitation(company.id, {
        email: "joiner@example.com",
        role: "contributor",
      });
      await getTestDb()
        .update(companyInvitations)
        .set({ invitedBy: admin.id })
        .where(eq(companyInvitations.email, "joiner@example.com"));

      // A bare `user` row with NO `profiles` row — proves Q4 creates the profile.
      const [bare] = await getTestDb()
        .insert(user)
        .values({ name: "Bare Joiner", email: "joiner@example.com" })
        .returning();
      const before = await getTestDb()
        .select()
        .from(profiles)
        .where(eq(profiles.id, bare.id));
      expect(before).toHaveLength(0);

      getSessionMock.mockResolvedValue(await sessionForUser(bare));
      const res = await acceptPOST(acceptReq({ token: rawToken }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.companyId).toBe(company.id);
      expect(body.data.role).toBe("contributor");

      // Q4 — the profile now exists.
      const [prof] = await getTestDb()
        .select()
        .from(profiles)
        .where(eq(profiles.id, bare.id));
      expect(prof).toBeTruthy();

      // Membership created, active.
      const mems = await membershipsOf(company.id, bare.id);
      expect(mems).toHaveLength(1);
      expect(mems[0].status).toBe("active");
      expect(mems[0].role).toBe("contributor");

      // The audit row was written against profiles.id WITHOUT a FK error.
      const audits = await getTestDb()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.companyId, company.id),
            eq(auditLog.entity, "member"),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe("create");
      expect(audits[0].userId).toBe(bare.id);
      expect(audits[0].actorRole).toBe("contributor");

      // GET /api/session for the accepter now resolves the new company as active.
      getSessionMock.mockResolvedValue(await sessionForUser(bare));
      const sres = await sessionGET(sessionReq());
      expect(sres.status).toBe(200);
      const sbody = await sres.json();
      expect(sbody.company.id).toBe(company.id);
    });

    it("double-click: a second accept with the SAME token → 422 and exactly ONE membership", async () => {
      const company = await insertPaidCompany();
      await insertUserWithProfile({ companyId: company.id, role: "esg_admin" });
      const { rawToken } = await insertInvitation(company.id, {
        email: "double@example.com",
        role: "contributor",
      });

      const { user: joiner } = await insertUserWithProfile({
        user: { email: "double@example.com" },
      });
      getSessionMock.mockResolvedValue(await sessionForUser(joiner));

      const first = await acceptPOST(acceptReq({ token: rawToken }));
      expect(first.status).toBe(200);

      const second = await acceptPOST(acceptReq({ token: rawToken }));
      expect(second.status).toBe(422);

      const mems = await membershipsOf(company.id, joiner.id);
      expect(mems).toHaveLength(1);
    });

    it("accept by an account whose email ≠ the invited email is ALLOWED, and the divergence is recorded in audit (§9.6)", async () => {
      const company = await insertPaidCompany();
      await insertUserWithProfile({ companyId: company.id, role: "esg_admin" });
      const { rawToken } = await insertInvitation(company.id, {
        email: "invited@example.com",
        role: "contributor",
      });

      // The account accepting uses a DIFFERENT email (work vs. personal, §9.6).
      const { user: joiner } = await insertUserWithProfile({
        user: { email: "different@example.com" },
      });
      getSessionMock.mockResolvedValue(await sessionForUser(joiner));

      const res = await acceptPOST(acceptReq({ token: rawToken }));
      expect(res.status).toBe(200); // allowed, not rejected

      const [audit] = await getTestDb()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.companyId, company.id),
            eq(auditLog.entity, "member"),
          ),
        );
      const summary = audit.summary as {
        invited_email: string;
        accepted_email: string;
      };
      expect(summary.invited_email).toBe("invited@example.com");
      expect(summary.accepted_email).toBe("different@example.com");
      expect(summary.invited_email).not.toBe(summary.accepted_email);
    });

    it("accept revives a `removed` membership (SAME row id, status active, new role, removed_at NULL) — no second row (§9.6)", async () => {
      const company = await insertPaidCompany();
      await insertUserWithProfile({ companyId: company.id, role: "esg_admin" });

      const { user: joiner } = await insertUserWithProfile({
        user: { email: "revive@example.com" },
      });
      // Pre-existing REMOVED membership with an OLD role.
      const removed = await insertMembership(company.id, joiner.id, {
        role: "contributor",
        status: "removed",
      });
      await getTestDb()
        .update(companyMembers)
        .set({ removedAt: new Date() })
        .where(eq(companyMembers.id, removed.id));

      // Invite the removed user back with a DIFFERENT role.
      const { rawToken } = await insertInvitation(company.id, {
        email: "revive@example.com",
        role: "approver",
      });
      getSessionMock.mockResolvedValue(await sessionForUser(joiner));

      const res = await acceptPOST(acceptReq({ token: rawToken }));
      expect(res.status).toBe(200);

      const mems = await membershipsOf(company.id, joiner.id);
      expect(mems).toHaveLength(1); // the SAME row, revived — not a second one
      expect(mems[0].id).toBe(removed.id);
      expect(mems[0].status).toBe("active");
      expect(mems[0].role).toBe("approver"); // new role
      expect(mems[0].removedAt).toBeNull();
    });

    it("accept when the seat limit is full → 402, no membership created, invitation NOT accepted", async () => {
      // Trial company (maxTeamMembers=1). Its one admin already fills the seat; a
      // live invitation (seeded via the harness, bypassing the issue-time gate)
      // pushes usage past the limit, so accept must be refused at the seat gate.
      const company = await insertCompany({ plan: "trial" });
      await insertUserWithProfile({ companyId: company.id, role: "esg_admin" });
      const { row: invite, rawToken } = await insertInvitation(company.id, {
        email: "overflow@example.com",
        role: "contributor",
      });

      const { user: joiner } = await insertUserWithProfile({
        user: { email: "overflow@example.com" },
      });
      getSessionMock.mockResolvedValue(await sessionForUser(joiner));

      const res = await acceptPOST(acceptReq({ token: rawToken }));
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toBe("PLAN_REQUIRED");

      // No membership, and the invitation is still un-accepted.
      const mems = await membershipsOf(company.id, joiner.id);
      expect(mems).toHaveLength(0);
      const after = await invitationRow(invite.id);
      expect(after.acceptedAt).toBeNull();
    });

    it("Medium #2: accept does NOT re-role an already-active member — the sole admin accepting a lower-role invite keeps esg_admin (D9 not bypassed)", async () => {
      const company = await insertPaidCompany();
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      // A live invitation to the admin's OWN account for a LOWER role (harness
      // bypasses the issue-time already-member guard, modelling an alias-addressed
      // token the existing member controls).
      const { row: invite, rawToken } = await insertInvitation(company.id, {
        email: "admin-alias@example.com",
        role: "contributor",
      });
      getSessionMock.mockResolvedValue(await sessionForUser(admin));

      const res = await acceptPOST(acceptReq({ token: rawToken }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.role).toBe("esg_admin"); // effective role UNCHANGED

      // The membership row is still esg_admin/active — not downgraded to contributor.
      const [m] = await membershipsOf(company.id, admin.id);
      expect(m.role).toBe("esg_admin");
      expect(m.status).toBe("active");
      // The company still has exactly one active admin (D9 invariant preserved).
      const admins = await getTestDb()
        .select({ id: companyMembers.id })
        .from(companyMembers)
        .where(
          and(
            eq(companyMembers.companyId, company.id),
            eq(companyMembers.role, "esg_admin"),
            eq(companyMembers.status, "active"),
          ),
        );
      expect(admins).toHaveLength(1);
      // The token is still spent (one-time), and the no-op re-role is visible.
      expect((await invitationRow(invite.id)).acceptedAt).not.toBeNull();
      const [audit] = await getTestDb()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.companyId, company.id),
            eq(auditLog.entity, "member"),
          ),
        );
      const summary = audit.summary as {
        invited_role?: string;
        role_unchanged?: boolean;
      };
      expect(summary.invited_role).toBe("contributor");
      expect(summary.role_unchanged).toBe(true);
      expect(audit.actorRole).toBe("esg_admin"); // snapshot = effective role
    });

    it("Low #2: an invitation can fill the LAST seat — accept is seat-neutral (the accepting invite is excluded from the count)", async () => {
      // starter = maxTeamMembers 5. Fill 4 member seats + 1 live invitation = 5 used.
      const company = await insertPaidCompany(); // starter
      for (let i = 0; i < 4; i++) {
        await insertUserWithProfile({
          companyId: company.id,
          role: i === 0 ? "esg_admin" : "contributor",
        });
      }
      const { rawToken } = await insertInvitation(company.id, {
        email: "last-seat@example.com",
        role: "contributor",
      });
      const { user: joiner } = await insertUserWithProfile({
        user: { email: "last-seat@example.com" },
      });
      getSessionMock.mockResolvedValue(await sessionForUser(joiner));

      // Accept converts the invite into the 5th member — net-neutral, so allowed.
      const res = await acceptPOST(acceptReq({ token: rawToken }));
      expect(res.status).toBe(200);
      const mems = await membershipsOf(company.id, joiner.id);
      expect(mems).toHaveLength(1);
      expect(mems[0].status).toBe("active");
    });
  },
);
