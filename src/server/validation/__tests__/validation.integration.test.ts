// [LOCAL-DB] The validation engine, end to end, against a real Postgres via the
// T1.7 harness. TWO SUITES LIVE HERE:
//
//   • T2.1 — the RUNNER, the DM-28 upsert key and the two routes;
//   • T4.4 — §6.2 IN FULL: every implemented Phase-1 rule in a pass/fail pair,
//     and for every blocking one, what exactly it blocks (VR-3). Its own header
//     is below, above `CASES`.
//
// What this file is really about is the UNIQUE KEY of §4.18. Its COALESCE
// placeholders ('--' and the nil uuid) are the only reason a rule with a NULL
// target has a stable identity at all, and a mistake there does not fail
// loudly: it silently appends a second row per run, so a period screen shows
// the same finding four times and a "fixed" failure never disappears. Hence the
// assertions are on ROW COUNTS after a re-run, not only on values.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so this file
// is a green no-op in a DB-less CI.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { and, eq, like, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
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
  GET as revisionValidationGET,
  OPTIONS as revisionValidationOPTIONS,
} from "@/app/api/revisions/[id]/validation/route";
import {
  OPTIONS as runOPTIONS,
  POST as runPOST,
} from "@/app/api/validation/run/route";
import { resolveSessionContext } from "@/server/auth/session";
import { calculateRevision } from "@/server/calc/run";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertDocument,
  insertDq,
  insertEmissionActivity,
  insertEnergyActivity,
  insertEvidenceLink,
  insertFacility,
  insertInstrument,
  insertLegalEntity,
  insertPaidCompany,
  insertPeriod,
  insertPeriodScope,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupDocumentsDir,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  calculation,
  document,
  dqAssessment,
  emissionFactor,
  factorSet,
  legalEntity,
  reportRevision,
  reportingPeriod,
  validationResult,
} from "@/server/db/schema";
import {
  createFactor,
  createFactorSet,
  type NewFactorValues,
} from "@/server/factors/factor-sets";
import {
  approveRow,
  createRow,
  deleteRow,
  editRow,
} from "@/server/inventory/rows";
import type { InputTableName } from "@/server/inventory/tables";
import { updateFacility } from "@/server/org/facilities";
import { updateLegalEntity } from "@/server/org/legal-entities";
import { REVISION_LOCK_FIELD } from "@/server/periods/lifecycle";
import { updatePeriod } from "@/server/periods/periods";
import {
  TRANSITION_PRECONDITIONS,
  transitionRevision,
} from "@/server/revisions/transition";
import { DocumentStorageError } from "@/server/storage/document-storage";
import { EVALUATORS, PENDING_EVALUATORS } from "@/server/validation/registry";
import {
  VALIDATION_RULES,
  findRule,
  type ValidationRuleCode,
  type ValidationScope,
} from "@/server/validation/rules";
import {
  blockingFailures,
  runValidation,
  upsertValidationResults,
  type ValidationResultRecord,
} from "@/server/validation/run";
import type { PlanId } from "@/shared/plans";

/** A request the route handlers accept (`NextRequest` is a superset of `Request`). */
const request = (path: string, origin?: string): NextRequest =>
  new Request(`http://api.example.com${path}`, {
    headers: origin ? { origin } : undefined,
  }) as unknown as NextRequest;

