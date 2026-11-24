// [LOCAL-DB] T3.1 — THE APPEND-ONLY ROW SERVICE (§0.4, D5/D23, LC-3…LC-8) and
// the Scope-1 activities it first serves, against a real Postgres via the T1.7
// harness.
//
// The properties this file exists to prove, none of which is visible without a
// database:
//
//   • AN EDIT IS A NEW ROW, AND THE OLD ONE IS NOT TOUCHED. Every column of the
//     superseded version is snapshotted before and after the edit and compared
//     field by field: `superseded_by_id` moves and NOTHING else does. That is
//     §0.4's whole promise, and the only way to check it is to look at all 32
//     columns rather than at the two the test author remembered.
//   • THE CHAIN IS THE AUDIT TRAIL (LC-10). `previous_version_id` forward,
//     `superseded_by_id` back, exactly one current row throughout, and the
//     author of the data still readable one link behind the approver.
//   • APPROVE IS A VERSION, NOT A FLAG (LC-4) — and it is `data.approve`'s first
//     consumer. The audit row carries the §11.2 disclosure, and TEST-5's two
//     cases are separated: a solo admin approving their own entry writes
//     `self_approved: true`, an independent approver writes `false`.
//   • DELETION IS A TOMBSTONE (LC-6, К-21). Gone from the listing, alive in the
//     table.
//   • THE FREEZE IS A RULE, NOT A COPY (LC-5, VAL-010). A mutation against a
//     `submitted` or `locked` revision is refused with the rule code; a
//     `rejected` one is RESUMED through the state machine's seventh action, so
//     `report_revision.status` keeps exactly one writer.
//   • AC-2 HAS AN OWNER. A row with neither a facility nor a note is refused by
//     VAL-104; a note makes it legal.
//   • AC-4 (part 1) HAS AN OWNER. VAL-015 and VAL-016 are proven passing AND
//     failing on EVERY ONE of the five §4.9 categories — a table, not a
//     stationary row that happens to work.
//   • THE PARTIAL INDEX IS REAL. `EXPLAIN` of the current-rows listing names
//     `emission_activity_current_idx`. An assertion about the PLAN, never about
//     a duration.
//   • `all_rows_approved` HAS SUBJECTS NOW. T2.6 registered it as a real query
//     over an empty population; a draft row makes submit refuse, and approving
//     it makes submit pass — with no edit to `transition.ts`.
//
// AND, FROM T3.4, THE TWO THINGS THAT ONLY EXIST ACROSS THE FOUR TABLES:
//
//   • THE INVENTORY IS THE FOUR TABLES AND NOTHING ELSE (DM-14, D23). The sum of
//     the four per-table listings is COMPUTED and compared with the response
//     length rather than hard-coded, so a fifth source — or a forgotten branch —
//     breaks the equation. Current versions only, tombstones out, this company
//     only, including when the filter names another company's revision.
//   • SEEDING CROSSES THE REVISION BOUNDARY WITHOUT CROSSING THE APPROVAL ONE
//     (LC-9). Three current rows in, three fresh DRAFTS out, every column of the
//     source compared before and after; `previous_version_id` points back at the
//     row each copy came from, so `GET …/history` on a copy reaches into the
//     revision it was restated from; and an abandoned draft keeps its rows and
//     its stamp, it merely stops being `is_current` (D6).
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so this file is
// a green no-op in a DB-less CI.
import { and, asc, eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
  return harness.testDbModule();
});

import type { NextRequest } from "next/server";

import {
  DELETE as activityDELETE,
  GET as activityGET,
  PATCH as activityPATCH,
} from "@/app/api/activities/emission/[id]/route";
import { POST as approvePOST } from "@/app/api/activities/emission/[id]/approve/route";
import { GET as historyGET } from "@/app/api/activities/emission/[id]/history/route";
import {
  GET as activitiesGET,
  OPTIONS as activitiesOPTIONS,
  POST as activitiesPOST,
} from "@/app/api/activities/emission/route";
import {
  GET as inventoryGET,
  OPTIONS as inventoryOPTIONS,
} from "@/app/api/inventory/route";
import { POST as revisionsPOST } from "@/app/api/periods/[id]/revisions/route";
import { POST as transitionPOST } from "@/app/api/revisions/[id]/transition/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertDisclosure,
  insertEmissionActivity,
  insertEnergyActivity,
  insertFacility,
  insertInstrument,
  insertLegalEntity,
  insertPaidCompany,
  insertPeriod,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  auditLog,
  companyMembers,
  emissionActivity,
  reportRevision,
} from "@/server/db/schema";
import { ACTIVITY_CATEGORIES } from "@/server/inventory/emission-activity";
import {
  currentOnly,
  listCurrent,
  VERSION_CARRY_HOOKS,
} from "@/server/inventory/rows";
import { INPUT_TABLE_NAMES, inputTableAmong } from "@/server/inventory/tables";
import { runValidation } from "@/server/validation/run";
import type { CompanyRole } from "@/shared/roles";

// ─── Request plumbing (same shape as the T2.6 suite) ─────────────────────────

const request = (path: string): NextRequest =>
  new Request(`http://api.example.com${path}`) as NextRequest;

