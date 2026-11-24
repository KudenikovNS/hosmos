// [LOCAL-DB] T3.7 — `GET /api/dashboard` against a real Postgres via the T1.7
// harness. The route was rewritten from the wide tables onto the Phase-1 layer
// (О-6), and every property below is invisible without a database: they are all
// about what the JOIN of period × revision × four input tables × validation
// answers, not about the shape of a literal.
//
// WHAT THIS FILE PROVES:
//   • THE HUB IS AN ANSWER, NOT AN ERROR, IN EVERY EMPTY CASE. A company with
//     no period gets 200 and `period: null` — the state the screen renders a CTA
//     for. A period with no revision gets the period and zero counters. Neither
//     is a 404, because "you have not started yet" is not a failure.
//   • THE COUNTERS ARE THE INVENTORY'S. The same rows `GET /api/inventory`
//     lists are the rows counted here — asserted by running BOTH and comparing,
//     so a superseded version or a tombstone can never be counted on one screen
//     and hidden on the other (API-2, LC-6).
//   • THE COUNTERS ARE THE CURRENT REVISION'S. Rows under an older revision of
//     the same period are not counted: the hub is about the report being
//     written (LC-1a).
//   • `period_status` IS DERIVED (LC-2/К-4). It follows the CURRENT revision's
//     status; there is no column and this route adds no second mapping.
//   • VALIDATION IS REPORTED, NOT RE-RUN. Blocking failures and warnings are
//     counted off the stored `validation_result` rows, passed results included
//     in `results` so "clean" and "never checked" stay distinguishable.
//   • PATTERN 3. The company is the session's; a `?company=` parameter naming
//     another tenant changes nothing.
//
// AND THE KPI BLOCK (T5.9, UI-6), which is what the second half of this file is
// about:
//   • THE FIGURES ARE `GET /api/revisions/[id]/results`' OWN. Asserted by
//     calling BOTH endpoints on one fixture and comparing the aggregate objects
//     field by field — not by re-summing the lines here, which would only prove
//     that two implementations of the same sum agree today.
//   • WHICH REVISION, when several periods have an approved one, and when one
//     period has several.
//   • THE THREE STATES A RUN CAN LEAVE THE BLOCK IN — never calculated, failed,
//     stale — AND NOT ONE OF THEM PUBLISHES A ZERO. The failed case is walked
//     leaf by leaf, exactly as `calc.integration.test.ts` walks `/results`: a
//     zero that leaks through a field nobody listed is the defect §0.7 is about,
//     and a dashboard is where a person would believe it.
//   • A DRAFT'S RUN IS NOT PUBLISHED. A preparer's working total is not the
//     company's answer.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so this file is
// a green no-op in a DB-less CI.
import { eq } from "drizzle-orm";
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
  GET as dashboardGET,
  OPTIONS as dashboardOPTIONS,
} from "@/app/api/dashboard/route";
import { GET as inventoryGET } from "@/app/api/inventory/route";
import { POST as calculatePOST } from "@/app/api/revisions/[id]/calculate/route";
import { GET as resultsGET } from "@/app/api/revisions/[id]/results/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertDisclosure,
  insertEmissionActivity,
  insertEnergyActivity,
  insertFacility,
  insertInstrument,
  insertLegalEntity,
  insertPeriod,
  insertPeriodScope,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  emissionActivity,
  periodScope,
  reportRevision,
  validationResult,
} from "@/server/db/schema";
import type { DashboardDto } from "@/server/dashboard/dashboard";

/** A GET request the route handlers accept. */
const request = (path: string): NextRequest =>
  new Request(`http://api.example.com${path}`) as NextRequest;

