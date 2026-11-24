// [LOCAL-DB] T2.4/T2.5 — reporting periods and their BOUNDARY (service → route →
// validation) against a real Postgres via the T1.7 harness.
//
// The properties this file exists to prove, none of which is visible without a
// database:
//
//   • THE PIN IS REAL AND IT IS THE ACTIVE SET (К-24, R-4). A period that names
//     no set gets the active one; a period that names a DRAFT or ARCHIVED one is
//     refused rather than pinned to factors nobody released. Without the pin,
//     AC-8 (a locked report reproduces) has nothing to stand on.
//   • AN INVERTED PERIOD IS REFUSED TWICE, at two levels that do not depend on
//     each other: the API answers VAL-008 with a rule code, and the CHECK
//     `reporting_period_dates_check` refuses the row to anyone who writes it
//     directly. The second is asserted by INSERTING one, not by trusting the
//     first.
//   • AN OVERLAP IS A WARNING, NOT A REFUSAL (VAL-009). It is the one rule of
//     this scope that is allowed to fail and still let the write through, so the
//     test asserts both halves: 200 AND the stored non-blocking row.
//   • AC-9 AND AC-10 HAVE AN OWNER (VAL-102, VAL-103). A consolidated report
//     with one company in it, or with no designated parent, is refused; an
//     included subsidiary with no `registered_address` is refused, and an
//     EXCLUDED one is not. Until the plan was corrected these two acceptance
//     criteria were "covered in effect" by no task at all.
//   • DM-7a FREEZES SIX FIELDS AND ONLY SIX (VAL-106). Once the current revision
//     leaves draft, `start_date` cannot move — while `period_name` still can,
//     and re-sending an unchanged value is not an edit. That is what keeps a
//     locked calculation's inputs from shifting underneath it.
//   • `period_status` IS DERIVED (К-4/LC-2). There is no such column: the value
//     in the response comes from the current revision, and `Draft` when there
//     is none.
//   • THE BOUNDARY IS A DISCLOSURE, NOT A CHECKBOX (T2.5 — DM-8/DM-9, D10/D15).
//     `PUT /api/periods/[id]/scope` replaces the whole (period, entity) set;
//     an exclusion without a reason is refused by VAL-101 and leaves NOTHING
//     behind, an omitted row leaves the boundary and says so in the audit trail,
//     every change writes exactly one `audit_log` row and every refusal none,
//     and the whole surface freezes with the period (VAL-106).
//
// WHERE T2.5 RE-POINTED THIS FILE. VAL-102 and VAL-103 read `period_scope`, and
// until T2.5 the only way to have a boundary was the harness fixture
// `insertPeriodScope` plus direct UPDATEs. The AC-9/AC-10 set-ups now go through
// the ROUTE, which changes one thing about them and nothing else: a boundary the
// report could not print (one included entity in a consolidated period, an
// included entity with no `registered_address`) is refused AT THE PUT, so the
// criterion is asserted where the API now refuses it rather than on the period
// PATCH that used to be the first write to see it. The PATCH path keeps its own
// coverage — a REGISTRY edit (demoting the designated parent) can still
// invalidate a boundary that was legal when it was drawn, and that is asserted
// too. `insertPeriodScope` survives where a fixture is the point: proving the
// UNIQUE key refuses a doubled entity no matter who writes it.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so this file is
// a green no-op in a DB-less CI.
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
  GET as scopeGET,
  OPTIONS as scopeOPTIONS,
  PUT as scopePUT,
} from "@/app/api/periods/[id]/scope/route";
import {
  GET as periodsGET,
  OPTIONS as periodsOPTIONS,
  POST as periodsPOST,
} from "@/app/api/periods/route";
import { resolveSessionContext } from "@/server/auth/session";
import { resetPlanFeaturesCache } from "@/server/billing/entitlements";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
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
  factorSet,
  legalEntity,
  periodScope,
  reportingPeriod,
  reportRevision,
  validationResult,
} from "@/server/db/schema";
import { METHODOLOGY_VERSIONS } from "@/shared/enums";
import type { PlanId } from "@/shared/plans";
import type { CompanyRole } from "@/shared/roles";

/**
 * The set an unspecified period pins — i.e. the ACTIVE set with the greatest
 * `published_at` (`resolveFactorSet`). 0009 published `si-2025` after
 * `legacy-v1`, 0015 `si-2025-r2` after that, 0020 `si-2025-r3` (biomass) and 0023
 * `si-2025-r4` (district heat + spend) and 0024 `si-2025-r5` (the 2024
 * reporting year) after that, so the default moved five times; that is what "default factor
 * set" means here, and it is a data fact rather than a flag on a column.
 */
const DEFAULT_SET_CODE = "si-2025-r5";

/**
 * The Phase-1 set (T1.5). Still `active` and still explicitly pinnable — every
 * period created before 0009 references it by id (К-24) — it is simply no
 * longer what a caller gets by omitting `factor_set_id`.
 */
const LEGACY_SET_CODE = "legacy-v1";

/** A GET request the route handlers accept. */
const request = (path: string, method = "GET"): NextRequest =>
  new Request(`http://api.example.com${path}`, { method }) as NextRequest;

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
  plan: PlanId,
  role: CompanyRole = "esg_admin",
): Promise<{ companyId: string; userId: string }> {
  const company = await insertCompany({ plan });
  const { user } = await insertUserWithProfile({ companyId: company.id, role });
  getSessionMock.mockResolvedValue(await sessionFor(user.id));
  return { companyId: company.id, userId: user.id };
}

/** POST a period and return `{status, body}`. */
async function postPeriod(overrides: Record<string, unknown> = {}) {
  const res = await periodsPOST(
    jsonRequest("/api/periods", "POST", {
      period_name: "FY2024",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      ...overrides,
    }),
  );
  return { status: res.status, body: await res.json() };
}

/** PATCH a period and return `{status, body}`. */
async function patchPeriod(id: string, body: Record<string, unknown>) {
  const res = await periodPATCH(
    jsonRequest(`/api/periods/${id}`, "PATCH", body),
    ctxFor(id),
  );
  return { status: res.status, body: await res.json() };
}