const jsonRequest = (
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): NextRequest =>
  new Request(`http://api.example.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as NextRequest;

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

/** The session `getSession()` would resolve for a user (PATTERN 3 identity). */
async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

/** Sign `userId` in for the next route call. */
async function signIn(userId: string): Promise<void> {
  getSessionMock.mockResolvedValue(await sessionFor(userId));
}

// ─── The graph every test starts from ────────────────────────────────────────

interface Fixture {
  companyId: string;
  userId: string;
  legalEntityId: string;
  facilityId: string;
  periodId: string;
  revisionId: string;
}

/**
 * A paid company (seats for a second member), one `esg_admin`, one legal entity
 * with a facility, a period whose boundary covers that entity, and a current
 * DRAFT revision. Signed in as the admin.
 */
async function setup(): Promise<Fixture> {
  const company = await insertPaidCompany();
  const { user } = await insertUserWithProfile({
    companyId: company.id,
    role: "esg_admin",
  });
  const entity = await insertLegalEntity(company.id);
  const site = await insertFacility(company.id, { legalEntityId: entity.id });
  const { period } = await insertPeriod(company.id, {
    legalEntityId: entity.id,
    createdBy: user.id,
  });
  const revision = await insertRevision(company.id, {
    periodId: period.id,
    createdBy: user.id,
  });
  await signIn(user.id);
  return {
    companyId: company.id,
    userId: user.id,
    legalEntityId: entity.id,
    facilityId: site.id,
    periodId: period.id,
    revisionId: revision.id,
  };
}

/** A second member of the same company with `role`. Does NOT sign them in. */
async function addMember(
  companyId: string,
  role: CompanyRole,
): Promise<string> {
  const { user } = await insertUserWithProfile({ companyId, role });
  return user.id;
}

/** Change a member's role — `actor_role` is a snapshot, roles move (§11.1). */
async function setRole(
  companyId: string,
  userId: string,
  role: CompanyRole,
): Promise<void> {
  await getTestDb()
    .update(companyMembers)
    .set({ role })
    .where(
      and(
        eq(companyMembers.companyId, companyId),
        eq(companyMembers.userId, userId),
      ),
    );
}

/** A minimal valid Scope-1 body: passes every blocking `record` rule. */
function activityBody(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    revision_id: fx.revisionId,
    legal_entity_id: fx.legalEntityId,
    facility_id: fx.facilityId,
    activity_category: "stationary_combustion",
    source_name: "Boiler 1",
    activity_type: "natural_gas",
    activity_value: 1000,
    method: "fuel_based",
    unit: "kWh",
    year_month: "2024-01",
    ...overrides,
  };
}

// ─── Route callers ───────────────────────────────────────────────────────────

async function postActivity(body: unknown) {
  const res = await activitiesPOST(
    jsonRequest("/api/activities/emission", "POST", body),
  );
  return { status: res.status, body: await res.json() };
}

async function listActivities(query = "") {
  const res = await activitiesGET(request(`/api/activities/emission${query}`));
  return { status: res.status, body: await res.json() };
}

async function patchActivity(id: string, body: unknown) {
  const res = await activityPATCH(
    jsonRequest(`/api/activities/emission/${id}`, "PATCH", body),
    ctxFor(id),
  );
  return { status: res.status, body: await res.json() };
}

async function deleteActivity(id: string, body?: unknown) {
  const res = await activityDELETE(
    jsonRequest(`/api/activities/emission/${id}`, "DELETE", body),
    ctxFor(id),
  );
  return { status: res.status, body: await res.json() };
}

async function approveActivity(id: string) {
  const res = await approvePOST(
    jsonRequest(`/api/activities/emission/${id}/approve`, "POST"),
    ctxFor(id),
  );
  return { status: res.status, body: await res.json() };
}

async function getHistory(id: string) {
  const res = await historyGET(
    request(`/api/activities/emission/${id}/history`),
    ctxFor(id),
  );
  return { status: res.status, body: await res.json() };
}

async function postTransition(revisionId: string, action: string, extra = {}) {
  const res = await transitionPOST(
    jsonRequest(`/api/revisions/${revisionId}/transition`, "POST", {
      action,
      ...extra,
    }),
    ctxFor(revisionId),
  );
  return { status: res.status, body: await res.json() };
}

/** GET the cross-table inventory (T3.4, DM-14). */
async function getInventory(query = "") {
  const res = await inventoryGET(request(`/api/inventory${query}`));
  return { status: res.status, body: await res.json() };
}

/** POST a new revision of a period — the LC-9 seed's entry point (T3.4). */
async function postRevision(periodId: string, body: unknown = {}) {
  const res = await revisionsPOST(
    jsonRequest(`/api/periods/${periodId}/revisions`, "POST", body),
    ctxFor(periodId),
  );
  return { status: res.status, body: await res.json() };
}

/** One row in each of the four input tables of a fixture's revision. */
async function insertAllFour(fx: Fixture): Promise<void> {
  const links = {
    revisionId: fx.revisionId,
    legalEntityId: fx.legalEntityId,
    actorId: fx.userId,
  };
  await insertEmissionActivity(fx.companyId, {
    ...links,
    facilityId: fx.facilityId,
  });
  await insertEnergyActivity(fx.companyId, links);
  await insertInstrument(fx.companyId, links);
  await insertDisclosure(fx.companyId, links);
}

// ─── Direct reads (the properties the API cannot show) ───────────────────────

async function storedRow(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(emissionActivity)
    .where(eq(emissionActivity.id, id));
  return row;
}

async function storedRows(revisionId: string) {
  return getTestDb()
    .select()
    .from(emissionActivity)
    .where(eq(emissionActivity.revisionId, revisionId))
    .orderBy(asc(emissionActivity.createdAt), asc(emissionActivity.id));
}

async function storedRevision(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(reportRevision)
    .where(eq(reportRevision.id, id));
  return row;
}

async function rowAudit(companyId: string) {
  return getTestDb()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.companyId, companyId),
        eq(auditLog.entity, "emission_activity"),
      ),
    )
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
}

/** Set a revision's status directly — the states the row service must refuse. */
async function forceStatus(revisionId: string, status: string): Promise<void> {
  await getTestDb()
    .update(reportRevision)
    .set({ status })
    .where(eq(reportRevision.id, revisionId));
}

/** The rule codes a 422 payload names. */
function codes(body: { rules?: { code: string }[] }): string[] {
  return (body.rules ?? []).map((rule) => rule.code);
}

/** Run the `record` rules against one row and read one code's verdict. */
async function verdict(
  companyId: string,
  rowId: string,
  code: string,
): Promise<boolean | undefined> {
  const records = await runValidation(getTestDb(), {
    companyId,
    scope: "record",
    targetId: rowId,
  });
  return records.find((record) => record.ruleCode === code)?.passed;
}

describeIntegration("activities/emission — append-only rows [LOCAL-DB]", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
    getSessionMock.mockReset();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  // ─── LC-3: creating a row ──────────────────────────────────────────────────

  describe("create (LC-3)", () => {
    it("writes a draft version stamped with the session actor", async () => {
      const fx = await setup();
      const created = await postActivity(activityBody(fx));

      expect(created.status).toBe(200);
      expect(created.body.data).toMatchObject({
        state: "draft",
        is_deleted: false,
        previous_version_id: null,
        superseded_by_id: null,
        actor_id: fx.userId,
        actor_role: "esg_admin",
        activity_category: "stationary_combustion",
        activity_value: 1000,
      });
      expect(created.body.data.approved_by).toBeNull();

      const listed = await listActivities(`?revision_id=${fx.revisionId}`);
      expect(listed.body.data.activities).toHaveLength(1);
    });

    it("refuses a body that names another company's revision (API-1)", async () => {
      const fx = await setup();
      const other = await insertPaidCompany();
      const foreign = await insertRevision(other.id);

      const created = await postActivity(
        activityBody(fx, { revision_id: foreign.id }),
      );
      expect(created.status).toBe(422);
      expect(created.body.error).toBe("VALIDATION");
      expect(await storedRows(foreign.id)).toHaveLength(0);
    });

    it("answers OPTIONS for the preflight (PATTERN 2)", async () => {
      const res = await activitiesOPTIONS(request("/api/activities/emission"));
      expect(res.status).toBe(204);
    });
  });

  // ─── LC-5: the version chain, and the ONE update ───────────────────────────

  describe("edit (LC-5) — a new version, and one mutated column", () => {
    it("links the chain and leaves exactly one current row", async () => {
      const fx = await setup();
      const first = (await postActivity(activityBody(fx))).body.data;

      const second = await patchActivity(first.id, { activity_value: 1500 });
      expect(second.status).toBe(200);
      expect(second.body.data.id).not.toBe(first.id);
      expect(second.body.data).toMatchObject({
        previous_version_id: first.id,
        superseded_by_id: null,
        state: "draft",
        activity_value: 1500,
        // The body carries forward: only `activity_value` was sent.
        source_name: "Boiler 1",
        year_month: "2024-01",
      });

      const stale = await storedRow(first.id);
      expect(stale.supersededById).toBe(second.body.data.id);

      const all = await storedRows(fx.revisionId);
      expect(all).toHaveLength(2);
      const current = await listCurrent(
        getTestDb(),
        fx.companyId,
        "emission_activity",
        { revisionId: fx.revisionId },
      );
      expect(current.map((row) => row.id)).toEqual([second.body.data.id]);
    });

    it("mutates NOTHING on the old version except superseded_by_id (§0.4)", async () => {
      const fx = await setup();
      const first = (await postActivity(activityBody(fx))).body.data;

      const before = await storedRow(first.id);
      const second = await patchActivity(first.id, {
        activity_value: 42,
        source_name: "Boiler 2",
        notes: "corrected from the invoice",
        year_month: "2024-02",
      });
      expect(second.status).toBe(200);
      const after = await storedRow(first.id);

      // EVERY column, not the two we remembered: the diff must be exactly one
      // key, and that key must be `superseded_by_id`.
      const changed = Object.keys(before).filter(
        (column) =>
          JSON.stringify((before as Record<string, unknown>)[column]) !==
          JSON.stringify((after as Record<string, unknown>)[column]),
      );
      expect(changed).toEqual(["supersededById"]);
      expect(before.supersededById).toBeNull();
      expect(after.supersededById).toBe(second.body.data.id);
    });

    it("refuses to edit a version that is already superseded", async () => {
      const fx = await setup();
      const first = (await postActivity(activityBody(fx))).body.data;
      await patchActivity(first.id, { activity_value: 2 });

      const stale = await patchActivity(first.id, { activity_value: 3 });
      expect(stale.status).toBe(422);
      expect(await storedRows(fx.revisionId)).toHaveLength(2);
    });

    it("returns any version by id, superseded ones included", async () => {
      const fx = await setup();
      const first = (await postActivity(activityBody(fx))).body.data;
      const second = (await patchActivity(first.id, { activity_value: 7 })).body
        .data;

      const old = await activityGET(
        request(`/api/activities/emission/${first.id}`),
        ctxFor(first.id),
      );
      expect(old.status).toBe(200);
      expect((await old.json()).data.superseded_by_id).toBe(second.id);
    });
  });

  // ─── LC-5: superseding an APPROVED version states why ──────────────────────

  describe("editing an approved row (LC-5)", () => {
    it("refuses without change_reason and succeeds with one", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;
      const approved = (await approveActivity(draft.id)).body.data;
      expect(approved.state).toBe("approved");

      const bare = await patchActivity(approved.id, { activity_value: 2000 });
      expect(bare.status).toBe(422);
      expect(bare.body).toMatchObject({
        field: "change_reason",
        reason: "approved_row_needs_reason",
      });
      // Refused writes leave NOTHING behind (VR-3).
      expect(await storedRows(fx.revisionId)).toHaveLength(2);

      const withReason = await patchActivity(approved.id, {
        activity_value: 2000,
        change_reason: "supplier reissued the invoice",
      });
      expect(withReason.status).toBe(200);
      expect(withReason.body.data).toMatchObject({
        state: "draft",
        change_reason: "supplier reissued the invoice",
        previous_version_id: approved.id,
        activity_value: 2000,
      });
      expect(withReason.body.data.approved_by).toBeNull();
    });

    it("needs no reason while the row is still a draft", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;
      const edited = await patchActivity(draft.id, { activity_value: 5 });
      expect(edited.status).toBe(200);
      expect(edited.body.data.change_reason).toBeNull();
    });
  });

  // ─── LC-4: approve is a version ────────────────────────────────────────────

  describe("approve (LC-4) — a new version, and the author stays visible", () => {
    it("stamps state/approved_by/at on a successor and keeps the author", async () => {
      const fx = await setup();
      const author = fx.userId;
      const draft = (await postActivity(activityBody(fx))).body.data;

      const approverId = await addMember(fx.companyId, "approver");
      await signIn(approverId);
      const approved = await approveActivity(draft.id);

      expect(approved.status).toBe(200);
      expect(approved.body.data).toMatchObject({
        id: expect.not.stringMatching(draft.id),
        state: "approved",
        approved_by: approverId,
        previous_version_id: draft.id,
        superseded_by_id: null,
        // LC-4: the head's actor is the APPROVER…
        actor_id: approverId,
        actor_role: "approver",
      });
      expect(approved.body.data.approved_at).not.toBeNull();

      // …and the author of the data is one link back down the chain.
      const previous = await storedRow(draft.id);
      expect(previous.actorId).toBe(author);
      expect(previous.supersededById).toBe(approved.body.data.id);
    });

    it("refuses a second approve of the same row", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;
      const approved = (await approveActivity(draft.id)).body.data;

      const again = await approveActivity(approved.id);
      expect(again.status).toBe(422);
      expect(again.body.reason).toBe("already_approved");
    });

    it("refuses a role without data.approve (403 before anything else)", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;

      // A second member with `data.approve` removes the D13 grant from the
      // admin, so `contributor` is judged on the matrix alone.
      await addMember(fx.companyId, "approver");
      const contributorId = await addMember(fx.companyId, "contributor");
      await signIn(contributorId);

      const denied = await approveActivity(draft.id);
      expect(denied.status).toBe(403);
      expect((await storedRow(draft.id)).state).toBe("draft");
    });
  });

  // ─── LC-7 / §11.2 / TEST-5: the self-approval disclosure ───────────────────

  describe("the approval disclosure (LC-7, §11.2) — data.approve's first consumer", () => {
    it("writes self_approved=true when one person entered and approved", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;
      const approved = await approveActivity(draft.id);
      expect(approved.status).toBe(200);

      const entries = await rowAudit(fx.companyId);
      expect(entries).toHaveLength(1);
      expect(entries[0].entityId).toBe(approved.body.data.id);
      expect(entries[0].userId).toBe(fx.userId);
      expect(entries[0].actorRole).toBe("esg_admin");
      expect(entries[0].summary).toMatchObject({
        action: "approve_row",
        table: "emission_activity",
        previous_version_id: draft.id,
        // The solo `esg_admin` holds `data.approve` only through the D13
        // compensating grant, which is itself a disclosure (§Q3).
        approval_grant: true,
        self_approved: true,
        independent_review: false,
        approvers_count: 0,
      });
    });

    it("writes self_approved=false for an independent approver", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;

      const approverId = await addMember(fx.companyId, "approver");
      await signIn(approverId);
      const approved = await approveActivity(draft.id);
      expect(approved.status).toBe(200);

      const entries = await rowAudit(fx.companyId);
      expect(entries).toHaveLength(1);
      expect(entries[0].userId).toBe(approverId);
      expect(entries[0].summary).toMatchObject({
        approval_grant: false,
        self_approved: false,
        independent_review: true,
        approvers_count: 1,
        active_member_count: 2,
      });
    });

    it("sees authorship EARLIER in the chain, not only on the last version", async () => {
      const fx = await setup();
      // The person who will approve wrote the FIRST version, back when they
      // were a contributor; somebody else made the last edit. No role in the
      // §6.2 matrix carries `data.write` and `data.approve` at once, so the only
      // way one human is both author and approver — the case LC-7 is about — is
      // that their role CHANGED. `actor_role` on each version is a snapshot,
      // and the chain is what remembers.
      const personId = await addMember(fx.companyId, "contributor");
      await signIn(personId);
      const first = (await postActivity(activityBody(fx))).body.data;
      expect(first.actor_id).toBe(personId);

      await setRole(fx.companyId, personId, "approver");
      await signIn(fx.userId);
      const second = (await patchActivity(first.id, { activity_value: 12 }))
        .body.data;
      expect(second.actor_id).toBe(fx.userId);

      await signIn(personId);
      const approved = await approveActivity(second.id);
      expect(approved.status).toBe(200);

      const entries = await rowAudit(fx.companyId);
      expect(entries[0].summary).toMatchObject({
        // NOT the D13 grant: an `approver` exists, so nothing is compensated.
        // The flag is true purely because the chain walk found this actor.
        approval_grant: false,
        self_approved: true,
        independent_review: false,
      });
    });
  });

  // ─── LC-6: deletion is a tombstone ─────────────────────────────────────────

  describe("delete (LC-6, К-21)", () => {
    it("hides the row from the listing and keeps it in the table", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;

      const deleted = await deleteActivity(draft.id);
      expect(deleted.status).toBe(200);
      expect(deleted.body.data).toMatchObject({
        is_deleted: true,
        previous_version_id: draft.id,
        superseded_by_id: null,
      });

      const listed = await listActivities(`?revision_id=${fx.revisionId}`);
      expect(listed.body.data.activities).toEqual([]);
      expect(
        await listCurrent(getTestDb(), fx.companyId, "emission_activity", {
          revisionId: fx.revisionId,
        }),
      ).toEqual([]);

      // Physically alive: both versions, and the tombstone reachable by id.
      expect(await storedRows(fx.revisionId)).toHaveLength(2);
      const tombstone = await storedRow(deleted.body.data.id);
      expect(tombstone.isDeleted).toBe(true);
      expect((await storedRow(draft.id)).supersededById).toBe(tombstone.id);
    });

    it("demands a reason when the row being removed was approved", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;
      const approved = (await approveActivity(draft.id)).body.data;

      const bare = await deleteActivity(approved.id);
      expect(bare.status).toBe(422);
      expect(bare.body.field).toBe("change_reason");

      const withReason = await deleteActivity(approved.id, {
        change_reason: "double entry",
      });
      expect(withReason.status).toBe(200);
      expect(withReason.body.data.change_reason).toBe("double entry");
    });

    it("refuses to edit or approve a tombstone", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;
      const tombstone = (await deleteActivity(draft.id)).body.data;

      expect(
        (await patchActivity(tombstone.id, { activity_value: 1 })).status,
      ).toBe(422);
      expect((await approveActivity(tombstone.id)).status).toBe(422);
    });
  });

  // ─── API-2: the history of a chain ─────────────────────────────────────────

  describe("history (API-2, LC-10)", () => {
    it("returns every version, oldest first, from ANY version's id", async () => {
      const fx = await setup();
      const first = (await postActivity(activityBody(fx))).body.data;
      const second = (await patchActivity(first.id, { activity_value: 2 })).body
        .data;
      const third = (await approveActivity(second.id)).body.data;

      const fromHead = await getHistory(third.id);
      expect(fromHead.status).toBe(200);
      expect(
        fromHead.body.data.versions.map((v: { id: string }) => v.id),
      ).toEqual([first.id, second.id, third.id]);
      expect(fromHead.body.data.truncated).toBe(false);

      // A stale id (the first version) yields the SAME chain.
      const fromRoot = await getHistory(first.id);
      expect(
        fromRoot.body.data.versions.map((v: { id: string }) => v.id),
      ).toEqual([first.id, second.id, third.id]);
    });

    it("is 404 for an id that is not this company's", async () => {
      await setup();
      const other = await insertPaidCompany();
      const foreign = await insertEmissionActivity(other.id);
      expect((await getHistory(foreign.id)).status).toBe(404);
    });
  });

  // ─── AC-2: VAL-104 ─────────────────────────────────────────────────────────

  describe("AC-2 — a row with no site documents the exception (VAL-104)", () => {
    it("refuses without facility_id and without notes, accepts with notes", async () => {
      const fx = await setup();

      const bare = await postActivity(
        activityBody(fx, { facility_id: null, notes: null }),
      );
      expect(bare.status).toBe(422);
      expect(codes(bare.body)).toContain("VAL-104");
      expect(await storedRows(fx.revisionId)).toHaveLength(0);

      const documented = await postActivity(
        activityBody(fx, {
          facility_id: null,
          notes: "leased office, landlord bills the whole building",
        }),
      );
      expect(documented.status).toBe(200);
      expect(documented.body.data.facility_id).toBeNull();
      expect(
        await verdict(fx.companyId, documented.body.data.id, "VAL-104"),
      ).toBe(true);
    });
  });

  // ─── AC-4 (part 1): VAL-015 and VAL-016 on all five categories ─────────────

  describe("AC-4 (part 1) — VAL-015 and VAL-016 across all five §4.9 categories", () => {
    /**
     * The table. One PASS and one FAIL per rule per category, so neither rule
     * can be "covered" by the stationary row that happens to be everybody's
     * example. `unit: null` is how a row says it has no input at all (VAL-015);
     * a method that contradicts the unit it was given is VAL-016's subject.
     */
    const CASES = [
      {
        category: "stationary_combustion",
        activityType: "natural_gas",
        val015Pass: { method: "fuel_based", unit: "kWh" },
        val015Fail: { method: "fuel_based", unit: null },
        val016Pass: { method: "fuel_based", unit: "kWh" },
        val016Fail: { method: "distance_based", unit: "kWh" },
      },
      {
        category: "mobile_combustion",
        activityType: "car_petrol_small",
        val015Pass: { method: "distance_based", unit: "km" },
        val015Fail: { method: "distance_based", unit: null },
        val016Pass: { method: "distance_based", unit: "km" },
        val016Fail: { method: "distance_based", unit: "L" },
      },
      {
        category: "fugitive_emissions",
        activityType: "r134a",
        // A mass balance's input is the К-5 column group, not the unit.
        val015Pass: { method: "mass_balance", unit: null, openingStock: "10" },
        val015Fail: { method: "mass_balance", unit: null },
        val016Pass: { method: "fuel_based", unit: "kg" },
        val016Fail: { method: "distance_based", unit: "kg" },
      },
      {
        category: "process_emissions",
        activityType: "industrial_process",
        val015Pass: { method: "activity_based", unit: "t" },
        val015Fail: { method: "activity_based", unit: null },
        val016Pass: { method: "fuel_based", unit: "t" },
        val016Fail: { method: "distance_based", unit: "t" },
      },
      {
        category: "onsite_generation",
        activityType: "natural_gas",
        val015Pass: { method: "fuel_based", unit: "kWh" },
        val015Fail: { method: "fuel_based", unit: null },
        val016Pass: { method: "fuel_based", unit: "kWh" },
        val016Fail: { method: "distance_based", unit: "kWh" },
      },
    ] as const;

    it("covers every category of the CHECK constraint", () => {
      expect(CASES.map((row) => row.category).sort()).toEqual(
        [...ACTIVITY_CATEGORIES].sort(),
      );
    });

    for (const row of CASES) {
      for (const [code, pass, fail] of [
        ["VAL-015", row.val015Pass, row.val015Fail],
        ["VAL-016", row.val016Pass, row.val016Fail],
      ] as const) {
        it(`${code} passes and fails on ${row.category}`, async () => {
          const fx = await setup();
          const base = {
            revisionId: fx.revisionId,
            legalEntityId: fx.legalEntityId,
            facilityId: fx.facilityId,
            activityCategory: row.category,
            activityType: row.activityType,
            activityValue: "100",
          };
          const good = await insertEmissionActivity(fx.companyId, {
            ...base,
            ...pass,
          });
          const bad = await insertEmissionActivity(fx.companyId, {
            ...base,
            ...fail,
          });

          expect(await verdict(fx.companyId, good.id, code)).toBe(true);
          expect(await verdict(fx.companyId, bad.id, code)).toBe(false);
        });
      }
    }
  });

  // ─── The other record rules ────────────────────────────────────────────────

  describe("the rest of the record family", () => {
    it("VAL-011 accepts zero and refuses a negative quantity", async () => {
      const fx = await setup();
      expect(
        (await postActivity(activityBody(fx, { activity_value: 0 }))).status,
      ).toBe(200);

      const negative = await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
        legalEntityId: fx.legalEntityId,
        facilityId: fx.facilityId,
        activityValue: "-5",
      });
      expect(await verdict(fx.companyId, negative.id, "VAL-011")).toBe(false);
    });

    it("VAL-014 reads the pinned factor set, not a hand-written list", async () => {
      const fx = await setup();
      const links = {
        revisionId: fx.revisionId,
        legalEntityId: fx.legalEntityId,
        facilityId: fx.facilityId,
      };
      // `m3` is a priced `input_unit` for natural gas; `kWh` reaches one through
      // a `unit_conversion` edge; `t` reaches neither.
      const direct = await insertEmissionActivity(fx.companyId, {
        ...links,
        activityType: "natural_gas",
        unit: "m3",
      });
      const converted = await insertEmissionActivity(fx.companyId, {
        ...links,
        activityType: "natural_gas",
        unit: "kWh",
      });
      const unsupported = await insertEmissionActivity(fx.companyId, {
        ...links,
        activityType: "natural_gas",
        unit: "t",
      });

      expect(await verdict(fx.companyId, direct.id, "VAL-014")).toBe(true);
      expect(await verdict(fx.companyId, converted.id, "VAL-014")).toBe(true);
      expect(await verdict(fx.companyId, unsupported.id, "VAL-014")).toBe(
        false,
      );
    });

    it("VAL-019 refuses a refrigerant the pinned set does not price", async () => {
      const fx = await setup();
      const links = {
        revisionId: fx.revisionId,
        legalEntityId: fx.legalEntityId,
        facilityId: fx.facilityId,
        activityCategory: "fugitive_emissions" as const,
        unit: "kg",
      };
      const priced = await insertEmissionActivity(fx.companyId, {
        ...links,
        activityType: "r134a",
      });
      const unpriced = await insertEmissionActivity(fx.companyId, {
        ...links,
        activityType: "r-nonexistent",
      });
      expect(await verdict(fx.companyId, priced.id, "VAL-019")).toBe(true);
      expect(await verdict(fx.companyId, unpriced.id, "VAL-019")).toBe(false);
    });

    it("VAL-018 warns on a negative refrigerant mass balance", async () => {
      const fx = await setup();
      const links = {
        revisionId: fx.revisionId,
        legalEntityId: fx.legalEntityId,
        facilityId: fx.facilityId,
        activityCategory: "fugitive_emissions" as const,
        activityType: "r134a",
        unit: "kg",
      };
      const balanced = await insertEmissionActivity(fx.companyId, {
        ...links,
        openingStock: "10",
        refrigerantAdded: "5",
        refrigerantRecovered: "2",
        closingStock: "11",
      });
      const impossible = await insertEmissionActivity(fx.companyId, {
        ...links,
        openingStock: "10",
        refrigerantAdded: "0",
        refrigerantRecovered: "5",
        closingStock: "20",
      });
      expect(await verdict(fx.companyId, balanced.id, "VAL-018")).toBe(true);
      expect(await verdict(fx.companyId, impossible.id, "VAL-018")).toBe(false);
      // A warning never refuses a write.
      expect(
        (
          await postActivity(
            activityBody(fx, {
              activity_category: "fugitive_emissions",
              activity_type: "r134a",
              unit: "kg",
              method: "mass_balance",
              opening_stock: 10,
              refrigerant_added: 0,
              refrigerant_recovered: 5,
              closing_stock: 20,
            }),
          )
        ).status,
      ).toBe(200);
    });

    it("VAL-007 and VAL-012 warn without refusing", async () => {
      const fx = await setup();
      const closed = await insertFacility(fx.companyId, {
        legalEntityId: fx.legalEntityId,
        openingDate: "2020-01-01",
        closingDate: "2021-12-31",
      });
      const late = await postActivity(
        activityBody(fx, { facility_id: closed.id, year_month: "2024-06" }),
      );
      expect(late.status).toBe(200);
      expect(await verdict(fx.companyId, late.body.data.id, "VAL-007")).toBe(
        false,
      );

      const outside = await postActivity(
        activityBody(fx, { year_month: "2025-06" }),
      );
      expect(outside.status).toBe(200);
      expect(await verdict(fx.companyId, outside.body.data.id, "VAL-012")).toBe(
        false,
      );
    });
  });

  // ─── LC-5 / VAL-010: the freeze, and the resume ────────────────────────────

  describe("the freeze (VAL-010) and the resume (LC-1)", () => {
    for (const status of ["submitted", "in_review", "approved", "locked"]) {
      it(`refuses a mutation while the revision is ${status}`, async () => {
        const fx = await setup();
        const draft = (await postActivity(activityBody(fx))).body.data;
        await forceStatus(fx.revisionId, status);

        const created = await postActivity(activityBody(fx));
        expect(created.status).toBe(422);
        expect(codes(created.body)).toContain("VAL-010");

        const edited = await patchActivity(draft.id, { activity_value: 9 });
        expect(edited.status).toBe(422);
        expect(codes(edited.body)).toContain("VAL-010");

        const removed = await deleteActivity(draft.id);
        expect(removed.status).toBe(422);
        expect(codes(removed.body)).toContain("VAL-010");

        // Nothing was written by any of the three refusals.
        expect(await storedRows(fx.revisionId)).toHaveLength(1);
        expect((await storedRow(draft.id)).supersededById).toBeNull();
      });
    }

    it("refuses a write aimed at a SUPERSEDED revision while a restatement is open", async () => {
      // Партия 25 — the prod gap. Revision 1 is locked and no longer current;
      // revision 2 is the open restatement, so the PERIOD reads as editable. A
      // write sent to revision 1 must still be refused: that is the revision a
      // published report was rendered from.
      const fx = await setup();
      const old = (await postActivity(activityBody(fx))).body.data;
      await getTestDb()
        .update(reportRevision)
        .set({ status: "locked", isCurrent: false })
        .where(eq(reportRevision.id, fx.revisionId));
      const restatement = await insertRevision(fx.companyId, {
        periodId: fx.periodId,
        createdBy: fx.userId,
        revisionNo: 2,
        status: "draft",
        isCurrent: true,
      });

      const created = await postActivity(activityBody(fx));
      expect(created.status).toBe(422);
      expect(codes(created.body)).toContain("VAL-010");

      const edited = await patchActivity(old.id, { activity_value: 9 });
      expect(edited.status).toBe(422);
      expect(codes(edited.body)).toContain("VAL-010");

      const removed = await deleteActivity(old.id);
      expect(removed.status).toBe(422);
      expect(codes(removed.body)).toContain("VAL-010");

      expect(await storedRows(fx.revisionId)).toHaveLength(1);
      expect((await storedRow(old.id)).supersededById).toBeNull();

      // …and the restatement itself is open for business.
      const fresh = await postActivity(
        activityBody({ ...fx, revisionId: restatement.id }),
      );
      expect(fresh.status).toBe(200);
    });

    it("resumes a REJECTED revision through the state machine, not by hand", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;
      await forceStatus(fx.revisionId, "rejected");

      const edited = await patchActivity(draft.id, { activity_value: 3 });
      expect(edited.status).toBe(200);
      expect((await storedRevision(fx.revisionId)).status).toBe("draft");

      // The transition is audited as a transition — `resume` is a row of the
      // §5.1 matrix, not a side effect of an edit.
      const entries = await getTestDb()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.companyId, fx.companyId),
            eq(auditLog.entity, "report_revision"),
          ),
        );
      expect(
        entries.map((entry) => (entry.summary as { action?: string }).action),
      ).toContain("resume");
    });

    it("declares the table it mutates, which is what makes VAL-010 speak", () => {
      expect(inputTableAmong(["emission_activity"])).toBe("emission_activity");
      expect(inputTableAmong(["start_date", "period_scope"])).toBeUndefined();
      expect(INPUT_TABLE_NAMES).toHaveLength(4);
    });
  });

  // ─── T2.6's `all_rows_approved`, now that it has subjects ──────────────────

  describe("all_rows_approved (§5.1) — vacuously true until now", () => {
    it("blocks submit while a row is a draft and passes once approved", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;

      const blocked = await postTransition(fx.revisionId, "submit");
      expect(blocked.status).toBe(422);
      expect(blocked.body.transition).toMatchObject({
        precondition: "all_rows_approved",
        reason: "rows_not_approved",
        rows: 1,
        approved: 0,
        pending: 1,
      });

      await approveActivity(draft.id);
      const allowed = await postTransition(fx.revisionId, "submit");
      expect(allowed.status).toBe(200);
      expect((await storedRevision(fx.revisionId)).status).toBe("submitted");
    });

    it("does not count a tombstone as pending (LC-6)", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;
      await deleteActivity(draft.id);

      const allowed = await postTransition(fx.revisionId, "submit");
      expect(allowed.status).toBe(200);
    });
  });

  // ─── DM-12: the partial index is used, not merely declared ────────────────

  describe("the partial index (DM-12, §4.21)", () => {
    // WHAT THIS BLOCK IS FOR, AND WHAT IT DELIBERATELY NO LONGER ASKS.
    //
    // R-1's subject is a PAIR: `<table>_current_idx` is a partial index whose
    // `WHERE` must be the predicate `listCurrent` issues, and nothing in the
    // toolchain compares the two — edit one side and the other silently stops
    // being usable. That is the question worth a test.
    //
    // It used to be asked by ranking two candidate indexes with EXPLAIN, and
    // that was a coin flip. On 120 rows the estimated costs of
    // `emission_activity_current_idx` and `emission_activity_company_month_idx`
    // differ by under 10%, and one of the inputs to the cheaper one is
    // `pg_stats.correlation` for `revision_id` — which depends on the sort order
    // of three RANDOMLY GENERATED uuids. Six orderings, all equally likely, and
    // roughly a quarter of them flip the plan. A retry would not have fixed it:
    // the test was asking which index is cheaper, and the answer is genuinely
    // "it depends on the uuids".
    //
    // So the question is asked directly instead, in two halves that fail for
    // two different edits:
    //   1. the index's OWN predicate, read out of `pg_index`, is exactly the SQL
    //      `currentOnly()` builds — the two sides of R-1, compared;
    //   2. with the rival index removed (inside a transaction that is rolled
    //      back), the planner really does answer that predicate FROM the partial
    //      index — which is only possible if Postgres considers the index's
    //      predicate to imply the query's. Divergent predicates leave the index
    //      unusable and the plan falls back to a penalised sequential scan.

    /**
     * The plan, carried out of a transaction that must NOT commit.
     *
     * Drizzle rolls a transaction back when its callback throws, and there is no
     * other way to undo the `DROP INDEX` below with certainty — a `CREATE INDEX`
     * in a `finally` would itself have to succeed, and a suite that leaves the
     * schema one index short breaks every later file with a plan nobody can
     * explain. So the result travels as the error.
     */
    class PlanProbe extends Error {
      constructor(readonly plan: string) {
        super("plan probe — this transaction is rolled back on purpose");
      }
    }

    /** The `WHERE` of a partial index, as Postgres itself renders it. */
    async function indexPredicate(name: string): Promise<string> {
      const [row] = await getTestDb().execute<{ predicate: string | null }>(sql`
        SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = ${name}
      `);
      expect(row, `no index named ${name}`).toBeDefined();
      return row.predicate ?? "";
    }

    it("carries the predicate `listCurrent` issues, verbatim (R-1)", async () => {
      // The application's half, built by the FUNCTION the listing calls rather
      // than re-typed here: change `currentOnly` and this side changes with it,
      // so the assertion keeps asking about the pair instead of about a string.
      const query = getTestDb()
        .select({ id: emissionActivity.id })
        .from(emissionActivity)
        .where(currentOnly("emission_activity"))
        .toSQL();
      expect(query.sql).toContain('"superseded_by_id" is null');

      // …and the database's half. `pg_get_expr` prints the predicate the index
      // was actually created with, so this is the migration's text and not the
      // declaration's.
      expect(await indexPredicate("emission_activity_current_idx")).toBe(
        "(superseded_by_id IS NULL)",
      );
    });

    it("can answer that predicate — the planner uses it (DM-12)", async () => {
      const fx = await setup();
      // Three revisions of the same company, so `revision_id` is genuinely more
      // selective than `company_id` — the situation the partial index exists for
      // and the one a real tenant is in.
      const revisions = [fx.revisionId];
      for (const revisionNo of [2, 3]) {
        const extra = await insertRevision(fx.companyId, {
          periodId: fx.periodId,
          revisionNo,
          isCurrent: false,
        });
        revisions.push(extra.id);
      }
      for (const revisionId of revisions) {
        for (let i = 0; i < 40; i += 1) {
          await insertEmissionActivity(fx.companyId, {
            revisionId,
            legalEntityId: fx.legalEntityId,
            facilityId: fx.facilityId,
          });
        }
      }
      await getTestDb().execute(sql`ANALYZE emission_activity`);

      const plan = await getTestDb()
        .transaction(async (tx) => {
          // The rival leaves the comparison rather than losing it by a hair.
          // `emission_activity_company_month_idx` leads with `company_id`, which
          // this query also filters on, so it is a legitimate alternative whose
          // cost lands within a few percent of the partial index's — and the
          // margin, not the predicate, is what decided the old assertion. Dropped
          // inside a transaction, so the rollback below puts it back whatever
          // happens; DDL is transactional in Postgres and the suite runs its
          // files sequentially (`vitest.config.ts`), so nothing else is looking.
          await tx.execute(sql`DROP INDEX emission_activity_company_month_idx`);
          // A sequential scan is genuinely cheapest on 120 rows, and asserting a
          // DURATION would be a flaky test about hardware. Disabling the scan
          // alternatives is not a cheat: it makes the plan say WHICH access path
          // can answer the predicate at all.
          await tx.execute(sql`SET LOCAL enable_seqscan = off`);
          await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
          const rows = await tx.execute<Record<string, string>>(sql`
          EXPLAIN SELECT id FROM emission_activity
           WHERE company_id = ${fx.companyId}
             AND revision_id = ${fx.revisionId}
             AND superseded_by_id IS NULL
             AND is_deleted = false
        `);
          const text = [...rows].map((row) => row["QUERY PLAN"]).join("\n");
          // Roll the DROP back by failing the transaction, and carry the plan out
          // through the error rather than returning it (a committed transaction
          // would leave the schema one index short for every later suite).
          throw new PlanProbe(text);
        })
        .catch((error: unknown) => {
          if (error instanceof PlanProbe) return error.plan;
          throw error;
        });

      expect(plan).toContain("emission_activity_current_idx");
      expect(plan).toMatch(/Index (Only )?Scan/);

      // The rollback really did put the rival back — otherwise this suite would
      // quietly hand a mutilated schema to the next one.
      const [restored] = await getTestDb().execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_class
             WHERE relname = 'emission_activity_company_month_idx'`,
      );
      expect(restored.n).toBe(1);
    });
  });

  // ─── The S4 seam ──────────────────────────────────────────────────────────

  describe("the S4 carry seam", () => {
    it("pins the registered set BY NAME", () => {
      // T4.2 appended `carry_evidence_links`, T4.3 `carry_dq_assessment`. The
      // list is asserted rather than counted so that adding a hook is a
      // deliberate edit here — a side effect that starts copying rows on every
      // version must not be able to arrive unnamed.
      expect(VERSION_CARRY_HOOKS.map((hook) => hook.name)).toEqual([
        "carry_evidence_links",
        "carry_dq_assessment",
      ]);
    });
  });

  // ─── T3.4: the cross-table inventory (DM-14, API-2) ───────────────────────

  describe("the cross-table inventory (DM-14, API-2)", () => {
    it("is the four tables and exactly the four tables", async () => {
      const fx = await setup();
      await insertAllFour(fx);

      const res = await getInventory();
      expect(res.status).toBe(200);
      expect(res.body.data.truncated).toBe(false);

      // The acceptance criterion, computed rather than hard-coded: the four
      // per-table listings ARE the inventory, so their sum is its length. A
      // fifth table (D23 forbids one) or a forgotten branch changes one side of
      // this equation and not the other.
      const perTable = await Promise.all(
        INPUT_TABLE_NAMES.map((table) =>
          listCurrent(getTestDb(), fx.companyId, table),
        ),
      );
      const total = perTable.reduce((sum, rows) => sum + rows.length, 0);
      expect(total).toBe(4);
      expect(res.body.data.inventory).toHaveLength(total);
      expect(
        res.body.data.inventory
          .map((row: { source_table: string }) => row.source_table)
          .sort(),
      ).toEqual([...INPUT_TABLE_NAMES].sort());
    });

    it("carries the mixin, the source table and a short body summary", async () => {
      const fx = await setup();
      const created = await postActivity(
        activityBody(fx, { source_name: "Boiler 7", activity_value: 1234.5 }),
      );

      const row = (await getInventory()).body.data.inventory[0];
      expect(row).toMatchObject({
        id: created.body.data.id,
        source_table: "emission_activity",
        revision_id: fx.revisionId,
        legal_entity_id: fx.legalEntityId,
        facility_id: fx.facilityId,
        year_month: "2024-01",
        unit: "kWh",
        state: "draft",
        is_deleted: false,
        actor_id: fx.userId,
        // The body, reduced to the triple: what kind, which one, how much.
        kind: "stationary_combustion",
        label: "Boiler 7",
        quantity: 1234.5,
      });
      // `created_at` survives the UNION as a real timestamp, not a string the
      // serialiser would have thrown on.
      expect(typeof row.created_at).toBe("string");
      expect(row.created_at).toBe(created.body.data.created_at);
    });

    it("truncates a long narrative label instead of shipping it whole", async () => {
      const fx = await setup();
      await insertDisclosure(fx.companyId, {
        revisionId: fx.revisionId,
        legalEntityId: fx.legalEntityId,
        actorId: fx.userId,
        valueText: "x".repeat(500),
      });

      const row = (await getInventory()).body.data.inventory[0];
      expect(row.source_table).toBe("disclosure_record");
      expect(row.label).toHaveLength(120);
      expect(row.quantity).toBeNull();
    });

    it("shows only the CURRENT version of a row, and drops its tombstone", async () => {
      const fx = await setup();
      const created = await postActivity(activityBody(fx));
      const edited = await patchActivity(created.body.data.id, {
        activity_value: 2000,
      });

      // Two versions in the table, one row in the inventory — and it is the
      // successor, not the version the client first got back.
      expect(await storedRows(fx.revisionId)).toHaveLength(2);
      const listed = (await getInventory()).body.data.inventory;
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(edited.body.data.id);
      expect(listed[0].quantity).toBe(2000);

      await deleteActivity(edited.body.data.id);
      expect(await storedRows(fx.revisionId)).toHaveLength(3);
      expect((await getInventory()).body.data.inventory).toHaveLength(0);
    });

    it("never crosses the tenant boundary", async () => {
      const fx = await setup();
      await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
        legalEntityId: fx.legalEntityId,
      });

      const other = await insertPaidCompany();
      const otherRevision = await insertRevision(other.id);
      await insertEmissionActivity(other.id, { revisionId: otherRevision.id });
      await insertDisclosure(other.id, { revisionId: otherRevision.id });

      // Still signed in as the first company's admin (PATTERN 3 — the tenant is
      // the session, never a parameter), including when the FILTER names the
      // other company's revision.
      const mine = await getInventory();
      expect(mine.body.data.inventory).toHaveLength(1);
      expect(
        (await getInventory(`?revision_id=${otherRevision.id}`)).body.data
          .inventory,
      ).toHaveLength(0);
    });

    it("filters by revision, entity, facility, month and state", async () => {
      const fx = await setup();
      const otherEntity = await insertLegalEntity(fx.companyId);
      const otherRevision = await insertRevision(fx.companyId, {
        periodId: fx.periodId,
        revisionNo: 2,
        isCurrent: false,
      });

      await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
        legalEntityId: fx.legalEntityId,
        facilityId: fx.facilityId,
        yearMonth: "2024-01",
      });
      await insertEnergyActivity(fx.companyId, {
        revisionId: fx.revisionId,
        legalEntityId: otherEntity.id,
        yearMonth: "2024-02",
        state: "approved",
      });
      await insertInstrument(fx.companyId, {
        revisionId: otherRevision.id,
        legalEntityId: fx.legalEntityId,
      });

      const count = async (query: string) =>
        (await getInventory(query)).body.data.inventory.length;

      expect(await count("")).toBe(3);
      expect(await count(`?revision_id=${fx.revisionId}`)).toBe(2);
      expect(await count(`?legal_entity_id=${otherEntity.id}`)).toBe(1);
      expect(await count(`?facility_id=${fx.facilityId}`)).toBe(1);
      expect(await count("?year_month=2024-02")).toBe(1);
      expect(await count("?state=approved")).toBe(1);
      expect(await count("?state=draft")).toBe(2);
      // AND-ed, not OR-ed.
      expect(await count(`?revision_id=${fx.revisionId}&state=approved`)).toBe(
        1,
      );
    });

    it("has an approval queue that is the drafts and only the drafts", async () => {
      const fx = await setup();
      const first = await postActivity(activityBody(fx));
      await postActivity(activityBody(fx, { source_name: "Boiler 2" }));
      const approved = await approveActivity(first.body.data.id);
      expect(approved.status).toBe(200);
      // A tombstone is not "awaiting approval" either.
      const third = await postActivity(
        activityBody(fx, { source_name: "Boiler 3" }),
      );
      await deleteActivity(third.body.data.id);

      const queue = (await getInventory("?queue=1")).body.data.inventory;
      expect(queue).toHaveLength(1);
      expect(queue[0].state).toBe("draft");
      expect(queue[0].label).toBe("Boiler 2");
      // `?queue` with no value is the same request — a hand-written link must
      // not silently mean "everything".
      expect((await getInventory("?queue")).body.data.inventory).toHaveLength(
        1,
      );
    });

    it("refuses a filter the column could not hold (422, by field)", async () => {
      await setup();
      for (const [query, field] of [
        ["?revision_id=nope", "revision_id"],
        ["?legal_entity_id=nope", "legal_entity_id"],
        ["?facility_id=nope", "facility_id"],
        ["?state=pending", "state"],
        ["?year_month=2024-13", "year_month"],
        ["?queue=maybe", "queue"],
      ]) {
        const res = await getInventory(query);
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ error: "VALIDATION", field });
      }
    });

    it("needs a session and `data.read`, and answers the preflight", async () => {
      const fx = await setup();
      const reviewer = await addMember(fx.companyId, "reviewer");
      await signIn(reviewer);
      expect((await getInventory()).status).toBe(200);

      getSessionMock.mockResolvedValue(null);
      expect((await getInventory()).status).toBe(401);

      expect((await inventoryOPTIONS(request("/api/inventory"))).status).toBe(
        204,
      );
    });
  });

  // ─── T3.4: seeding a revision from another one (LC-9) ─────────────────────

  describe("revision seeding (LC-9)", () => {
    it("copies the current rows as new drafts of the new revision", async () => {
      const fx = await setup();
      const a = await postActivity(activityBody(fx, { source_name: "A" }));
      const b = await postActivity(activityBody(fx, { source_name: "B" }));
      await postActivity(activityBody(fx, { source_name: "C" }));
      // One approved, one edited into a second version, so the seed has to pick
      // the CURRENT version and reset the approval.
      await approveActivity(a.body.data.id);
      await patchActivity(b.body.data.id, { activity_value: 99 });

      const before = await storedRows(fx.revisionId);
      const seeded = await postRevision(fx.periodId, {
        seedFrom: fx.revisionId,
      });
      expect(seeded.status).toBe(200);
      expect(seeded.body.data.seeded_from_revision_id).toBe(fx.revisionId);
      const newRevisionId = seeded.body.data.id;

      // Three current rows in, three rows out.
      const copies = (await getInventory(`?revision_id=${newRevisionId}`)).body
        .data.inventory;
      expect(copies).toHaveLength(3);
      expect(copies.map((row: { label: string }) => row.label).sort()).toEqual([
        "A",
        "B",
        "C",
      ]);

      // Every copy is a fresh draft with a clean approval stamp.
      for (const copy of copies) {
        expect(copy).toMatchObject({
          revision_id: newRevisionId,
          state: "draft",
          approved_by: null,
          approved_at: null,
          change_reason: null,
          superseded_by_id: null,
          is_deleted: false,
          actor_id: fx.userId,
        });
        expect(copy.previous_version_id).not.toBeNull();
      }

      // THE SOURCE IS UNTOUCHED — every column of every version it had, not
      // just the two a test author would remember.
      expect(await storedRows(fx.revisionId)).toEqual(before);
    });

    it("copies placement and body verbatim and stamps only the version columns", async () => {
      const fx = await setup();
      const created = await postActivity(
        activityBody(fx, {
          source_name: "Boiler 7",
          notes: "as metered",
          activity_value: 4242,
        }),
      );
      const sourceId = created.body.data.id;
      await approveActivity(sourceId);
      const [source] = await storedRows(fx.revisionId).then((rows) =>
        rows.filter((row) => row.supersededById === null),
      );

      const seeded = await postRevision(fx.periodId, {
        seedFrom: fx.revisionId,
      });
      const [copy] = await storedRows(seeded.body.data.id);

      // Copied: the row's own facts, revision-independent.
      for (const column of [
        "legalEntityId",
        "facilityId",
        "assetId",
        "metricKey",
        "yearMonth",
        "unit",
        "notes",
        "companyId",
        "activityCategory",
        "sourceName",
        "activityType",
        "activityValue",
        "method",
      ] as const) {
        expect(copy[column]).toEqual(source[column]);
      }
      // Moved, linked, reset and fresh.
      expect(copy.revisionId).toBe(seeded.body.data.id);
      expect(copy.previousVersionId).toBe(source.id);
      expect(copy.state).toBe("draft");
      expect(copy.approvedBy).toBeNull();
      expect(copy.approvedAt).toBeNull();
      expect(copy.changeReason).toBeNull();
      expect(copy.supersededById).toBeNull();
      expect(copy.isDeleted).toBe(false);
      expect(copy.id).not.toBe(source.id);
      expect(copy.createdAt.getTime()).toBeGreaterThanOrEqual(
        source.createdAt.getTime(),
      );
    });

    it("makes provenance readable across the revision boundary (history)", async () => {
      const fx = await setup();
      const created = await postActivity(activityBody(fx));
      const seeded = await postRevision(fx.periodId, {
        seedFrom: fx.revisionId,
      });
      const [copy] = await storedRows(seeded.body.data.id);

      // `history` walks the CHAIN, not the revision: asking the copy for its
      // versions reaches back through `previous_version_id` into the revision it
      // was restated from. That is what LC-9's provenance means in practice.
      const chain = await getHistory(copy.id);
      expect(chain.status).toBe(200);
      expect(chain.body.data.versions.map((v: { id: string }) => v.id)).toEqual(
        [created.body.data.id, copy.id],
      );
      expect(chain.body.data.versions[0].revision_id).toBe(fx.revisionId);
      expect(chain.body.data.versions[1].revision_id).toBe(seeded.body.data.id);
    });

    it("copies neither tombstones nor superseded versions", async () => {
      const fx = await setup();
      const kept = await postActivity(activityBody(fx, { source_name: "A" }));
      const gone = await postActivity(activityBody(fx, { source_name: "B" }));
      await patchActivity(kept.body.data.id, { activity_value: 5 });
      await deleteActivity(gone.body.data.id);

      // Four versions in the source, ONE current non-deleted row.
      expect(await storedRows(fx.revisionId)).toHaveLength(4);
      const seeded = await postRevision(fx.periodId, {
        seedFrom: fx.revisionId,
      });
      expect(await storedRows(seeded.body.data.id)).toHaveLength(1);
    });

    it("seeds all four tables, not just the one the test remembered", async () => {
      const fx = await setup();
      await insertAllFour(fx);

      const seeded = await postRevision(fx.periodId, {
        seedFrom: fx.revisionId,
      });
      const copies = (await getInventory(`?revision_id=${seeded.body.data.id}`))
        .body.data.inventory;
      expect(
        copies.map((row: { source_table: string }) => row.source_table).sort(),
      ).toEqual([...INPUT_TABLE_NAMES].sort());
    });

    it("leaves an abandoned draft revision in the database, merely not current (D6)", async () => {
      const fx = await setup();
      await postActivity(activityBody(fx));
      const seeded = await postRevision(fx.periodId, {
        seedFrom: fx.revisionId,
      });
      const abandoned = seeded.body.data.id;

      const dropped = await postTransition(abandoned, "abandon");
      expect(dropped.status).toBe(200);

      // Not current — and still there, with its rows and its `seeded_from`
      // stamp. Currency went back to the revision it was seeded from.
      const revision = await storedRevision(abandoned);
      expect(revision.isCurrent).toBe(false);
      expect(revision.seededFromRevisionId).toBe(fx.revisionId);
      expect((await storedRevision(fx.revisionId)).isCurrent).toBe(true);
      expect(await storedRows(abandoned)).toHaveLength(1);
      // Its rows are still readable BY REVISION; they are simply not the
      // period's report any more.
      expect(
        (await getInventory(`?revision_id=${abandoned}`)).body.data.inventory,
      ).toHaveLength(1);
    });
  });
});
