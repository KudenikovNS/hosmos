// [LOCAL-DB] T4.3 — DATA-QUALITY ASSESSMENTS: AUTO-CREATE, OVERRIDE, COPY
// (DM-27, DQ-1…DQ-5, К-16, VAL-010, VAL-038, VAL-039) against a real Postgres
// through the T1.7 harness.
//
// The properties this file exists to prove:
//
//   • EVERY INPUT ROW HAS EXACTLY ONE ASSESSMENT FROM THE MOMENT IT EXISTS
//     (DQ-1). Not "can have one" — has one, under the UNIQUE
//     `(company_id, object_type, object_id)`, in the SAME transaction as the row,
//     so a refused create leaves neither. The tier is the rule-driven pre-fill and
//     the scores are NULL: a machine may say how the number was produced, it may
//     not say how good it is.
//   • THE ASSESSMENT FOLLOWS THE ROW ONTO ITS NEW VERSION, AND THE OLD VERSION
//     KEEPS ITS OWN (DQ-5, §4.17, LC-4/LC-5/LC-9). This is the acceptance
//     criterion of the task: an edit, an approve, a delete and a seed each write
//     a new version, and "how good was this figure when it was approved" has to
//     stay answerable for every version of the chain. Nothing is moved, so the
//     history is not rewritten.
//   • THE OVERRIDE IS A REVIEW ACT (DQ-2, К-16, VAL-039). Setting
//     `is_overridden` needs `data.review` AND a reason; the reason is a BLOCKING
//     rule, so an unexplained override leaves no row behind at all. Clearing
//     somebody else's override needs the same capability — the guard reads the
//     resulting state, not the delta.
//   • THE GUARD ORDER IS CAPABILITY FIRST (§0.2). A contributor asking for an
//     override with no reason gets 403, never the 422 the missing reason would
//     have earned: the role is decided before the body is judged.
//   • VAL-038 IS A WARNING AND MEANS IT (DQ-3). An assessment with a tier and no
//     scores fails it — the tier is not an assessment — and the failure stops
//     nothing: the row is written, approved and SUBMITTED with the warning
//     recorded beside it. T4.4 builds the submit gates on top of that severity.
//   • THE RANGES ARE THE COLUMN'S (§4.17). `reliability_score = 6` is refused by
//     the CHECK constraint itself, proven by writing it PAST the route's parser;
//     the route's own 422 is the same refusal made legible.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so the DB half
// of this file is a green no-op in a DB-less CI; the manifest, the seam and the
// tier table are plain `describe`s and run everywhere.
import { and, eq } from "drizzle-orm";
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
  POST as emissionPOST,
  OPTIONS as emissionOPTIONS,
} from "@/app/api/activities/emission/route";
import { POST as approvePOST } from "@/app/api/activities/emission/[id]/approve/route";
import { PATCH as emissionPATCH } from "@/app/api/activities/emission/[id]/route";
import { POST as energyPOST } from "@/app/api/activities/energy/route";
import {
  GET as dqGET,
  OPTIONS as dqOPTIONS,
  PUT as dqPUT,
} from "@/app/api/dq/[objectType]/[objectId]/route";
import { POST as transitionPOST } from "@/app/api/revisions/[id]/transition/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertEmissionActivity,
  insertFacility,
  insertLegalEntity,
  insertPaidCompany,
  insertPeriod,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  dqAssessment,
  emissionFactor,
  reportRevision,
  validationResult,
} from "@/server/db/schema";
import { initialQualityTier } from "@/server/dq/assessments";
import {
  seedRevisionRows,
  VERSION_CARRY_HOOKS,
  type RowSession,
} from "@/server/inventory/rows";
import { INPUT_TABLE_NAMES, type InputRow } from "@/server/inventory/tables";
import { EVALUATORS, PENDING_EVALUATORS } from "@/server/validation/registry";

// ─── Request plumbing ────────────────────────────────────────────────────────

const request = (path: string, method = "GET"): NextRequest =>
  new Request(`http://api.example.com${path}`, { method }) as NextRequest;