/** A POST request `…/calculate` accepts. */
const postRequest = (path: string): NextRequest =>
  new Request(`http://api.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }) as NextRequest;

/** The `{ params }` a `[id]` route handler is called with. */
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

/** The session `getSession()` would resolve for a user (PATTERN 3 identity). */
async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

/** A company plus a signed-in `esg_admin`; installs the session. */
async function actor(): Promise<{ companyId: string; userId: string }> {
  const company = await insertCompany({ plan: "starter" });
  const { user } = await insertUserWithProfile({ companyId: company.id });
  getSessionMock.mockResolvedValue(await sessionFor(user.id));
  return { companyId: company.id, userId: user.id };
}

/** GET the hub. */
async function getDashboard(query = "") {
  const res = await dashboardGET(request(`/api/dashboard${query}`));
  return { status: res.status, body: await res.json() };
}

/** The hub's payload, or a failure if the route refused. */
async function dashboardData(query = ""): Promise<DashboardDto> {
  const { status, body } = await getDashboard(query);
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  return body.data as DashboardDto;
}

/** The cross-table listing of one revision — the counters' own subject. */
async function inventoryRows(revisionId: string) {
  const res = await inventoryGET(
    request(`/api/inventory?revision_id=${revisionId}`),
  );
  const body = await res.json();
  expect(body.ok).toBe(true);
  return body.data.inventory as { id: string; state: string }[];
}

/** One counter bucket of the hub. */
function scopeOf(data: DashboardDto, scope: string) {
  const entry = data.rows.by_scope.find((row) => row.scope === scope);
  if (!entry) throw new Error(`no bucket for ${scope}`);
  return entry;
}

/** Store one validation result against a revision (the write path of VR-3). */
async function storeResult(
  companyId: string,
  revisionId: string,
  values: {
    ruleCode: string;
    passed: boolean;
    severity: "error" | "warning";
    blocking: boolean;
  },
) {
  await getTestDb()
    .insert(validationResult)
    .values({
      companyId,
      revisionId,
      scope: "revision",
      message: "тестовое сообщение",
      ...values,
    });
}

/** POST `…/calculate` — the only way a `calculation` row is ever written. */
async function calculate(revisionId: string) {
  const res = await calculatePOST(
    postRequest(`/api/revisions/${revisionId}/calculate`),
    ctxFor(revisionId),
  );
  const body = await res.json();
  expect(res.status).toBe(200);
  return body.data as { run: { runId: string; status: string } };
}

/** GET `…/results` — the endpoint the KPI block's figures must agree with. */
async function results(revisionId: string) {
  const res = await resultsGET(
    request(`/api/revisions/${revisionId}/results`),
    ctxFor(revisionId),
  );
  return { status: res.status, body: await res.json() };
}

/**
 * Sign off a revision without going through `./transition`.
 *
 * The transition machinery has preconditions of its own (evidence, validation,
 * a green run) and every one of them is tested where it lives; dragging them in
 * here would make a test about WHICH REVISION THE DASHBOARD PICKS fail for
 * reasons that have nothing to do with the dashboard.
 */
async function publish(revisionId: string, status: "approved" | "locked") {
  await getTestDb()
    .update(reportRevision)
    .set({ status, approvedAt: new Date() })
    .where(eq(reportRevision.id, revisionId));
}

/**
 * Every number-ish leaf of a JSON value that reads as ZERO, with the path that
 * reached it — the same probe `calc.integration.test.ts` walks `/results` with,
 * because the claim is the same one: §0.7's substitution must not appear
 * ANYWHERE, not merely in the two fields a test remembers to name. Counts are
 * excluded by key: `failed_count: 0` is a number of things, not a quantity of
 * CO₂e.
 */
function zeroPaths(value: unknown, path = "$"): string[] {
  const COUNT_KEYS = new Set([
    "line_count",
    "failed_count",
    "legal_entities_included",
    "legal_entities_total",
    "facilities_included",
    "facilities_total",
    "revision_no",
  ]);
  if (value === null || value === undefined) return [];
  if (typeof value === "number") return value === 0 ? [path] : [];
  if (typeof value === "string") {
    return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value) && Number(value) === 0
      ? [path]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => zeroPaths(item, `${path}[${i}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, item]) =>
        COUNT_KEYS.has(key) && typeof item !== "object"
          ? []
          : zeroPaths(item, `${path}.${key}`),
    );
  }
  return [];
}