/** PUT a boundary — the WHOLE set — and return `{status, body}` (T2.5). */
async function putScope(periodId: string, entries: unknown) {
  const res = await scopePUT(
    jsonRequest(`/api/periods/${periodId}/scope`, "PUT", { entries }),
    ctxFor(periodId),
  );
  return { status: res.status, body: await res.json() };
}

/** GET a boundary and return `{status, body}`. */
async function getScope(periodId: string) {
  const res = await scopeGET(
    request(`/api/periods/${periodId}/scope`),
    ctxFor(periodId),
  );
  return { status: res.status, body: await res.json() };
}

/** The stored boundary of a period, straight from the table, by entity id. */
async function storedScope(periodId: string) {
  return getTestDb()
    .select()
    .from(periodScope)
    .where(eq(periodScope.periodId, periodId))
    .orderBy(asc(periodScope.legalEntityId));
}

/** Every boundary audit entry of a company, oldest first (LC-10). */
async function boundaryAudit(companyId: string) {
  return getTestDb()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.companyId, companyId),
        eq(auditLog.entity, "period_scope"),
      ),
    )
    .orderBy(asc(auditLog.createdAt));
}

/** One boundary row as the audit summary spells it. */
interface AuditedScopeRow {
  legal_entity_id: string;
  status: string;
  exclusion_reason: string | null;
}

/** The `summary` of a boundary audit entry — the DIFF, not the resulting set. */
interface BoundaryAuditSummary {
  period_id: string;
  entities: number;
  included: number;
  added: AuditedScopeRow[];
  changed: {
    legal_entity_id: string;
    from: { status: string; exclusion_reason: string | null };
    to: { status: string; exclusion_reason: string | null };
  }[];
  removed: AuditedScopeRow[];
}

/** `audit_log.summary` is `jsonb`, i.e. `unknown` — read it as what T2.5 writes. */
const summaryOf = (row: { summary: unknown }) =>
  row.summary as BoundaryAuditSummary;

/** One stored period row, straight from the table (never through the route). */
async function storedPeriod(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(reportingPeriod)
    .where(eq(reportingPeriod.id, id));
  return row;
}

/** The real `count(*)` of a company's periods. */
async function periodCount(companyId: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(reportingPeriod)
    .where(eq(reportingPeriod.companyId, companyId));
  return row.n;
}

/** One stored validation result by (company, rule, object). */
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

/** The rule codes a 422 payload names (API-1 `{rules:[{code,…}]}`). */
const ruleCodes = (body: { rules?: { code: string }[] }): string[] =>
  (body.rules ?? []).map((rule) => rule.code);

