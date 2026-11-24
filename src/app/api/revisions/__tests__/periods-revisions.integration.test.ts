// [LOCAL-DB] T2.6 — THE ONE STATE MACHINE (D22, §5.1) against a real Postgres
// via the T1.7 harness: `report_revision`, its transitions, and everything that
// hangs off them.
//
// The properties this file exists to prove, none of which is visible without a
// database:
//
//   • THE MATRIX IS THE WHOLE TRUTH (§5.1, LC-1). Every (action, from) pair is
//     tried — all 36 of the six wire actions against the six statuses — and the
//     seven that §5.1 lists succeed while the other twenty-nine are refused with
//     422 and a payload that says what WOULD be legal from here. The test is a
//     LOOP over the matrix, not a list of hand-picked cases, so a row added to
//     (or dropped from) `ALLOWED_TRANSITIONS` changes the test's behaviour
//     automatically and a forgotten pair cannot hide.
//   • THE SEVENTH ACTION IS A MEMBER OF THE MATRIX, NOT A SIDE EFFECT.
//     `rejected → draft` (`resume`) is executed by the service — the row-edit
//     path of T3.1 will call it — and is NOT on the wire: a client naming it is
//     a 422, so "status is only ever written in one place" survives T3.1.
//   • `is_current` IS A DATABASE INVARIANT, not a convention. A second current
//     revision inserted BY HAND is refused by the partial unique index; `abandon`
//     hands currency back to the highest-numbered survivor (LC-1a).
//   • `period_status` IS DERIVED, ALL SEVEN CASES (LC-2/К-4) — including the two
//     that no earlier task could produce: `rejected → Draft` and a draft
//     revision over a locked one → `Reopened`.
//   • F1 IS A HARD GATE AND A 402, NOT A 422 (PG-3). On Starter, four includable
//     facilities stop the report at `approved`; VAL-105 is WRITTEN so the screen
//     can explain the payment wall, and three facilities lock cleanly.
//   • LOCK FREEZES THE INPUTS FOR EVER (DM-9, CALC-7). `frozen_scope` carries
//     the boundary rows WITH their stated exclusion reasons and the six DM-7a
//     fields, and after the lock the live period and boundary refuse to move
//     (VAL-106 — the VAL-010 family).
//   • `seedFrom` COPIES (LC-9). T2.6 shipped this as a REFUSAL — 422 "seeding
//     not available yet", nothing created — because there were no input rows to
//     copy before S3. T3.4 implemented the mechanism and deleted that test in
//     the same commit, replacing it with the one below: the new revision is
//     stamped `seeded_from_revision_id` AND has the source's rows under it, and
//     the source keeps everything it had. A `seedFrom` naming a revision of
//     another period is still refused, and still creates nothing.
//   • THE PRECONDITION REGISTRY IS PINNED BY NAME. S4 and S5 add checks to
//     `approve`; if they forget, this assertion is what tells them.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so this file is
// a green no-op in a DB-less CI.
import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
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
  GET as periodGET,
  PATCH as periodPATCH,
} from "@/app/api/periods/[id]/route";
import {
  GET as revisionsGET,
  OPTIONS as revisionsOPTIONS,
  POST as revisionsPOST,
} from "@/app/api/periods/[id]/revisions/route";
import { PUT as scopePUT } from "@/app/api/periods/[id]/scope/route";
import { GET as revisionGET } from "@/app/api/revisions/[id]/route";
import { GET as dashboardGET } from "@/app/api/dashboard/route";
import { POST as transitionPOST } from "@/app/api/revisions/[id]/transition/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertDisclosure,
  insertEmissionActivity,
  insertFacility,
  insertLegalEntity,
  insertPeriod,
  insertPeriodScope,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  auditLog,
  disclosureRecord,
  emissionActivity,
  reportRevision,
  validationResult,
} from "@/server/db/schema";
import { calculateRevision } from "@/server/calc/run";
import { legalEntity } from "@/server/db/schema";
import {
  REVISION_CREATION_ALLOWED_FROM,
  serialiseRevision,
} from "@/server/revisions/revisions";
import {
  ALLOWED_TRANSITIONS,
  transitionFor,
  transitionRevision,
  TRANSITION_PRECONDITIONS,
  WIRE_ACTIONS,
  type RevisionAction,
} from "@/server/revisions/transition";
import { WORKFLOW_STATUSES, type WorkflowStatus } from "@/shared/enums";
import type { PlanId } from "@/shared/plans";
import type { CompanyRole } from "@/shared/roles";

/** A GET request the route handlers accept. */
const request = (path: string): NextRequest =>
  new Request(`http://api.example.com${path}`) as NextRequest;

