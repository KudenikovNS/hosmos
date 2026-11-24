// =============================================================================
// [LOCAL-DB] T5.4 — THE CALCULATION RUN, ITS AGGREGATES AND ITS GATE.
//
// `scope1.test.ts` and `scope2.test.ts` prove the ARITHMETIC against hand
// figures and golden fixtures. Nothing here re-checks a multiplication. What
// needs a Postgres is everything the pure cores refused to own:
//
//   • §0.7/AC-6 — a run with a missing factor is stored, is `failed`, blocks the
//     approval, and produces NO ZERO ANYWHERE. The last clause is checked by
//     walking the whole response, not by naming the two fields we happen to
//     remember: a zero that leaks through a field nobody listed is exactly the
//     defect §0.7 is about.
//   • CALC-6's append-only — a second run is a second `run_id` and the first
//     run's rows are still there afterwards.
//   • CALC-6's invalidation — THE THREE SOURCES, ONE TEST EACH. Editing a row,
//     editing the period and redrawing the boundary each stale a green run, and
//     each is asserted on its own: the third is the one that ships broken,
//     because it is the only one that changes no figure a preparer can see.
//   • CALC-8/AC-1 — the per-entity partition adds up to the total within
//     VAL-034's tolerance, with two entities so the partition is a real one.
//   • FX — a currency with no rate produces a WARNING and withholds the
//     intensity. Never a silent 1.0.
//   • R-12 — `PENDING_EVALUATORS` is empty.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so this file is
// a green no-op in a DB-less CI.
// =============================================================================
import { and, eq, sql } from "drizzle-orm";
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

import { POST as calculatePOST } from "@/app/api/revisions/[id]/calculate/route";
import { GET as resultsGET } from "@/app/api/revisions/[id]/results/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertDq,
  insertEmissionActivity,
  insertEnergyActivity,
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
  calculation,
  fxRates,
  legalEntity,
  periodScope,
  reportRevision,
  reportingPeriod,
} from "@/server/db/schema";
import { transitionRevision } from "@/server/revisions/transition";
import { runValidation } from "@/server/validation/run";
import {
  EVALUATORS,
  PENDING_EVALUATORS,
  coverageProblems,
} from "@/server/validation/registry";
import { VALIDATION_RULES } from "@/server/validation/rules";

import { add, formatDecimal, parseDecimal, ZERO } from "../decimal";
import { VAL_034_TOLERANCE } from "../formula-version";
import { FAILED_NUMERIC } from "../run";

// ─── The manifest is empty (R-12) ────────────────────────────────────────────

describe("the evaluator manifest after T5.4 (R-12)", () => {
  it("implements the last three rules and empties the manifest", () => {
    for (const code of ["VAL-017", "VAL-034", "VAL-035"] as const) {
      expect(EVALUATORS[code]).toBeTypeOf("function");
    }
    // THE assertion of this task. Not "has three fewer entries" — EMPTY, which
    // is the state the whole mechanism was built to reach.
    expect(Object.keys(PENDING_EVALUATORS)).toEqual([]);
  });

  it("gives EVERY §6.2 rule an evaluator, with nothing left over", () => {
    // The other direction, and the one an auditor actually asks about: walk the
    // inventory rather than the registry, so a rule declared in T2.1 and never
    // implemented is caught even if nobody remembered to list it here.
    const missing = VALIDATION_RULES.filter(
      (rule) => EVALUATORS[rule.code] === undefined,
    ).map((rule) => rule.code);
    expect(missing).toEqual([]);
    expect(coverageProblems()).toEqual([]);
  });
});

// ─── Test-local helpers ──────────────────────────────────────────────────────