describeIntegration("reporting periods, their pin and their boundary", () => {
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
    resetPlanFeaturesCache();
  });

  // ─── The wire contract (§4.5 + К-13/К-19/К-24/К-4) ─────────────────────────
  it("speaks the DD field names, derives the pin's version and the status", async () => {
    const { companyId, userId } = await actor("pro");

    const created = await postPeriod({ base_year: 2019 });
    expect(created.status).toBe(200);
    const dto = created.body.data;

    expect(dto.period_name).toBe("FY2024");
    expect(dto.start_date).toBe("2024-01-01");
    expect(dto.end_date).toBe("2024-12-31");
    // Defaults DM-7 lets a caller omit: the year of `start_date` (К-19's single
    // dictionary entry for the methodology, the active set for the pin).
    expect(dto.reporting_year).toBe(2024);
    expect(dto.base_year).toBe(2019);
    expect(dto.reporting_basis).toBe("individual");
    expect(dto.methodology_version).toBe(METHODOLOGY_VERSIONS[0]);
    // К-24 — the id AND the version string, from `factor_set.code`.
    expect(dto.factor_set_version).toBe(DEFAULT_SET_CODE);
    expect(dto.factor_set_id).toBeTruthy();
    // К-4 / LC-2 — DERIVED, and `Draft` because the period has no revisions.
    expect(dto.period_status).toBe("Draft");
    expect(dto.created_by).toBe(userId);
    expect(dto).not.toHaveProperty("company_id");
    expect(dto).not.toHaveProperty("periodName");

    // The values are real in the table, and `period_status` is NOT one of them.
    const stored = await storedPeriod(dto.id);
    expect(stored.periodName).toBe("FY2024");
    expect(stored.companyId).toBe(companyId);
    expect(stored).not.toHaveProperty("periodStatus");

    // GET /:id speaks the same contract.
    const read = await periodGET(
      request(`/api/periods/${dto.id}`),
      ctxFor(dto.id),
    );
    expect(read.status).toBe(200);
    expect((await read.json()).data.factor_set_version).toBe(DEFAULT_SET_CODE);
  });

  // ─── VAL-008: refused at BOTH levels ───────────────────────────────────────
  it("end < start → VAL-008 from the API and the CHECK from the database", async () => {
    const { companyId } = await actor("pro");

    const refused = await postPeriod({
      start_date: "2024-12-31",
      end_date: "2024-01-01",
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe("VALIDATION");
    // The CODE, not `{field:"end_date"}`: narrowing this in the parser would
    // make VAL-008 unreachable from the API and leave the rule dead.
    expect(ruleCodes(refused.body)).toContain("VAL-008");
    expect(await periodCount(companyId)).toBe(0);

    // The other level, proved independently of the route: the fixture writes
    // straight to the table and the CHECK — not the service — refuses it. The
    // constraint is named, so this cannot pass because of some other failure.
    const err = await insertPeriod(companyId, {
      startDate: "2024-12-31",
      endDate: "2024-01-01",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    // Drizzle wraps the postgres.js error; the constraint name is on the cause.
    const wrapped = err as { cause?: { constraint_name?: string } };
    expect(wrapped?.cause?.constraint_name).toBe(
      "reporting_period_dates_check",
    );
    expect(await periodCount(companyId)).toBe(0);

    // A PATCH is judged on the MERGED dates — only `end_date` is sent here.
    const ok = await postPeriod();
    const inverted = await patchPeriod(ok.body.data.id, {
      end_date: "2023-06-30",
    });
    expect(inverted.status).toBe(422);
    expect(ruleCodes(inverted.body)).toContain("VAL-008");
    expect((await storedPeriod(ok.body.data.id)).endDate).toBe("2024-12-31");
  });

  // ─── VAL-009: a warning does NOT refuse ────────────────────────────────────
  it("overlapping periods are saved, with a non-blocking VAL-009 row", async () => {
    const { companyId } = await actor("pro");

    expect((await postPeriod()).status).toBe(200);
    const second = await postPeriod({
      period_name: "FY2024/25",
      start_date: "2024-07-01",
      end_date: "2025-06-30",
    });
    expect(second.status).toBe(200);
    expect(await periodCount(companyId)).toBe(2);

    const row = await storedResult(companyId, "VAL-009", second.body.data.id);
    expect(row.passed).toBe(false);
    expect(row.severity).toBe("warning");
    expect(row.blocking).toBe(false);
    // …and VAL-008 passed for the same period, so the warning is the only
    // finding that could have refused it and deliberately did not.
    expect(
      (await storedResult(companyId, "VAL-008", second.body.data.id)).passed,
    ).toBe(true);
  });

  // ─── К-24: the pin, and what may be pinned ─────────────────────────────────
  it("pins the active set by default and refuses a draft, archived or unknown one", async () => {
    const { companyId } = await actor("pro");
    const conn = getTestDb();

    const [archived] = await conn
      .insert(factorSet)
      .values({
        code: `retired-${Date.now()}`,
        name: "Retired",
        status: "archived",
      })
      .returning();
    const [draft] = await conn
      .insert(factorSet)
      .values({
        code: `unreleased-${Date.now()}`,
        name: "Unreleased",
        status: "draft",
      })
      .returning();

    for (const id of [archived.id, draft.id, randomUUID()]) {
      const refused = await postPeriod({ factor_set_id: id });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe("VALIDATION");
      // A bare refusal: an unreleasable set "does not exist" for this purpose
      // (API-1), and no VAL-* rule owns the factor library's lifecycle.
      expect(ruleCodes(refused.body)).toEqual([]);
    }
    expect(await periodCount(companyId)).toBe(0);

    // THE DEFAULT IS THE MOST RECENTLY PUBLISHED ACTIVE SET, and an active set
    // that was never stamped with a `published_at` does not displace it. This
    // is a regression test with a scar: `ORDER BY published_at DESC` sorts NULLs
    // FIRST in Postgres, so without `NULLS LAST` an unstamped set silently
    // became the default pin of every new period.
    const [unstamped] = await conn
      .insert(factorSet)
      .values({
        code: `unstamped-${Date.now()}`,
        name: "Active, never published",
        status: "active",
      })
      .returning();
    try {
      const created = await postPeriod();
      expect(created.status).toBe(200);
      expect(created.body.data.factor_set_version).toBe(DEFAULT_SET_CODE);
    } finally {
      // Archived rather than deleted: the period just created references it by
      // FK, and `factor_set` is reference data that no reset cleans up.
      await conn
        .update(factorSet)
        .set({ status: "archived" })
        .where(eq(factorSet.id, unstamped.id));
    }

    // …AND THE SET THAT STOPPED BEING THE DEFAULT IS STILL PINNABLE. 0009 moved
    // the default to `si-2025` by publishing it later; it did NOT archive
    // `legacy-v1`, because a company whose fuels the narrow national set does
    // not price must be able to choose the wide one on the period. Asserted
    // through the same POST a user's screen makes, not by reading the table.
    const [legacy] = await conn
      .select({ id: factorSet.id, status: factorSet.status })
      .from(factorSet)
      .where(eq(factorSet.code, LEGACY_SET_CODE));
    expect(legacy.status).toBe("active");
    const pinnedLegacy = await postPeriod({ factor_set_id: legacy.id });
    expect(pinnedLegacy.status).toBe(200);
    expect(pinnedLegacy.body.data.factor_set_version).toBe(LEGACY_SET_CODE);
    expect(pinnedLegacy.body.data.factor_set_id).toBe(legacy.id);

    // `factor_set_id: null` is a rejected FIELD, not "use the default": the
    // column is NOT NULL, and omitting the key is how a caller asks for the
    // default (which is what the first test of this file exercises).
    const blanked = await postPeriod({ factor_set_id: null });
    expect(blanked.status).toBe(422);
    expect(blanked.body.field).toBe("factor_set_id");
    expect(blanked.body.rules).toBeUndefined();
    // The default-pin period plus the one that pinned `legacy-v1` explicitly.
    expect(await periodCount(companyId)).toBe(2);
  });

  it("refuses to create a period when no factor set is active at all", async () => {
    const { companyId } = await actor("pro");
    const conn = getTestDb();
    // `factor_set` is REFERENCE data: `resetAppTables` does not touch it, and
    // other suites leave active sets of their own behind. So the rows this test
    // deactivates are remembered by id and put back exactly — blanket-restoring
    // "legacy-v1" would silently archive somebody else's fixture for the rest of
    // the run.
    const wasActive = await conn
      .select({ id: factorSet.id })
      .from(factorSet)
      .where(eq(factorSet.status, "active"));
    await conn
      .update(factorSet)
      .set({ status: "archived" })
      .where(eq(factorSet.status, "active"));
    try {
      const refused = await postPeriod();
      expect(refused.status).toBe(422);
      expect(ruleCodes(refused.body)).toEqual([]);
      expect(await periodCount(companyId)).toBe(0);
    } finally {
      await conn
        .update(factorSet)
        .set({ status: "active" })
        .where(
          inArray(
            factorSet.id,
            wasActive.map((row) => row.id),
          ),
        );
    }
  });

  // ─── PG-2: `consolidated` is a paid basis ──────────────────────────────────
  it("consolidated is 402 on starter and 200 on pro, on POST and on PATCH", async () => {
    const starter = await actor("starter");
    const refused = await postPeriod({ reporting_basis: "consolidated" });
    expect(refused.status).toBe(402);
    expect(refused.body).toEqual({ ok: false, error: "PLAN_REQUIRED" });
    expect(await periodCount(starter.companyId)).toBe(0);

    // The SAME company may still create an individual period, and may not
    // upgrade it to consolidated by PATCH either — the gate is on the value.
    const individual = await postPeriod();
    expect(individual.status).toBe(200);
    const upgraded = await patchPeriod(individual.body.data.id, {
      reporting_basis: "consolidated",
    });
    expect(upgraded.status).toBe(402);
    expect((await storedPeriod(individual.body.data.id)).reportingBasis).toBe(
      "individual",
    );

    // On pro the very same request is a 200 — with no boundary rows yet, which
    // is exactly the state a consolidated period is created in (T2.5 draws the
    // boundary afterwards).
    const pro = await actor("pro");
    const consolidated = await postPeriod({ reporting_basis: "consolidated" });
    expect(consolidated.status).toBe(200);
    expect(consolidated.body.data.reporting_basis).toBe("consolidated");
    expect(await periodCount(pro.companyId)).toBe(1);
  });

  it("a contributor gets 403 where an admin gets 402 (403 ≺ 402)", async () => {
    const company = await insertCompany({ plan: "starter" });
    const { user: contributor } = await insertUserWithProfile({
      companyId: company.id,
      role: "contributor", // data.write + data.read, no company.manage
    });
    const { user: admin } = await insertUserWithProfile({
      companyId: company.id,
      role: "esg_admin",
    });

    getSessionMock.mockResolvedValue(await sessionFor(contributor.id));
    const byRole = await postPeriod({ reporting_basis: "consolidated" });
    expect(byRole.status).toBe(403);
    expect(byRole.body).toEqual({ ok: false, error: "FORBIDDEN" });

    // The 402 proves the request WOULD have reached the plan gate, so the 403
    // above can only have come from a check that runs before it.
    getSessionMock.mockResolvedValue(await sessionFor(admin.id));
    expect((await postPeriod({ reporting_basis: "consolidated" })).status).toBe(
      402,
    );
    expect(await periodCount(company.id)).toBe(0);
  });

  // ─── AC-9 (VAL-102) ────────────────────────────────────────────────────────
  it("AC-9: a consolidated report needs ≥2 included entities and one designated parent", async () => {
    const { companyId } = await actor("pro");
    const conn = getTestDb();

    const created = await postPeriod({ reporting_basis: "consolidated" });
    expect(created.status).toBe(200);
    const periodId = created.body.data.id;

    // ONE included company is an individual report wearing another label — and
    // since T2.5 the boundary route refuses to RECORD it in the first place.
    const first = await insertLegalEntity(companyId, {
      groupStructureType: "parent",
    });
    const alone = await putScope(periodId, [
      { legal_entity_id: first.id, status: "included" },
    ]);
    expect(alone.status).toBe(422);
    expect(ruleCodes(alone.body)).toContain("VAL-102");
    expect(await storedScope(periodId)).toHaveLength(0);

    // TWO included companies, NEITHER designated the parent: still refused —
    // "≥2 entities" is half the rule, not all of it. (`first` is demoted for
    // this step so that the only thing missing is the designation.)
    await conn
      .update(legalEntity)
      .set({ groupStructureType: "standalone" })
      .where(eq(legalEntity.id, first.id));
    const second = await insertLegalEntity(companyId, {
      groupStructureType: "standalone",
    });
    const bothIncluded = [
      { legal_entity_id: first.id, status: "included" },
      { legal_entity_id: second.id, status: "included" },
    ];
    const headless = await putScope(periodId, bothIncluded);
    expect(headless.status).toBe(422);
    expect(ruleCodes(headless.body)).toContain("VAL-102");

    // Designate the parent and make the other its subsidiary → the group has a
    // single top and the write goes through.
    await conn
      .update(legalEntity)
      .set({ groupStructureType: "parent" })
      .where(eq(legalEntity.id, first.id));
    await conn
      .update(legalEntity)
      .set({ groupStructureType: "subsidiary", parentLegalEntityId: first.id })
      .where(eq(legalEntity.id, second.id));
    const group = await putScope(periodId, bothIncluded);
    expect(group.status).toBe(200);
    expect((await storedResult(companyId, "VAL-102", periodId)).passed).toBe(
      true,
    );
    // …and the PERIOD's own write path sees the same pass.
    expect(
      (await patchPeriod(periodId, { period_name: "Group FY2024" })).status,
    ).toBe(200);

    // Take the subsidiary out of the boundary again and the rule bites again.
    const shrunk = await putScope(periodId, [
      { legal_entity_id: first.id, status: "included" },
      {
        legal_entity_id: second.id,
        status: "excluded",
        exclusion_reason: "sold in Q1",
      },
    ]);
    expect(shrunk.status).toBe(422);
    expect(ruleCodes(shrunk.body)).toContain("VAL-102");
    // The boundary the route refused to shrink is untouched — both still in.
    expect((await storedScope(periodId)).map((row) => row.status)).toEqual([
      "included",
      "included",
    ]);

    // A boundary that was legal when it was drawn can be invalidated by a
    // REGISTRY edit, which is how VAL-102 still reaches the period's own write
    // path: demote the designated parent and the PATCH is refused.
    await conn
      .update(legalEntity)
      .set({ groupStructureType: "standalone" })
      .where(eq(legalEntity.id, first.id));
    const demoted = await patchPeriod(periodId, { period_name: "Group only" });
    expect(demoted.status).toBe(422);
    expect(ruleCodes(demoted.body)).toContain("VAL-102");
    await conn
      .update(legalEntity)
      .set({ groupStructureType: "parent" })
      .where(eq(legalEntity.id, first.id));

    // An INDIVIDUAL period with the same one-entity boundary is not the rule's
    // subject: the very payload refused above is a 200 here.
    const individual = await postPeriod({
      period_name: "FY2023",
      start_date: "2023-01-01",
      end_date: "2023-12-31",
    });
    expect(individual.status).toBe(200);
    expect(
      (
        await putScope(individual.body.data.id, [
          { legal_entity_id: first.id, status: "included" },
        ])
      ).status,
    ).toBe(200);
    expect(
      (await patchPeriod(individual.body.data.id, { period_name: "FY2023 " }))
        .status,
    ).toBe(200);
  });

  // ─── AC-10 (VAL-103) ───────────────────────────────────────────────────────
  it("AC-10: an INCLUDED entity needs a registered_address; an excluded one does not", async () => {
    const { companyId } = await actor("pro");
    const conn = getTestDb();

    const created = await postPeriod();
    const periodId = created.body.data.id;

    const homeless = await insertLegalEntity(companyId, {
      registeredAddress: null,
    });

    // Putting an addressless entity INTO the boundary is refused by the rule
    // that owns AC-10 — the report would have to print a company with no
    // registered address.
    const refused = await putScope(periodId, [
      { legal_entity_id: homeless.id, status: "included" },
    ]);
    expect(refused.status).toBe(422);
    expect(ruleCodes(refused.body)).toContain("VAL-103");
    // VR-3: a refused write leaves NEITHER the row NOR a result row — results
    // only ever describe a state that exists.
    expect(await storedScope(periodId)).toHaveLength(0);
    expect(
      await storedResult(companyId, "VAL-103", homeless.id),
    ).toBeUndefined();

    // EXCLUDING the entity resolves it: the rule does not fire on an entity the
    // report does not print…
    const excluded = await putScope(periodId, [
      {
        legal_entity_id: homeless.id,
        status: "excluded",
        exclusion_reason: "immaterial",
      },
    ]);
    expect(excluded.status).toBe(200);
    // …and the pass is WRITTEN, so an earlier failure could not have survived
    // as a stale blocking row on the boundary screen (§4.18).
    expect((await storedResult(companyId, "VAL-103", homeless.id)).passed).toBe(
      true,
    );

    // Back in the boundary WITH an address: also a pass, by the other branch,
    // and the period's own write path agrees.
    await conn
      .update(legalEntity)
      .set({ registeredAddress: "Dunajska cesta 1, 1000 Ljubljana" })
      .where(eq(legalEntity.id, homeless.id));
    const included = await putScope(periodId, [
      { legal_entity_id: homeless.id, status: "included" },
    ]);
    expect(included.status).toBe(200);
    expect((await storedResult(companyId, "VAL-103", homeless.id)).passed).toBe(
      true,
    );
    expect(
      (await patchPeriod(periodId, { period_name: "FY2024 group" })).status,
    ).toBe(200);
  });

  // ─── DM-7a / VAL-106 ───────────────────────────────────────────────────────
  it("freezes the six calculation-bearing fields once the revision leaves draft", async () => {
    const { companyId } = await actor("pro");
    const conn = getTestDb();
    const { period } = await insertPeriod(companyId);

    // No revisions at all → editable (there is no locked calculation to
    // protect), and the derived status says so.
    expect(
      (await patchPeriod(period.id, { start_date: "2024-02-01" })).status,
    ).toBe(200);
    const beforeRevisions = await periodGET(
      request(`/api/periods/${period.id}`),
      ctxFor(period.id),
    );
    expect((await beforeRevisions.json()).data.period_status).toBe("Draft");

    // A DRAFT revision → still editable.
    const revision = await insertRevision(companyId, { periodId: period.id });
    expect((await patchPeriod(period.id, { base_year: 2019 })).status).toBe(
      200,
    );

    // SUBMITTED → the six are frozen, and the refusal names the rule.
    await conn
      .update(reportRevision)
      .set({ status: "submitted" })
      .where(eq(reportRevision.id, revision.id));
    for (const body of [
      { start_date: "2024-03-01" },
      { end_date: "2025-12-31" },
      { base_year: 2018 },
      { methodology_version: METHODOLOGY_VERSIONS[0], base_year: 2017 },
    ]) {
      const frozen = await patchPeriod(period.id, body);
      expect(frozen.status).toBe(422);
      expect(ruleCodes(frozen.body)).toContain("VAL-106");
    }
    const untouched = await storedPeriod(period.id);
    expect(untouched.startDate).toBe("2024-02-01");
    expect(untouched.baseYear).toBe(2019);

    // …and the derived status followed the revision (К-4/LC-2), which is what
    // proves `period_status` is computed rather than a constant.
    const submitted = await periodGET(
      request(`/api/periods/${period.id}`),
      ctxFor(period.id),
    );
    expect((await submitted.json()).data.period_status).toBe("Submitted");

    // LABELLING fields are NOT frozen — they change nothing a calculation reads.
    expect(
      (await patchPeriod(period.id, { period_name: "FY2024 (submitted)" }))
        .status,
    ).toBe(200);

    // Re-sending an UNCHANGED calculation-bearing value is not an edit: a form
    // that PUTs every field it rendered must not be told the period is frozen.
    expect(
      (
        await patchPeriod(period.id, {
          start_date: "2024-02-01",
          base_year: 2019,
          period_name: "FY2024 (resent)",
        })
      ).status,
    ).toBe(200);

    // REJECTED → editable again (LC-2 maps it back to a draft for the API).
    await conn
      .update(reportRevision)
      .set({ status: "rejected" })
      .where(eq(reportRevision.id, revision.id));
    expect(
      (await patchPeriod(period.id, { start_date: "2024-04-01" })).status,
    ).toBe(200);
    expect((await storedPeriod(period.id)).startDate).toBe("2024-04-01");
  });

  // ─── Tenant isolation (PATTERN 3, API-1) ───────────────────────────────────
  it("never reaches another company's period, by PATCH, by GET or by reference", async () => {
    const other = await insertCompany({ plan: "pro" });
    const { period: foreign } = await insertPeriod(other.id, {
      periodName: "Not yours",
    });

    const { companyId } = await actor("pro");

    const patched = await patchPeriod(foreign.id, { period_name: "Hijacked" });
    expect(patched.status).toBe(422);
    expect(patched.body.error).toBe("VALIDATION");
    expect((await storedPeriod(foreign.id)).periodName).toBe("Not yours");

    const read = await periodGET(
      request(`/api/periods/${foreign.id}`),
      ctxFor(foreign.id),
    );
    expect(read.status).toBe(404);

    // A comparative period of another company is a reference that does not
    // resolve — refused, and nothing written.
    const refused = await postPeriod({ comparative_period_id: foreign.id });
    expect(refused.status).toBe(422);
    expect(ruleCodes(refused.body)).toEqual([]);
    expect(await periodCount(companyId)).toBe(0);

    // The company's OWN period is a valid comparative.
    const base = await postPeriod({
      period_name: "FY2023",
      start_date: "2023-01-01",
      end_date: "2023-12-31",
    });
    const linked = await postPeriod({
      comparative_period_id: base.body.data.id,
    });
    expect(linked.status).toBe(200);
    expect(linked.body.data.comparative_period_id).toBe(base.body.data.id);
  });

  // ─── API-3: what the list carries ──────────────────────────────────────────
  it("the list is the company's own and carries `used` + `consolidated_available`", async () => {
    const { companyId } = await actor("pro");
    await postPeriod();
    await postPeriod({
      period_name: "FY2023",
      start_date: "2023-01-01",
      end_date: "2023-12-31",
    });
    const otherCompany = await insertCompany({ plan: "pro" });
    await insertPeriod(otherCompany.id);

    const res = await periodsGET(request("/api/periods"));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.used).toBe(await periodCount(companyId));
    expect(data.used).toBe(2);
    expect(data.periods).toHaveLength(2);
    // Chronological, and every row carries the derived pair.
    expect(data.periods[0].start_date).toBe("2023-01-01");
    expect(
      data.periods.every(
        (p: { period_status: string }) => p.period_status === "Draft",
      ),
    ).toBe(true);
    expect(
      data.periods.every(
        (p: { factor_set_version: string }) =>
          p.factor_set_version === DEFAULT_SET_CODE,
      ),
    ).toBe(true);
    // PG-2's only axis on this route. NOT `limit`: PG-1 has no per-period cap,
    // and `-1` would assert that an axis exists and happens to be uncapped.
    expect(data.consolidated_available).toBe(true);
    expect(data).not.toHaveProperty("limit");

    const starter = await actor("starter");
    await insertPeriod(starter.companyId);
    const onStarter = await periodsGET(request("/api/periods"));
    expect((await onStarter.json()).data.consolidated_available).toBe(false);
  });

  // ─── The parser / rule split (§ `@/server/api/parse`) ──────────────────────
  it("rejects malformed shapes as FIELDS, with no rule code", async () => {
    await actor("pro");
    for (const [body, field] of [
      [{ start_date: "yesterday" }, "start_date"],
      [{ reporting_basis: "group" }, "reporting_basis"],
      [{ methodology_version: "made-up-2024" }, "methodology_version"],
      [{ reporting_year: 2024.5 }, "reporting_year"],
      [{ base_year: 12 }, "base_year"],
      [{ period_name: "" }, "period_name"],
    ] as const) {
      const res = await postPeriod(body);
      expect({ field: res.body.field, status: res.status }).toEqual({
        field,
        status: 422,
      });
      expect(res.body.rules).toBeUndefined();
    }
  });

  // ─── PATTERN 2 ─────────────────────────────────────────────────────────────
  it("answers the CORS preflight (§0.9)", () => {
    expect(
      periodsOPTIONS(request("/api/periods", "OPTIONS")).status,
    ).toBeLessThan(300);
  });

  // ═══ T2.5 — the reporting boundary (DM-8, DM-9, D10/D15, VAL-101, LC-10) ═══
  describe("the reporting boundary", () => {
    it("PUT replaces the whole set, and the audit entry says exactly what moved", async () => {
      const { companyId, userId } = await actor("pro");
      const periodId = (await postPeriod()).body.data.id;

      // A period is created with NO boundary: an empty list, not a 404 — the
      // boundary is drawn after the period exists.
      const empty = await getScope(periodId);
      expect(empty.status).toBe(200);
      expect(empty.body.data).toEqual({ period_id: periodId, entries: [] });

      const kept = await insertLegalEntity(companyId);
      const flipped = await insertLegalEntity(companyId);
      const dropped = await insertLegalEntity(companyId);

      const drawn = await putScope(periodId, [
        { legal_entity_id: kept.id, status: "included" },
        {
          legal_entity_id: flipped.id,
          status: "excluded",
          exclusion_reason: "sold in Q1",
        },
        { legal_entity_id: dropped.id, status: "not_assessed" },
      ]);
      expect(drawn.status).toBe(200);
      expect(drawn.body.data.entries).toHaveLength(3);

      // The wire speaks the DD names, carries the actor stamp (DM-8) and does
      // NOT publish the surrogate id: the key of a boundary row is its entity.
      const wire = drawn.body.data.entries.find(
        (row: { legal_entity_id: string }) =>
          row.legal_entity_id === flipped.id,
      );
      expect(wire).toEqual({
        legal_entity_id: flipped.id,
        status: "excluded",
        exclusion_reason: "sold in Q1",
        updated_by: userId,
        updated_at: expect.any(String),
      });

      // LC-10 — EXACTLY ONE audit row, with the actor's role and the reasons.
      const afterDraw = await boundaryAudit(companyId);
      expect(afterDraw).toHaveLength(1);
      expect(afterDraw[0].entityId).toBe(periodId);
      expect(afterDraw[0].action).toBe("create");
      expect(afterDraw[0].userId).toBe(userId);
      expect(afterDraw[0].actorRole).toBe("esg_admin");
      const drawSummary = summaryOf(afterDraw[0]);
      expect(drawSummary.added).toHaveLength(3);
      expect(
        drawSummary.added.find((row) => row.legal_entity_id === flipped.id)
          ?.exclusion_reason,
      ).toBe("sold in Q1");

      // THE REPLACEMENT. `dropped` is omitted → it LEAVES the boundary;
      // `flipped` comes back in; `kept` is re-sent unchanged.
      const before = await storedScope(periodId);
      const keptBefore = before.find((row) => row.legalEntityId === kept.id);
      const replaced = await putScope(periodId, [
        { legal_entity_id: kept.id, status: "included" },
        { legal_entity_id: flipped.id, status: "included" },
      ]);
      expect(replaced.status).toBe(200);

      const rows = await storedScope(periodId);
      expect(rows.map((row) => row.legalEntityId).sort()).toEqual(
        [kept.id, flipped.id].sort(),
      );
      // A row nobody edited is not rewritten — `updated_by`/`updated_at` keep
      // pointing at who last really changed it.
      expect(
        rows.find((row) => row.legalEntityId === kept.id)?.updatedAt,
      ).toEqual(keptBefore?.updatedAt);
      // Each entry is a WHOLE row, so a reason cannot outlive its exclusion.
      expect(
        rows.find((row) => row.legalEntityId === flipped.id)?.exclusionReason,
      ).toBeNull();

      const afterReplace = await boundaryAudit(companyId);
      expect(afterReplace).toHaveLength(2);
      const change = summaryOf(
        afterReplace.filter((row) => row.id !== afterDraw[0].id)[0],
      );
      expect(change.added).toEqual([]);
      expect(change.changed).toEqual([
        {
          legal_entity_id: flipped.id,
          from: { status: "excluded", exclusion_reason: "sold in Q1" },
          to: { status: "included", exclusion_reason: null },
        },
      ]);
      // A removal is NOT silent: the trail keeps the row it destroyed, with the
      // status and the stated reason it carried (D15).
      expect(change.removed).toEqual([
        {
          legal_entity_id: dropped.id,
          status: "not_assessed",
          exclusion_reason: null,
        },
      ]);
      expect({ entities: change.entities, included: change.included }).toEqual({
        entities: 2,
        included: 2,
      });

      // An IDENTICAL PUT changes nothing, so it writes no audit entry: a screen
      // that saves without edits must not fill the trail with non-events.
      expect(
        (
          await putScope(periodId, [
            { legal_entity_id: kept.id, status: "included" },
            { legal_entity_id: flipped.id, status: "included" },
          ])
        ).status,
      ).toBe(200);
      expect(await boundaryAudit(companyId)).toHaveLength(2);

      // `[]` is a legitimate boundary — the way back to the state a period is
      // created in — and it is audited like any other change.
      expect((await putScope(periodId, [])).status).toBe(200);
      expect(await storedScope(periodId)).toHaveLength(0);
      const cleared = await boundaryAudit(companyId);
      expect(cleared).toHaveLength(3);
      expect(summaryOf(cleared[2]).removed).toHaveLength(2);
    });

    it("VAL-101: an exclusion with no reason is refused, and NOTHING is written", async () => {
      const { companyId } = await actor("pro");
      const periodId = (await postPeriod()).body.data.id;
      const kept = await insertLegalEntity(companyId);
      const leaving = await insertLegalEntity(companyId);

      expect(
        (
          await putScope(periodId, [
            { legal_entity_id: kept.id, status: "included" },
          ])
        ).status,
      ).toBe(200);
      expect(await boundaryAudit(companyId)).toHaveLength(1);

      // A replacement that changes an existing row AND excludes a new entity
      // with no reason. The refusal names the rule…
      const refused = await putScope(periodId, [
        { legal_entity_id: kept.id, status: "not_applicable" },
        { legal_entity_id: leaving.id, status: "excluded" },
      ]);
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe("VALIDATION");
      expect(ruleCodes(refused.body)).toContain("VAL-101");

      // …and it is ATOMIC: the new row is absent, the row that WOULD have been
      // legal still says what it said, and no audit entry claims otherwise.
      const rows = await storedScope(periodId);
      expect(rows).toHaveLength(1);
      expect(rows[0].legalEntityId).toBe(kept.id);
      expect(rows[0].status).toBe("included");
      expect(await boundaryAudit(companyId)).toHaveLength(1);

      // A blank string is not a reason (it parses as NULL, VAL-101 reads it as
      // missing) — "Excluded, reason: (blank)" is a hole with a tick next to it.
      const blank = await putScope(periodId, [
        {
          legal_entity_id: kept.id,
          status: "excluded",
          exclusion_reason: "   ",
        },
      ]);
      expect(blank.status).toBe(422);
      expect(ruleCodes(blank.body)).toContain("VAL-101");
      expect((await storedScope(periodId))[0].status).toBe("included");

      // With a reason the same write is a 200, and the stored result of the
      // rule is a PASS against the boundary ROW (`object_type='period_scope'`).
      const stated = await putScope(periodId, [
        {
          legal_entity_id: kept.id,
          status: "excluded",
          exclusion_reason: "immaterial: 0.2% of revenue",
        },
      ]);
      expect(stated.status).toBe(200);
      const stored = (await storedScope(periodId))[0];
      expect(stored.exclusionReason).toBe("immaterial: 0.2% of revenue");
      const result = await storedResult(companyId, "VAL-101", stored.id);
      expect({
        passed: result.passed,
        objectType: result.objectType,
        blocking: result.blocking,
      }).toEqual({ passed: true, objectType: "period_scope", blocking: true });
      expect(await boundaryAudit(companyId)).toHaveLength(2);
    });

    it("an entity cannot be listed twice — refused by the API and by the UNIQUE key", async () => {
      const { companyId } = await actor("pro");
      const periodId = (await postPeriod()).body.data.id;
      const entity = await insertLegalEntity(companyId);

      // Two spellings of one entity's fate: a malformed request, not something
      // a server should pick a winner from. A FIELD (with the index), because
      // no VAL-* rule owns it.
      const twice = await putScope(periodId, [
        { legal_entity_id: entity.id, status: "included" },
        {
          legal_entity_id: entity.id,
          status: "excluded",
          exclusion_reason: "…",
        },
      ]);
      expect(twice.status).toBe(422);
      expect(twice.body.field).toBe("entries[1].legal_entity_id");
      expect(twice.body.rules).toBeUndefined();
      expect(await storedScope(periodId)).toHaveLength(0);

      // The other level, proved independently of the route: the fixture writes
      // straight to the table and the UNIQUE key — not the parser — refuses it.
      await insertPeriodScope(companyId, {
        periodId,
        legalEntityId: entity.id,
      });
      const err = await insertPeriodScope(companyId, {
        periodId,
        legalEntityId: entity.id,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      const wrapped = err as { cause?: { constraint_name?: string } };
      expect(wrapped?.cause?.constraint_name).toBe(
        "period_scope_period_entity_key",
      );
      expect(await storedScope(periodId)).toHaveLength(1);
    });

    it("VAL-106: the boundary freezes with its period once the revision leaves draft", async () => {
      const { companyId } = await actor("pro");
      const conn = getTestDb();
      const { period, scope } = await insertPeriod(companyId);
      const root = scope.legalEntityId;
      const other = await insertLegalEntity(companyId);

      // A DRAFT revision → the boundary is still editable.
      const revision = await insertRevision(companyId, { periodId: period.id });
      const drawn = [
        { legal_entity_id: root, status: "included" },
        {
          legal_entity_id: other.id,
          status: "excluded",
          exclusion_reason: "dormant",
        },
      ];
      expect((await putScope(period.id, drawn)).status).toBe(200);
      expect(await boundaryAudit(companyId)).toHaveLength(1);

      // SUBMITTED → frozen. The refusal names the rule, the rows do not move,
      // and the trail gains nothing.
      await conn
        .update(reportRevision)
        .set({ status: "submitted" })
        .where(eq(reportRevision.id, revision.id));
      const frozen = await putScope(period.id, [
        { legal_entity_id: root, status: "included" },
      ]);
      expect(frozen.status).toBe(422);
      expect(ruleCodes(frozen.body)).toContain("VAL-106");
      expect(await storedScope(period.id)).toHaveLength(2);
      expect(await boundaryAudit(companyId)).toHaveLength(1);

      // The WHOLE surface is frozen, so re-sending the boundary unchanged is
      // still an attempt to write it. (A period PATCH diffs its six fields
      // instead, because there the frozen ones share a form with labelling
      // ones; a boundary PUT is nothing but the frozen surface.)
      const resent = await putScope(period.id, drawn);
      expect(resent.status).toBe(422);
      expect(ruleCodes(resent.body)).toContain("VAL-106");

      // READING is never frozen — the boundary is a disclosure, and the people
      // who review a submitted report are exactly the ones who must see it.
      expect((await getScope(period.id)).body.data.entries).toHaveLength(2);

      // REJECTED → editable again (LC-2 maps it back to a draft for the API).
      await conn
        .update(reportRevision)
        .set({ status: "rejected" })
        .where(eq(reportRevision.id, revision.id));
      expect(
        (
          await putScope(period.id, [
            { legal_entity_id: root, status: "included" },
          ])
        ).status,
      ).toBe(200);
      expect(await storedScope(period.id)).toHaveLength(1);
      expect(await boundaryAudit(companyId)).toHaveLength(2);
    });

    it("never reaches another company's period, or its entities", async () => {
      const other = await insertCompany({ plan: "pro" });
      const { period: foreign, scope: foreignScope } = await insertPeriod(
        other.id,
      );

      const { companyId } = await actor("pro");
      const periodId = (await postPeriod()).body.data.id;

      // Another tenant's period: PUT is a bare VALIDATION, GET is a 404 — both
      // indistinguishable from "never existed" (API-1).
      const hijacked = await putScope(foreign.id, [
        {
          legal_entity_id: foreignScope.legalEntityId,
          status: "excluded",
          exclusion_reason: "not mine",
        },
      ]);
      expect(hijacked.status).toBe(422);
      expect(ruleCodes(hijacked.body)).toEqual([]);
      expect((await storedScope(foreign.id))[0].status).toBe("included");
      expect((await getScope(foreign.id)).status).toBe(404);

      // Another tenant's ENTITY inside MY period's boundary: the same bare
      // refusal, and not even the legal half of the payload is written.
      const mine = await insertLegalEntity(companyId);
      const mixed = await putScope(periodId, [
        { legal_entity_id: mine.id, status: "included" },
        { legal_entity_id: foreignScope.legalEntityId, status: "included" },
      ]);
      expect(mixed.status).toBe(422);
      expect(ruleCodes(mixed.body)).toEqual([]);
      expect(await storedScope(periodId)).toHaveLength(0);
      expect(await boundaryAudit(companyId)).toHaveLength(0);
    });

    it("reads with data.read and writes with company.manage", async () => {
      const company = await insertCompany({ plan: "pro" });
      const { user: contributor } = await insertUserWithProfile({
        companyId: company.id,
        role: "contributor", // data.write + data.read, no company.manage
      });
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const { period, scope } = await insertPeriod(company.id);

      getSessionMock.mockResolvedValue(await sessionFor(contributor.id));
      const denied = await putScope(period.id, [
        { legal_entity_id: scope.legalEntityId, status: "not_applicable" },
      ]);
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ ok: false, error: "FORBIDDEN" });
      expect(await boundaryAudit(company.id)).toHaveLength(0);

      // …but the same session READS it: the boundary is a disclosure, and
      // drawing it — not seeing it — is the organisational decision.
      const read = await getScope(period.id);
      expect(read.status).toBe(200);
      expect(read.body.data.entries).toHaveLength(1);

      // The admin's identical request goes through, which is what proves the
      // 403 came from the capability gate and not from the body.
      getSessionMock.mockResolvedValue(await sessionFor(admin.id));
      expect(
        (
          await putScope(period.id, [
            { legal_entity_id: scope.legalEntityId, status: "not_applicable" },
          ])
        ).status,
      ).toBe(200);
    });

    it("rejects malformed shapes as FIELDS, with no rule code", async () => {
      const { companyId } = await actor("pro");
      const periodId = (await postPeriod()).body.data.id;
      const entity = await insertLegalEntity(companyId);

      for (const [entries, field] of [
        [undefined, "entries"],
        ["all of them", "entries"],
        [[null], "entries[0]"],
        [[{ status: "included" }], "entries[0].legal_entity_id"],
        [
          [{ legal_entity_id: "not-a-uuid", status: "included" }],
          "entries[0].legal_entity_id",
        ],
        [[{ legal_entity_id: entity.id }], "entries[0].status"],
        [
          [{ legal_entity_id: entity.id, status: "Included" }],
          "entries[0].status",
        ],
        [
          [
            {
              legal_entity_id: entity.id,
              status: "included",
              exclusion_reason: 7,
            },
          ],
          "entries[0].exclusion_reason",
        ],
      ] as const) {
        const res = await putScope(periodId, entries);
        expect({ field: res.body.field, status: res.status }).toEqual({
          field,
          status: 422,
        });
        expect(res.body.rules).toBeUndefined();
      }

      // The body itself must be an object carrying `entries` — a bare array is
      // not the representation this resource speaks.
      const bare = await scopePUT(
        jsonRequest(`/api/periods/${periodId}/scope`, "PUT", []),
        ctxFor(periodId),
      );
      expect((await bare.json()).field).toBe("body");
      // …and a non-uuid period id never reaches Postgres as a literal.
      const badId = await putScope("not-a-uuid", []);
      expect(badId.body.field).toBe("id");
      expect(await storedScope(periodId)).toHaveLength(0);
    });

    it("answers the CORS preflight (§0.9)", () => {
      expect(
        scopeOPTIONS(request("/api/periods/x/scope", "OPTIONS")).status,
      ).toBeLessThan(300);
    });
  });
});