describeIntegration("T3.7 GET /api/dashboard — the revision-state hub", () => {
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

  // ─── Guards (§0.2, PATTERN 3) ──────────────────────────────────────────────

  it("refuses an anonymous request with 401 UNAUTHENTICATED", async () => {
    getSessionMock.mockResolvedValue(null);
    const { status, body } = await getDashboard();
    expect(status).toBe(401);
    expect(body).toEqual({ ok: false, error: "UNAUTHENTICATED" });
  });

  it("answers COMPANY_NOT_FOUND for a session without a company", async () => {
    const { user } = await insertUserWithProfile();
    getSessionMock.mockResolvedValue(await sessionFor(user.id));
    const { status, body } = await getDashboard();
    expect(status).toBe(404);
    expect(body).toEqual({ ok: false, error: "COMPANY_NOT_FOUND" });
  });

  it("CORS-tags the OPTIONS preflight (PATTERN 2)", async () => {
    const res = await dashboardOPTIONS(request("/api/dashboard"));
    expect(res.status).toBe(204);
  });

  // ─── The empty states — answers, not errors ────────────────────────────────

  it("a company with NO PERIOD gets 200 with `period: null` and zero counters", async () => {
    await actor();
    const data = await dashboardData();

    expect(data.period).toBeNull();
    expect(data.revision).toBeNull();
    expect(data.rows.total).toBe(0);
    expect(data.rows.by_scope.map((row) => row.scope)).toEqual([
      "scope1",
      "scope2",
      "disclosures",
    ]);
    expect(data.rows.by_scope.every((row) => row.total === 0)).toBe(true);
    expect(data.validation).toEqual({
      results: 0,
      blocking: 0,
      warnings: 0,
      blocking_codes: [],
    });
  });

  it("a period with NO REVISION carries the period and zero counters", async () => {
    const { companyId } = await actor();
    const { period } = await insertPeriod(companyId, {
      periodName: "FY2024",
    });

    const data = await dashboardData();
    expect(data.period?.id).toBe(period.id);
    expect(data.period?.period_name).toBe("FY2024");
    // LC-2 case 1 — no revisions at all reads as Draft.
    expect(data.period?.period_status).toBe("Draft");
    expect(data.revision).toBeNull();
    expect(data.rows.total).toBe(0);
    expect(data.validation.results).toBe(0);
  });

  // ─── Which period, which revision ──────────────────────────────────────────

  it("reports the NEWEST period, not the first one created", async () => {
    const { companyId } = await actor();
    const { period: newer } = await insertPeriod(companyId, {
      periodName: "FY2025",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      reportingYear: 2025,
    });
    await insertPeriod(companyId, {
      periodName: "FY2023",
      startDate: "2023-01-01",
      endDate: "2023-12-31",
      reportingYear: 2023,
    });

    const data = await dashboardData();
    expect(data.period?.id).toBe(newer.id);
  });

  it("reports the CURRENT revision of that period (LC-1a)", async () => {
    const { companyId } = await actor();
    const { period } = await insertPeriod(companyId);
    await insertRevision(companyId, {
      periodId: period.id,
      revisionNo: 1,
      status: "locked",
      isCurrent: false,
    });
    const current = await insertRevision(companyId, {
      periodId: period.id,
      revisionNo: 2,
      status: "draft",
      isCurrent: true,
    });

    const data = await dashboardData();
    expect(data.revision?.id).toBe(current.id);
    expect(data.revision?.revision_no).toBe(2);
    // LC-2's seventh case: a draft revision over a locked one is a restatement.
    expect(data.period?.period_status).toBe("Reopened");
  });

  it("`period_status` follows the current revision's status (LC-2/К-4)", async () => {
    const { companyId } = await actor();
    const { period } = await insertPeriod(companyId);
    await insertRevision(companyId, {
      periodId: period.id,
      status: "in_review",
    });

    const data = await dashboardData();
    expect(data.period?.period_status).toBe("In review");
    expect(data.revision?.status).toBe("in_review");
  });

  // ─── The counters ──────────────────────────────────────────────────────────

  it("counts rows by scope and by state across the four input tables", async () => {
    const { companyId } = await actor();
    const { period } = await insertPeriod(companyId);
    const revision = await insertRevision(companyId, { periodId: period.id });

    // Scope 1: two rows, one approved.
    await insertEmissionActivity(companyId, { revisionId: revision.id });
    await insertEmissionActivity(companyId, {
      revisionId: revision.id,
      state: "approved",
    });
    // Scope 2: consumption + the instrument that backs the market-based figure.
    await insertEnergyActivity(companyId, { revisionId: revision.id });
    await insertInstrument(companyId, {
      revisionId: revision.id,
      state: "approved",
    });
    // Disclosures: one narrative row.
    await insertDisclosure(companyId, { revisionId: revision.id });

    const data = await dashboardData();
    expect(data.rows.total).toBe(5);
    expect(data.rows.approved).toBe(2);
    expect(data.rows.draft).toBe(3);

    expect(scopeOf(data, "scope1")).toEqual({
      scope: "scope1",
      total: 2,
      approved: 1,
      draft: 1,
    });
    expect(scopeOf(data, "scope2")).toEqual({
      scope: "scope2",
      total: 2,
      approved: 1,
      draft: 1,
    });
    expect(scopeOf(data, "disclosures")).toEqual({
      scope: "disclosures",
      total: 1,
      approved: 0,
      draft: 1,
    });
  });

  it("counts exactly what `GET /api/inventory` lists — tombstones and superseded versions excluded", async () => {
    const { companyId } = await actor();
    const { period } = await insertPeriod(companyId);
    const revision = await insertRevision(companyId, { periodId: period.id });

    const live = await insertEmissionActivity(companyId, {
      revisionId: revision.id,
    });
    const newer = await insertEmissionActivity(companyId, {
      revisionId: revision.id,
    });
    // An OLD version: superseded by `newer` — history, not a row of the report.
    const old = await insertEmissionActivity(companyId, {
      revisionId: revision.id,
    });
    await getTestDb()
      .update(emissionActivity)
      .set({ supersededById: newer.id })
      .where(eq(emissionActivity.id, old.id));
    // A tombstone (LC-6) — a deletion, not a row of the report.
    await insertEmissionActivity(companyId, {
      revisionId: revision.id,
      isDeleted: true,
    });

    const data = await dashboardData();
    const listed = await inventoryRows(revision.id);

    expect(data.rows.total).toBe(listed.length);
    expect(data.rows.total).toBe(2);
    expect(listed.map((row) => row.id).sort()).toEqual(
      [live.id, newer.id].sort(),
    );
  });

  it("counts the CURRENT revision only, not every revision of the period", async () => {
    const { companyId } = await actor();
    const { period } = await insertPeriod(companyId);
    const older = await insertRevision(companyId, {
      periodId: period.id,
      revisionNo: 1,
      isCurrent: false,
      status: "locked",
    });
    const current = await insertRevision(companyId, {
      periodId: period.id,
      revisionNo: 2,
      isCurrent: true,
    });
    await insertEmissionActivity(companyId, { revisionId: older.id });
    await insertEmissionActivity(companyId, { revisionId: older.id });
    await insertEmissionActivity(companyId, { revisionId: current.id });

    const data = await dashboardData();
    expect(data.rows.total).toBe(1);
    expect(scopeOf(data, "scope1").total).toBe(1);
  });

  // ─── Validation (VR-3) ─────────────────────────────────────────────────────

  it("summarises the STORED results: blocking, warnings and the codes to explain", async () => {
    const { companyId } = await actor();
    const { period } = await insertPeriod(companyId);
    const revision = await insertRevision(companyId, { periodId: period.id });

    await storeResult(companyId, revision.id, {
      ruleCode: "VAL-101",
      passed: false,
      severity: "error",
      blocking: true,
    });
    await storeResult(companyId, revision.id, {
      ruleCode: "VAL-104",
      passed: false,
      severity: "error",
      blocking: true,
    });
    await storeResult(companyId, revision.id, {
      ruleCode: "VAL-020",
      passed: false,
      severity: "warning",
      blocking: false,
    });
    // A PASSED blocking rule is neither a blocker nor a warning — but it is a
    // result, which is how "clean" is told apart from "never checked".
    await storeResult(companyId, revision.id, {
      ruleCode: "VAL-008",
      passed: true,
      severity: "error",
      blocking: true,
    });

    const data = await dashboardData();
    expect(data.validation.results).toBe(4);
    expect(data.validation.blocking).toBe(2);
    expect(data.validation.warnings).toBe(1);
    expect(data.validation.blocking_codes).toEqual(["VAL-101", "VAL-104"]);
  });

  it("a revision that has never been evaluated reports zero results", async () => {
    const { companyId } = await actor();
    const { period } = await insertPeriod(companyId);
    await insertRevision(companyId, { periodId: period.id });

    const data = await dashboardData();
    expect(data.validation.results).toBe(0);
    expect(data.validation.blocking_codes).toEqual([]);
  });

  // ─── The KPI block (T5.9, UI-6) ────────────────────────────────────────────

  describe("the aggregates of the latest Approved/Locked run", () => {
    /** A Slovenian entity with a site and the turnover CALC-8 divides by. */
    async function org(companyId: string) {
      const entity = await insertLegalEntity(companyId, {
        country: "SI",
        reportingCurrency: "EUR",
        turnover: "1000000",
      });
      const site = await insertFacility(companyId, {
        legalEntityId: entity.id,
        country: "SI",
      });
      return { entity, site };
    }

    /** A period, a revision, and the two approved rows a run prices. */
    async function reportOf(
      companyId: string,
      entity: { id: string },
      site: { id: string },
      year: number,
    ) {
      const { period } = await insertPeriod(companyId, {
        legalEntityId: entity.id,
        periodName: `FY${year}`,
        startDate: `${year}-01-01`,
        endDate: `${year}-12-31`,
        reportingYear: year,
      });
      const revision = await insertRevision(companyId, {
        periodId: period.id,
      });
      await insertEmissionActivity(companyId, {
        revisionId: revision.id,
        legalEntityId: entity.id,
        facilityId: site.id,
        activityType: "natural_gas",
        activityValue: "1000",
        unit: "kWh_gross",
        yearMonth: `${year}-03`,
        state: "approved",
      });
      await insertEnergyActivity(companyId, {
        revisionId: revision.id,
        legalEntityId: entity.id,
        facilityId: site.id,
        energyType: "electricity",
        consumption: "1000",
        unit: "kWh",
        renewableShare: "40",
        yearMonth: `${year}-03`,
        state: "approved",
        supplier: null,
      });
      return { period, revision };
    }

    /** One company, one FY2024 report: calculated, then approved. */
    async function approvedReport() {
      const { companyId } = await actor();
      const { entity, site } = await org(companyId);
      const { period, revision } = await reportOf(
        companyId,
        entity,
        site,
        2024,
      );
      await calculate(revision.id);
      await publish(revision.id, "approved");
      return { companyId, entity, site, period, revision };
    }

    // ── Which revision ───────────────────────────────────────────────────────

    it("a company with NO approved revision gets `emissions: null` — never zeros", async () => {
      const { companyId } = await actor();
      const { entity, site } = await org(companyId);
      const { revision } = await reportOf(companyId, entity, site, 2024);
      // A DRAFT with a perfectly green run behind it. The figures exist; they
      // are a preparer's working total and are not the company's answer, so the
      // hub publishes nothing at all rather than a headline nobody signed.
      const run = await calculate(revision.id);
      expect(run.run.status).toBe("ok");

      const data = await dashboardData();
      expect(data.emissions).toBeNull();
      // And the payload carries no withheld-figure zero either.
      expect(zeroPaths(data.emissions)).toEqual([]);
    });

    it("picks the newest PERIOD's approved revision, not the newest approval", async () => {
      const { companyId } = await actor();
      const { entity, site } = await org(companyId);
      const recent = await reportOf(companyId, entity, site, 2025);
      const old = await reportOf(companyId, entity, site, 2022);
      await calculate(recent.revision.id);
      await calculate(old.revision.id);

      // FY2025 first, FY2022 SECOND — so the most recently approved report is
      // the OLDEST one. A dashboard headline answers "where are we now", so the
      // restatement of 2022 signed off this morning must not replace it.
      await publish(recent.revision.id, "approved");
      await publish(old.revision.id, "approved");

      const data = await dashboardData();
      expect(data.emissions?.period_id).toBe(recent.period.id);
      expect(data.emissions?.period_name).toBe("FY2025");
    });

    it("picks the highest revision inside one period (a restatement wins)", async () => {
      const { companyId } = await actor();
      const { entity, site } = await org(companyId);
      const { period, revision } = await reportOf(
        companyId,
        entity,
        site,
        2024,
      );
      await publish(revision.id, "locked");
      // LC-1a: currency MOVES to the restatement — exactly one revision of a
      // period is current, and the partial unique index enforces it.
      await getTestDb()
        .update(reportRevision)
        .set({ isCurrent: false })
        .where(eq(reportRevision.id, revision.id));
      // LC-9's restatement: revision 2 of the same period, itself approved.
      const restatement = await insertRevision(companyId, {
        periodId: period.id,
        revisionNo: 2,
        isCurrent: true,
        status: "approved",
      });

      const data = await dashboardData();
      expect(data.emissions?.revision_id).toBe(restatement.id);
      expect(data.emissions?.revision_no).toBe(2);
      expect(data.emissions?.status).toBe("approved");
    });

    it("finds last year's approved report from a period that has no revision yet", async () => {
      const { companyId } = await actor();
      const { entity, site } = await org(companyId);
      const last = await reportOf(companyId, entity, site, 2024);
      await calculate(last.revision.id);
      await publish(last.revision.id, "locked");
      // The company has opened FY2025 and not started it. The hub's own cards
      // are about that empty period; the KPI block is about FY2024, and a
      // `null` taken from the wrong branch would have hidden it.
      const { period: opened } = await insertPeriod(companyId, {
        legalEntityId: entity.id,
        periodName: "FY2025",
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        reportingYear: 2025,
      });

      const data = await dashboardData();
      expect(data.period?.id).toBe(opened.id);
      expect(data.revision).toBeNull();
      expect(data.emissions?.period_id).toBe(last.period.id);
      expect(data.emissions?.status).toBe("locked");
    });

    // ── The figures ──────────────────────────────────────────────────────────

    it("publishes EXACTLY what `GET …/results` publishes (AC-1)", async () => {
      const f = await approvedReport();
      const data = await dashboardData();
      const { status, body } = await results(f.revision.id);
      expect(status).toBe(200);

      const aggregates = body.data.aggregates;
      // FIELD BY FIELD, against the endpoint's own objects. Not a re-computed
      // expectation: the acceptance criterion is that the two AGREE, and a
      // second implementation of the sum written here could only ever prove
      // that two sums agree today.
      expect(data.emissions?.totals).toEqual(aggregates.totals);
      expect(data.emissions?.energy).toEqual(aggregates.energy);
      expect(data.emissions?.intensity).toEqual(aggregates.intensity);
      expect(data.emissions?.run?.run_id).toBe(body.data.run.runId);
      expect(data.emissions?.state).toBe("ok");

      // …and the comparison is not vacuously null == null.
      expect(data.emissions?.totals?.scope1Co2e).toBe("182.900000");
      expect(data.emissions?.totals?.scope2LocationBasedCo2e).toBe(
        "212.000000",
      );
      expect(data.emissions?.totals?.scope2MarketBasedCo2e).toBe("212.000000");
      expect(data.emissions?.energy?.totalMwh).toBe("1.000000");
      expect(data.emissions?.intensity?.locationBasedIntensity).not.toBeNull();
    });

    it("reports the boundary the figures cover, and it is the run's own", async () => {
      const { companyId } = await actor();
      const { entity, site } = await org(companyId);
      const { period, revision } = await reportOf(
        companyId,
        entity,
        site,
        2024,
      );
      // A second entity with a site of its own, EXCLUDED from this period.
      const other = await insertLegalEntity(companyId, { country: "SI" });
      await insertFacility(companyId, { legalEntityId: other.id });
      await insertPeriodScope(companyId, {
        periodId: period.id,
        legalEntityId: other.id,
        status: "excluded",
      });
      await calculate(revision.id);
      await publish(revision.id, "approved");

      const data = await dashboardData();
      expect(data.emissions?.coverage).toEqual({
        legal_entities_included: 1,
        legal_entities_total: 2,
        facilities_included: 1,
        facilities_total: 2,
      });

      // The same partition the aggregate divides the figures into — so the
      // sentence "1 of 2 entities" cannot disagree with the totals beside it.
      const { body } = await results(revision.id);
      expect(body.data.aggregates.byLegalEntity).toHaveLength(1);
      expect(
        body.data.aggregates.byFacility.filter(
          (entry: { facilityId: string | null }) => entry.facilityId !== null,
        ),
      ).toHaveLength(1);
    });

    // ── The three states a run can leave the block in ────────────────────────

    it("`no_run` — approved but never calculated, and no figure invented", async () => {
      const { companyId } = await actor();
      const { entity, site } = await org(companyId);
      const { revision } = await reportOf(companyId, entity, site, 2024);
      await publish(revision.id, "approved");

      const data = await dashboardData();
      expect(data.emissions?.state).toBe("no_run");
      expect(data.emissions?.run).toBeNull();
      expect(data.emissions?.totals).toBeNull();
      expect(data.emissions?.energy).toBeNull();
      expect(data.emissions?.intensity).toBeNull();
      // The boundary is still known, and it is still reported: it is what the
      // figures WOULD cover, and it needs no calculation.
      expect(data.emissions?.coverage.legal_entities_included).toBe(1);
      expect(zeroPaths(data.emissions)).toEqual([]);
    });

    it("`failed` — a line nobody could price publishes NO figure at all (§0.7)", async () => {
      const { companyId } = await actor();
      const { entity, site } = await org(companyId);
      const { period } = await insertPeriod(companyId, {
        legalEntityId: entity.id,
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        reportingYear: 2024,
      });
      const revision = await insertRevision(companyId, {
        periodId: period.id,
      });
      await insertEmissionActivity(companyId, {
        revisionId: revision.id,
        legalEntityId: entity.id,
        facilityId: site.id,
        // A fuel the pinned set has never heard of. Nothing about the row looks
        // wrong until the calculation cannot price it.
        activityType: "unobtainium_gas",
        activityValue: "1000",
        unit: "kWh_gross",
        yearMonth: "2024-03",
        state: "approved",
      });
      await calculate(revision.id);
      await publish(revision.id, "approved");

      const data = await dashboardData();
      expect(data.emissions?.state).toBe("failed");
      expect(data.emissions?.run?.failed_count).toBe(1);
      // Present, and empty. `aggregate.ts` publishes the OBJECTS with every
      // figure null rather than the sum of the lines that worked.
      expect(data.emissions?.totals?.scope1Co2e).toBeNull();
      expect(data.emissions?.totals?.scope2LocationBasedCo2e).toBeNull();
      expect(data.emissions?.energy?.totalMwh).toBeNull();
      expect(data.emissions?.intensity?.locationBasedIntensity).toBeNull();
      // THE assertion of this task, on the whole block: a zero anywhere — a
      // total, an energy figure, an intensity — is §0.7's substitution, and a
      // dashboard is where a person would believe it.
      expect(zeroPaths(data.emissions)).toEqual([]);
    });

    it("`stale` — the boundary moved after the run, and the figures say so", async () => {
      const f = await approvedReport();
      // CALC-6's third source, the one that changes no figure a preparer can
      // see: redrawing the boundary. The run is complete and its figures are
      // real; they just no longer describe the current scope.
      await getTestDb()
        .update(periodScope)
        .set({ updatedAt: new Date(Date.now() + 60_000) })
        .where(eq(periodScope.periodId, f.period.id));

      const data = await dashboardData();
      expect(data.emissions?.state).toBe("stale");
      expect(data.emissions?.stale_sources).toContain("period_scope");
      // SHOWN, not withheld: they are what somebody approved, and they are the
      // only totals the company has.
      expect(data.emissions?.totals?.scope1Co2e).toBe("182.900000");
    });

    it("a green run reports no staleness sources at all", async () => {
      await approvedReport();
      const data = await dashboardData();
      expect(data.emissions?.state).toBe("ok");
      expect(data.emissions?.stale_sources).toEqual([]);
    });

    // ── PATTERN 3 ────────────────────────────────────────────────────────────

    it("never reaches another tenant's approved report", async () => {
      const other = await insertCompany({ name: "Other" });
      const theirEntity = await insertLegalEntity(other.id, { country: "SI" });
      const theirSite = await insertFacility(other.id, {
        legalEntityId: theirEntity.id,
      });
      const theirs = await reportOf(other.id, theirEntity, theirSite, 2024);
      await publish(theirs.revision.id, "approved");

      // Now sign in as somebody else entirely, with nothing approved.
      const { companyId } = await actor();
      await insertPeriod(companyId, { periodName: "My FY2024" });

      const data = await dashboardData();
      expect(data.emissions).toBeNull();
    });
  });

  it("ignores a `?company=` parameter naming another tenant (PATTERN 3)", async () => {
    const other = await insertCompany({ name: "Other" });
    const { period: theirs } = await insertPeriod(other.id, {
      periodName: "Their FY2025",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      reportingYear: 2025,
    });
    const theirRevision = await insertRevision(other.id, {
      periodId: theirs.id,
    });
    await insertEmissionActivity(other.id, { revisionId: theirRevision.id });

    const { companyId } = await actor();
    const { period: mine } = await insertPeriod(companyId, {
      periodName: "My FY2024",
    });

    const data = await dashboardData(`?company=${other.id}`);
    expect(data.period?.id).toBe(mine.id);
    expect(data.period?.period_name).toBe("My FY2024");
    expect(data.rows.total).toBe(0);
  });
});