const jsonRequest = (path: string, method: "POST"): NextRequest =>
  new Request(`http://api.example.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: "{}",
  }) as NextRequest;

const getRequest = (path: string): NextRequest =>
  new Request(`http://api.example.com${path}`) as NextRequest;

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * The `detail` of a transition refusal, or `null` when it went through.
 *
 * `NOT_FOUND`/`FORBIDDEN` THROW rather than returning `null`: this suite is
 * about a precondition, and a test that quietly read "the revision does not
 * exist" as "the gate let it through" would pass for the wrong reason.
 */
function refusalOf(
  result: Awaited<ReturnType<typeof transitionRevision>>,
): Record<string, unknown> | null {
  if (result.ok) return null;
  if (result.error === "NOT_FOUND" || result.error === "FORBIDDEN") {
    throw new Error(`unexpected transition refusal: ${result.error}`);
  }
  return result.detail;
}

/**
 * Every number-ish leaf of a JSON value that reads as ZERO, with the path that
 * reached it.
 *
 * AC-6's "no zero appears anywhere" is a claim about the WHOLE payload, so the
 * probe walks the whole payload. It counts a numeric `0` and any `numeric`
 * string that parses to zero (`'0'`, `'0.000000'`, `'-0.00'`), because the wire
 * carries `numeric` as a string and `'0.000000'` is exactly the value §0.7
 * forbids a failed line from producing. Counts and array lengths are excluded by
 * name: `failed: 0` is a count of things, not a quantity of CO₂e.
 */
function zeroPaths(value: unknown, path = "$"): string[] {
  const COUNT_KEYS = new Set([
    "lines",
    "failed",
    "lineCount",
    "failedCount",
    "results",
    "blocking",
    "applicable_year",
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

describeIntegration("the calculation run [LOCAL-DB]", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  /** The session `getSession()` would resolve, installed on the mock. */
  async function actor(companyId: string) {
    const { user } = await insertUserWithProfile({
      companyId,
      role: "esg_admin",
    });
    const ctx = await resolveSessionContext(getTestDb(), user.id);
    const session = {
      userId: user.id,
      email: "u@example.com",
      name: "U",
      ...ctx,
    };
    getSessionMock.mockResolvedValue(session);
    if (!session.company) throw new Error("session has no company");
    return {
      userId: user.id,
      session: { ...session, company: session.company },
    };
  }

  /**
   * A company with one Slovenian entity, one site, a 2024 period and a draft
   * revision. `turnover` is set because CALC-8's intensity is one of the things
   * under test and a fixture with no denominator would prove nothing about it.
   */
  async function fixture() {
    const company = await insertCompany({ plan: "starter" });
    const signed = await actor(company.id);
    const entity = await insertLegalEntity(company.id, {
      country: "SI",
      reportingCurrency: "EUR",
      turnover: "1000000",
    });
    const site = await insertFacility(company.id, {
      legalEntityId: entity.id,
      country: "SI",
    });
    const { period } = await insertPeriod(company.id, {
      legalEntityId: entity.id,
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      reportingYear: 2024,
    });
    const revision = await insertRevision(company.id, { periodId: period.id });
    return { company, entity, site, period, revision, ...signed };
  }

  /** 1000 kWh_gross of approved natural gas — the identity conversion (CALC-3). */
  const gas = (
    companyId: string,
    revisionId: string,
    legalEntityId: string,
    overrides: Record<string, unknown> = {},
  ) =>
    insertEmissionActivity(companyId, {
      revisionId,
      legalEntityId,
      activityType: "natural_gas",
      activityValue: "1000",
      unit: "kWh_gross",
      yearMonth: "2024-03",
      state: "approved",
      ...overrides,
    });

  /** 1000 kWh of approved grid electricity, 40% renewable. */
  const power = (
    companyId: string,
    revisionId: string,
    legalEntityId: string,
    overrides: Record<string, unknown> = {},
  ) =>
    insertEnergyActivity(companyId, {
      revisionId,
      legalEntityId,
      energyType: "electricity",
      consumption: "1000",
      unit: "kWh",
      renewableShare: "40",
      yearMonth: "2024-03",
      state: "approved",
      supplier: null,
      ...overrides,
    });

  /** POST /api/revisions/:id/calculate. */
  async function calculate(revisionId: string) {
    const res = await calculatePOST(
      jsonRequest(`/api/revisions/${revisionId}/calculate`, "POST"),
      ctxFor(revisionId),
    );
    return { status: res.status, body: await res.json() };
  }

  /** GET /api/revisions/:id/results. */
  async function results(revisionId: string) {
    const res = await resultsGET(
      getRequest(`/api/revisions/${revisionId}/results`),
      ctxFor(revisionId),
    );
    return { status: res.status, body: await res.json() };
  }

  /** The stored `calculation` rows of a revision, oldest run first. */
  async function storedRows(revisionId: string) {
    return getTestDb()
      .select()
      .from(calculation)
      .where(eq(calculation.revisionId, revisionId))
      .orderBy(calculation.calculatedAt, calculation.activityRowId);
  }

  // ─── A green run ───────────────────────────────────────────────────────────

  describe("a green run (CALC-6, DM-29)", () => {
    it("stores one row per line with the factor snapshotted whole", async () => {
      const f = await fixture();
      await gas(f.company.id, f.revision.id, f.entity.id, {
        facilityId: f.site.id,
      });
      await power(f.company.id, f.revision.id, f.entity.id, {
        facilityId: f.site.id,
      });

      const res = await calculate(f.revision.id);
      expect(res.status).toBe(200);
      expect(res.body.data.run.status).toBe("ok");
      // One Scope-1 line + the TWO Scope-2 lines of dual reporting (К-20).
      expect(res.body.data.run.lineCount).toBe(3);
      expect(res.body.data.run.failedCount).toBe(0);

      const rows = await storedRows(f.revision.id);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.runId)).size).toBe(1);
      // Every row of one run carries the SAME `calculated_at` — the run is one
      // moment, and CALC-6 compares that moment against the inputs.
      expect(
        new Set(rows.map((row) => row.calculatedAt?.toISOString())).size,
      ).toBe(1);

      for (const row of rows) {
        const snapshot = row.factorSnapshot as Record<string, unknown>;
        expect(snapshot.resolved).toBe(true);
        // DM-29 names four things by hand: value, units, source, gwp_basis.
        expect(snapshot.factor_value).toBeTypeOf("string");
        expect(snapshot.input_unit).toBeTypeOf("string");
        expect(snapshot.output_unit).toBeTypeOf("string");
        expect(snapshot.source_name).toBeTypeOf("string");
        expect(snapshot).toHaveProperty("gwp_basis");
        expect(snapshot.factor_id).toBe(row.factorId);
        expect(snapshot.formula_version).toBe(row.formulaVersion);
        expect(row.calculationStatus).toBe("ok");
      }
    });

    it("computes the three figures CALC-8 names", async () => {
      const f = await fixture();
      await gas(f.company.id, f.revision.id, f.entity.id, {
        facilityId: f.site.id,
      });
      await power(f.company.id, f.revision.id, f.entity.id, {
        facilityId: f.site.id,
      });

      const { body } = await calculate(f.revision.id);
      const totals = body.data.aggregates.totals;
      // 1000 kWh_gross × 1 × 0.18290 (natural_gas, GLOBAL, 2024).
      expect(totals.scope1Co2e).toBe("182.900000");
      // 1000 kWh × 1 × 0.212 (grid, SI, 2024) — the location-based line.
      expect(totals.scope2LocationBasedCo2e).toBe("212.000000");
      // The market-based line prices the UNMATCHED 1 MWh by the same grid row
      // (no residual mix is seeded), so it agrees to the last decimal.
      expect(totals.scope2MarketBasedCo2e).toBe("212.000000");

      // Energy: 1 MWh, 40% of it renewable.
      expect(body.data.aggregates.energy.totalMwh).toBe("1.000000");
      expect(body.data.aggregates.energy.renewableMwh).toBe("0.400000");
      expect(body.data.aggregates.energy.nonRenewableMwh).toBe("0.600000");
    });

    it("converts turnover at the FX of the year the period ENDS", async () => {
      const f = await fixture();
      await getTestDb()
        .update(legalEntity)
        .set({ reportingCurrency: "GBP", turnover: "1000000" })
        .where(eq(legalEntity.id, f.entity.id));
      await gas(f.company.id, f.revision.id, f.entity.id);

      const { body } = await calculate(f.revision.id);
      const intensity = body.data.aggregates.intensity;
      // §9 CALC-8: the annual average of the END year (2024), never "today".
      expect(intensity.fxYear).toBe("2024");
      // 1 000 000 GBP × 1.18120 (2024) — not × 1.14970 (2023) and not × 1.
      expect(intensity.turnoverEur).toBe("1181200.00");
      expect(
        body.data.aggregates.warnings.map((w: { code: string }) => w.code),
      ).not.toContain("fx_rate_missing");
    });
  });

  // ─── AC-6 — a missing factor produces no zero anywhere ─────────────────────

  describe("a run with a missing factor (§0.7, AC-6)", () => {
    /** A revision whose only row is priced by nothing in the pinned set. */
    async function withMissingFactor() {
      const f = await fixture();
      const row = await gas(f.company.id, f.revision.id, f.entity.id, {
        // A fuel the seeded `legacy-v1` set has never heard of. The row is
        // otherwise perfectly valid, which is the point: nothing about it looks
        // wrong until the calculation cannot price it.
        activityType: "unobtainium_gas",
      });
      // DQ-4/AC-7's evidence hole would otherwise refuse the approval one
      // precondition EARLIER, and the test would prove nothing about the
      // calculation gate. Every fixture that approves carries an admissible
      // assumption for its rows, tier AND sentence (see `evidenceHoles`).
      await insertDq(f.company.id, {
        objectType: "emission_activity",
        objectId: row.id,
        qualityTier: "estimate",
        qualityComment: "supplier statement, not yet filed",
      });
      return { ...f, row };
    }

    it("is stored, is `failed`, and names the reason on the line", async () => {
      const f = await withMissingFactor();
      const res = await calculate(f.revision.id);

      expect(res.status).toBe(200); // The RUN happened; the DATA is the problem.
      expect(res.body.data.run.status).toBe("failed");
      expect(res.body.data.run.failedCount).toBe(1);
      expect(res.body.data.lines[0].calculationStatus).toBe(
        "failed_missing_factor",
      );

      const rows = await storedRows(f.revision.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].calculationStatus).toBe("failed_missing_factor");
      expect(rows[0].factorId).toBeNull();
      expect((rows[0].factorSnapshot as Record<string, unknown>).resolved).toBe(
        false,
      );
      expect((rows[0].factorSnapshot as Record<string, unknown>).reason).toBe(
        "failed_missing_factor",
      );
    });

    it("stores the NOT-NULL sentinel, and NOBODY can read it as a number", async () => {
      const f = await withMissingFactor();
      await calculate(f.revision.id);

      // The column is NOT NULL (DM-29) so SOMETHING is stored. What is stored
      // is `NaN`, and the two assertions below are the whole argument for it:
      // the constraint is satisfied, and the value cannot be summed.
      const [raw] = await getTestDb().execute<{
        co2e: string;
        is_nan: boolean;
        total: string | null;
      }>(sql`
        SELECT co2e_result::text AS co2e,
               co2e_result = 'NaN'::numeric AS is_nan,
               sum(co2e_result) OVER ()::text AS total
          FROM calculation
         WHERE revision_id = ${f.revision.id}`);
      expect(raw.co2e).toBe(FAILED_NUMERIC);
      expect(raw.is_nan).toBe(true);
      // A zero would have summed to a plausible total. NaN poisons the SUM,
      // which is the property that makes it safe where 0 is not.
      expect(raw.total).toBe("NaN");

      // And it never LEAVES as a number: the API reads it as `null`.
      const { body } = await results(f.revision.id);
      expect(body.data.lines[0].co2eResult).toBeNull();
      expect(body.data.lines[0].inputValue).toBe("1000");
    });

    it("blocks the approval, naming the calculation precondition (§5.1)", async () => {
      const f = await withMissingFactor();
      await calculate(f.revision.id);
      await getTestDb()
        .update(reportRevision)
        .set({ status: "in_review" })
        .where(eq(reportRevision.id, f.revision.id));

      expect(
        refusalOf(
          await transitionRevision(
            getTestDb(),
            f.session,
            f.revision.id,
            "approve",
            {},
          ),
        ),
      ).toMatchObject({
        precondition: "calculation_run_green",
        reason: "calculation_run_failed",
      });
    });

    it("produces NO ZERO ANYWHERE, in either payload (AC-6)", async () => {
      const f = await withMissingFactor();
      const run = await calculate(f.revision.id);
      const read = await results(f.revision.id);

      // The whole payload is walked. A zero anywhere — a total, a per-entity
      // subtotal, an intensity, an energy figure — is the substitution §0.7
      // forbids, wearing whichever field name happened to be free.
      expect(zeroPaths(run.body.data)).toEqual([]);
      expect(zeroPaths(read.body.data)).toEqual([]);

      // Positively: the figures are WITHHELD, not zeroed, and the aggregate
      // says why.
      const aggregates = run.body.data.aggregates;
      expect(aggregates.status).toBe("failed");
      expect(aggregates.totals.scope1Co2e).toBeNull();
      expect(aggregates.totals.scope2LocationBasedCo2e).toBeNull();
      expect(aggregates.energy.totalMwh).toBeNull();
      expect(aggregates.intensity.locationBasedIntensity).toBeNull();
      expect(aggregates.failedLines).toHaveLength(1);
    });
  });

  // ─── Append-only ───────────────────────────────────────────────────────────

  it("a second run gets a new `run_id` and leaves the first intact (CALC-6)", async () => {
    const f = await fixture();
    await gas(f.company.id, f.revision.id, f.entity.id);

    const first = await calculate(f.revision.id);
    const firstRows = await storedRows(f.revision.id);
    const second = await calculate(f.revision.id);

    expect(second.body.data.run.runId).not.toBe(first.body.data.run.runId);

    const allRows = await storedRows(f.revision.id);
    expect(allRows).toHaveLength(2 * firstRows.length);
    // The FIRST run's rows, by id, are still there and byte-identical: nothing
    // was updated in place and nothing was deleted.
    const survivors = allRows.filter(
      (row) => row.runId === first.body.data.run.runId,
    );
    expect(survivors.map((row) => row.id).sort()).toEqual(
      firstRows.map((row) => row.id).sort(),
    );
    expect(survivors.map((row) => row.co2eResult)).toEqual(
      firstRows.map((row) => row.co2eResult),
    );

    // And the READ shows the newest one (`GET …/results` is "the latest run").
    const { body } = await results(f.revision.id);
    expect(body.data.run.runId).toBe(second.body.data.run.runId);
  });

  // ─── CALC-6's invalidation, one source at a time ───────────────────────────

  describe("invalidation (CALC-6) — all three sources, separately", () => {
    /** A green run over one gas row, with the revision parked in `in_review`. */
    async function green() {
      const f = await fixture();
      const row = await gas(f.company.id, f.revision.id, f.entity.id);
      await insertDq(f.company.id, {
        objectType: "emission_activity",
        objectId: row.id,
        qualityTier: "estimate",
        qualityComment: "metered invoice, transcribed",
      });
      const run = await calculate(f.revision.id);
      expect(run.body.data.run.status).toBe("ok");
      await getTestDb()
        .update(reportRevision)
        .set({ status: "in_review" })
        .where(eq(reportRevision.id, f.revision.id));
      return { ...f, row, run: run.body.data.run };
    }

    /** Approve, and hand back the refusal detail (or `null` when it passed). */
    async function approve(f: Awaited<ReturnType<typeof green>>) {
      return refusalOf(
        await transitionRevision(
          getTestDb(),
          f.session,
          f.revision.id,
          "approve",
          {},
        ),
      );
    }

    it("a fresh run over untouched inputs is NOT stale", async () => {
      const f = await green();
      const { body } = await results(f.revision.id);
      expect(body.data.freshness.stale).toBe(false);
      expect(body.data.freshness.staleSources).toEqual([]);
      // The control for the three tests below: without it, "approve is refused"
      // would prove nothing about staleness — it might always be refused.
      expect(await approve(f)).toBeNull();
    });

    it("editing an input ROW stales it", async () => {
      const f = await green();
      // A new VERSION of the row, as §0.4's append-only edit produces — its
      // `created_at` is later than the run's `calculated_at`.
      const edited = await gas(f.company.id, f.revision.id, f.entity.id, {
        previousVersionId: f.row.id,
        activityValue: "2000",
      });
      await insertDq(f.company.id, {
        objectType: "emission_activity",
        objectId: edited.id,
        qualityTier: "estimate",
        qualityComment: "metered invoice, transcribed",
      });

      const { body } = await results(f.revision.id);
      expect(body.data.freshness.stale).toBe(true);
      expect(body.data.freshness.staleSources).toEqual(["rows"]);
      expect(await approve(f)).toMatchObject({
        precondition: "calculation_run_green",
        reason: "calculation_run_stale",
        sources: ["rows"],
      });
    });

    it("editing the PERIOD stales it", async () => {
      const f = await green();
      // No row moved and no figure a preparer can see changed — but the period
      // is what prices the factors (`applicable_year`, `asOf`) and pins the set.
      await getTestDb()
        .update(reportingPeriod)
        .set({ baseYear: 2019, updatedAt: new Date() })
        .where(eq(reportingPeriod.id, f.period.id));

      const { body } = await results(f.revision.id);
      expect(body.data.freshness.stale).toBe(true);
      expect(body.data.freshness.staleSources).toEqual(["period"]);
      expect(await approve(f)).toMatchObject({
        reason: "calculation_run_stale",
        sources: ["period"],
      });
    });

    it("redrawing the BOUNDARY stales it — the source that ships forgotten", async () => {
      const f = await green();
      // A SECOND entity joins the boundary. Not one row of the revision moved,
      // not one field of the period changed, and the report now covers a
      // different organisation than the run does.
      const sister = await insertLegalEntity(f.company.id, { country: "SI" });
      await insertPeriodScope(f.company.id, {
        periodId: f.period.id,
        legalEntityId: sister.id,
        status: "included",
      });

      const { body } = await results(f.revision.id);
      expect(body.data.freshness.stale).toBe(true);
      expect(body.data.freshness.staleSources).toEqual(["period_scope"]);
      expect(await approve(f)).toMatchObject({
        reason: "calculation_run_stale",
        sources: ["period_scope"],
      });
    });

    it("recalculating clears the staleness and the approval goes through", async () => {
      const f = await green();
      await getTestDb()
        .update(periodScope)
        .set({ status: "included", updatedAt: new Date() })
        .where(
          and(
            eq(periodScope.periodId, f.period.id),
            eq(periodScope.legalEntityId, f.entity.id),
          ),
        );
      expect(await approve(f)).toMatchObject({
        reason: "calculation_run_stale",
      });

      await calculate(f.revision.id);
      expect(await approve(f)).toBeNull();
    });

    it("a revision that was NEVER calculated cannot be approved", async () => {
      const f = await fixture();
      const row = await gas(f.company.id, f.revision.id, f.entity.id);
      await insertDq(f.company.id, {
        objectType: "emission_activity",
        objectId: row.id,
        qualityTier: "estimate",
        qualityComment: "metered invoice, transcribed",
      });
      await getTestDb()
        .update(reportRevision)
        .set({ status: "in_review" })
        .where(eq(reportRevision.id, f.revision.id));

      expect(
        refusalOf(
          await transitionRevision(
            getTestDb(),
            f.session,
            f.revision.id,
            "approve",
            {},
          ),
        ),
      ).toMatchObject({ reason: "calculation_run_missing" });
    });
  });

  // ─── AC-1 — the per-entity partition adds up ───────────────────────────────

  it("the per-entity aggregate agrees with the sum of the lines (AC-1, VAL-034)", async () => {
    const f = await fixture();
    // TWO entities in the boundary, so the partition is a real one: a single
    // entity would make "the sum of the buckets equals the total" true by
    // having one bucket.
    const sister = await insertLegalEntity(f.company.id, {
      country: "SI",
      reportingCurrency: "EUR",
      turnover: "250000",
    });
    await insertPeriodScope(f.company.id, {
      periodId: f.period.id,
      legalEntityId: sister.id,
      status: "included",
    });
    const sisterSite = await insertFacility(f.company.id, {
      legalEntityId: sister.id,
      country: "SI",
    });

    await gas(f.company.id, f.revision.id, f.entity.id, {
      facilityId: f.site.id,
    });
    await gas(f.company.id, f.revision.id, sister.id, {
      facilityId: sisterSite.id,
      activityValue: "2500",
    });
    await power(f.company.id, f.revision.id, sister.id, {
      facilityId: sisterSite.id,
      consumption: "7500",
    });

    const { body } = await calculate(f.revision.id);
    const aggregates = body.data.aggregates;
    expect(aggregates.status).toBe("ok");
    expect(aggregates.byLegalEntity).toHaveLength(2);

    // The claim itself, computed from the LINES rather than re-read from the
    // aggregate: the sum of the per-entity subtotals is the total, to within
    // VAL-034's 0.5%.
    for (const key of [
      "scope1Co2e",
      "scope2LocationBasedCo2e",
      "scope2MarketBasedCo2e",
    ] as const) {
      const fromLines = body.data.lines
        .filter((line: { scope: string; reportingBasis: string | null }) =>
          key === "scope1Co2e"
            ? line.scope === "scope1"
            : line.reportingBasis ===
              (key === "scope2LocationBasedCo2e"
                ? "location_based"
                : "market_based"),
        )
        .reduce(
          (
            sum: ReturnType<typeof parseDecimal>,
            line: { co2eResult: string },
          ) => add(sum, parseDecimal(line.co2eResult)),
          ZERO,
        );
      const fromEntities = aggregates.byLegalEntity.reduce(
        (
          sum: ReturnType<typeof parseDecimal>,
          entity: { totals: Record<string, string> },
        ) => add(sum, parseDecimal(entity.totals[key])),
        ZERO,
      );
      expect(formatDecimal(fromEntities, 6)).toBe(formatDecimal(fromLines, 6));
      expect(aggregates.totals[key]).toBe(formatDecimal(fromLines, 6));
    }

    // Both partitions reconcile, which is exactly what VAL-034 evaluates.
    expect(
      aggregates.reconciliation.every((e: { balanced: boolean }) => e.balanced),
    ).toBe(true);
    // The tolerance is the shared one, not a second literal in a test.
    expect(VAL_034_TOLERANCE).toBe(0.005);
  });

  // ─── FX — a missing rate is a warning, never a 1.0 ─────────────────────────

  it("a missing FX rate warns and withholds the intensity — never a silent 1.0", async () => {
    const f = await fixture();
    // RSD is a seeded currency whose rates this test removes for its duration —
    // the only way to reach the branch without inventing reference data that
    // would outlive the suite (`currencies`/`fx_rates` are NOT truncated).
    const saved = await getTestDb()
      .select()
      .from(fxRates)
      .where(eq(fxRates.currencyCode, "RSD"));
    try {
      await getTestDb().delete(fxRates).where(eq(fxRates.currencyCode, "RSD"));
      await getTestDb()
        .update(legalEntity)
        .set({ reportingCurrency: "RSD", turnover: "117000000" })
        .where(eq(legalEntity.id, f.entity.id));
      await gas(f.company.id, f.revision.id, f.entity.id);

      const { body } = await calculate(f.revision.id);
      const aggregates = body.data.aggregates;

      expect(aggregates.status).toBe("ok"); // The EMISSIONS are fine.
      expect(aggregates.totals.scope1Co2e).toBe("182.900000");
      // The warning names the currency and the year it was looked up for.
      expect(aggregates.warnings).toContainEqual({
        code: "fx_rate_missing",
        detail: {
          legal_entity_id: f.entity.id,
          currency: "RSD",
          year: "2024",
        },
      });
      // AND the figures that would have needed the rate are WITHHELD. If the
      // resolver had fallen back to 1.0, `turnoverEur` would read
      // "117000000.00" — a Serbian company reported as a €117M one — and the
      // intensity would be understated by two orders of magnitude.
      expect(aggregates.intensity.turnoverEur).toBeNull();
      expect(aggregates.intensity.locationBasedIntensity).toBeNull();
      expect(aggregates.intensity.marketBasedIntensity).toBeNull();
      // The tonnage itself is still published — it needs no currency at all.
      expect(aggregates.intensity.locationBasedTco2e).toBe("0.182900000");
    } finally {
      if (saved.length > 0) await getTestDb().insert(fxRates).values(saved);
    }
  });

  // ─── The boundary decides what is calculated ───────────────────────────────

  it("a row of an EXCLUDED entity is reported, not calculated (DM-8, D15)", async () => {
    const f = await fixture();
    const outsider = await insertLegalEntity(f.company.id, { country: "SI" });
    await insertPeriodScope(f.company.id, {
      periodId: f.period.id,
      legalEntityId: outsider.id,
      status: "excluded",
      exclusionReason: "sold in 2023",
    });
    await gas(f.company.id, f.revision.id, f.entity.id);
    const dropped = await gas(f.company.id, f.revision.id, outsider.id);

    const { body } = await calculate(f.revision.id);
    expect(body.data.run.lineCount).toBe(1);
    expect(body.data.excluded).toContainEqual({
      activityTable: "emission_activity",
      activityRowId: dropped.id,
      legalEntityId: outsider.id,
      reason: "outside_boundary",
    });
    // Silence would have looked exactly like a row that does not exist — which
    // is the difference between "the report omits a subsidiary" and "the
    // subsidiary is out of scope, and here is why".
    expect(body.data.aggregates.byLegalEntity).toHaveLength(1);
  });

  // ─── The three new evaluators, against real rows ───────────────────────────

  describe("VAL-017 / VAL-034 / VAL-035 over a stored run", () => {
    it("passes a clean run and files a finding per line", async () => {
      const f = await fixture();
      await gas(f.company.id, f.revision.id, f.entity.id);
      await power(f.company.id, f.revision.id, f.entity.id);
      await calculate(f.revision.id);

      const records = await runValidation(getTestDb(), {
        companyId: f.company.id,
        scope: "revision",
        targetId: f.revision.id,
      });
      const byCode = (code: string) =>
        records.filter((record) => record.ruleCode === code);

      expect(byCode("VAL-017")).toHaveLength(3); // one per calculation row
      expect(byCode("VAL-035")).toHaveLength(3);
      expect(byCode("VAL-034")).toHaveLength(1); // one per RUN
      for (const record of [
        ...byCode("VAL-017"),
        ...byCode("VAL-034"),
        ...byCode("VAL-035"),
      ]) {
        expect(record.passed).toBe(true);
      }
    });

    it("VAL-017 fails when biogenic carbon is moved onto the fossil line", async () => {
      const f = await fixture();
      await gas(f.company.id, f.revision.id, f.entity.id, {
        activityType: "wood_logs_biogenic",
        unit: "t",
        activityValue: "2",
        biogenicFlag: true,
      });
      await calculate(f.revision.id);

      const clean = (
        await runValidation(getTestDb(), {
          companyId: f.company.id,
          scope: "revision",
          targetId: f.revision.id,
        })
      ).filter((r) => r.ruleCode === "VAL-017");
      expect(clean).toHaveLength(1);
      expect(clean[0].passed).toBe(true);
      // The engine put it where VAL-017 wants it: nothing on the fossil line.
      const [row] = await storedRows(f.revision.id);
      expect(row.co2eResult).toBe("0.000000");
      expect(row.biogenicCo2Result).toBe("3676.000000");

      // Now move the kilograms onto the FOSSIL column by hand — the exact
      // failure §6.2 names, and the one an aggregate cannot see.
      await getTestDb()
        .update(calculation)
        .set({ co2eResult: "3676.000000", biogenicCo2Result: null })
        .where(eq(calculation.id, row.id));

      const dirty = (
        await runValidation(getTestDb(), {
          companyId: f.company.id,
          scope: "revision",
          targetId: f.revision.id,
        })
      ).filter((r) => r.ruleCode === "VAL-017");
      expect(dirty[0].passed).toBe(false);
      expect(dirty[0].blocking).toBe(true);
    });

    it("VAL-035 fails a line whose snapshot lost its source", async () => {
      const f = await fixture();
      await gas(f.company.id, f.revision.id, f.entity.id);
      await calculate(f.revision.id);
      const [row] = await storedRows(f.revision.id);

      // `factor_snapshot` is `jsonb NOT NULL`, so `{}` satisfies the COLUMN —
      // and is exactly the shape a bug produces. The rule reads the fields.
      await getTestDb()
        .update(calculation)
        .set({ factorSnapshot: {} })
        .where(eq(calculation.id, row.id));

      const records = (
        await runValidation(getTestDb(), {
          companyId: f.company.id,
          scope: "revision",
          targetId: f.revision.id,
        })
      ).filter((r) => r.ruleCode === "VAL-035");
      expect(records[0].passed).toBe(false);
    });

    it("VAL-034 fails when a line's attribution disappears", async () => {
      const f = await fixture();
      await gas(f.company.id, f.revision.id, f.entity.id);
      await calculate(f.revision.id);
      const [row] = await storedRows(f.revision.id);

      // Point the line at an activity row that does not exist: it is still in
      // the grand total and in no per-entity bucket, so the partitions stop
      // adding up. That is the accounting gap VAL-034 exists to catch.
      await getTestDb()
        .update(calculation)
        .set({ activityRowId: "00000000-0000-0000-0000-0000000000ff" })
        .where(eq(calculation.id, row.id));

      const records = (
        await runValidation(getTestDb(), {
          companyId: f.company.id,
          scope: "revision",
          targetId: f.revision.id,
        })
      ).filter((r) => r.ruleCode === "VAL-034");
      expect(records[0].passed).toBe(false);
    });
  });

  // ─── The read API ──────────────────────────────────────────────────────────

  describe("GET /api/revisions/[id]/results", () => {
    it("is 404 before the revision has ever been calculated", async () => {
      const f = await fixture();
      await gas(f.company.id, f.revision.id, f.entity.id);
      expect((await results(f.revision.id)).status).toBe(404);
    });

    it("recomputes the aggregate from the STORED lines", async () => {
      const f = await fixture();
      await gas(f.company.id, f.revision.id, f.entity.id);
      await power(f.company.id, f.revision.id, f.entity.id);

      const run = await calculate(f.revision.id);
      const read = await results(f.revision.id);
      expect(read.status).toBe(200);
      // The figure a preparer saw when they pressed Calculate and the figure
      // the report reads back are the SAME function over the same rows.
      expect(read.body.data.aggregates.totals).toEqual(
        run.body.data.aggregates.totals,
      );
      expect(read.body.data.aggregates.energy).toEqual(
        run.body.data.aggregates.energy,
      );
      expect(read.body.data.lines).toHaveLength(3);
    });

    it("is 404 for a revision of another tenant (API-1)", async () => {
      const f = await fixture();
      await gas(f.company.id, f.revision.id, f.entity.id);
      await calculate(f.revision.id);

      const stranger = await insertCompany();
      await actor(stranger.id);
      expect((await results(f.revision.id)).status).toBe(404);
      expect((await calculate(f.revision.id)).status).toBe(404);
    });
  });
});