/** A JSON body request (POST/PATCH/PUT read `req.json()`). */
const jsonRequest = (
  path: string,
  method: "POST" | "PATCH" | "PUT",
  body: unknown,
): NextRequest =>
  new Request(`http://api.example.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;

/** The `{ params }` context Next hands a dynamic route. */
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

/** The session `getSession()` would resolve for a user (PATTERN 3 identity). */
async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

/** A company on `plan` plus a signed-in member with `role`; installs the session. */
async function actor(
  plan: PlanId = "trial",
  role: CompanyRole = "esg_admin",
): Promise<{ companyId: string; userId: string }> {
  const company = await insertCompany({ plan });
  const { user } = await insertUserWithProfile({ companyId: company.id, role });
  getSessionMock.mockResolvedValue(await sessionFor(user.id));
  return { companyId: company.id, userId: user.id };
}

/** The session shape the SERVICE takes (company narrowed, as the route does). */
async function serviceSession(userId: string) {
  const session = await sessionFor(userId);
  if (!session.company) throw new Error("session has no company");
  return { ...session, company: session.company };
}

/** POST a transition through the route. */
async function postTransition(
  revisionId: string,
  action: string,
  body: Record<string, unknown> = {},
) {
  const res = await transitionPOST(
    jsonRequest(`/api/revisions/${revisionId}/transition`, "POST", {
      action,
      ...body,
    }),
    ctxFor(revisionId),
  );
  return { status: res.status, body: await res.json() };
}

/** POST a new revision of a period through the route. */
async function postRevision(periodId: string, body: unknown = {}) {
  const res = await revisionsPOST(
    jsonRequest(`/api/periods/${periodId}/revisions`, "POST", body),
    ctxFor(periodId),
  );
  return { status: res.status, body: await res.json() };
}

/** GET the revisions of a period. */
async function getRevisions(periodId: string) {
  const res = await revisionsGET(
    request(`/api/periods/${periodId}/revisions`),
    ctxFor(periodId),
  );
  return { status: res.status, body: await res.json() };
}

/** GET the summary of one revision. */
async function getRevisionSummary(revisionId: string) {
  const res = await revisionGET(
    request(`/api/revisions/${revisionId}`),
    ctxFor(revisionId),
  );
  return { status: res.status, body: await res.json() };
}

/** GET one period (the LC-2 `period_status` is read from here). */
async function getPeriodDto(periodId: string) {
  const res = await periodGET(
    request(`/api/periods/${periodId}`),
    ctxFor(periodId),
  );
  return { status: res.status, body: await res.json() };
}

/** The stored revision row, straight from the table. */
async function storedRevision(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(reportRevision)
    .where(eq(reportRevision.id, id));
  return row;
}

/** Every revision of a period, by number. */
async function storedRevisions(periodId: string) {
  return getTestDb()
    .select()
    .from(reportRevision)
    .where(eq(reportRevision.periodId, periodId))
    .orderBy(asc(reportRevision.revisionNo));
}

/**
 * The input rows a revision holds, across the two tables this suite seeds into.
 * The FOUR-table version of this question is `GET /api/inventory` (DM-14) and is
 * proven in `activities.integration`; here it only has to show that the stamp on
 * the revision is backed by rows.
 */
async function seededRows(revisionId: string) {
  const conn = getTestDb();
  const activities = await conn
    .select()
    .from(emissionActivity)
    .where(eq(emissionActivity.revisionId, revisionId));
  const disclosures = await conn
    .select()
    .from(disclosureRecord)
    .where(eq(disclosureRecord.revisionId, revisionId));
  return [...activities, ...disclosures];
}

/** The stored VAL-105 results of a company (F1's explanation for the UI). */
async function storedRule(companyId: string, code: string) {
  return getTestDb()
    .select()
    .from(validationResult)
    .where(
      and(
        eq(validationResult.companyId, companyId),
        eq(validationResult.ruleCode, code),
      ),
    );
}

/** Every revision audit entry of a company, oldest first (LC-10). */
async function revisionAudit(companyId: string) {
  return getTestDb()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.companyId, companyId),
        eq(auditLog.entity, "report_revision"),
      ),
    )
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
}

describeIntegration(
  "periods/revisions — the §5.1 state machine [LOCAL-DB]",
  () => {
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

    // ─── The matrix, in full ───────────────────────────────────────────────────

    describe("the whole §5.1 matrix (LC-1)", () => {
      for (const from of WORKFLOW_STATUSES) {
        for (const action of WIRE_ACTIONS) {
          const rule = transitionFor(action, from);
          const verdict = rule ? "allows" : "refuses";
          it(`${verdict} ${action} from ${from}`, async () => {
            const { companyId } = await actor();
            const revision = await insertRevision(companyId, { status: from });
            if (rule && action === "lock")
              await calculateRevision(getTestDb(), companyId, revision);

            const res = await postTransition(revision.id, action, {
              comment: "needs work",
              change_reason: "because",
            });
            const stored = await storedRevision(revision.id);

            if (rule) {
              expect(res, JSON.stringify(res.body)).toMatchObject({
                status: 200,
              });
              // `abandon` has no `to`: it moves currency, not state (LC-1a).
              expect(stored.status).toBe(rule.to ?? from);
            } else {
              expect(res.status).toBe(422);
              expect(res.body.error).toBe("VALIDATION");
              expect(Array.isArray(res.body.rules)).toBe(true);
              expect(res.body.transition).toMatchObject({
                action,
                from,
                allowed: expect.any(Array),
              });
              // A refused transition changes nothing at all.
              expect(stored.status).toBe(from);
            }
          });
        }
      }

      it("names every allowed transition exactly once, as data (§5.1)", () => {
        expect(
          ALLOWED_TRANSITIONS.map((rule) => [rule.from, rule.action, rule.to]),
        ).toEqual([
          ["draft", "submit", "submitted"],
          ["submitted", "start_review", "in_review"],
          ["in_review", "approve", "approved"],
          ["in_review", "reject", "rejected"],
          ["rejected", "resume", "draft"],
          ["approved", "lock", "locked"],
          ["draft", "abandon", null],
        ]);
        // Each action carries exactly one capability (§5.4) — no role branching.
        expect(
          Object.fromEntries(
            ALLOWED_TRANSITIONS.map((rule) => [rule.action, rule.capability]),
          ),
        ).toEqual({
          submit: "data.submit",
          start_review: "data.review",
          approve: "data.approve",
          reject: "data.review",
          resume: "data.write",
          lock: "data.approve",
          abandon: "data.write",
        });
      });

      it("cites VAL-010 when the refused transition is against a LOCKED revision", async () => {
        const { companyId } = await actor();
        const revision = await insertRevision(companyId, { status: "locked" });

        const res = await postTransition(revision.id, "submit");
        expect(res.status).toBe(422);
        expect(res.body.rules.map((r: { code: string }) => r.code)).toEqual([
          "VAL-010",
        ]);
        expect(res.body.transition.allowed).toEqual([]);
      });

      it("executes `rejected → draft` as a member of the matrix (service-only)", async () => {
        const { companyId, userId } = await actor();
        const revision = await insertRevision(companyId, {
          status: "rejected",
        });

        // NOT on the wire: T3.1's row-edit service calls it, a client cannot.
        const refused = await postTransition(revision.id, "resume");
        expect(refused.status).toBe(422);
        expect(refused.body.field).toBe("action");

        const result = await transitionRevision(
          getTestDb(),
          await serviceSession(userId),
          revision.id,
          "resume",
        );
        expect(result.ok).toBe(true);
        expect((await storedRevision(revision.id)).status).toBe("draft");
      });

      it("refuses a reject with no comment, and accepts one with (§5.1)", async () => {
        const { companyId } = await actor();
        const revision = await insertRevision(companyId, {
          status: "in_review",
        });

        const bare = await postTransition(revision.id, "reject");
        expect(bare.status).toBe(422);
        expect(bare.body.transition.precondition).toBe(
          "review_comment_required",
        );
        expect((await storedRevision(revision.id)).status).toBe("in_review");

        const withComment = await postTransition(revision.id, "reject", {
          comment: "Scope 2 evidence missing",
        });
        expect(withComment.status).toBe(200);
        const stored = await storedRevision(revision.id);
        expect(stored.status).toBe("rejected");
        expect(stored.reviewComment).toBe("Scope 2 evidence missing");
        expect(stored.reviewedBy).not.toBeNull();
        expect(stored.reviewedAt).not.toBeNull();
      });

      it("stamps the actor of every transition it applies (О-16, DM-13)", async () => {
        const { companyId, userId } = await actor();
        const revision = await insertRevision(companyId, { status: "draft" });

        expect((await postTransition(revision.id, "submit")).status).toBe(200);
        expect((await postTransition(revision.id, "start_review")).status).toBe(
          200,
        );
        expect((await postTransition(revision.id, "approve")).status).toBe(200);
        await calculateRevision(
          getTestDb(),
          companyId,
          await storedRevision(revision.id),
        );
        const locked = await postTransition(revision.id, "lock");
        expect(locked, JSON.stringify(locked.body)).toMatchObject({
          status: 200,
        });

        const stored = await storedRevision(revision.id);
        expect(stored.submittedBy).toBe(userId);
        expect(stored.assignedTo).toBe(userId);
        expect(stored.approvedBy).toBe(userId);
        expect(stored.lockedBy).toBe(userId);
        expect(stored.submittedAt).not.toBeNull();
        expect(stored.approvedAt).not.toBeNull();
        expect(stored.lockedAt).not.toBeNull();
      });

      it("refuses an action the role cannot perform, before anything else (403)", async () => {
        // `reviewer` holds `data.review` but neither `data.submit` nor `data.write`.
        const { companyId } = await actor("starter", "reviewer");
        const revision = await insertRevision(companyId, { status: "draft" });

        expect((await postTransition(revision.id, "submit")).status).toBe(403);
        expect((await postTransition(revision.id, "abandon")).status).toBe(403);
        expect((await storedRevision(revision.id)).status).toBe("draft");
      });

      it("answers 404 for a revision of another company (API-1)", async () => {
        const other = await actor();
        const revision = await insertRevision(other.companyId);
        await actor(); // a different tenant is now signed in

        expect((await postTransition(revision.id, "submit")).status).toBe(404);
        expect((await getRevisionSummary(revision.id)).status).toBe(404);
      });
    });

    // ─── The precondition registry ─────────────────────────────────────────────

    describe("the precondition registry", () => {
      it("registers EXACTLY the current set, by name and in order", () => {
        const registered = Object.fromEntries(
          Object.entries(TRANSITION_PRECONDITIONS).map(([action, checks]) => [
            action,
            checks.map((check) => check.name),
          ]),
        );
        // THE ORDER IS PART OF THE ASSERTION, not incidental. `all_rows_approved`
        // comes first on submit because "you have unapproved rows" is the answer
        // a user can act on, and `plan_facility_limit` comes first on lock
        // because F1 is a 402 with an upgrade path that must not be reported as
        // a 422 by the generic check that runs after it.
        expect(registered).toEqual({
          submit: ["all_rows_approved", "no_blocking_rules"],
          start_review: [],
          // T5.4 appended `calculation_run_green` (CALC-6, §5.1's "прогон
          // расчёта существует и `ok`") AFTER the rule sweep: "your data does
          // not validate" is the cheaper and more actionable answer, and a run
          // made over data that does not validate has to be made again anyway.
          // With it the registry is COMPLETE — §5.1's precondition column has no
          // cell left to fill.
          approve: ["no_blocking_rules", "calculation_run_green"],
          reject: ["review_comment_required"],
          resume: [],
          lock: [
            "plan_facility_limit",
            "no_blocking_rules",
            "calculation_run_green",
          ],
          abandon: ["abandon_requires_current"],
        });
      });

      it("covers every action of the matrix", () => {
        const actions = new Set(ALLOWED_TRANSITIONS.map((rule) => rule.action));
        for (const action of actions) {
          expect(
            TRANSITION_PRECONDITIONS[action as RevisionAction],
          ).toBeDefined();
        }
      });
    });

    // ─── Creating revisions (§5.1, row 1) ──────────────────────────────────────

    describe("creating a revision (§5.1 row 1, LC-1a)", () => {
      // Driven by the DATA, like the transition table above: the three statuses
      // the constant lists allow a new revision and every other one refuses, so
      // moving a status between the two halves moves this test with it.
      const ALLOWED = REVISION_CREATION_ALLOWED_FROM;
      const REFUSED: WorkflowStatus[] = WORKFLOW_STATUSES.filter(
        (status) => !REVISION_CREATION_ALLOWED_FROM.includes(status),
      );

      for (const status of REFUSED) {
        it(`refuses a second revision while the current one is ${status}`, async () => {
          const { companyId } = await actor();
          const first = await insertRevision(companyId, { status });

          const res = await postRevision(first.periodId);
          expect(res.status).toBe(422);
          expect(res.body).toMatchObject({
            error: "VALIDATION",
            reason: "review_in_flight",
            current_status: status,
          });
          expect(await storedRevisions(first.periodId)).toHaveLength(1);
        });
      }

      for (const status of ALLOWED) {
        it(`allows a second revision while the current one is ${status}`, async () => {
          const { companyId } = await actor();
          const first = await insertRevision(companyId, { status });

          // A restatement over a LOCKED revision must state why (§5.1, last row).
          const body = status === "locked" ? { change_reason: "restated" } : {};
          const res = await postRevision(first.periodId, body);
          expect(res.status).toBe(200);
          expect(res.body.data.revision_no).toBe(2);
          expect(res.body.data.status).toBe("draft");
          expect(res.body.data.is_current).toBe(true);
          expect(res.body.data.seeded_from_revision_id).toBeNull();

          const rows = await storedRevisions(first.periodId);
          expect(rows.map((row) => row.isCurrent)).toEqual([false, true]);
        });
      }

      it("requires a change_reason for a restatement over a locked revision", async () => {
        const { companyId } = await actor();
        const locked = await insertRevision(companyId, { status: "locked" });

        const bare = await postRevision(locked.periodId);
        expect(bare.status).toBe(422);
        expect(bare.body).toMatchObject({
          field: "change_reason",
          reason: "restatement_needs_reason",
        });
        expect(await storedRevisions(locked.periodId)).toHaveLength(1);
      });

      it("creates revision 1 for a period that has none, and lists it", async () => {
        const { companyId } = await actor();
        const { period } = await insertPeriod(companyId);

        const created = await postRevision(period.id);
        expect(created.status).toBe(200);
        expect(created.body.data.revision_no).toBe(1);

        const listed = await getRevisions(period.id);
        expect(listed.status).toBe(200);
        expect(listed.body.data.revisions).toHaveLength(1);
        expect(listed.body.data.current_revision_id).toBe(created.body.data.id);
      });

      it("seeds the new revision from `seedFrom` and stamps the source (LC-9)", async () => {
        const { companyId, userId } = await actor();
        const source = await insertRevision(companyId, { status: "locked" });
        await insertEmissionActivity(companyId, {
          revisionId: source.id,
          actorId: userId,
          state: "approved",
        });
        await insertDisclosure(companyId, {
          revisionId: source.id,
          actorId: userId,
        });

        const res = await postRevision(source.periodId, {
          seedFrom: source.id,
          change_reason: "restated after an audit finding",
        });
        expect(res.status).toBe(200);
        expect(res.body.data.revision_no).toBe(2);
        expect(res.body.data.seeded_from_revision_id).toBe(source.id);

        // The stamp is not a promise: the rows are there, in the SAME
        // transaction that made the revision current.
        const seeded = await seededRows(res.body.data.id);
        expect(seeded).toHaveLength(2);
        // A fresh draft, whatever the source row's state was.
        expect(seeded.every((row) => row.state === "draft")).toBe(true);
        expect(seeded.every((row) => row.previousVersionId !== null)).toBe(
          true,
        );

        // And the source revision is untouched — it keeps its rows and its
        // status; it merely stops being current (D6).
        const rows = await storedRevisions(source.periodId);
        expect(rows.map((row) => row.isCurrent)).toEqual([false, true]);
        expect(rows[0].status).toBe("locked");
      });

      it("refuses a `seedFrom` that is not a revision of this period", async () => {
        const { companyId } = await actor();
        const target = await insertRevision(companyId, { status: "draft" });
        // A perfectly real revision of this company — of ANOTHER period.
        const elsewhere = await insertRevision(companyId, { status: "draft" });

        const res = await postRevision(target.periodId, {
          seedFrom: elsewhere.id,
        });
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({
          error: "VALIDATION",
          field: "seedFrom",
          reason: "unknown_revision",
        });
        // Refused BEFORE anything is written: no half-made revision behind it.
        expect(await storedRevisions(target.periodId)).toHaveLength(1);
      });

      it("refuses a malformed seedFrom by shape, before the state rules", async () => {
        const { companyId } = await actor();
        const { period } = await insertPeriod(companyId);
        const res = await postRevision(period.id, { seedFrom: "not-a-uuid" });
        expect(res.status).toBe(422);
        expect(res.body.field).toBe("seedFrom");
      });

      it("refuses a period of another company (API-1)", async () => {
        const other = await actor();
        const { period } = await insertPeriod(other.companyId);
        await actor();

        const res = await postRevision(period.id);
        expect(res.status).toBe(422);
        expect(await storedRevisions(period.id)).toHaveLength(0);
        expect((await getRevisions(period.id)).status).toBe(404);
      });

      it("needs `data.write` to create and only `data.read` to list", async () => {
        const { companyId } = await actor("starter", "reviewer");
        const { period } = await insertPeriod(companyId);

        expect((await postRevision(period.id)).status).toBe(403);
        expect((await getRevisions(period.id)).status).toBe(200);
      });
    });

    // ─── `is_current` (LC-1a) ──────────────────────────────────────────────────

    describe("`is_current` — one per period (LC-1a)", () => {
      it("is refused by the partial UNIQUE index, not merely by the service", async () => {
        const { companyId, userId } = await actor();
        const first = await insertRevision(companyId, { status: "draft" });

        const err = await getTestDb()
          .insert(reportRevision)
          .values({
            id: randomUUID(),
            companyId,
            periodId: first.periodId,
            revisionNo: 99,
            status: "draft",
            isCurrent: true,
            createdBy: userId,
          })
          .then(
            () => null,
            (e: unknown) => e,
          );
        // Drizzle wraps the postgres.js error; the index name is on the cause, so
        // this cannot pass because of some other failure.
        const wrapped = err as { cause?: { constraint_name?: string } };
        expect(wrapped?.cause?.constraint_name).toBe(
          "report_revision_period_current_key",
        );
        expect(await storedRevisions(first.periodId)).toHaveLength(1);
      });

      it("gives currency back to the previous revision on abandon", async () => {
        const { companyId } = await actor();
        const first = await insertRevision(companyId, { status: "draft" });
        const second = await postRevision(first.periodId);
        expect(second.status).toBe(200);

        const abandoned = await postTransition(second.body.data.id, "abandon");
        expect(abandoned.status).toBe(200);

        const rows = await storedRevisions(first.periodId);
        expect(rows.map((row) => [row.revisionNo, row.isCurrent])).toEqual([
          [1, true],
          [2, false],
        ]);
        // D6 — the abandoned revision is NOT deleted: it keeps its status and row.
        expect(rows[1].status).toBe("draft");
      });

      it("refuses to abandon a revision that is not current", async () => {
        const { companyId } = await actor();
        const first = await insertRevision(companyId, { status: "draft" });
        await postRevision(first.periodId);

        const res = await postTransition(first.id, "abandon");
        expect(res.status).toBe(422);
        expect(res.body.transition.precondition).toBe(
          "abandon_requires_current",
        );
      });

      it("leaves a period with no current revision when the only one is abandoned", async () => {
        const { companyId } = await actor();
        const only = await insertRevision(companyId, { status: "draft" });

        expect((await postTransition(only.id, "abandon")).status).toBe(200);
        const rows = await storedRevisions(only.periodId);
        expect(rows.map((row) => row.isCurrent)).toEqual([false]);
        // LC-2 case 1 again: no CURRENT revision reads as `Draft`.
        const period = await getPeriodDto(only.periodId);
        expect(period.body.data.period_status).toBe("Draft");
      });
    });

    // ─── LC-2 — the derived period status, all seven cases ─────────────────────

    describe("LC-2 — `period_status` is derived (К-4)", () => {
      const CASES: {
        name: string;
        setup: (companyId: string) => Promise<string>;
        expected: string;
      }[] = [
        {
          name: "1. no revisions at all → Draft",
          setup: async (companyId) => (await insertPeriod(companyId)).period.id,
          expected: "Draft",
        },
        ...(
          [
            ["draft", "Draft"],
            ["submitted", "Submitted"],
            ["in_review", "In review"],
            ["approved", "Approved"],
            ["locked", "Locked"],
            // The mapping's one non-obvious row: a rejected revision is editable
            // again, so to a consumer of the API it is a draft.
            ["rejected", "Draft"],
          ] as const
        ).map(([status, expected], index) => ({
          name: `${index + 2}. current revision ${status} → ${expected}`,
          setup: async (companyId: string) =>
            (await insertRevision(companyId, { status })).periodId,
          expected,
        })),
        {
          name: "8. draft revision no > 1 over a LOCKED one → Reopened",
          setup: async (companyId) => {
            const locked = await insertRevision(companyId, {
              status: "locked",
              isCurrent: false,
            });
            await insertRevision(companyId, {
              periodId: locked.periodId,
              revisionNo: 2,
              status: "draft",
              isCurrent: true,
            });
            return locked.periodId;
          },
          expected: "Reopened",
        },
      ];

      for (const testCase of CASES) {
        it(testCase.name, async () => {
          const { companyId } = await actor();
          const periodId = await testCase.setup(companyId);
          const res = await getPeriodDto(periodId);
          expect(res.status).toBe(200);
          expect(res.body.data.period_status).toBe(testCase.expected);
        });
      }

      it("reports Reopened through a REAL restatement, not a fixture", async () => {
        const { companyId } = await actor();
        const first = await insertRevision(companyId, { status: "draft" });
        for (const action of ["submit", "start_review", "approve", "lock"]) {
          if (action === "lock")
            await calculateRevision(
              getTestDb(),
              companyId,
              await storedRevision(first.id),
            );
          expect((await postTransition(first.id, action)).status).toBe(200);
        }
        expect(
          (await getPeriodDto(first.periodId)).body.data.period_status,
        ).toBe("Locked");

        const restatement = await postRevision(first.periodId, {
          change_reason: "corrected Scope 2",
        });
        expect(restatement.status).toBe(200);
        expect(
          (await getPeriodDto(first.periodId)).body.data.period_status,
        ).toBe("Reopened");
      });
    });

    // ─── F1 — the Starter hard gate (PG-3, VAL-105) ────────────────────────────

    describe("F1 — the Starter hard gate at lock (PG-3)", () => {
      /** An approved revision whose period's included entity owns `facilities`. */
      async function approvedWithFacilities(
        companyId: string,
        facilities: number,
      ) {
        const entity = await insertLegalEntity(companyId);
        const { period } = await insertPeriod(companyId, {
          legalEntityId: entity.id,
        });
        for (let i = 0; i < facilities; i += 1) {
          await insertFacility(companyId, {
            legalEntityId: entity.id,
            includedInBoundary: true,
          });
        }
        const revision = await insertRevision(companyId, {
          periodId: period.id,
          status: "approved",
        });
        await calculateRevision(getTestDb(), companyId, revision);
        return revision;
      }

      it("refuses the lock with 402 and WRITES VAL-105 (4 facilities on starter)", async () => {
        const { companyId } = await actor("starter");
        const revision = await approvedWithFacilities(companyId, 4);

        const res = await postTransition(revision.id, "lock");
        expect(res.status).toBe(402);
        expect(res.body.error).toBe("PLAN_REQUIRED");
        expect(res.body.rules.map((r: { code: string }) => r.code)).toEqual([
          "VAL-105",
        ]);
        expect(res.body.transition.precondition).toBe("plan_facility_limit");

        // The revision did NOT move, and did not acquire a snapshot.
        const stored = await storedRevision(revision.id);
        expect(stored.status).toBe("approved");
        expect(stored.lockedAt).toBeNull();
        expect(stored.frozenScope).toBeNull();

        // …and the explanation SURVIVED the refusal — that is what the screen reads.
        const [result] = await storedRule(companyId, "VAL-105");
        expect(result.passed).toBe(false);
        expect(result.blocking).toBe(true);
        expect(result.revisionId).toBe(revision.id);
      });

      it("locks cleanly with 3 facilities on starter", async () => {
        const { companyId } = await actor("starter");
        const revision = await approvedWithFacilities(companyId, 3);

        const res = await postTransition(revision.id, "lock");
        expect(res.status).toBe(200);
        expect((await storedRevision(revision.id)).status).toBe("locked");

        const [result] = await storedRule(companyId, "VAL-105");
        expect(result.passed).toBe(true);
      });

      it("does not hard-gate a plan the tariff soft-stamps instead (PG-4)", async () => {
        const { companyId } = await actor("pro");
        const revision = await approvedWithFacilities(companyId, 4);
        expect((await postTransition(revision.id, "lock")).status).toBe(200);
      });

      it("counts only facilities of INCLUDED entities (§11.3)", async () => {
        const { companyId } = await actor("starter");
        const entity = await insertLegalEntity(companyId);
        const { period } = await insertPeriod(companyId, {
          legalEntityId: entity.id,
        });
        // A second entity, EXCLUDED from the boundary, with three more sites.
        const excluded = await insertLegalEntity(companyId);
        await insertPeriodScope(companyId, {
          periodId: period.id,
          legalEntityId: excluded.id,
          status: "excluded",
          exclusionReason: "sold in Q1",
        });
        for (let i = 0; i < 3; i += 1) {
          await insertFacility(companyId, { legalEntityId: entity.id });
          await insertFacility(companyId, { legalEntityId: excluded.id });
        }
        const revision = await insertRevision(companyId, {
          periodId: period.id,
          status: "approved",
        });

        await calculateRevision(getTestDb(), companyId, revision);
        expect((await postTransition(revision.id, "lock")).status).toBe(200);
      });

      it("does not fire VAL-105 on an ordinary period write (no deadlock)", async () => {
        const { companyId } = await actor("starter");
        const entity = await insertLegalEntity(companyId);
        const { period } = await insertPeriod(companyId, {
          legalEntityId: entity.id,
        });
        for (let i = 0; i < 4; i += 1) {
          await insertFacility(companyId, { legalEntityId: entity.id });
        }

        // Over the limit, but the period is still editable and the boundary still
        // redrawable — F1 gates CLOSING the report, not working on it.
        const patched = await periodPATCH(
          jsonRequest(`/api/periods/${period.id}`, "PATCH", {
            period_name: "FY2024 renamed",
          }),
          ctxFor(period.id),
        );
        expect(patched.status).toBe(200);
        const put = await scopePUT(
          jsonRequest(`/api/periods/${period.id}/scope`, "PUT", {
            entries: [
              {
                legal_entity_id: entity.id,
                status: "excluded",
                exclusion_reason: "restructured",
              },
            ],
          }),
          ctxFor(period.id),
        );
        expect(put.status).toBe(200);
        expect(await storedRule(companyId, "VAL-105")).toHaveLength(0);
      });
    });

    // ─── Lock — the frozen snapshot and the freeze that follows (DM-9, CALC-7) ──

    describe("lock — `frozen_scope` and the freeze (DM-9, CALC-7, VAL-106)", () => {
      /** A period with an included and an excluded entity, and an approved revision. */
      async function approvedWithBoundary(companyId: string) {
        const included = await insertLegalEntity(companyId);
        const excluded = await insertLegalEntity(companyId);
        const { period } = await insertPeriod(companyId, {
          legalEntityId: included.id,
          baseYear: 2020,
        });
        await insertPeriodScope(companyId, {
          periodId: period.id,
          legalEntityId: excluded.id,
          status: "excluded",
          exclusionReason: "immaterial branch",
        });
        const revision = await insertRevision(companyId, {
          periodId: period.id,
          status: "approved",
        });
        await calculateRevision(getTestDb(), companyId, revision);
        return { period, revision, included, excluded };
      }

      it("requires an explicit run before lock even when the revision has no emissions", async () => {
        const { companyId } = await actor();
        const revision = await insertRevision(companyId, {
          status: "approved",
        });
        const refused = await postTransition(revision.id, "lock");
        expect(refused.status).toBe(422);
        expect(refused.body.transition).toMatchObject({
          precondition: "calculation_run_green",
          reason: "calculation_run_missing",
        });
        expect((await storedRevision(revision.id)).frozenScope).toBeNull();
        const run = await calculateRevision(getTestDb(), companyId, revision);
        if (!run.ok) throw new Error("empty calculation failed");
        expect(run.lines).toHaveLength(0);
        expect((await postTransition(revision.id, "lock")).status).toBe(200);
        const snapshot = (await storedRevision(revision.id)).frozenScope as {
          render_context: { run_id: string };
        };
        expect(snapshot.render_context.run_id).toBe(run.run.runId);
      });

      it("refuses to freeze organisation changes without a fresh calculation", async () => {
        const { companyId } = await actor();
        const { revision, included } = await approvedWithBoundary(companyId);
        await getTestDb()
          .update(legalEntity)
          .set({ turnover: "2000" })
          .where(eq(legalEntity.id, included.id));
        const refused = await postTransition(revision.id, "lock");
        expect(refused.status).toBe(422);
        expect(refused.body.transition).toMatchObject({
          precondition: "calculation_run_green",
          reason: "calculation_run_stale",
        });
        expect((await storedRevision(revision.id)).status).toBe("approved");
        expect((await storedRevision(revision.id)).frozenScope).toBeNull();
        await calculateRevision(getTestDb(), companyId, revision);
        expect((await postTransition(revision.id, "lock")).status).toBe(200);
      });

      it("keeps both internal snapshots out of revision and dashboard DTOs", async () => {
        const { companyId } = await actor();
        const { revision, period } = await approvedWithBoundary(companyId);
        const transition = await postTransition(revision.id, "lock");
        expect(transition.status).toBe(200);
        const stored = await storedRevision(revision.id);
        expect(stored.frozenScope).toHaveProperty("render_context");
        expect(stored.frozenScope).toHaveProperty("calculation_context");
        const expected = serialiseRevision(stored).frozen_scope;
        expect(expected).toHaveProperty("period_id", period.id);
        expect(expected).toHaveProperty("scope");
        expect(expected).not.toHaveProperty("render_context");
        expect(expected).not.toHaveProperty("calculation_context");
        const listed = await getRevisions(period.id);
        const summary = await getRevisionSummary(revision.id);
        const dashboard = await dashboardGET(request("/api/dashboard"));
        const dashboardBody = await dashboard.json();
        expect(listed.status).toBe(200);
        expect(summary.status).toBe(200);
        expect(dashboard.status).toBe(200);
        expect(listed.body.data.revisions[0].frozen_scope).toEqual(expected);
        expect(summary.body.data.revision.frozen_scope).toEqual(expected);
        expect(dashboardBody.data.revision.frozen_scope).toEqual(expected);
        for (const body of [
          transition.body,
          listed.body,
          summary.body,
          dashboardBody,
        ]) {
          expect(JSON.stringify(body)).not.toMatch(
            /render_context|calculation_context/,
          );
        }
      });

      it("reports stale calculation when organisation changes between precheck and lock transaction", async () => {
        const { companyId } = await actor();
        const { revision, included } = await approvedWithBoundary(companyId);
        const db = getTestDb();
        const transaction = db.transaction.bind(db);
        const spy = vi
          .spyOn(db, "transaction")
          .mockImplementationOnce(async (callback, config) => {
            await db
              .update(legalEntity)
              .set({ turnover: "3000" })
              .where(eq(legalEntity.id, included.id));
            return transaction(callback, config);
          });
        try {
          const refused = await postTransition(revision.id, "lock");
          expect(refused.status).toBe(422);
          expect(refused.body.transition).toMatchObject({
            precondition: "calculation_run_green",
            reason: "calculation_run_stale",
          });
          expect((await storedRevision(revision.id)).status).toBe("approved");
          expect((await storedRevision(revision.id)).frozenScope).toBeNull();
        } finally {
          spy.mockRestore();
        }
      });

      it("snapshots the boundary rows AND the six DM-7a fields", async () => {
        const { companyId } = await actor();
        const { period, revision, included, excluded } =
          await approvedWithBoundary(companyId);

        expect((await postTransition(revision.id, "lock")).status).toBe(200);
        const stored = await storedRevision(revision.id);
        expect(stored.lockedAt).not.toBeNull();

        const frozen = stored.frozenScope as {
          version: number;
          period_id: string;
          period: Record<string, unknown>;
          scope: Record<string, unknown>[];
        };
        expect(frozen.version).toBe(1);
        expect(frozen.period_id).toBe(period.id);
        // The six calculation-bearing fields of DM-7a, by their API names.
        expect(Object.keys(frozen.period).sort()).toEqual([
          "base_year",
          "end_date",
          "factor_set_id",
          "methodology_version",
          "reporting_basis",
          "start_date",
        ]);
        expect(frozen.period).toMatchObject({
          factor_set_id: period.factorSetId,
          start_date: period.startDate,
          end_date: period.endDate,
          reporting_basis: period.reportingBasis,
          methodology_version: period.methodologyVersion,
          base_year: 2020,
        });
        // …and the boundary WITH its stated reasons (D15).
        expect(frozen.scope).toHaveLength(2);
        const byEntity = Object.fromEntries(
          frozen.scope.map((row) => [row.legal_entity_id, row]),
        );
        expect(byEntity[included.id]).toMatchObject({
          status: "included",
          exclusion_reason: null,
        });
        expect(byEntity[excluded.id]).toMatchObject({
          status: "excluded",
          exclusion_reason: "immaterial branch",
        });
      });

      it("freezes the live period and boundary afterwards (VAL-106)", async () => {
        const { companyId } = await actor();
        const { period, revision, included } =
          await approvedWithBoundary(companyId);
        expect((await postTransition(revision.id, "lock")).status).toBe(200);

        const patched = await periodPATCH(
          jsonRequest(`/api/periods/${period.id}`, "PATCH", {
            start_date: "2024-02-01",
          }),
          ctxFor(period.id),
        );
        expect(patched.status).toBe(422);
        const patchBody = await patched.json();
        expect(patchBody.rules.map((r: { code: string }) => r.code)).toContain(
          "VAL-106",
        );

        const put = await scopePUT(
          jsonRequest(`/api/periods/${period.id}/scope`, "PUT", {
            entries: [{ legal_entity_id: included.id, status: "included" }],
          }),
          ctxFor(period.id),
        );
        expect(put.status).toBe(422);
        const putBody = await put.json();
        expect(putBody.rules.map((r: { code: string }) => r.code)).toContain(
          "VAL-106",
        );

        // Labelling fields are NOT frozen — the report's name is not an input.
        const renamed = await periodPATCH(
          jsonRequest(`/api/periods/${period.id}`, "PATCH", {
            period_name: "FY2024 (locked)",
          }),
          ctxFor(period.id),
        );
        expect(renamed.status).toBe(200);
      });

      it("keeps the snapshot when the boundary changes in a LATER revision", async () => {
        const { companyId } = await actor();
        const { period, revision, included, excluded } =
          await approvedWithBoundary(companyId);
        expect((await postTransition(revision.id, "lock")).status).toBe(200);
        const snapshot = (await storedRevision(revision.id)).frozenScope;

        // A restatement unfreezes the period (LC-2: Reopened) …
        expect(
          (await postRevision(period.id, { change_reason: "restated" })).status,
        ).toBe(200);
        const put = await scopePUT(
          jsonRequest(`/api/periods/${period.id}/scope`, "PUT", {
            entries: [{ legal_entity_id: included.id, status: "included" }],
          }),
          ctxFor(period.id),
        );
        expect(put.status).toBe(200);

        // … and the locked revision still remembers what IT reported on (D15).
        const after = (await storedRevision(revision.id)).frozenScope as {
          scope: { legal_entity_id: string }[];
        };
        expect(after).toEqual(snapshot);
        expect(after.scope.map((row) => row.legal_entity_id).sort()).toEqual(
          [included.id, excluded.id].sort(),
        );
      });
    });

    // ─── The summary read and the audit trail ──────────────────────────────────

    describe("the summary read and the trail (§12.2, LC-10)", () => {
      it("answers status, counters, validation and run", async () => {
        const { companyId } = await actor();
        const revision = await insertRevision(companyId, { status: "draft" });

        const res = await getRevisionSummary(revision.id);
        expect(res.status).toBe(200);
        expect(res.body.data.revision).toMatchObject({
          id: revision.id,
          status: "draft",
          is_current: true,
          revision_no: 1,
        });
        expect(res.body.data.period_status).toBe("Draft");
        // No input row has a write path before T3.1 — the counters are real and
        // the population is empty, which is exactly why `all_rows_approved` passes.
        expect(res.body.data.rows).toEqual({
          total: 0,
          approved: 0,
          pending: 0,
        });
        expect(res.body.data.validation).toMatchObject({ blocking: 0 });
        expect(res.body.data.run).toBeNull();
      });

      it("writes one audit row per transition, with the self-approval disclosure", async () => {
        const { companyId } = await actor();
        const revision = await insertRevision(companyId, { status: "draft" });
        for (const action of ["submit", "start_review", "approve"]) {
          expect((await postTransition(revision.id, action)).status).toBe(200);
        }
        // A refused transition writes NOTHING (the fourth call is not in the matrix).
        expect((await postTransition(revision.id, "submit")).status).toBe(422);

        const entries = await revisionAudit(companyId);
        expect(
          entries.map(
            (entry) => (entry.summary as Record<string, unknown>).action,
          ),
        ).toEqual(["submit", "start_review", "approve"]);
        expect(entries[2].summary).toMatchObject({
          from: "in_review",
          to: "approved",
          // LC-7/§11.2 — one person entered and approved: disclosed, not refused.
          self_approved: true,
          independent_review: false,
        });
        expect(entries[0].entityId).toBe(revision.id);
      });

      it("audits the creation of a revision too (LC-10)", async () => {
        const { companyId } = await actor();
        const { period } = await insertPeriod(companyId);
        const created = await postRevision(period.id);

        const [entry] = await revisionAudit(companyId);
        expect(entry.action).toBe("create");
        expect(entry.entityId).toBe(created.body.data.id);
        expect(entry.summary).toMatchObject({
          period_id: period.id,
          revision_no: 1,
          previous_revision_id: null,
        });
      });

      it("serves CORS preflight on the collection route (PATTERN 2)", async () => {
        const res = await revisionsOPTIONS(
          new Request("http://api.example.com/api/periods/x/revisions", {
            method: "OPTIONS",
            headers: { origin: "http://localhost:3000" },
          }) as NextRequest,
        );
        expect(res.status).toBeLessThan(300);
      });
    });
  },
);