const jsonRequest = (
  path: string,
  method: "POST" | "PATCH" | "PUT",
  body?: unknown,
): NextRequest =>
  new Request(`http://api.example.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as NextRequest;

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

const dqCtx = (objectType: string, objectId: string) => ({
  params: Promise.resolve({ objectType, objectId }),
});

// `body` is left as the `any` `Response.json()` gives, exactly as the S3/S4
// route suites do.
const answer = async (res: Response) => ({
  status: res.status,
  body: await res.json(),
});

// ─── Route callers ───────────────────────────────────────────────────────────

const postActivity = (body: unknown) =>
  emissionPOST(jsonRequest("/api/activities/emission", "POST", body)).then(
    answer,
  );

const patchActivity = (id: string, body: unknown) =>
  emissionPATCH(
    jsonRequest(`/api/activities/emission/${id}`, "PATCH", body),
    ctxFor(id),
  ).then(answer);

const approveActivity = (id: string) =>
  approvePOST(
    jsonRequest(`/api/activities/emission/${id}/approve`, "POST"),
    ctxFor(id),
  ).then(answer);

const postEnergy = (body: unknown) =>
  energyPOST(jsonRequest("/api/activities/energy", "POST", body)).then(answer);

const getDq = (objectType: string, objectId: string) =>
  dqGET(
    request(`/api/dq/${objectType}/${objectId}`),
    dqCtx(objectType, objectId),
  ).then(answer);

const putDq = (objectType: string, objectId: string, body: unknown) =>
  dqPUT(
    jsonRequest(`/api/dq/${objectType}/${objectId}`, "PUT", body),
    dqCtx(objectType, objectId),
  ).then(answer);

const postTransition = (revisionId: string, action: string, extra = {}) =>
  transitionPOST(
    jsonRequest(`/api/revisions/${revisionId}/transition`, "POST", {
      action,
      ...extra,
    }),
    ctxFor(revisionId),
  ).then(answer);

// ─── Session plumbing ────────────────────────────────────────────────────────

async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

async function signIn(userId: string): Promise<void> {
  getSessionMock.mockResolvedValue(await sessionFor(userId));
}

/** The rule codes a 422 payload names. */
function codes(body: { rules?: { code: string }[] }): string[] {
  return (body.rules ?? []).map((rule) => rule.code);
}

// ─── The manifest, the seam and the tier table (no database needed) ──────────

describe("the evaluator manifest after T4.3 (R-12)", () => {
  it("implements VAL-038 and VAL-039 and drops them from the pending list", () => {
    for (const code of ["VAL-038", "VAL-039"] as const) {
      expect(EVALUATORS[code]).toBeTypeOf("function");
      expect(PENDING_EVALUATORS[code]).toBeUndefined();
    }
  });

  it("leaves exactly the codes that wait for something T4.3 does not build", () => {
    // Named one by one rather than counted: the point of the manifest is WHICH
    // gap is scheduled to WHOM. T4.4 took the approval gates' three
    // (VAL-036/VAL-040/VAL-041) as it built them, so everything left waits for a
    // CALCULATION (T5.3/T5.4) — nothing left waits for a table or for a gate.
    // T5.4 removed the last three (VAL-017, VAL-034, VAL-035) with the run
    // that writes their subject, so the list this task's successors kept
    // shrinking is now EMPTY — which is the end state, not a gap: every §6.2
    // rule has an evaluator. The assertion stays because it is the one that
    // would go red if a later phase added a rule and forgot to own it.
    expect(Object.keys(PENDING_EVALUATORS).sort()).toEqual([]);
  });
});

describe("the S4 carry seam after T4.3", () => {
  it("registers both hooks, in the order the two tasks appended them", () => {
    expect(VERSION_CARRY_HOOKS.map((hook) => hook.name)).toEqual([
      "carry_evidence_links",
      "carry_dq_assessment",
    ]);
  });
});

describe("the DQ-1 tier table", () => {
  /** A row is only ever read for its `method` here — the rest is not consulted. */
  const rowWith = (method: string) => ({ method }) as unknown as InputRow;

  it("maps an estimate method to `estimate` and everything else to manual entry", () => {
    expect(initialQualityTier("emission_activity", rowWith("fuel_based"))).toBe(
      "medium_calculated",
    );
    expect(
      initialQualityTier("emission_activity", rowWith("engineering_estimate")),
    ).toBe("estimate");
    expect(
      initialQualityTier("emission_activity", rowWith("spend_based")),
    ).toBe("estimate");
    // `supplier_specific` deliberately does NOT become `high_primary`: that is a
    // claim about evidence nobody has looked at yet.
    expect(
      initialQualityTier("emission_activity", rowWith("supplier_specific")),
    ).toBe("medium_calculated");
  });

  it("has a rule for every one of the four input tables", () => {
    // The mapping is a TABLE read by the creator (`@/server/dq/assessments`), so
    // a fifth input table would have to be classified rather than silently
    // falling into whichever branch was written last.
    for (const table of INPUT_TABLE_NAMES) {
      expect(initialQualityTier(table, rowWith("fuel_based"))).toBeTypeOf(
        "string",
      );
    }
  });
});

describeIntegration("api/dq [LOCAL-DB]", () => {
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

  interface Fixture {
    companyId: string;
    adminId: string;
    contributorId: string;
    reviewerId: string;
    legalEntityId: string;
    facilityId: string;
    periodId: string;
    revisionId: string;
  }

  /**
   * A paid company with an `esg_admin` (signed in), a `contributor` and a
   * `reviewer`, one legal entity with a facility, a period covering it and a
   * current DRAFT revision.
   *
   * The three roles are the point: `data.write` without `data.review`
   * (contributor), `data.review` without `data.write` (reviewer) and both
   * (admin) are exactly the three answers this route has to give.
   */
  async function setup(): Promise<Fixture> {
    const company = await insertPaidCompany();
    const { user: admin } = await insertUserWithProfile({
      companyId: company.id,
      role: "esg_admin",
    });
    const { user: contributor } = await insertUserWithProfile({
      companyId: company.id,
      role: "contributor",
    });
    const { user: reviewer } = await insertUserWithProfile({
      companyId: company.id,
      role: "reviewer",
    });
    const entity = await insertLegalEntity(company.id);
    const site = await insertFacility(company.id, {
      legalEntityId: entity.id,
    });
    const { period } = await insertPeriod(company.id, {
      legalEntityId: entity.id,
      createdBy: admin.id,
    });
    const revision = await insertRevision(company.id, {
      periodId: period.id,
      createdBy: admin.id,
    });
    await signIn(admin.id);
    return {
      companyId: company.id,
      adminId: admin.id,
      contributorId: contributor.id,
      reviewerId: reviewer.id,
      legalEntityId: entity.id,
      facilityId: site.id,
      periodId: period.id,
      revisionId: revision.id,
    };
  }

  /** A minimal valid Scope-1 body: passes every blocking `record` rule. */
  const activityBody = (fx: Fixture, overrides: Record<string, unknown> = {}) =>
    ({
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
    }) as Record<string, unknown>;

  const energyBody = (fx: Fixture) => ({
    revision_id: fx.revisionId,
    legal_entity_id: fx.legalEntityId,
    facility_id: fx.facilityId,
    energy_type: "electricity",
    supplier: "Elektro Ljubljana",
    consumption: 12000,
    unit: "kWh",
    year_month: "2024-01",
  });

  /** Every assessment of one company, oldest first. */
  const allAssessments = (companyId: string) =>
    getTestDb()
      .select()
      .from(dqAssessment)
      .where(eq(dqAssessment.companyId, companyId));

  /** The assessment of one object, read straight from the table. */
  async function assessmentOf(companyId: string, objectId: string) {
    const [row] = await getTestDb()
      .select()
      .from(dqAssessment)
      .where(
        and(
          eq(dqAssessment.companyId, companyId),
          eq(dqAssessment.objectId, objectId),
        ),
      );
    return row;
  }

  /** A stored `validation_result` of one rule against one object. */
  async function resultFor(companyId: string, code: string, objectId: string) {
    const [row] = await getTestDb()
      .select()
      .from(validationResult)
      .where(
        and(
          eq(validationResult.companyId, companyId),
          eq(validationResult.ruleCode, code),
          eq(validationResult.objectId, objectId),
        ),
      );
    return row;
  }

  /** The four scores VAL-038 asks for, filled in. */
  const filledScores = {
    reliability_score: 4,
    temporal_score: 3,
    geographical_score: 3,
    technology_score: 4,
    is_overridden: false,
  };

  const rowSession = (fx: Fixture): Promise<RowSession> =>
    sessionFor(fx.adminId) as Promise<RowSession>;

  async function forceStatus(revisionId: string, status: string) {
    await getTestDb()
      .update(reportRevision)
      .set({ status })
      .where(eq(reportRevision.id, revisionId));
  }

  // ─── DQ-1 — the assessment arrives with the row ────────────────────────────

  describe("auto-create (DQ-1, К-16)", () => {
    it("gives a created row exactly ONE assessment, pre-filled and unscored", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      const rows = await allAssessments(fx.companyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        objectType: "emission_activity",
        objectId: row.id,
        // DQ-1: the tier comes from the method, the scores stay NULL until
        // somebody assesses them.
        qualityTier: "medium_calculated",
        reliabilityScore: null,
        temporalScore: null,
        geographicalScore: null,
        technologyScore: null,
        isOverridden: false,
        overrideReason: null,
        // Nobody assessed it — a rule-driven pre-fill is not a judgement.
        assessedBy: null,
      });
    });

    it("reads the tier off the METHOD: an estimate method starts as `estimate`", async () => {
      const fx = await setup();
      const estimated = (
        await postActivity(activityBody(fx, { method: "engineering_estimate" }))
      ).body.data;

      expect((await assessmentOf(fx.companyId, estimated.id)).qualityTier).toBe(
        "estimate",
      );
    });

    it("covers a second input table, not just Scope 1", async () => {
      const fx = await setup();
      const energy = (await postEnergy(energyBody(fx))).body.data;

      const row = await assessmentOf(fx.companyId, energy.id);
      expect(row).toMatchObject({
        objectType: "purchased_energy_activity",
        // No `method` column on this table — every row of it is a manual entry.
        qualityTier: "medium_calculated",
      });
    });

    it("writes NOTHING when the row itself is refused (one transaction)", async () => {
      const fx = await setup();
      // VAL-104 (К-18): no facility and no note is a blocking refusal.
      const refused = await postActivity(
        activityBody(fx, { facility_id: null, notes: null }),
      );
      expect(refused.status).toBe(422);
      expect(codes(refused.body)).toContain("VAL-104");

      // The assessment would be an orphan pointing at a row that never existed.
      expect(await allAssessments(fx.companyId)).toHaveLength(0);
    });

    it("keeps one assessment per object under the UNIQUE key", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      await expect(
        getTestDb().insert(dqAssessment).values({
          companyId: fx.companyId,
          objectType: "emission_activity",
          objectId: row.id,
        }),
      ).rejects.toThrow();
    });
  });

  // ─── DQ-5 — the copy onto a new version ────────────────────────────────────

  describe("the version copy (DQ-5, §4.17)", () => {
    it("gives the NEW version its own copy and leaves the old one its own", async () => {
      const fx = await setup();
      const first = (await postActivity(activityBody(fx))).body.data;

      const scored = await putDq("emission_activity", first.id, {
        ...filledScores,
        quality_comment: "meter readings",
      });
      expect(scored.status).toBe(200);

      const second = (await patchActivity(first.id, { activity_value: 1200 }))
        .body.data;
      expect(second.id).not.toBe(first.id);

      const before = await assessmentOf(fx.companyId, first.id);
      const after = await assessmentOf(fx.companyId, second.id);

      // Two rows, two ids — a copy, never a move. The history of the superseded
      // version is intact, which is the whole point of DQ-5.
      expect(await allAssessments(fx.companyId)).toHaveLength(2);
      expect(after.id).not.toBe(before.id);
      expect(after).toMatchObject({
        reliabilityScore: 4,
        temporalScore: 3,
        geographicalScore: 3,
        technologyScore: 4,
        qualityComment: "meter readings",
        assessedBy: fx.adminId,
      });
      expect(before).toMatchObject({
        reliabilityScore: 4,
        qualityComment: "meter readings",
      });
    });

    it("carries the assessment through approve and through a tombstone", async () => {
      const fx = await setup();
      const draft = (await postActivity(activityBody(fx))).body.data;
      await putDq("emission_activity", draft.id, filledScores);

      const approved = (await approveActivity(draft.id)).body.data;
      expect(
        (await assessmentOf(fx.companyId, approved.id)).reliabilityScore,
      ).toBe(4);

      // An approved row's successor needs a reason (LC-5); the tombstone keeps
      // the assessment because "how good was the figure we removed" is asked
      // exactly when it is removed.
      const tombstone = (
        await patchActivity(approved.id, {
          activity_value: 5,
          change_reason: "meter re-read",
        })
      ).body.data;
      expect(
        (await assessmentOf(fx.companyId, tombstone.id)).reliabilityScore,
      ).toBe(4);
    });

    it("transfers the assessment onto a seeded restatement (LC-9)", async () => {
      const fx = await setup();
      const source = (await postActivity(activityBody(fx))).body.data;
      await putDq("emission_activity", source.id, filledScores);

      const restated = await insertRevision(fx.companyId, {
        periodId: fx.periodId,
        createdBy: fx.adminId,
        revisionNo: 2,
        isCurrent: false,
      });
      const session = await rowSession(fx);
      const seeded = await seedRevisionRows(
        getTestDb(),
        fx.companyId,
        { userId: session.userId, role: "esg_admin" },
        fx.revisionId,
        restated.id,
      );
      expect(seeded.total).toBe(1);

      const rows = await allAssessments(fx.companyId);
      expect(rows).toHaveLength(2);
      const copy = rows.find((row) => row.objectId !== source.id);
      expect(copy).toMatchObject({ reliabilityScore: 4, temporalScore: 3 });
    });

    it("carries `is_overridden` AND its reason together", async () => {
      const fx = await setup();
      const first = (await postActivity(activityBody(fx))).body.data;
      const overridden = await putDq("emission_activity", first.id, {
        ...filledScores,
        is_overridden: true,
        override_reason: "supplier confirmed the meter in writing",
      });
      expect(overridden.status).toBe(200);

      const second = (await patchActivity(first.id, { activity_value: 1200 }))
        .body.data;

      // The pair travels together: dropping the FLAG would present hand-set
      // scores as computed ones, and dropping BOTH would let an edit erase a
      // reviewer's judgement. Carrying both keeps VAL-039 satisfied by
      // construction.
      expect(await assessmentOf(fx.companyId, second.id)).toMatchObject({
        isOverridden: true,
        overrideReason: "supplier confirmed the meter in writing",
      });
    });
  });

  // ─── DQ-2 — the override, its capability and its reason ────────────────────

  describe("the override (DQ-2, VAL-039)", () => {
    it("refuses an override with no reason — 422 VAL-039, nothing written", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      const refused = await putDq("emission_activity", row.id, {
        ...filledScores,
        is_overridden: true,
      });
      expect(refused.status).toBe(422);
      expect(codes(refused.body)).toContain("VAL-039");

      // VR-3: the blocking rule rolled the whole write back, so not even the
      // scores landed — the assessment is exactly as the row service left it.
      expect(await assessmentOf(fx.companyId, row.id)).toMatchObject({
        isOverridden: false,
        reliabilityScore: null,
      });
    });

    it("accepts an override with a reason from a role that may review", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      const done = await putDq("emission_activity", row.id, {
        ...filledScores,
        is_overridden: true,
        override_reason: "site engineer re-measured the boiler",
      });
      expect(done.status).toBe(200);
      expect(done.body.data.assessment).toMatchObject({
        is_overridden: true,
        override_reason: "site engineer re-measured the boiler",
        assessed_by: fx.adminId,
      });
    });

    it("refuses an override by a role WITHOUT `data.review` — 403", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      await signIn(fx.contributorId);
      // A contributor may edit the scores: that is `data.write`.
      const scored = await putDq("emission_activity", row.id, filledScores);
      expect(scored.status).toBe(200);

      const refused = await putDq("emission_activity", row.id, {
        ...filledScores,
        is_overridden: true,
        override_reason: "because I say so",
      });
      expect(refused.status).toBe(403);
      expect(await assessmentOf(fx.companyId, row.id)).toMatchObject({
        isOverridden: false,
      });
    });

    it("puts the capability BEFORE the reason (§0.2): 403, not 422", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      await signIn(fx.contributorId);
      const refused = await putDq("emission_activity", row.id, {
        ...filledScores,
        is_overridden: true,
      });
      // Both things are wrong with the request; the ROLE is decided first, so
      // the answer never tells a contributor how to make the override valid.
      expect(refused.status).toBe(403);
    });

    it("needs `data.review` to CLEAR somebody else's override too", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;
      await putDq("emission_activity", row.id, {
        ...filledScores,
        is_overridden: true,
        override_reason: "reviewed against the supplier statement",
      });

      await signIn(fx.contributorId);
      const cleared = await putDq("emission_activity", row.id, {
        ...filledScores,
        is_overridden: false,
      });
      expect(cleared.status).toBe(403);
      expect(await assessmentOf(fx.companyId, row.id)).toMatchObject({
        isOverridden: true,
      });

      // The reviewer's own role cannot do it either — the ROUTE is `data.write`
      // (DQ-2), and a reviewer does not record data.
      await signIn(fx.reviewerId);
      const byReviewer = await putDq("emission_activity", row.id, {
        ...filledScores,
        is_overridden: false,
      });
      expect(byReviewer.status).toBe(403);
    });
  });

  // ─── DQ-3 / VAL-038 — the warning that stops nothing ───────────────────────

  describe("VAL-038 — completeness of the assessment (DQ-3)", () => {
    it("fails on a fresh row: a tier is not an assessment", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      const assessment = await assessmentOf(fx.companyId, row.id);
      // The pre-fill DID set a tier — and the rule still fails, because the four
      // pedigree scores are what "заполнены обязательные DQ-оценки" means.
      expect(assessment.qualityTier).toBe("medium_calculated");

      const result = await resultFor(fx.companyId, "VAL-038", assessment.id);
      expect(result).toMatchObject({
        passed: false,
        severity: "warning",
        blocking: false,
        objectType: "dq_assessment",
        // Filed against the row's revision, so it surfaces on
        // `GET /api/revisions/[id]/validation` beside everything else.
        revisionId: fx.revisionId,
      });
    });

    it("passes once the four pedigree scores are filled in", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      const saved = await putDq("emission_activity", row.id, filledScores);
      expect(saved.status).toBe(200);
      // A Warning travels WITH the successful write; after the fix there is
      // nothing left to warn about.
      expect(
        (saved.body.data.warnings as { code: string }[]).map((w) => w.code),
      ).not.toContain("VAL-038");

      const assessment = await assessmentOf(fx.companyId, row.id);
      expect(
        (await resultFor(fx.companyId, "VAL-038", assessment.id)).passed,
      ).toBe(true);
    });

    it("does NOT impede submit (DQ-3) — empty scores and a green transition", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;
      const approved = (await approveActivity(row.id)).body.data;

      const assessment = await assessmentOf(fx.companyId, approved.id);
      expect(assessment.reliabilityScore).toBeNull();
      expect(
        (await resultFor(fx.companyId, "VAL-038", assessment.id)).passed,
      ).toBe(false);

      // The whole point of the severity: an unfinished quality assessment is
      // recorded and reported, it does not close the door on the report.
      const submitted = await postTransition(fx.revisionId, "submit");
      expect(submitted.status).toBe(200);
      expect(submitted.body.data.to).toBe("submitted");
    });
  });

  // ─── The column's own ranges (§4.17) ───────────────────────────────────────

  describe("score ranges", () => {
    it("refuses `reliability_score = 6` at the CHECK constraint", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      // Written PAST the route's parser, straight at the table: the CHECK is
      // what makes 6 impossible, and the 422 below is only that made legible.
      await expect(
        getTestDb()
          .update(dqAssessment)
          .set({ reliabilityScore: 6 })
          .where(eq(dqAssessment.objectId, row.id)),
      ).rejects.toThrow();

      const refused = await putDq("emission_activity", row.id, {
        ...filledScores,
        reliability_score: 6,
      });
      expect(refused.status).toBe(422);
      expect(refused.body.field).toBe("reliability_score");
    });

    it("refuses a percentage outside 0–100 and an unknown tier", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      expect(
        (
          await putDq("emission_activity", row.id, {
            is_overridden: false,
            coverage_score: 101,
          })
        ).body.field,
      ).toBe("coverage_score");
      expect(
        (
          await putDq("emission_activity", row.id, {
            is_overridden: false,
            quality_tier: "excellent",
          })
        ).body.field,
      ).toBe("quality_tier");
      // The field the guard reads is mandatory — a body that omits it never says
      // what it means (see `DqValues`).
      expect(
        (await putDq("emission_activity", row.id, { temporal_score: 2 })).body
          .field,
      ).toBe("is_overridden");
    });
  });

  // ─── The freeze (§5.3, LC-8(2), VAL-010) ───────────────────────────────────

  describe("the freeze covers assessments (§5.3)", () => {
    it("refuses a PUT against a row of a LOCKED revision — 422 VAL-010", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;
      await forceStatus(fx.revisionId, "locked");

      const refused = await putDq("emission_activity", row.id, filledScores);
      expect(refused.status).toBe(422);
      expect(codes(refused.body)).toContain("VAL-010");
      expect(await assessmentOf(fx.companyId, row.id)).toMatchObject({
        reliabilityScore: null,
      });
    });
  });

  // ─── Reads, tenancy and the wire (К-8, PATTERN 2/3) ────────────────────────

  describe("the endpoint itself", () => {
    it("keeps shared-factor assessments and their authors independent across companies", async () => {
      const a = await setup();
      const b = await setup();
      const [factor] = await getTestDb().select().from(emissionFactor).limit(1);
      expect(factor).toBeDefined();

      await signIn(a.adminId);
      const savedA = await putDq("emission_factor", factor.id, {
        ...filledScores,
        reliability_score: 1,
        quality_comment: "Company A assessment",
      });
      expect(savedA.status).toBe(200);
      const originalA = savedA.body.data.assessment;
      expect(originalA.assessed_by).toBe(a.adminId);

      await signIn(b.adminId);
      const emptyB = await getDq("emission_factor", factor.id);
      expect(emptyB.status).toBe(200);
      expect(emptyB.body.data.assessment).toBeNull();
      const savedB = await putDq("emission_factor", factor.id, {
        ...filledScores,
        reliability_score: 5,
        quality_comment: "Company B assessment",
      });
      expect(savedB.status).toBe(200);
      const originalB = savedB.body.data.assessment;
      expect(originalB.id).not.toBe(originalA.id);
      expect(originalB.assessed_by).toBe(b.adminId);

      // A partial PUT updates B's existing assessment without touching A's.
      await signIn(b.contributorId);
      const updatedB = await putDq("emission_factor", factor.id, {
        is_overridden: false,
        reliability_score: 2,
      });
      expect(updatedB.status).toBe(200);
      expect(updatedB.body.data.assessment).toMatchObject({
        id: originalB.id,
        reliability_score: 2,
        quality_comment: "Company B assessment",
        assessed_by: b.contributorId,
      });
      const readB = await getDq("emission_factor", factor.id);
      expect(readB.status).toBe(200);
      expect(readB.body.data.assessment).toEqual(updatedB.body.data.assessment);

      await signIn(a.adminId);
      const readA = await getDq("emission_factor", factor.id);
      expect(readA.status).toBe(200);
      // Includes A's id, author, timestamp, scores and comment.
      expect(readA.body.data.assessment).toEqual(originalA);
      expect(await allAssessments(a.companyId)).toHaveLength(1);
      expect(await allAssessments(b.companyId)).toHaveLength(1);
    });

    it("does not expose or clear another company's shared-factor override", async () => {
      const a = await setup();
      const b = await setup();
      const [factor] = await getTestDb().select().from(emissionFactor).limit(1);
      expect(factor).toBeDefined();

      await signIn(a.adminId);
      const savedA = await putDq("emission_factor", factor.id, {
        ...filledScores,
        is_overridden: true,
        override_reason: "Company A reviewer decision",
        quality_comment: "Company A private comment",
      });
      expect(savedA.status).toBe(200);
      const originalA = savedA.body.data.assessment;

      // A contributor may write B's own assessment, even if A has an override.
      await signIn(b.contributorId);
      const savedB = await putDq("emission_factor", factor.id, {
        is_overridden: false,
        reliability_score: 5,
      });
      expect(savedB.status).toBe(200);
      expect(savedB.body.data.assessment).toMatchObject({
        is_overridden: false,
        override_reason: null,
        quality_comment: null,
        assessed_by: b.contributorId,
      });
      expect(savedB.body.data.assessment.id).not.toBe(originalA.id);

      await signIn(a.contributorId);
      const readA = await getDq("emission_factor", factor.id);
      expect(readA.status).toBe(200);
      expect(readA.body.data.assessment).toEqual(originalA);
      // The existing review-capability guard still protects A's own override.
      const refused = await putDq("emission_factor", factor.id, {
        is_overridden: false,
      });
      expect(refused.status).toBe(403);
      expect(
        (await getDq("emission_factor", factor.id)).body.data.assessment,
      ).toEqual(originalA);
    });

    it("reads back what the row service created", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      const read = await getDq("emission_activity", row.id);
      expect(read.status).toBe(200);
      expect(read.body.data.assessment).toMatchObject({
        object_type: "emission_activity",
        object_id: row.id,
        quality_tier: "medium_calculated",
        reliability_score: null,
        is_overridden: false,
      });
    });

    it("answers `null` for an object that has no assessment yet", async () => {
      const fx = await setup();
      // `facility` is one of the three object types the row service never
      // touches (DM-27 shares DM-25's vocabulary), so its first PUT is a create.
      const read = await getDq("facility", fx.facilityId);
      expect(read.status).toBe(200);
      expect(read.body.data.assessment).toBeNull();

      const written = await putDq("facility", fx.facilityId, {
        ...filledScores,
        quality_tier: "high_primary",
      });
      expect(written.status).toBe(200);
      expect(written.body.data.assessment.quality_tier).toBe("high_primary");

      // And the second PUT updates rather than colliding on the UNIQUE.
      const again = await putDq("facility", fx.facilityId, {
        is_overridden: false,
        quality_tier: "low_proxy",
      });
      expect(again.status).toBe(200);
      expect(again.body.data.assessment.id).toBe(
        written.body.data.assessment.id,
      );
      expect(again.body.data.assessment.quality_tier).toBe("low_proxy");
      // Untouched columns survive a partial PUT.
      expect(again.body.data.assessment.reliability_score).toBe(4);
    });

    it("treats another tenant's object as absent (К-8, API-1)", async () => {
      await setup();
      const other = await insertCompany();
      const foreign = await insertEmissionActivity(other.id);

      expect((await getDq("emission_activity", foreign.id)).status).toBe(404);
      expect(
        (await putDq("emission_activity", foreign.id, filledScores)).status,
      ).toBe(404);
      // Nothing was written into the other tenant's data either.
      expect(await allAssessments(other.id)).toHaveLength(0);
    });

    it("answers an unusable path as absent", async () => {
      const fx = await setup();
      expect(
        (await getDq("monthly_emissions_data", fx.facilityId)).status,
      ).toBe(404);
      expect((await getDq("facility", "not-a-uuid")).status).toBe(404);
    });

    it("refuses a reader without `data.write` on PUT and answers CORS", async () => {
      const fx = await setup();
      const row = (await postActivity(activityBody(fx))).body.data;

      await signIn(fx.reviewerId);
      expect((await getDq("emission_activity", row.id)).status).toBe(200);
      expect(
        (await putDq("emission_activity", row.id, filledScores)).status,
      ).toBe(403);

      const preflight = await dqOPTIONS(
        request(`/api/dq/emission_activity/${row.id}`, "OPTIONS"),
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toContain(
        "PUT",
      );
      // The row routes' preflight is unchanged by this task.
      expect(
        (await emissionOPTIONS(request("/api/activities/emission", "OPTIONS")))
          .status,
      ).toBe(204);
    });
  });
});