/** A JSON POST request (the run route reads `req.json()`). */
const jsonRequest = (path: string, body: unknown): NextRequest =>
  new Request(`http://api.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;

/** The `{ params }` context Next hands a dynamic route. */
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

/** The session `getSession()` would resolve for a user (PATTERN 3 identity). */
async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

/** Every stored result row of a company, oldest column set first. */
async function storedResults(companyId: string) {
  return getTestDb()
    .select()
    .from(validationResult)
    .where(eq(validationResult.companyId, companyId))
    .orderBy(validationResult.ruleCode);
}

/** One stored row by (company, rule, object). */
async function storedResult(
  companyId: string,
  ruleCode: string,
  objectId: string,
) {
  const [row] = await getTestDb()
    .select()
    .from(validationResult)
    .where(
      and(
        eq(validationResult.companyId, companyId),
        eq(validationResult.ruleCode, ruleCode),
        eq(validationResult.objectId, objectId),
      ),
    );
  return row;
}

/** One `report_revision` row, for the assertions about what a gate let through. */
async function storedRevision(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(reportRevision)
    .where(eq(reportRevision.id, id));
  return row;
}

/** A record with a fully-NULL target — the shape О-17 is about. */
const nullTargetRecord = (passed: boolean): ValidationResultRecord => ({
  ruleCode: "VAL-102",
  scope: "period",
  severity: "error",
  blocking: true,
  passed,
  message: "Консолидированный отчёт: ≥2 включённых юрлица",
  objectType: null,
  objectId: null,
  revisionId: null,
});

describeIntegration("T2.1 validation engine", () => {
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

  // ─── reference_org scope ───────────────────────────────────────────────────
  it("fails VAL-001 for an entity with no registration number, passes VAL-004", async () => {
    const company = await insertPaidCompany();
    const entity = await insertLegalEntity(company.id, {
      registrationNumber: null,
    });

    const results = await runValidation(getTestDb(), {
      companyId: company.id,
      scope: "reference_org",
      targetId: entity.id,
    });

    const byCode = Object.fromEntries(results.map((r) => [r.ruleCode, r]));
    expect(byCode["VAL-001"].passed).toBe(false);
    expect(byCode["VAL-001"].blocking).toBe(true);
    expect(byCode["VAL-001"].severity).toBe("error");
    expect(byCode["VAL-001"].objectType).toBe("legal_entity");
    expect(byCode["VAL-004"].passed).toBe(true);
    // Only the LEGAL-ENTITY rules ran: the facility rule (VAL-006) shares the
    // `reference_org` scope but found no facility with that id. The list is
    // asserted by membership rather than by equality because later tasks add
    // evaluators to this scope (T2.2 brought VAL-002/VAL-003) — the invariant is
    // "entity rules yes, facility rules no", not a fixed count.
    const codes = results.map((r) => r.ruleCode);
    expect(codes).toEqual(expect.arrayContaining(["VAL-001", "VAL-004"]));
    expect(codes).not.toContain("VAL-006");
    expect(results.every((r) => r.objectType === "legal_entity")).toBe(true);

    const stored = await storedResults(company.id);
    expect(stored).toHaveLength(results.length);
    // The stored message is the canonical RU (О-12) — the UI translates by code.
    expect(stored.find((r) => r.ruleCode === "VAL-001")?.message).toContain(
      "Обязательные поля организации",
    );
  });

  it("re-running a rule UPDATES its row instead of duplicating it (§4.18 key)", async () => {
    const company = await insertPaidCompany();
    const entity = await insertLegalEntity(company.id, {
      registrationNumber: null,
    });

    const firstRun = await runValidation(getTestDb(), {
      companyId: company.id,
      scope: "reference_org",
      targetId: entity.id,
    });
    const first = await storedResult(company.id, "VAL-001", entity.id);
    expect(first.passed).toBe(false);
    expect(await storedResults(company.id)).toHaveLength(firstRun.length);

    // Fix the data and re-run: same row, flipped verdict, no second row.
    await getTestDb()
      .update(legalEntity)
      .set({ registrationNumber: "REG-1" })
      .where(eq(legalEntity.id, entity.id));

    await runValidation(getTestDb(), {
      companyId: company.id,
      scope: "reference_org",
      targetId: entity.id,
    });

    const stored = await storedResults(company.id);
    // One row per rule of the run — the SECOND run updated them, it did not
    // append a second set (which is the whole point of the §4.18 key).
    expect(stored).toHaveLength(firstRun.length);
    const second = await storedResult(company.id, "VAL-001", entity.id);
    expect(second.id).toBe(first.id); // updated in place
    expect(second.passed).toBe(true);
    expect(second.evaluatedAt?.getTime()).toBeGreaterThanOrEqual(
      first.evaluatedAt?.getTime() ?? 0,
    );
  });

  it("fails VAL-006 for an out-of-range latitude and passes a valid pair", async () => {
    const company = await insertPaidCompany();
    const bad = await insertFacility(company.id, { latitude: "91" });
    const good = await insertFacility(company.id, {
      latitude: "46.05",
      longitude: "14.5",
    });

    for (const facility of [bad, good]) {
      await runValidation(getTestDb(), {
        companyId: company.id,
        scope: "reference_org",
        targetId: facility.id,
      });
    }

    expect((await storedResult(company.id, "VAL-006", bad.id)).passed).toBe(
      false,
    );
    expect((await storedResult(company.id, "VAL-006", good.id)).passed).toBe(
      true,
    );
  });

  it("writes nothing for a target of another company (tenant pin)", async () => {
    const mine = await insertPaidCompany();
    const theirs = await insertPaidCompany();
    const foreign = await insertLegalEntity(theirs.id);

    const results = await runValidation(getTestDb(), {
      companyId: mine.id,
      scope: "reference_org",
      targetId: foreign.id,
    });

    expect(results).toEqual([]);
    expect(await storedResults(mine.id)).toHaveLength(0);
    expect(await storedResults(theirs.id)).toHaveLength(0);
  });

  // ─── period scope ──────────────────────────────────────────────────────────
  it("reports VAL-009 as a non-blocking warning when two periods overlap", async () => {
    const company = await insertPaidCompany();
    const { period } = await insertPeriod(company.id, {
      startDate: "2024-01-01",
      endDate: "2024-12-31",
    });

    let results = await runValidation(getTestDb(), {
      companyId: company.id,
      scope: "period",
      targetId: period.id,
    });
    let byCode = Object.fromEntries(results.map((r) => [r.ruleCode, r]));
    expect(byCode["VAL-008"].passed).toBe(true);
    expect(byCode["VAL-009"].passed).toBe(true);

    // A second period that overlaps the first.
    await insertPeriod(company.id, {
      startDate: "2024-07-01",
      endDate: "2025-06-30",
      reportingYear: 2025,
    });

    results = await runValidation(getTestDb(), {
      companyId: company.id,
      scope: "period",
      targetId: period.id,
    });
    byCode = Object.fromEntries(results.map((r) => [r.ruleCode, r]));
    expect(byCode["VAL-009"].passed).toBe(false);
    expect(byCode["VAL-009"].severity).toBe("warning");
    expect(byCode["VAL-009"].blocking).toBe(false);
    // Still one row per (rule, target) — the overlap did not duplicate anything.
    //
    // GROWTH-PROOF against `results`, not a fixed 2. It was `toHaveLength(2)`
    // while VAL-008 and VAL-009 were the only implemented rules of the `period`
    // scope; T2.4 added VAL-103 (a finding per boundary row, and `insertPeriod`
    // creates one). The invariant this line is FOR is "the second run updated
    // the same rows instead of appending a set", which is what the comparison
    // with the run's own record count says — the same idiom the reference_org
    // tests above already use.
    expect(await storedResults(company.id)).toHaveLength(results.length);
    expect(
      (await storedResults(company.id)).filter((r) => r.ruleCode === "VAL-009"),
    ).toHaveLength(1);
  });

  // ─── the COALESCE/NIL_UUID unique key itself ───────────────────────────────
  it("does not collide a NULL-target result with an object-scoped one", async () => {
    const company = await insertPaidCompany();
    const { period } = await insertPeriod(company.id);

    const objectScoped: ValidationResultRecord = {
      ...nullTargetRecord(false),
      objectType: "reporting_period",
      objectId: period.id,
    };
    await upsertValidationResults(getTestDb(), company.id, [
      nullTargetRecord(false),
      objectScoped,
    ]);
    expect(await storedResults(company.id)).toHaveLength(2);

    // Re-running the SAME pair updates both rows and adds none.
    await upsertValidationResults(getTestDb(), company.id, [
      nullTargetRecord(true),
      { ...objectScoped, passed: true },
    ]);
    const stored = await storedResults(company.id);
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.passed)).toBe(true);
    expect(stored.filter((row) => row.objectId === null)).toHaveLength(1);
  });

  it("keeps two companies' fully-NULL targets apart (О-17)", async () => {
    const alpha = await insertPaidCompany();
    const beta = await insertPaidCompany();

    await upsertValidationResults(getTestDb(), alpha.id, [
      nullTargetRecord(false),
    ]);
    await upsertValidationResults(getTestDb(), beta.id, [
      nullTargetRecord(true),
    ]);

    expect(await storedResults(alpha.id)).toHaveLength(1);
    expect(await storedResults(beta.id)).toHaveLength(1);
    expect((await storedResults(alpha.id))[0].passed).toBe(false);
    expect((await storedResults(beta.id))[0].passed).toBe(true);
  });

  it("distinguishes results of the same rule on different revisions", async () => {
    const company = await insertPaidCompany();
    const first = await insertRevision(company.id);
    const second = await insertRevision(company.id, {
      periodId: first.periodId,
      revisionNo: 2,
      isCurrent: false,
    });

    await upsertValidationResults(getTestDb(), company.id, [
      { ...nullTargetRecord(false), revisionId: first.id },
      { ...nullTargetRecord(true), revisionId: second.id },
    ]);

    const stored = await storedResults(company.id);
    expect(stored).toHaveLength(2);
    expect(stored.find((r) => r.revisionId === first.id)?.passed).toBe(false);
    expect(stored.find((r) => r.revisionId === second.id)?.passed).toBe(true);
  });

  // ─── routes ────────────────────────────────────────────────────────────────
  it("POST /api/validation/run → 401 with no session, 422 on a bad body", async () => {
    getSessionMock.mockResolvedValue(null);
    const unauth = await runPOST(
      jsonRequest("/api/validation/run", { scope: "period", targetId: "x" }),
    );
    expect(unauth.status).toBe(401);

    const company = await insertPaidCompany();
    const { user } = await insertUserWithProfile({
      companyId: company.id,
      role: "esg_admin",
    });
    getSessionMock.mockResolvedValue(await sessionFor(user.id));

    const badScope = await runPOST(
      jsonRequest("/api/validation/run", {
        scope: "submission",
        targetId: "00000000-0000-0000-0000-000000000001",
      }),
    );
    expect(badScope.status).toBe(422);

    // A non-uuid target must be 422, not a driver error surfacing as 500.
    const badId = await runPOST(
      jsonRequest("/api/validation/run", {
        scope: "reference_org",
        targetId: "not-a-uuid",
      }),
    );
    expect(badId.status).toBe(422);
  });

  it("POST /api/validation/run → 403 for a role without data.write", async () => {
    const company = await insertPaidCompany();
    const { user } = await insertUserWithProfile({
      companyId: company.id,
      role: "auditor", // audit.read + data.read only
    });
    const entity = await insertLegalEntity(company.id);
    getSessionMock.mockResolvedValue(await sessionFor(user.id));

    const res = await runPOST(
      jsonRequest("/api/validation/run", {
        scope: "reference_org",
        targetId: entity.id,
      }),
    );
    expect(res.status).toBe(403);
    expect(await storedResults(company.id)).toHaveLength(0);
  });

  it("POST /api/validation/run runs the rules and echoes the blocking failures", async () => {
    const company = await insertPaidCompany();
    const { user } = await insertUserWithProfile({
      companyId: company.id,
      role: "esg_admin",
    });
    const entity = await insertLegalEntity(company.id, { country: null });
    getSessionMock.mockResolvedValue(await sessionFor(user.id));

    const res = await runPOST(
      jsonRequest("/api/validation/run", {
        scope: "reference_org",
        targetId: entity.id,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Every implemented entity rule answered, and exactly one of them refuses:
    // the missing country is VAL-001's business, and a NULL value passes the
    // reference-list rule (VAL-002) rather than failing it twice.
    expect(body.data.results.length).toBeGreaterThanOrEqual(2);
    expect(
      body.data.blocking.map((r: { ruleCode: string }) => r.ruleCode),
    ).toEqual(["VAL-001"]);
    expect(await storedResults(company.id)).toHaveLength(
      body.data.results.length,
    );
  });

  it("GET /api/revisions/:id/validation returns the revision's results, 404 across tenants", async () => {
    const company = await insertPaidCompany();
    const other = await insertPaidCompany();
    const { user } = await insertUserWithProfile({
      companyId: company.id,
      role: "auditor", // data.read is enough to READ results
    });
    const revision = await insertRevision(company.id);
    const foreign = await insertRevision(other.id);
    await upsertValidationResults(getTestDb(), company.id, [
      { ...nullTargetRecord(false), revisionId: revision.id },
    ]);
    getSessionMock.mockResolvedValue(await sessionFor(user.id));

    const res = await revisionValidationGET(
      request(`/api/revisions/${revision.id}/validation`),
      ctxFor(revision.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.results).toHaveLength(1);
    expect(body.data.results[0].ruleCode).toBe("VAL-102");
    expect(body.data.blocking).toHaveLength(1);

    // Another tenant's revision is indistinguishable from a missing one.
    const cross = await revisionValidationGET(
      request(`/api/revisions/${foreign.id}/validation`),
      ctxFor(foreign.id),
    );
    expect(cross.status).toBe(404);

    const malformed = await revisionValidationGET(
      request("/api/revisions/nope/validation"),
      ctxFor("nope"),
    );
    expect(malformed.status).toBe(422);
  });

  it("answers the CORS preflight on both routes (PATTERN 2)", async () => {
    const origin = "http://localhost:3000";
    for (const options of [runOPTIONS, revisionValidationOPTIONS]) {
      const res = options(request("/api/validation/run", origin));
      expect(res.status).toBeLessThan(300);
    }
  });

  it("stores the scope CHECK values Postgres accepts", async () => {
    const company = await insertPaidCompany();
    await upsertValidationResults(getTestDb(), company.id, [
      nullTargetRecord(true),
    ]);
    const [row] = await getTestDb().execute<{ scope: string }>(
      sql`SELECT scope FROM validation_result WHERE company_id = ${company.id}`,
    );
    expect(["record", "revision", "period", "reference_org"]).toContain(
      row.scope,
    );
  });
});

// =============================================================================
// T4.4 — §6.2 IN FULL: every implemented Phase-1 rule, pass and fail, and for
// every BLOCKING one, what exactly it blocks (VR-3).
//
// WHY THE TABLE IS COMPUTED AGAINST THE REGISTRY. A hand-written list of rule
// tests is a list that silently stops covering the inventory the moment a rule
// is added — which is the same failure mode `PENDING_EVALUATORS` exists to
// prevent one level down (R-12). So `CASES` is checked against `EVALUATORS`:
// every implemented code must appear exactly once, and a code with an evaluator
// and no case fails a test rather than going unnoticed.
//
// WHAT A CASE ASSERTS, and why both halves are needed. A rule that never fires
// passes every "is it green" test; a rule that always fires passes every "does
// it catch it" test. Only the PAIR says the rule discriminates — so each case
// builds the §6.2 wrong state, asserts a stored failure with the inventory's own
// severity/blocking/scope, then builds the right one and asserts a stored pass.
// The verdict is read from what `runValidation` WROTE, not from a return value:
// the stored row is what the UI, the report and the gates read.
//
// AND, FOR EVERY BLOCKING RULE, THE CONSEQUENCE. VR-3 says a blocking rule
// forbids advancement AT ITS OWN LEVEL, and "blocking" is worth nothing unless
// something is actually refused, so each blocking case performs the advancement
// its scope names and asserts the refusal cites the code:
//   • `reference_org` — the registry service refuses to save the record;
//   • `record`        — the row's APPROVE is refused, and a row forced past it
//                       stops the SUBMIT of its revision;
//   • `period`        — the LOCK is refused (VAL-105 with 402, not 422);
//   • `revision`      — the APPROVE of the revision is refused.
// The three rules gated on `mutatedFields` (VAL-010, VAL-105, VAL-106) block a
// WRITE rather than an advancement, and each says so in its own case.
// =============================================================================

/** The graph a rule case starts from. `pro` — not plan-gated, so F1 is silent. */
interface Fx {
  companyId: string;
  userId: string;
  entityId: string;
  facilityId: string;
  periodId: string;
  revisionId: string;
}

async function setupFx(plan: PlanId = "pro"): Promise<Fx> {
  const company = await insertCompany({ plan });
  const { user } = await insertUserWithProfile({
    companyId: company.id,
    role: "esg_admin",
  });
  const entity = await insertLegalEntity(company.id);
  const facility = await insertFacility(company.id, {
    legalEntityId: entity.id,
  });
  const { period } = await insertPeriod(company.id, {
    legalEntityId: entity.id,
  });
  const revision = await insertRevision(company.id, {
    periodId: period.id,
    createdBy: user.id,
  });
  getSessionMock.mockResolvedValue(await sessionFor(user.id));
  return {
    companyId: company.id,
    userId: user.id,
    entityId: entity.id,
    facilityId: facility.id,
    periodId: period.id,
    revisionId: revision.id,
  };
}

/** The session the SERVICES take (company narrowed, as every route does). */
async function serviceSession(userId: string) {
  const session = await sessionFor(userId);
  if (!session.company) throw new Error("session has no company");
  return { ...session, company: session.company };
}

/** What a case hands to the run — and to its `blocks` step. */
interface Subject {
  readonly scope: ValidationScope;
  readonly targetId: string;
  /** Declared by the write a `mutatedFields`-gated rule is about (VAL-010/105/106). */
  readonly mutatedFields?: readonly string[];
  /** The input table of `targetId`, when the subject is a row. */
  readonly table?: InputTableName;
  /** A revision to advance in the `blocks` step, when it is not `fx.revisionId`. */
  readonly revisionId?: string;
  /** A period to advance against, when it is not `fx.periodId`. */
  readonly periodId?: string;
  /** The draft set a factor case wrote into, and the values it wrote. */
  readonly factorSetId?: string;
  readonly factorValues?: NewFactorValues;
}

/** One rule of §6.2, as a pass/fail pair plus (when blocking) its consequence. */
interface RuleCase {
  readonly code: ValidationRuleCode;
  /** The plan the fixture company is on — only F1's gate cares (VAL-105). */
  readonly plan?: PlanId;
  readonly fail?: (fx: Fx) => Promise<Subject>;
  /**
   * The records of the failing run, for the ONE rule whose failing state cannot
   * exist outside a transaction (VAL-008 — its CHECK twin forbids it).
   */
  readonly failRun?: (fx: Fx) => Promise<ValidationResultRecord[]>;
  readonly pass: (fx: Fx) => Promise<Subject>;
  /** Perform what the rule must forbid; return the codes the refusal cited. */
  readonly blocks?: (fx: Fx, subject?: Subject) => Promise<string[]>;
}

/**
 * A SEPARATE revision carrying one approved electricity row and, optionally, one
 * approved certificate — the subject of CALC-5's matching and therefore of
 * VAL-022 and VAL-024.
 *
 * Separate because both rules are `revision` scope and judge the WHOLE entity's
 * balance: putting a passing and a failing scenario in `fx.revisionId` would
 * make one the other's noise. The default period is 2024, the row's
 * `year_month` and the certificate's vintage are both inside it, so CALC-1
 * takes them and the proration is a full one.
 */
async function scope2Revision(
  fx: Fx,
  spec: { consumption: string; unit?: string; covered?: string },
): Promise<string> {
  const { period } = await insertPeriod(fx.companyId, {
    legalEntityId: fx.entityId,
  });
  const revision = await insertRevision(fx.companyId, {
    periodId: period.id,
    createdBy: fx.userId,
  });
  await insertEnergyActivity(fx.companyId, {
    revisionId: revision.id,
    legalEntityId: fx.entityId,
    facilityId: fx.facilityId,
    energyType: "electricity",
    consumption: spec.consumption,
    unit: spec.unit ?? "MWh",
    yearMonth: "2024-01",
    state: "approved",
  });
  if (spec.covered !== undefined) {
    await insertInstrument(fx.companyId, {
      revisionId: revision.id,
      legalEntityId: fx.entityId,
      coveredVolume: spec.covered,
      generationPeriodStart: "2024-01-01",
      generationPeriodEnd: "2024-12-31",
      state: "approved",
    });
  }
  return revision.id;
}

/** Run one subject's scope and return the records the run wrote. */
async function runFor(fx: Fx, subject: Subject) {
  return runValidation(getTestDb(), {
    companyId: fx.companyId,
    scope: subject.scope,
    targetId: subject.targetId,
    mutatedFields: subject.mutatedFields,
  });
}

/** The codes any refusal shape (`WriteResult`, `RowWriteResult`, transition) cited. */
function codesOf(result: unknown): string[] {
  const rules = (result as { rules?: { code: string }[] }).rules ?? [];
  return rules.map((rule) => rule.code);
}

/** The NAMED precondition a transition refusal reports (§5.1's registry). */
function preconditionOf(result: unknown): string | undefined {
  return (result as { detail?: { precondition?: string } }).detail
    ?.precondition;
}

/** The subject a `blocks` step needs — absent only for the one case with none. */
function required(subject?: Subject): Subject {
  if (!subject) throw new Error("this rule case has no failing subject");
  return subject;
}

// ─── Subject constructors, so a case reads as its §6.2 row ──────────────────
const atRefOrg = (targetId: string): Subject => ({
  scope: "reference_org",
  targetId,
});
const atRecord = (targetId: string, table?: InputTableName): Subject => ({
  scope: "record",
  targetId,
  table,
});
const atPeriod = (targetId: string, extra: Partial<Subject> = {}): Subject => ({
  scope: "period",
  targetId,
  ...extra,
});
const atRevision = (targetId: string): Subject => ({
  scope: "revision",
  targetId,
});

// ─── The advancements a blocking rule has to forbid ─────────────────────────

/** `reference_org` — the registry service refuses to save the record (VR-3). */
const refusesEntityWrite = async (fx: Fx, subject?: Subject) =>
  codesOf(
    await updateLegalEntity(
      getTestDb(),
      fx.companyId,
      required(subject).targetId,
      {},
    ),
  );

const refusesFacilityWrite = async (fx: Fx, subject?: Subject) =>
  codesOf(
    await updateFacility(
      getTestDb(),
      fx.companyId,
      required(subject).targetId,
      {},
    ),
  );

/**
 * `record` — the ROW's approve is refused (LC-4), and a row forced past that by
 * hand stops the SUBMIT of its revision (§5.1). Both are asserted, because they
 * are two different consequences of one severity and VR-3 names both.
 */
async function refusesRowApproveAndSubmit(
  fx: Fx,
  subject?: Subject,
): Promise<string[]> {
  const s = required(subject);
  const table = s.table as InputTableName;
  const session = await serviceSession(fx.userId);
  const approve = await approveRow(getTestDb(), session, table, s.targetId);
  expect(approve.ok).toBe(false);

  // Straight at the table, past the service that just refused: the submit gate
  // must reach the same verdict about a row somebody managed to approve. The
  // table name is a code constant (`INPUT_TABLE_NAMES`), never a request value.
  await getTestDb().execute(
    sql`UPDATE ${sql.identifier(table)}
           SET state = 'approved', approved_by = ${fx.userId}, approved_at = now()
         WHERE id = ${s.targetId}`,
  );
  const submit = await transitionRevision(
    getTestDb(),
    session,
    s.revisionId ?? fx.revisionId,
    "submit",
  );
  expect(submit.ok).toBe(false);
  expect(preconditionOf(submit)).toBe("no_blocking_rules");
  const both = [...codesOf(approve), ...codesOf(submit)];
  // The same code from both refusals, or the test proves only half of VR-3.
  expect(codesOf(approve)).toEqual(codesOf(submit));
  return both;
}

/** `period` — the LOCK is refused. The revision is walked to `approved` first. */
async function refusesLock(fx: Fx, subject?: Subject): Promise<string[]> {
  const revisionId = required(subject).revisionId ?? fx.revisionId;
  const session = await serviceSession(fx.userId);
  await getTestDb()
    .update(reportRevision)
    .set({ status: "approved" })
    .where(eq(reportRevision.id, revisionId));
  const locked = await transitionRevision(
    getTestDb(),
    session,
    revisionId,
    "lock",
  );
  expect(locked.ok).toBe(false);
  return codesOf(locked);
}

/** `revision` — the APPROVE of the revision is refused. */
async function refusesApprove(fx: Fx, subject?: Subject): Promise<string[]> {
  const revisionId = required(subject).targetId;
  const session = await serviceSession(fx.userId);
  await getTestDb()
    .update(reportRevision)
    .set({ status: "in_review" })
    .where(eq(reportRevision.id, revisionId));
  const approved = await transitionRevision(
    getTestDb(),
    session,
    revisionId,
    "approve",
  );
  expect(approved.ok).toBe(false);
  return codesOf(approved);
}

/** Every factor set this suite creates wears it; `afterEach` deletes by it. */
const FACTOR_SET_PREFIX = "t44-";

/** A draft factor set of this suite (deleted by `afterEach`, cascade included). */
async function draftFactorSet(): Promise<string> {
  const created = await createFactorSet(getTestDb(), {
    code: `${FACTOR_SET_PREFIX}${randomUUID().slice(0, 8)}`,
    name: "T4.4 draft set",
  });
  if (!created.ok) throw new Error("could not create the draft factor set");
  return created.row.id;
}

/** The eight NOT NULL columns of a factor, with one key per call. */
function factorValues(
  overrides: Partial<NewFactorValues> = {},
): NewFactorValues {
  return {
    factorCode: `T44-${randomUUID().slice(0, 8)}`,
    factorName: "T4.4 factor",
    sourceName: "T4.4",
    sourceVersion: "1",
    geography: "SI",
    activityType: "natural_gas",
    inputUnit: "kWh",
    factorValue: "2.3",
    applicableYear: 2024,
    ...overrides,
  };
}

/** Insert a factor PAST the service, so the rule has a subject to judge. */
async function insertFactor(
  setId: string,
  values: NewFactorValues,
): Promise<string> {
  const [row] = await getTestDb()
    .insert(emissionFactor)
    .values({ ...values, factorSetId: setId })
    .returning({ id: emissionFactor.id });
  return row.id;
}

/** Thrown to unwind a transaction that was only ever opened to be rolled back. */
class RollbackSignal extends Error {}

/** Where `DocumentStorage` keeps the bytes of one document (EV-0's layout). */
function objectPath(companyId: string, fileHash: string): string {
  return path.join(process.env.DOCUMENTS_DIR ?? "", companyId, fileHash);
}

/** The values every emission row of these scenarios is created with. */
const rowValues = (fx: Fx) => ({
  revisionId: fx.revisionId,
  legalEntityId: fx.entityId,
  facilityId: fx.facilityId,
  activityCategory: "stationary_combustion",
  sourceName: "Boiler",
  activityType: "natural_gas",
  activityValue: "1000",
  method: "fuel_based",
  unit: "kWh",
  yearMonth: "2024-01",
});

/** Create one row THROUGH the service, so it exists exactly as a user's would. */
async function createdRow(fx: Fx, overrides = {}) {
  const session = await serviceSession(fx.userId);
  const created = await createRow(getTestDb(), session, "emission_activity", {
    ...rowValues(fx),
    ...overrides,
  });
  if (!created.ok) throw new Error("the row under test was refused");
  return created.row;
}

/** Attach one document to one row version (DM-25), and return the document. */
async function attachDocument(fx: Fx, rowId: string) {
  const doc = await insertDocument(fx.companyId);
  await insertEvidenceLink(fx.companyId, {
    documentId: doc.id,
    linkedObjectType: "emission_activity",
    linkedObjectId: rowId,
  });
  return doc;
}

/**
 * An APPROVED row whose evidence is either still on disk or was removed behind
 * the application's back — VAL-036's two cases, built the way they happen.
 */
async function approvedRowWithEvidence(fx: Fx, evidence: "intact" | "broken") {
  const row = await createdRow(fx);
  const doc = await attachDocument(fx, row.id);
  const session = await serviceSession(fx.userId);
  const approved = await approveRow(
    getTestDb(),
    session,
    "emission_activity",
    row.id,
  );
  if (!approved.ok) throw new Error("the approval under test was refused");
  // The file goes AFTER the approval: while it was there the rule passed, which
  // is what makes the failure afterwards a change in the world rather than a
  // row that was never valid.
  if (evidence === "broken") await rm(objectPath(fx.companyId, doc.fileHash));
  return approved.row;
}

/** A DRAFT row whose document has already lost its bytes — approve must refuse. */
async function rowLinkedToBrokenDocument(fx: Fx) {
  const row = await createdRow(fx);
  const doc = await attachDocument(fx, row.id);
  await rm(objectPath(fx.companyId, doc.fileHash));
  return { rowId: row.id, table: "emission_activity" as InputTableName };
}

/**
 * A SUBMITTED revision holding one approved row with no evidence at all, whose
 * assessment carries `tier` — DQ-4's exact subject (AC-7).
 */
async function revisionWithEvidenceHole(fx: Fx, tier: string) {
  const { period } = await insertPeriod(fx.companyId, {
    legalEntityId: fx.entityId,
  });
  const revision = await insertRevision(fx.companyId, {
    periodId: period.id,
    status: "submitted",
    createdBy: fx.userId,
  });
  const row = await insertEmissionActivity(fx.companyId, {
    revisionId: revision.id,
    legalEntityId: fx.entityId,
    facilityId: fx.facilityId,
    state: "approved",
    approvedBy: fx.userId,
    approvedAt: new Date(),
  });
  await insertDq(fx.companyId, {
    objectType: "emission_activity",
    objectId: row.id,
    qualityTier: tier,
    qualityComment:
      tier === "high_primary"
        ? null
        : "estimated from floor area — the landlord bills the whole building",
  });
  return { ...revision, rowId: row.id };
}

/**
 * `reference_org`, factors — the create is refused by the run inside it. The set
 * is always a FRESH one: in a set that already holds the same resolution key,
 * VAL-031 would refuse the create before the rule under test ever looked at it
 * (which is VAL-031's own case, and it builds that collision itself).
 */
const refusesFactorCreateFresh = async (fx: Fx, subject?: Subject) =>
  codesOf(
    await createFactor(
      getTestDb(),
      fx.companyId,
      await draftFactorSet(),
      required(subject).factorValues as NewFactorValues,
    ),
  );

/** An emission row inside `fx`, attributed to its site (so VAL-104 is silent). */
const emissionRow = (fx: Fx, overrides = {}) =>
  insertEmissionActivity(fx.companyId, {
    revisionId: fx.revisionId,
    legalEntityId: fx.entityId,
    facilityId: fx.facilityId,
    ...overrides,
  });

/** A purchased-energy row inside `fx`, likewise attributed. */
const energyRow = (fx: Fx, overrides = {}) =>
  insertEnergyActivity(fx.companyId, {
    revisionId: fx.revisionId,
    legalEntityId: fx.entityId,
    facilityId: fx.facilityId,
    ...overrides,
  });

/**
 * Make the calculation run §5.1's approve gate demands (CALC-6, T5.4).
 *
 * A revision that holds calculable rows cannot be approved without a green run
 * over them — that is the whole of `calculation_run_green` — so every scenario
 * below that expects an approve to SUCCEED calls this first, AFTER its last row
 * write (a run stamped before a row exists is stale by construction). It is
 * deliberately not folded into the fixtures: the revisions that must be REFUSED
 * must not acquire a run by accident.
 *
 * THE UNIT USED TO BE NORMALISED FIRST, AND NO LONGER IS. The harness's default
 * Scope-1 row is `natural_gas` in `kWh`, and `legacy-v1` prices natural gas in
 * `kWh_gross`, `kWh_net` and `m3` — the last two BOTH reachable from `kWh`
 * through a CONTEXTUAL calorific conversion, both GLOBAL, both undated. Under
 * `hosmos-calc-1.2.0` those two tied on every rung the ladder had and CALC-2
 * refused to pick, so this helper rewrote the unit to `kWh_gross` to get an
 * identity conversion and a single winner. That was papering over a real defect
 * — a gas bill in kilowatt-hours is the commonest Scope-1 input there is and it
 * could not be calculated at all — and 1.3.0's unit-distance rung fixes it: a
 * `kWh` row now takes the `kWh_gross` factor through the table's ×1 "a billed
 * kWh is Gross CV", which is the same factor and the same multiplier the rewrite
 * used to force. The rewrite is gone, so these scenarios exercise the unit a
 * user actually types.
 */
async function calculateFor(fx: Fx, revisionId: string = fx.revisionId) {
  const [row] = await getTestDb()
    .select()
    .from(reportRevision)
    .where(eq(reportRevision.id, revisionId));
  const outcome = await calculateRevision(getTestDb(), fx.companyId, row);
  expect(outcome.ok).toBe(true);
  return outcome;
}

/**
 * A SEPARATE revision holding one approved Scope-1 row, ALREADY CALCULATED —
 * the subject of the three rules whose object is a `calculation` row (T5.4).
 *
 * Separate, for the reason `scope2Revision` gives: all three are `revision`
 * scope and judge a whole RUN, so a passing and a failing scenario in one
 * revision would each be the other's noise. The run is made through
 * `calculateRevision` rather than through the route, because what these cases
 * need is the stored rows, not the HTTP envelope around them.
 */
async function calculatedRevision(
  fx: Fx,
  spec: { biogenic?: boolean } = {},
): Promise<string> {
  const { period } = await insertPeriod(fx.companyId, {
    legalEntityId: fx.entityId,
  });
  const revision = await insertRevision(fx.companyId, {
    periodId: period.id,
    createdBy: fx.userId,
  });
  await insertEmissionActivity(fx.companyId, {
    revisionId: revision.id,
    legalEntityId: fx.entityId,
    facilityId: fx.facilityId,
    // `wood_logs_biogenic` is the seeded factor whose `biogenic_treatment` is
    // `biogenic` — the only way to reach VAL-017's branch with real reference
    // data instead of a hand-made factor.
    activityType: spec.biogenic ? "wood_logs_biogenic" : "natural_gas",
    activityValue: spec.biogenic ? "2" : "1000",
    unit: spec.biogenic ? "t" : "kWh_gross",
    yearMonth: "2024-03",
    state: "approved",
    approvedBy: fx.userId,
    approvedAt: new Date(),
    biogenicFlag: spec.biogenic ?? false,
  });
  const [row] = await getTestDb()
    .select()
    .from(reportRevision)
    .where(eq(reportRevision.id, revision.id));
  const outcome = await calculateRevision(getTestDb(), fx.companyId, row);
  expect(outcome.ok).toBe(true);
  return revision.id;
}

/** Rewrite the stored lines of a revision's run — how a case breaks ONE thing. */
async function corruptRun(
  revisionId: string,
  values: Partial<typeof calculation.$inferInsert>,
): Promise<void> {
  await getTestDb()
    .update(calculation)
    .set(values)
    .where(eq(calculation.revisionId, revisionId));
}

/**
 * THE TABLE — one entry per implemented rule of §6.2, in inventory order.
 *
 * Each `fail`/`pass` builds the state STRAIGHT AT THE TABLE where the service
 * would refuse it: the point is to judge a rule, and a rule cannot be judged on
 * a row the gate never let exist. The `blocks` step is the other half — there
 * the real service, route or transition is called, and the refusal it produces
 * is what proves the severity means something.
 */
const CASES: RuleCase[] = [
  // ── Organisation and facility (reference_org) ─────────────────────────────
  {
    code: "VAL-001",
    fail: async (fx) =>
      atRefOrg(
        (await insertLegalEntity(fx.companyId, { registrationNumber: null }))
          .id,
      ),
    pass: async (fx) => atRefOrg((await insertLegalEntity(fx.companyId)).id),
    blocks: refusesEntityWrite,
  },
  {
    code: "VAL-002",
    // "ZZ" is a well-formed alpha-2 that is not a country — the mistake the
    // reference list exists for, as opposed to a typo the parser would catch.
    fail: async (fx) =>
      atRefOrg((await insertLegalEntity(fx.companyId, { country: "ZZ" })).id),
    pass: async (fx) =>
      atRefOrg((await insertLegalEntity(fx.companyId, { country: "SI" })).id),
    blocks: refusesEntityWrite,
  },
  {
    code: "VAL-003",
    fail: async (fx) => {
      const parent = await insertLegalEntity(fx.companyId);
      const child = await insertLegalEntity(fx.companyId, {
        parentLegalEntityId: parent.id,
      });
      // …and now the parent points back at its own child (DM-3's cycle).
      await getTestDb()
        .update(legalEntity)
        .set({ parentLegalEntityId: child.id })
        .where(eq(legalEntity.id, parent.id));
      return atRefOrg(parent.id);
    },
    pass: async (fx) => {
      const parent = await insertLegalEntity(fx.companyId);
      return atRefOrg(
        (
          await insertLegalEntity(fx.companyId, {
            parentLegalEntityId: parent.id,
          })
        ).id,
      );
    },
    blocks: refusesEntityWrite,
  },
  {
    code: "VAL-004",
    fail: async (fx) =>
      atRefOrg(
        (
          await insertLegalEntity(fx.companyId, {
            effectiveFrom: "2024-12-31",
            effectiveTo: "2024-01-01",
          })
        ).id,
      ),
    pass: async (fx) =>
      atRefOrg(
        (
          await insertLegalEntity(fx.companyId, {
            effectiveFrom: "2024-01-01",
            effectiveTo: "2024-12-31",
          })
        ).id,
      ),
    blocks: refusesEntityWrite,
  },
  {
    code: "VAL-005",
    fail: async (fx) => {
      const closed = await insertLegalEntity(fx.companyId, {
        effectiveTo: "2020-01-01", // out of force long before today
      });
      return atRefOrg(
        (await insertFacility(fx.companyId, { legalEntityId: closed.id })).id,
      );
    },
    pass: async (fx) =>
      atRefOrg(
        (await insertFacility(fx.companyId, { legalEntityId: fx.entityId })).id,
      ),
    blocks: refusesFacilityWrite,
  },
  {
    code: "VAL-006",
    fail: async (fx) =>
      atRefOrg((await insertFacility(fx.companyId, { latitude: "91" })).id),
    pass: async (fx) =>
      atRefOrg(
        (
          await insertFacility(fx.companyId, {
            latitude: "46.05",
            longitude: "14.5",
          })
        ).id,
      ),
    blocks: refusesFacilityWrite,
  },

  // ── Emission factors (reference_org) ──────────────────────────────────────
  {
    code: "VAL-031",
    // Like VAL-008, the failing state cannot exist: `emission_factor_resolution_key`
    // is this rule's twin (an EXPRESSION unique index, §4.21). The rule is
    // watched refusing with the index held open for one transaction, and the
    // real refusal — the one a user meets — is the create below.
    failRun: async (fx) => {
      const setId = await draftFactorSet();
      const values = factorValues();
      await insertFactor(setId, values);

      let records: ValidationResultRecord[] = [];
      await getTestDb()
        .transaction(async (tx) => {
          await tx.execute(sql`DROP INDEX emission_factor_resolution_key`);
          const [twin] = await tx
            .insert(emissionFactor)
            .values({
              ...values,
              factorCode: `${values.factorCode}-2`,
              factorSetId: setId,
            })
            .returning({ id: emissionFactor.id });
          records = await runValidation(tx, {
            companyId: fx.companyId,
            scope: "reference_org",
            targetId: twin.id,
          });
          throw new RollbackSignal();
        })
        .catch((error: unknown) => {
          if (!(error instanceof RollbackSignal)) throw error;
        });
      return records;
    },
    pass: async () => {
      const setId = await draftFactorSet();
      return atRefOrg(await insertFactor(setId, factorValues()));
    },
    blocks: async (fx) => {
      const setId = await draftFactorSet();
      const values = factorValues();
      const first = await createFactor(
        getTestDb(),
        fx.companyId,
        setId,
        values,
      );
      expect(first.ok).toBe(true);
      // A second row that answers the same resolve key — CALC-2 would have two
      // answers for one question, so the create never happens.
      return codesOf(
        await createFactor(getTestDb(), fx.companyId, setId, {
          ...values,
          factorCode: `${values.factorCode}-2`,
        }),
      );
    },
  },
  {
    code: "VAL-032",
    fail: async () => {
      const setId = await draftFactorSet();
      const values = factorValues({
        validFrom: "2025-01-01",
        validTo: "2024-01-01",
      });
      return {
        ...atRefOrg(await insertFactor(setId, values)),
        factorSetId: setId,
        factorValues: values,
      };
    },
    pass: async () => {
      const setId = await draftFactorSet();
      return atRefOrg(
        await insertFactor(
          setId,
          factorValues({ validFrom: "2024-01-01", validTo: "2024-12-31" }),
        ),
      );
    },
    blocks: refusesFactorCreateFresh,
  },
  {
    code: "VAL-033",
    fail: async () => {
      const setId = await draftFactorSet();
      // Zero with nothing to justify it — §0.7's "нулём не подменять".
      const values = factorValues({ factorValue: "0", sourceLocator: null });
      return {
        ...atRefOrg(await insertFactor(setId, values)),
        factorSetId: setId,
        factorValues: values,
      };
    },
    pass: async () => {
      const setId = await draftFactorSet();
      return atRefOrg(
        await insertFactor(setId, factorValues({ factorValue: "2.3" })),
      );
    },
    blocks: refusesFactorCreateFresh,
  },

  // ── Period and boundary (period) ──────────────────────────────────────────
  {
    code: "VAL-008",
    // NO `fail` FIXTURE EXISTS, and that is the finding rather than a gap: the
    // failing state is forbidden by `reporting_period_dates_check`, the CHECK
    // this rule is paired with (§0.8 allows a CHECK on exactly this kind of
    // column). The only way to watch the rule refuse is to hold its twin open
    // for the length of ONE transaction and roll the whole thing back — which is
    // itself the proof that the two agree about the same state.
    failRun: async (fx) => {
      let records: ValidationResultRecord[] = [];
      await getTestDb()
        .transaction(async (tx) => {
          await tx.execute(
            sql`ALTER TABLE reporting_period DROP CONSTRAINT reporting_period_dates_check`,
          );
          await tx
            .update(reportingPeriod)
            .set({ startDate: "2024-12-31", endDate: "2024-01-01" })
            .where(eq(reportingPeriod.id, fx.periodId));
          records = await runValidation(tx, {
            companyId: fx.companyId,
            scope: "period",
            targetId: fx.periodId,
          });
          throw new RollbackSignal();
        })
        .catch((error: unknown) => {
          if (!(error instanceof RollbackSignal)) throw error;
        });
      return records;
    },
    pass: async (fx) => atPeriod(fx.periodId),
    // What it blocks is the period WRITE — the service refuses to store dates
    // the rule would fail, which is why the failing state is unreachable above.
    blocks: async (fx) =>
      codesOf(
        await updatePeriod(getTestDb(), fx.companyId, fx.periodId, {
          endDate: "2023-06-30",
        }),
      ),
  },
  {
    code: "VAL-009",
    fail: async (fx) => {
      // `fx` already holds a 2024 period; a second one over the same year is
      // the overlap. A WARNING: two periods may legitimately overlap while a
      // company changes its financial year, so it reports and never refuses.
      const { period } = await insertPeriod(fx.companyId, {
        startDate: "2024-06-01",
        endDate: "2025-05-31",
      });
      return atPeriod(period.id);
    },
    pass: async (fx) => {
      const { period } = await insertPeriod(fx.companyId, {
        startDate: "2019-01-01",
        endDate: "2019-12-31",
      });
      return atPeriod(period.id);
    },
  },
  {
    code: "VAL-010",
    fail: async (fx) => {
      const { period } = await insertPeriod(fx.companyId, {
        legalEntityId: fx.entityId,
      });
      const revision = await insertRevision(fx.companyId, {
        periodId: period.id,
        status: "locked",
      });
      return atPeriod(period.id, {
        mutatedFields: ["emission_activity"],
        revisionId: revision.id,
      });
    },
    pass: async (fx) =>
      atPeriod(fx.periodId, { mutatedFields: ["emission_activity"] }),
    // It blocks a ROW WRITE, not an advancement: the freeze is about mutating
    // the facts of a closed report (LC-8(2)), and the transition it would stop
    // is refused by the matrix itself long before a rule is consulted.
    blocks: async (fx, subject) => {
      const session = await serviceSession(fx.userId);
      const written = await createRow(
        getTestDb(),
        session,
        "emission_activity",
        {
          revisionId: subject?.revisionId as string,
          legalEntityId: fx.entityId,
          activityCategory: "stationary_combustion",
          sourceName: "Boiler",
          activityType: "natural_gas",
          activityValue: "1",
          method: "fuel_based",
          unit: "kWh",
          facilityId: fx.facilityId,
        },
      );
      return codesOf(written);
    },
  },
  {
    code: "VAL-101",
    fail: async (fx) => {
      const { period } = await insertPeriod(fx.companyId);
      const revision = await insertRevision(fx.companyId, {
        periodId: period.id,
      });
      await insertPeriodScope(fx.companyId, {
        periodId: period.id,
        status: "excluded",
        exclusionReason: null,
      });
      return atPeriod(period.id, { revisionId: revision.id });
    },
    pass: async (fx) => {
      const { period } = await insertPeriod(fx.companyId);
      await insertPeriodScope(fx.companyId, {
        periodId: period.id,
        status: "excluded",
        exclusionReason: "immaterial: dormant subsidiary",
      });
      return atPeriod(period.id);
    },
    blocks: refusesLock,
  },
  {
    code: "VAL-102",
    fail: async (fx) => {
      // Consolidated, but only ONE entity is inside the boundary (D17/AC-9).
      const { period } = await insertPeriod(fx.companyId, {
        reportingBasis: "consolidated",
      });
      const revision = await insertRevision(fx.companyId, {
        periodId: period.id,
      });
      return atPeriod(period.id, { revisionId: revision.id });
    },
    pass: async (fx) => {
      const parent = await insertLegalEntity(fx.companyId, {
        groupStructureType: "parent",
      });
      const child = await insertLegalEntity(fx.companyId, {
        groupStructureType: "subsidiary",
        parentLegalEntityId: parent.id,
      });
      const { period } = await insertPeriod(fx.companyId, {
        reportingBasis: "consolidated",
        legalEntityId: parent.id,
      });
      await insertPeriodScope(fx.companyId, {
        periodId: period.id,
        legalEntityId: child.id,
      });
      return atPeriod(period.id);
    },
    blocks: refusesLock,
  },
  {
    code: "VAL-103",
    fail: async (fx) => {
      const homeless = await insertLegalEntity(fx.companyId, {
        registeredAddress: null,
      });
      const { period } = await insertPeriod(fx.companyId, {
        legalEntityId: homeless.id,
      });
      const revision = await insertRevision(fx.companyId, {
        periodId: period.id,
      });
      return atPeriod(period.id, { revisionId: revision.id });
    },
    pass: async (fx) => atPeriod(fx.periodId),
    blocks: refusesLock,
  },
  {
    code: "VAL-105",
    plan: "starter", // F1 gates `trial` and `starter`; `maxFacilities` is 3
    fail: async (fx) => {
      // `fx` brings one site; three more put the boundary over the limit.
      for (let i = 0; i < 3; i += 1) {
        await insertFacility(fx.companyId, { legalEntityId: fx.entityId });
      }
      return atPeriod(fx.periodId, {
        mutatedFields: [REVISION_LOCK_FIELD],
        revisionId: fx.revisionId,
      });
    },
    pass: async (fx) => {
      // A boundary of one entity with no sites at all — well inside the limit.
      const { period } = await insertPeriod(fx.companyId);
      return atPeriod(period.id, { mutatedFields: [REVISION_LOCK_FIELD] });
    },
    // The ONE blocking rule that is not answered with 422: a plan limit is a
    // 402 with an upgrade path (§11.3, PG-3), and the assertion says so.
    blocks: async (fx, subject) => {
      const session = await serviceSession(fx.userId);
      await getTestDb()
        .update(reportRevision)
        .set({ status: "approved" })
        .where(eq(reportRevision.id, subject?.revisionId as string));
      const locked = await transitionRevision(
        getTestDb(),
        session,
        subject?.revisionId as string,
        "lock",
      );
      expect(locked.ok).toBe(false);
      if (locked.ok) return [];
      expect(locked.error).toBe("PLAN_REQUIRED");
      expect(preconditionOf(locked)).toBe("plan_facility_limit");
      return codesOf(locked);
    },
  },
  {
    code: "VAL-106",
    fail: async (fx) => {
      await getTestDb()
        .update(reportRevision)
        .set({ status: "submitted" })
        .where(eq(reportRevision.id, fx.revisionId));
      return atPeriod(fx.periodId, { mutatedFields: ["start_date"] });
    },
    // A period of its own, whose current revision is still a DRAFT: the failing
    // half froze `fx`'s, and a rule about a MOMENT can only be watched passing
    // where that moment is legal.
    pass: async (fx) => {
      const { period } = await insertPeriod(fx.companyId);
      await insertRevision(fx.companyId, { periodId: period.id });
      return atPeriod(period.id, { mutatedFields: ["start_date"] });
    },
    // Like VAL-010 it blocks a WRITE — here the period's own calculation-bearing
    // field, refused by the service that declares it as mutated (DM-7a).
    blocks: async (fx) => {
      await getTestDb()
        .update(reportRevision)
        .set({ status: "submitted" })
        .where(eq(reportRevision.id, fx.revisionId));
      return codesOf(
        await updatePeriod(getTestDb(), fx.companyId, fx.periodId, {
          startDate: "2024-02-01",
        }),
      );
    },
  },

  // ── Input rows (record) ───────────────────────────────────────────────────
  {
    code: "VAL-007",
    fail: async (fx) => {
      const future = await insertFacility(fx.companyId, {
        legalEntityId: fx.entityId,
        openingDate: "2025-01-01",
      });
      const row = await emissionRow(fx, {
        facilityId: future.id,
        yearMonth: "2024-01",
      });
      return atRecord(row.id, "emission_activity");
    },
    pass: async (fx) =>
      atRecord(
        (await emissionRow(fx, { yearMonth: "2024-01" })).id,
        "emission_activity",
      ),
  },
  {
    code: "VAL-011",
    fail: async (fx) =>
      atRecord(
        (await emissionRow(fx, { activityValue: "-5" })).id,
        "emission_activity",
      ),
    pass: async (fx) =>
      atRecord(
        (await emissionRow(fx, { activityValue: "0" })).id,
        "emission_activity",
      ),
    blocks: refusesRowApproveAndSubmit,
  },
  {
    code: "VAL-012",
    fail: async (fx) =>
      atRecord(
        (await emissionRow(fx, { yearMonth: "2023-01" })).id,
        "emission_activity",
      ),
    pass: async (fx) =>
      atRecord(
        (await emissionRow(fx, { yearMonth: "2024-06" })).id,
        "emission_activity",
      ),
  },
  {
    code: "VAL-013",
    fail: async (fx) => {
      const first = await insertDocument(fx.companyId);
      // The same bytes uploaded twice: EV-1 keeps both rows and suggests reuse.
      const twin = await insertDocument(fx.companyId, {
        fileHash: first.fileHash,
        storageKey: first.storageKey,
      });
      return atRecord(twin.id);
    },
    pass: async (fx) => atRecord((await insertDocument(fx.companyId)).id),
  },
  {
    code: "VAL-014",
    fail: async (fx) =>
      atRecord(
        (await emissionRow(fx, { unit: "banana" })).id,
        "emission_activity",
      ),
    pass: async (fx) =>
      atRecord(
        (await emissionRow(fx, { unit: "kWh" })).id,
        "emission_activity",
      ),
    blocks: refusesRowApproveAndSubmit,
  },
  {
    code: "VAL-015",
    fail: async (fx) =>
      atRecord(
        (await emissionRow(fx, { method: "fuel_based", unit: null })).id,
        "emission_activity",
      ),
    pass: async (fx) =>
      atRecord(
        (await emissionRow(fx, { method: "fuel_based", unit: "kWh" })).id,
        "emission_activity",
      ),
    blocks: refusesRowApproveAndSubmit,
  },
  {
    code: "VAL-016",
    fail: async (fx) =>
      atRecord(
        (
          await emissionRow(fx, {
            activityCategory: "mobile_combustion",
            method: "distance_based",
            activityType: "car_petrol_medium",
            unit: "kWh", // a distance measured in energy
          })
        ).id,
        "emission_activity",
      ),
    pass: async (fx) =>
      atRecord(
        (
          await emissionRow(fx, {
            activityCategory: "mobile_combustion",
            method: "distance_based",
            activityType: "car_petrol_medium",
            unit: "km",
          })
        ).id,
        "emission_activity",
      ),
    blocks: refusesRowApproveAndSubmit,
  },
  {
    code: "VAL-018",
    fail: async (fx) =>
      atRecord(
        (
          await emissionRow(fx, {
            activityCategory: "fugitive_emissions",
            activityType: "r410a",
            method: "mass_balance",
            unit: "kg",
            openingStock: "0",
            refrigerantAdded: "0",
            refrigerantRecovered: "10",
            closingStock: "0",
          })
        ).id,
        "emission_activity",
      ),
    pass: async (fx) =>
      atRecord(
        (
          await emissionRow(fx, {
            activityCategory: "fugitive_emissions",
            activityType: "r410a",
            method: "mass_balance",
            unit: "kg",
            openingStock: "10",
            refrigerantAdded: "0",
            refrigerantRecovered: "0",
            closingStock: "5",
          })
        ).id,
        "emission_activity",
      ),
  },
  {
    code: "VAL-019",
    fail: async (fx) =>
      atRecord(
        (
          await emissionRow(fx, {
            activityCategory: "fugitive_emissions",
            activityType: "r-not-in-the-set",
            method: "mass_balance",
            unit: "kg",
            refrigerantAdded: "1",
          })
        ).id,
        "emission_activity",
      ),
    pass: async (fx) =>
      atRecord(
        (
          await emissionRow(fx, {
            activityCategory: "fugitive_emissions",
            activityType: "r410a",
            method: "mass_balance",
            unit: "kg",
            refrigerantAdded: "1",
          })
        ).id,
        "emission_activity",
      ),
    blocks: refusesRowApproveAndSubmit,
  },
  {
    code: "VAL-020",
    fail: async (fx) =>
      atRecord(
        (await energyRow(fx, { consumption: "-1" })).id,
        "purchased_energy_activity",
      ),
    pass: async (fx) =>
      atRecord(
        (await energyRow(fx, { consumption: "1000" })).id,
        "purchased_energy_activity",
      ),
    blocks: refusesRowApproveAndSubmit,
  },
  {
    code: "VAL-021",
    fail: async (fx) => {
      // No site, and the entity it is attributed to has no country either —
      // so no grid factor can be resolved for it (CALC-5).
      const stateless = await insertLegalEntity(fx.companyId, {
        country: null,
      });
      const row = await insertEnergyActivity(fx.companyId, {
        revisionId: fx.revisionId,
        legalEntityId: stateless.id,
        notes: "documented exception (VAL-104)",
      });
      return atRecord(row.id, "purchased_energy_activity");
    },
    pass: async (fx) =>
      atRecord((await energyRow(fx)).id, "purchased_energy_activity"),
    blocks: refusesRowApproveAndSubmit,
  },
  {
    code: "VAL-023",
    fail: async (fx) =>
      atRecord(
        (
          await insertInstrument(fx.companyId, {
            revisionId: fx.revisionId,
            legalEntityId: fx.entityId,
            generationPeriodStart: "2022-01-01",
            generationPeriodEnd: "2023-06-01", // over before the period began
          })
        ).id,
        "contractual_instrument",
      ),
    pass: async (fx) =>
      atRecord(
        (
          await insertInstrument(fx.companyId, {
            revisionId: fx.revisionId,
            legalEntityId: fx.entityId,
            generationPeriodStart: "2024-01-01",
            generationPeriodEnd: "2024-12-31",
          })
        ).id,
        "contractual_instrument",
      ),
  },
  {
    code: "VAL-022",
    // 150 MWh of certificates against 100 MWh of electricity — the over-claim
    // §9 caps and this rule reports. The cap is what keeps the market-based
    // arithmetic sound; without the rule it would also keep the accident
    // invisible.
    fail: async (fx) =>
      atRevision(
        await scope2Revision(fx, { consumption: "100", covered: "150" }),
      ),
    pass: async (fx) =>
      atRevision(
        await scope2Revision(fx, { consumption: "100", covered: "60" }),
      ),
    blocks: refusesApprove,
  },
  {
    code: "VAL-024",
    // A row entered in a unit no conversion reaches from: its consumption is in
    // NEITHER the covered nor the residual column, so the balance has a hole
    // the cap cannot see. No certificate is involved, which is exactly what
    // separates this failure from VAL-022's.
    fail: async (fx) =>
      atRevision(
        await scope2Revision(fx, { consumption: "100", unit: "therm" }),
      ),
    pass: async (fx) =>
      atRevision(
        await scope2Revision(fx, { consumption: "100", covered: "60" }),
      ),
    blocks: refusesApprove,
  },
  {
    code: "VAL-036",
    fail: async (fx) =>
      atRecord(
        (await approvedRowWithEvidence(fx, "broken")).id,
        "emission_activity",
      ),
    pass: async (fx) =>
      atRecord(
        (await approvedRowWithEvidence(fx, "intact")).id,
        "emission_activity",
      ),
    // EV-5 in one assertion: the row the broken document backs cannot be
    // approved. The neighbouring row that cites a healthy file still can — that
    // half is proved by the dedicated scenario below, where both rows exist.
    blocks: async (fx) => {
      const { rowId, table } = await rowLinkedToBrokenDocument(fx);
      const session = await serviceSession(fx.userId);
      return codesOf(await approveRow(getTestDb(), session, table, rowId));
    },
  },
  {
    code: "VAL-037",
    fail: async (fx) => {
      const row = await emissionRow(fx, { yearMonth: "2024-01" });
      const doc = await insertDocument(fx.companyId, {
        coverageStart: "2023-01-01",
        coverageEnd: "2023-02-28",
      });
      const link = await insertEvidenceLink(fx.companyId, {
        documentId: doc.id,
        linkedObjectType: "emission_activity",
        linkedObjectId: row.id,
      });
      return atRecord(link.id);
    },
    pass: async (fx) => {
      const row = await emissionRow(fx, { yearMonth: "2024-01" });
      const doc = await insertDocument(fx.companyId, {
        coverageStart: "2024-01-01",
        coverageEnd: "2024-01-31",
      });
      const link = await insertEvidenceLink(fx.companyId, {
        documentId: doc.id,
        linkedObjectType: "emission_activity",
        linkedObjectId: row.id,
      });
      return atRecord(link.id);
    },
  },
  {
    code: "VAL-038",
    fail: async (fx) => {
      const row = await emissionRow(fx);
      await insertDq(fx.companyId, {
        objectType: "emission_activity",
        objectId: row.id,
        reliabilityScore: null,
        temporalScore: null,
        geographicalScore: null,
        technologyScore: null,
      });
      return atRecord(row.id, "emission_activity");
    },
    pass: async (fx) => {
      const row = await emissionRow(fx);
      await insertDq(fx.companyId, {
        objectType: "emission_activity",
        objectId: row.id,
      });
      return atRecord(row.id, "emission_activity");
    },
  },
  {
    code: "VAL-039",
    fail: async (fx) => {
      const row = await emissionRow(fx);
      await insertDq(fx.companyId, {
        objectType: "emission_activity",
        objectId: row.id,
        isOverridden: true,
        overrideReason: null,
      });
      return atRecord(row.id, "emission_activity");
    },
    pass: async (fx) => {
      const row = await emissionRow(fx);
      await insertDq(fx.companyId, {
        objectType: "emission_activity",
        objectId: row.id,
        isOverridden: true,
        overrideReason: "supplier confirmed the meter reading in writing",
      });
      return atRecord(row.id, "emission_activity");
    },
    blocks: refusesRowApproveAndSubmit,
  },
  {
    code: "VAL-104",
    fail: async (fx) =>
      atRecord(
        (
          await insertEmissionActivity(fx.companyId, {
            revisionId: fx.revisionId,
            legalEntityId: fx.entityId,
            facilityId: null,
            notes: null,
          })
        ).id,
        "emission_activity",
      ),
    pass: async (fx) =>
      atRecord(
        (
          await insertEmissionActivity(fx.companyId, {
            revisionId: fx.revisionId,
            legalEntityId: fx.entityId,
            facilityId: null,
            notes: "leased office, landlord bills the whole building (AC-2)",
          })
        ).id,
        "emission_activity",
      ),
    blocks: refusesRowApproveAndSubmit,
  },

  // ── Workflow (revision) ───────────────────────────────────────────────────
  {
    code: "VAL-040",
    fail: async (fx) => {
      // One person enters the figure and approves it: disclosed, not refused.
      const row = await createdRow(fx);
      const session = await serviceSession(fx.userId);
      const approved = await approveRow(
        getTestDb(),
        session,
        "emission_activity",
        row.id,
      );
      if (!approved.ok) throw new Error("the approval under test was refused");
      return atRevision(fx.revisionId);
    },
    pass: async (fx) => {
      const author = await serviceSession(fx.userId);
      const { user: second } = await insertUserWithProfile({
        companyId: fx.companyId,
        role: "approver",
      });
      // A revision of its own — the failing half left a self-approved row in
      // `fx`'s, and one such row is enough to fail the whole revision.
      const { period } = await insertPeriod(fx.companyId, {
        legalEntityId: fx.entityId,
      });
      const other = await insertRevision(fx.companyId, {
        periodId: period.id,
        createdBy: fx.userId,
      });
      const created = await createRow(
        getTestDb(),
        author,
        "emission_activity",
        { ...rowValues(fx), revisionId: other.id },
      );
      if (!created.ok) throw new Error("the row under test was refused");
      const approved = await approveRow(
        getTestDb(),
        await serviceSession(second.id),
        "emission_activity",
        created.row.id,
      );
      if (!approved.ok) throw new Error("the approval under test was refused");
      return atRevision(other.id);
    },
  },
  {
    code: "VAL-041",
    fail: async (fx) =>
      atRevision((await revisionWithEvidenceHole(fx, "high_primary")).id),
    pass: async (fx) =>
      atRevision((await revisionWithEvidenceHole(fx, "estimate")).id),
    blocks: refusesApprove,
  },

  // ── The calculation (revision) — T5.4's three ─────────────────────────────
  {
    code: "VAL-017",
    // The biogenic kilograms MOVED onto the fossil line — the failure §6.2
    // names, and the one an aggregate cannot see: the grand total goes UP by
    // exactly the carbon VSME says to disclose separately, and every
    // reconciliation still closes.
    fail: async (fx) => {
      const revisionId = await calculatedRevision(fx, { biogenic: true });
      await corruptRun(revisionId, {
        co2eResult: "3676.000000",
        biogenicCo2Result: null,
      });
      return atRevision(revisionId);
    },
    pass: async (fx) =>
      atRevision(await calculatedRevision(fx, { biogenic: true })),
    blocks: refusesApprove,
  },
  {
    code: "VAL-034",
    // A line whose activity row cannot be found: it is in the grand total and
    // in NO per-entity bucket, so the details stop adding up to the headline —
    // exactly the discrepancy an auditor recomputes first (AC-1).
    fail: async (fx) => {
      const revisionId = await calculatedRevision(fx);
      await corruptRun(revisionId, {
        activityRowId: "00000000-0000-0000-0000-0000000000ff",
      });
      return atRevision(revisionId);
    },
    pass: async (fx) => atRevision(await calculatedRevision(fx)),
    blocks: refusesApprove,
  },
  {
    code: "VAL-035",
    // `factor_snapshot` is `jsonb NOT NULL`, so `{}` satisfies the COLUMN and a
    // presence test — and `{}` is precisely the shape a bug produces. A figure
    // whose source nobody can name is a figure nobody can attribute.
    fail: async (fx) => {
      const revisionId = await calculatedRevision(fx);
      await corruptRun(revisionId, { factorSnapshot: {} });
      return atRevision(revisionId);
    },
    pass: async (fx) => atRevision(await calculatedRevision(fx)),
    blocks: refusesApprove,
  },
  {
    code: "VAL-107",
    // NO `blocks`, AND THAT IS THE POINT. A figure priced by a weaker basis
    // than the pinned set offers is a legitimate, disclosable choice — refusing
    // the report over it would be worse than saying so — and the absence of a
    // `blocks` clause here is the assertion that submit, approve and lock all
    // still go through with the finding stored and failing.
    //
    // THE FAILING STATE IS WRITTEN ONTO THE SNAPSHOT rather than provoked out
    // of the resolver, exactly as VAL-035's is. What the resolver does with a
    // real `si-2025` set — a Slovenian diesel row entered in kWh, priced by the
    // 2006 IPCC global default because no conversion reaches ARSO's per-litre
    // factor — is proved against the migrated rows in
    // `db/__tests__/factor-set-si-2025.integration.test.ts`. What is proved
    // HERE is the other half: that the rule READS the account and does not
    // re-derive it against the live factor library, which would make a locked
    // revision's verdict change the day an administrator adds a factor.
    fail: async (fx) => {
      const revisionId = await calculatedRevision(fx);
      const [line] = await getTestDb()
        .select()
        .from(calculation)
        .where(eq(calculation.revisionId, revisionId));
      const snapshot = line.factorSnapshot as Record<string, unknown>;
      const provenance = snapshot.provenance as Record<string, unknown>;
      await corruptRun(revisionId, {
        factorSnapshot: {
          ...snapshot,
          provenance: {
            ...provenance,
            passed_over: [
              {
                reason: "unit_unreachable",
                tier: "site_country",
                geography: "SI",
                source_name: "Slovenian Environment Agency (ARSO)",
                source_version: "2025",
                applicable_year: 2025,
                input_units: ["L"],
                factor_ids: ["00000000-0000-0000-0000-0000000000aa"],
              },
            ],
          },
        },
      });
      return atRevision(revisionId);
    },
    // A run in which every line took the best factor the set holds carries an
    // EMPTY `passed_over`, and the rule passes on it untouched. The noise floor
    // is the feature: a warning that fires on every report is a warning nobody
    // reads by the second one.
    pass: async (fx) => atRevision(await calculatedRevision(fx)),
  },
];

describeIntegration("T4.4 — §6.2 in full, and the gates it closes", () => {
  setupDocumentsDir();

  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    // The factor catalogue survives `resetAppTables` (it is reference data), so
    // every draft set this suite creates is removed by its prefix — a leaked
    // draft would make `resolveFactorSet` non-deterministic for other suites.
    await getTestDb()
      .delete(factorSet)
      .where(like(factorSet.code, `${FACTOR_SET_PREFIX}%`));
  });
  afterAll(async () => {
    await closeTestDb();
  });

  // ─── The table itself ──────────────────────────────────────────────────────

  describe("the inventory is covered by construction", () => {
    it("has a case for every implemented rule, and none for anything else", () => {
      const covered = CASES.map((testCase) => testCase.code).sort();
      expect(covered).toEqual([...new Set(covered)].sort()); // no duplicates
      expect(covered).toEqual(Object.keys(EVALUATORS).sort());
    });

    it("gives every BLOCKING implemented rule a consequence to prove", () => {
      const blocking = VALIDATION_RULES.filter(
        (rule) => rule.blocking && EVALUATORS[rule.code] !== undefined,
      )
        .map((rule) => rule.code)
        .sort();
      const withConsequence = CASES.filter((testCase) => testCase.blocks)
        .map((testCase) => testCase.code)
        .sort();
      // A rule declared blocking that nothing refuses on is a rule in name only.
      expect(withConsequence).toEqual(blocking);
    });
  });

  for (const testCase of CASES) {
    const rule = findRule(testCase.code);
    if (!rule) throw new Error(`unknown rule in the table: ${testCase.code}`);

    describe(`${testCase.code} (${rule.domain}, ${rule.scope})`, () => {
      it("fails §6.2's wrong case and passes its right one", async () => {
        const fx = await setupFx(testCase.plan);

        const failed = testCase.failRun
          ? await testCase.failRun(fx)
          : await runFor(fx, await testCase.fail!(fx));
        const failing = failed.filter((r) => r.ruleCode === testCase.code);
        expect(failing.length).toBeGreaterThan(0);
        expect(failing.some((r) => !r.passed)).toBe(true);
        // The stored verdict carries the INVENTORY's own metadata: a rule that
        // fails with the wrong severity is a rule the gates read differently.
        for (const record of failing) {
          expect(record.scope).toBe(rule.scope);
          expect(record.severity).toBe(rule.severity);
          expect(record.blocking).toBe(rule.blocking);
        }

        const passed = await runFor(fx, await testCase.pass(fx));
        const passing = passed.filter((r) => r.ruleCode === testCase.code);
        expect(passing.length).toBeGreaterThan(0);
        expect(passing.every((r) => r.passed)).toBe(true);
      });

      if (testCase.blocks) {
        it("refuses the advancement VR-3 gives it, naming the code", async () => {
          const fx = await setupFx(testCase.plan);
          const subject = testCase.fail ? await testCase.fail(fx) : undefined;
          expect(await testCase.blocks!(fx, subject)).toContain(testCase.code);
        });
      }
    });
  }

  // ─── AC-7 — DQ-4 inside VAL-041 ────────────────────────────────────────────

  describe("AC-7 — every report fact has evidence or an assumption (DQ-4)", () => {
    it("blocks the approve for `high_primary` with no evidence, allows `estimate` + a comment", async () => {
      const fx = await setupFx();
      const revision = await revisionWithEvidenceHole(fx, "high_primary");
      const session = await serviceSession(fx.userId);
      await getTestDb()
        .update(reportRevision)
        .set({ status: "in_review" })
        .where(eq(reportRevision.id, revision.id));

      const refused = await transitionRevision(
        getTestDb(),
        session,
        revision.id,
        "approve",
      );
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error).toBe("VALIDATION");
      expect(codesOf(refused)).toContain("VAL-041");
      expect(preconditionOf(refused)).toBe("no_blocking_rules");

      // HALF THE PAIR IS NOT THE PAIR: an assumption tier with no sentence
      // behind it still says nothing about where the number came from.
      await getTestDb()
        .update(dqAssessment)
        .set({ qualityTier: "estimate", qualityComment: null })
        .where(eq(dqAssessment.objectId, revision.rowId));
      const stillRefused = await transitionRevision(
        getTestDb(),
        session,
        revision.id,
        "approve",
      );
      expect(stillRefused.ok).toBe(false);
      expect(codesOf(stillRefused)).toContain("VAL-041");

      // …and with both halves, the same revision is approvable.
      await getTestDb()
        .update(dqAssessment)
        .set({
          qualityTier: "estimate",
          qualityComment: "estimated from floor area; no invoice exists",
        })
        .where(eq(dqAssessment.objectId, revision.rowId));
      await calculateFor(fx, revision.id);
      const approved = await transitionRevision(
        getTestDb(),
        session,
        revision.id,
        "approve",
      );
      expect(approved.ok).toBe(true);
      expect(
        (await storedResult(fx.companyId, "VAL-041", revision.id)).passed,
      ).toBe(true);
    });

    it("counts a row WITH evidence as answered whatever its tier says", async () => {
      const fx = await setupFx();
      const revision = await revisionWithEvidenceHole(fx, "high_primary");
      await attachDocument(fx, revision.rowId);
      const session = await serviceSession(fx.userId);
      await getTestDb()
        .update(reportRevision)
        .set({ status: "in_review" })
        .where(eq(reportRevision.id, revision.id));

      // The tier is untouched: DQ-4 asks for evidence OR an assumption, and a
      // document IS the evidence half.
      await calculateFor(fx, revision.id);
      const approved = await transitionRevision(
        getTestDb(),
        session,
        revision.id,
        "approve",
      );
      expect(approved.ok).toBe(true);
    });
  });

  // ─── EV-5 — a document deleted behind the application's back ───────────────

  describe("EV-5 — evidence integrity (VAL-036)", () => {
    it("blocks the approve of ONLY the rows the broken document backs", async () => {
      const fx = await setupFx();
      const session = await serviceSession(fx.userId);

      const backed = await createdRow(fx, {
        sourceName: "Backed by the gone file",
      });
      const gone = await attachDocument(fx, backed.id);
      const neighbour = await createdRow(fx, {
        sourceName: "Backed by a real file",
      });
      const kept = await attachDocument(fx, neighbour.id);
      const unevidenced = await createdRow(fx, {
        sourceName: "No evidence at all",
      });

      // Removed by something that is not this application — a tidy-up script, a
      // restore, a sync. Nothing in the database changed.
      await rm(objectPath(fx.companyId, gone.fileHash));

      const refused = await approveRow(
        getTestDb(),
        session,
        "emission_activity",
        backed.id,
      );
      expect(refused.ok).toBe(false);
      expect(codesOf(refused)).toEqual(["VAL-036"]);

      // The blast radius is the LINK, not the revision: its neighbours approve.
      expect(
        (
          await approveRow(
            getTestDb(),
            session,
            "emission_activity",
            neighbour.id,
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await approveRow(
            getTestDb(),
            session,
            "emission_activity",
            unevidenced.id,
          )
        ).ok,
      ).toBe(true);

      // The finding is filed under the DOCUMENT (§6.2 `appliesTo`), which is
      // what the screen needs to say WHICH file to re-upload. The refused row is
      // still a draft — the transaction that would have approved it was rolled
      // back — so the state is forced here to watch the rule WRITE its verdict.
      await getTestDb().execute(
        sql`UPDATE emission_activity SET state = 'approved' WHERE id = ${backed.id}`,
      );
      await runValidation(getTestDb(), {
        companyId: fx.companyId,
        scope: "record",
        targetId: backed.id,
      });
      expect(
        (await storedResult(fx.companyId, "VAL-036", gone.id)).passed,
      ).toBe(false);
      expect(
        (await storedResult(fx.companyId, "VAL-036", gone.id)).objectType,
      ).toBe("document");
      expect(
        (await storedResult(fx.companyId, "VAL-036", kept.id)).passed,
      ).toBe(true);
    });

    it("re-checks the whole revision at approve, and blocks it (EV-5's other half)", async () => {
      const fx = await setupFx();
      const session = await serviceSession(fx.userId);
      const row = await approvedRowWithEvidence(fx, "intact");
      const doc = await getTestDb()
        .select({ id: document.id, fileHash: document.fileHash })
        .from(document)
        .where(eq(document.companyId, fx.companyId));

      expect(
        (
          await transitionRevision(
            getTestDb(),
            session,
            fx.revisionId,
            "submit",
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await transitionRevision(
            getTestDb(),
            session,
            fx.revisionId,
            "start_review",
          )
        ).ok,
      ).toBe(true);

      // The file disappears AFTER the row was approved and the report submitted
      // — the case a per-row check at approval time cannot catch on its own.
      await rm(objectPath(fx.companyId, doc[0].fileHash));

      const refused = await transitionRevision(
        getTestDb(),
        session,
        fx.revisionId,
        "approve",
      );
      expect(refused.ok).toBe(false);
      expect(codesOf(refused)).toContain("VAL-041");
      expect(row.state).toBe("approved"); // the row itself was never in doubt
    });

    it("tells a MISSING FILE from an unreachable store — one is a verdict, the other is not", async () => {
      const fx = await setupFx();
      const row = await approvedRowWithEvidence(fx, "intact");
      const target = {
        companyId: fx.companyId,
        scope: "record" as const,
        targetId: row.id,
      };
      expect(
        (await runFor(fx, atRecord(row.id))).some(
          (r) => r.ruleCode === "VAL-036" && r.passed,
        ),
      ).toBe(true);

      const configured = process.env.DOCUMENTS_DIR;
      process.env.DOCUMENTS_DIR = "";
      try {
        // The store cannot be asked, so the rule does not answer. Refusing the
        // approval here would accuse the user of losing a file over a mount that
        // is briefly down — and a retry would then contradict the accusation.
        await expect(runValidation(getTestDb(), target)).rejects.toBeInstanceOf(
          DocumentStorageError,
        );
      } finally {
        process.env.DOCUMENTS_DIR = configured;
      }

      // Nothing was written by the failed run: the last stored verdict is still
      // the pass from before, not a fabricated failure.
      const documents = await getTestDb()
        .select({ id: document.id })
        .from(document)
        .where(eq(document.companyId, fx.companyId));
      expect(
        (await storedResult(fx.companyId, "VAL-036", documents[0].id)).passed,
      ).toBe(true);
    });
  });

  // ─── VAL-041's first question — "нет критических ошибок" ──────────────────

  it("refuses the approve while a CURRENT row still carries a blocking failure", async () => {
    const fx = await setupFx();
    const session = await serviceSession(fx.userId);
    const row = await createdRow(fx);
    await attachDocument(fx, row.id);
    const approved = await approveRow(
      getTestDb(),
      session,
      "emission_activity",
      row.id,
    );
    if (!approved.ok) throw new Error("the approval under test was refused");
    for (const action of ["submit", "start_review"] as const) {
      expect(
        (await transitionRevision(getTestDb(), session, fx.revisionId, action))
          .ok,
      ).toBe(true);
    }

    // The figure drifts underneath the frozen report — an importer, a restore, a
    // hand-run UPDATE. The service would refuse it (LC-5); the database will not.
    await getTestDb().execute(
      sql`UPDATE emission_activity SET activity_value = '-5' WHERE id = ${approved.row.id}`,
    );
    await runValidation(getTestDb(), {
      companyId: fx.companyId,
      scope: "record",
      targetId: approved.row.id,
    });

    const refused = await transitionRevision(
      getTestDb(),
      session,
      fx.revisionId,
      "approve",
    );
    expect(refused.ok).toBe(false);
    // VAL-011 failed against the row; VAL-041 is what carries that up to the
    // revision, which is the level the approval is decided at (§6.2).
    expect(codesOf(refused)).toContain("VAL-041");
    expect(
      (await storedResult(fx.companyId, "VAL-041", fx.revisionId)).passed,
    ).toBe(false);
  });

  // ─── LC-7 — self-approval is disclosed, never prevented ────────────────────

  it("VAL-040 — self-approval yields a Warning and does NOT block the approve", async () => {
    const fx = await setupFx();
    const session = await serviceSession(fx.userId);
    const row = await createdRow(fx);
    await attachDocument(fx, row.id); // so DQ-4 has nothing to say
    const approvedRow = await approveRow(
      getTestDb(),
      session,
      "emission_activity",
      row.id,
    );
    expect(approvedRow.ok).toBe(true);
    await calculateFor(fx);

    for (const action of ["submit", "start_review", "approve"] as const) {
      const moved = await transitionRevision(
        getTestDb(),
        session,
        fx.revisionId,
        action,
      );
      expect(moved.ok).toBe(true);
    }

    const disclosure = await storedResult(
      fx.companyId,
      "VAL-040",
      fx.revisionId,
    );
    expect(disclosure.passed).toBe(false);
    expect(disclosure.severity).toBe("warning");
    expect(disclosure.blocking).toBe(false);
    // The transition happened anyway — LC-7 disclosed it (see the audit summary
    // `self_approved`, asserted in `periods-revisions.integration`).
    expect((await storedRevision(fx.revisionId)).status).toBe("approved");
  });

  // ─── VR-3 — each level answers for itself ─────────────────────────────────

  describe("VR-3 — a blocking rule stops its own level and leaves another's alone", () => {
    it("a PERIOD failure lets the submit through and refuses the approve", async () => {
      const fx = await setupFx();
      const session = await serviceSession(fx.userId);
      const row = await createdRow(fx);
      await attachDocument(fx, row.id);
      expect(
        (await approveRow(getTestDb(), session, "emission_activity", row.id))
          .ok,
      ).toBe(true);
      // D15's missing reason — a `period`-scope blocking failure.
      await insertPeriodScope(fx.companyId, {
        periodId: fx.periodId,
        status: "excluded",
        exclusionReason: null,
      });

      // submit answers for record / revision / reference_org — not for `period`.
      expect(
        (
          await transitionRevision(
            getTestDb(),
            session,
            fx.revisionId,
            "submit",
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await transitionRevision(
            getTestDb(),
            session,
            fx.revisionId,
            "start_review",
          )
        ).ok,
      ).toBe(true);

      const refused = await transitionRevision(
        getTestDb(),
        session,
        fx.revisionId,
        "approve",
      );
      expect(refused.ok).toBe(false);
      expect(codesOf(refused)).toContain("VAL-101");
    });

    it("a RECORD failure stops the submit while the period stays clean", async () => {
      const fx = await setupFx();
      const session = await serviceSession(fx.userId);
      const bad = await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
        legalEntityId: fx.entityId,
        facilityId: fx.facilityId,
        activityValue: "-5", // VAL-011, straight at the table
        state: "approved",
        approvedBy: fx.userId,
        approvedAt: new Date(),
      });

      const refused = await transitionRevision(
        getTestDb(),
        session,
        fx.revisionId,
        "submit",
      );
      expect(refused.ok).toBe(false);
      expect(codesOf(refused)).toContain("VAL-011");

      // The PERIOD is untouched by the row's problem: its own scope is green.
      const periodRun = await runValidation(getTestDb(), {
        companyId: fx.companyId,
        scope: "period",
        targetId: fx.periodId,
      });
      expect(blockingFailures(periodRun)).toEqual([]);

      // Fixing the row through the service clears the gate — the same gate.
      const fixed = await editRow(
        getTestDb(),
        session,
        "emission_activity",
        bad.id,
        {
          values: { activityValue: "5" },
          changeReason: "meter re-read",
        },
      );
      expect(fixed.ok).toBe(true);
      if (!fixed.ok) return;
      expect(
        (
          await approveRow(
            getTestDb(),
            session,
            "emission_activity",
            fixed.row.id,
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await transitionRevision(
            getTestDb(),
            session,
            fx.revisionId,
            "submit",
          )
        ).ok,
      ).toBe(true);
    });

    it("does not hold a revision hostage to a version it no longer contains", async () => {
      const fx = await setupFx();
      const session = await serviceSession(fx.userId);
      const bad = await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
        legalEntityId: fx.entityId,
        facilityId: fx.facilityId,
        activityValue: "-5",
      });
      // The failure is STORED against that version — and stays there for ever,
      // because a version is immutable and results are keyed per object.
      await runValidation(getTestDb(), {
        companyId: fx.companyId,
        scope: "record",
        targetId: bad.id,
      });
      expect((await storedResult(fx.companyId, "VAL-011", bad.id)).passed).toBe(
        false,
      );

      const fixed = await editRow(
        getTestDb(),
        session,
        "emission_activity",
        bad.id,
        {
          values: { activityValue: "5" },
        },
      );
      if (!fixed.ok) throw new Error("the fix was refused");
      await attachDocument(fx, fixed.row.id);
      expect(
        (
          await approveRow(
            getTestDb(),
            session,
            "emission_activity",
            fixed.row.id,
          )
        ).ok,
      ).toBe(true);
      await calculateFor(fx);

      for (const action of ["submit", "start_review", "approve"] as const) {
        const moved = await transitionRevision(
          getTestDb(),
          session,
          fx.revisionId,
          action,
        );
        expect(moved.ok).toBe(true);
      }
      // …and the stale row is still there, still failing, still ignored.
      expect((await storedResult(fx.companyId, "VAL-011", bad.id)).passed).toBe(
        false,
      );
    });
  });

  // ─── The two registries this task fills ───────────────────────────────────

  describe("the registries after T4.4", () => {
    it("leaves PENDING_EVALUATORS EMPTY — every §6.2 rule has an evaluator", () => {
      // T4.4 left three codes here, all waiting for a `calculation` ROW. T5.4
      // wrote the run that produces one and took all three, so R-12 is closed:
      // no rule of the inventory can pass by nobody having written its check.
      expect(Object.keys(PENDING_EVALUATORS).sort()).toEqual([]);
      for (const code of [
        "VAL-036",
        "VAL-040",
        "VAL-041",
        "VAL-022",
        "VAL-024",
        "VAL-017",
        "VAL-034",
        "VAL-035",
        "VAL-107",
      ] as const) {
        expect(EVALUATORS[code]).toBeTypeOf("function");
      }
    });

    it("registers the preconditions of §5.1 by name, in order", () => {
      const registered = Object.fromEntries(
        Object.entries(TRANSITION_PRECONDITIONS).map(([action, checks]) => [
          action,
          checks.map((check) => check.name),
        ]),
      );
      expect(registered).toEqual({
        submit: ["all_rows_approved", "no_blocking_rules"],
        start_review: [],
        // T5.4 appended CALC-6's "a green run over the CURRENT rows" AFTER the
        // rule sweep: "your data does not validate" is the cheaper and more
        // actionable answer, and a run made over data that does not validate
        // has to be made again anyway.
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

    it("counts a tombstone and a superseded version out of `all_rows_approved`", async () => {
      const fx = await setupFx();
      const session = await serviceSession(fx.userId);
      const row = await createdRow(fx);
      await attachDocument(fx, row.id);
      const deleted = await deleteRow(
        getTestDb(),
        session,
        "emission_activity",
        row.id,
      );
      expect(deleted.ok).toBe(true);

      // A tombstone is not a row the report contains, so nothing waits for its
      // approval — and the superseded draft underneath it is history.
      expect(
        (
          await transitionRevision(
            getTestDb(),
            session,
            fx.revisionId,
            "submit",
          )
        ).ok,
      ).toBe(true);
    });
  });
});
