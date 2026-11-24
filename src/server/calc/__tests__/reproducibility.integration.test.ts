// =============================================================================
// [LOCAL-DB] T5.5 — A LOCKED REVISION REPRODUCES BYTE FOR BYTE (CALC-7, TEST-4,
// AC-8, AC-11).
//
// This file is a PROOF, not a feature test. Everything the append-only design of
// §0.4/§0.6 claims comes together in one scenario and either holds or does not:
//
//   • THE FLOW THAT REACHES `locked` IS THE PRODUCT'S. The rows, their DQ
//     assessments, their approvals and all four transitions (submit →
//     start_review → approve → lock) go through the ROUTES; only the
//     organisation and the period come from the T1.7 fixtures, as everywhere
//     else in this repo. A scenario that arrived at `locked` by an UPDATE would
//     prove nothing about the gates that make `locked` mean something — and the
//     gates are load-bearing here: `approve` refuses without a green run over
//     the current rows, and `lock` is what writes `frozen_scope` at all.
//   • TWO RUNS, THE SAME BYTES (AC-8). The comparison is the ORDERED SET of
//     `(activity_table, activity_row_id, scope, reporting_basis, co2e_result,
//     biogenic_co2_result, factor_snapshot)`, read back as Postgres wrote it
//     (`::text` of every column, so `numeric` scale and `jsonb` key order are
//     part of what is compared). Not a grand total: a matching total hides two
//     offsetting errors, and the failure mode this test exists to catch — a
//     factor resolved differently for two lines — moves two lines and no total.
//   • THE RUN READS THE SNAPSHOT, NOT THE LIVE TABLES (AC-11). Between two runs
//     of the LOCKED revision the boundary and the period are moved BY DIRECT
//     SQL — deliberately around the application, because the claim under test is
//     about what the CALCULATION reads, and a test that let the API refuse the
//     edit would only have proved that VAL-106 works (which `periods-revisions`
//     already proves). The live rows really move, `frozen_scope` really differs
//     from them afterwards, and the numbers do not budge.
//   • THE SNAPSHOT OUTLIVES THE FACTOR (DM-29) — AND THE PLAN'S WORDING IS ONE
//     LAYER OFF. T5.5 asks for "deleting a `factor_set` row the run used does
//     not change the result". The delete cannot happen at all:
//     `calculation.factor_id REFERENCES emission_factor(id)` carries no
//     `ON DELETE` clause, so Postgres refuses it (23503), and deleting the whole
//     set runs the cascade into the same wall. Both are asserted, because a
//     migration that later relaxed the FK to SET NULL — or to CASCADE — would
//     change what a locked report is made of, silently. The claim the criterion
//     was reaching for is then proved on the mutation the database DOES allow:
//     the factor is rewritten and the stored run does not move.
//   • SIX MUTATIONS, SIX REFUSALS, AND NOTHING WRITTEN (§0.6). A row, a DQ
//     assessment, an evidence link, the boundary, the period's fields and a
//     repeat approve are all attempted against the locked revision. Each is 422
//     with a named rule, and afterwards EVERY per-tenant table has the same
//     `count(*)` AND the same bytes as before — the second half matters because
//     a repeat `approve` that went through would UPDATE a row, not insert one,
//     and a count would never see it.
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

import { POST as emissionApprovePOST } from "@/app/api/activities/emission/[id]/approve/route";
import { PATCH as emissionPATCH } from "@/app/api/activities/emission/[id]/route";
import { POST as emissionPOST } from "@/app/api/activities/emission/route";
import { POST as energyApprovePOST } from "@/app/api/activities/energy/[id]/approve/route";
import { POST as energyPOST } from "@/app/api/activities/energy/route";
import { PUT as dqPUT } from "@/app/api/dq/[objectType]/[objectId]/route";
import { POST as linksPOST } from "@/app/api/evidence-links/route";
import { PATCH as periodPATCH } from "@/app/api/periods/[id]/route";
import { PUT as scopePUT } from "@/app/api/periods/[id]/scope/route";
import { POST as calculatePOST } from "@/app/api/revisions/[id]/calculate/route";
import { GET as resultsGET } from "@/app/api/revisions/[id]/results/route";
import { POST as transitionPOST } from "@/app/api/revisions/[id]/transition/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  APP_TABLES,
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertDocument,
  insertEmissionActivity,
  insertFacility,
  insertLegalEntity,
  insertPeriod,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupDocumentsDir,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  calculation,
  emissionFactor,
  legalEntity,
  periodScope,
  reportingPeriod,
  reportRevision,
} from "@/server/db/schema";
import type { FrozenScope } from "@/server/revisions/frozen";

// ─── Request plumbing (the shape every route suite in this repo uses) ────────

const request = (path: string): NextRequest =>
  new Request(`http://api.example.com${path}`) as NextRequest;

const jsonRequest = (
  path: string,
  method: "POST" | "PATCH" | "PUT",
  body?: unknown,
): NextRequest =>
  new Request(`http://api.example.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? { body: "{}" } : { body: JSON.stringify(body) }),
  }) as NextRequest;

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

const dqCtx = (objectType: string, objectId: string) => ({
  params: Promise.resolve({ objectType, objectId }),
});

/** `body` is left as the `any` `Response.json()` gives, as the S3/S4 suites do. */
const answer = async (res: Response) => ({
  status: res.status,
  body: await res.json(),
});

/** The `{code}` list of an API-1 refusal — `[]` when the payload names none. */
const codes = (body: { rules?: { code: string }[] }): string[] =>
  (body.rules ?? []).map((rule) => rule.code);

/**
 * The `SQLSTATE` of a rejected query, dug out of the `cause` chain.
 *
 * Drizzle wraps a driver error in one of its own (`Failed query: …`), so the
 * class of the failure — a foreign-key violation rather than, say, a typo — is
 * only readable one or two links down. A test that matched the MESSAGE would
 * pass on any rejection at all, which is precisely the mistake that would make
 * "the delete is refused" prove nothing.
 */
function pgErrorCode(error: unknown): string | undefined {
  for (let cursor = error; cursor instanceof Error; cursor = cursor.cause) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

// ─── What the proof compares ─────────────────────────────────────────────────

/**
 * THE SEVEN FIELDS CALC-7 NAMES, read back as Postgres stored them.
 *
 * `::text` everywhere on purpose. `co2e_result` is `numeric`, so `182.900000`
 * and `182.9` are the same NUMBER and different BYTES; a driver that normalised
 * the scale between two runs would be a real reproducibility defect and a
 * float comparison would never see it. `factor_snapshot` is `jsonb`, whose text
 * form Postgres normalises deterministically (keys sorted, whitespace fixed), so
 * comparing the text compares the whole snapshot object — every field of DM-29 —
 * rather than the handful a test author would have thought to list.
 *
 * ORDERED, and by the data rather than by the storage order: `activity_table`,
 * `activity_row_id`, then `reporting_basis` (which separates К-20's two Scope-2
 * lines over one energy row). `ctid`/insertion order would make the comparison
 * pass for the wrong reason — two runs writing the same rows in a different
 * order still reproduce the same report.
 */
const RESULT_TUPLE_SQL = sql`
  SELECT activity_table                       AS activity_table,
         activity_row_id::text                AS activity_row_id,
         scope                                AS scope,
         coalesce(reporting_basis, '∅')       AS reporting_basis,
         co2e_result::text                    AS co2e_result,
         coalesce(biogenic_co2_result::text, '∅') AS biogenic_co2_result,
         factor_snapshot::text                AS factor_snapshot`;

/**
 * The columns of `calculation` that are NOT part of CALC-7's tuple and are NOT
 * allowed to move either — everything except the three that IDENTIFY the run.
 *
 * `id`, `run_id` and `calculated_at` are excluded, and the exclusion is not a
 * convenience: CALC-6 requires a second run to be a second `run_id` with its own
 * rows and its own moment, so demanding those three be equal would make AC-8
 * unsatisfiable BY CONSTRUCTION. They are the identity of the RUN; the tuple
 * below plus the seven above are the identity of the RESULT. `company_id` and
 * `revision_id` are constant across the runs of one revision and are compared
 * here rather than assumed.
 */
const RESULT_REST_SQL = sql`
  SELECT company_id::text, revision_id::text, method_code, formula_version,
         input_value::text, input_unit, conversion_factor::text,
         factor_id::text, scope3_category, rounding_rule, calculation_status`;

/** One row of the compared set, as a single opaque string. */
type Tuple = Record<string, string | null>;

// ─── The suite ───────────────────────────────────────────────────────────────

setupDocumentsDir();

describeIntegration(
  "a locked revision reproduces byte for byte [LOCAL-DB]",
  () => {
    beforeAll(async () => {
      await setupSchema();
    });
    beforeEach(async () => {
      await resetAppTables();
    });
    afterAll(async () => {
      await closeTestDb();
    });

    // ─── Route callers ─────────────────────────────────────────────────────────

    const postEmission = (body: unknown) =>
      emissionPOST(jsonRequest("/api/activities/emission", "POST", body)).then(
        answer,
      );

    const approveEmission = (id: string) =>
      emissionApprovePOST(
        jsonRequest(`/api/activities/emission/${id}/approve`, "POST"),
        ctxFor(id),
      ).then(answer);

    const patchEmission = (id: string, body: unknown) =>
      emissionPATCH(
        jsonRequest(`/api/activities/emission/${id}`, "PATCH", body),
        ctxFor(id),
      ).then(answer);

    const postEnergy = (body: unknown) =>
      energyPOST(jsonRequest("/api/activities/energy", "POST", body)).then(
        answer,
      );

    const approveEnergy = (id: string) =>
      energyApprovePOST(
        jsonRequest(`/api/activities/energy/${id}/approve`, "POST"),
        ctxFor(id),
      ).then(answer);

    const putDq = (objectType: string, objectId: string, body: unknown) =>
      dqPUT(
        jsonRequest(`/api/dq/${objectType}/${objectId}`, "PUT", body),
        dqCtx(objectType, objectId),
      ).then(answer);

    const link = (body: unknown) =>
      linksPOST(jsonRequest("/api/evidence-links", "POST", body)).then(answer);

    const patchPeriod = (id: string, body: unknown) =>
      periodPATCH(
        jsonRequest(`/api/periods/${id}`, "PATCH", body),
        ctxFor(id),
      ).then(answer);

    const putScope = (id: string, body: unknown) =>
      scopePUT(
        jsonRequest(`/api/periods/${id}/scope`, "PUT", body),
        ctxFor(id),
      ).then(answer);

    const postTransition = (revisionId: string, action: string, extra = {}) =>
      transitionPOST(
        jsonRequest(`/api/revisions/${revisionId}/transition`, "POST", {
          action,
          ...extra,
        }),
        ctxFor(revisionId),
      ).then(answer);

    const calculate = (revisionId: string) =>
      calculatePOST(
        jsonRequest(`/api/revisions/${revisionId}/calculate`, "POST"),
        ctxFor(revisionId),
      ).then(answer);

    const results = (revisionId: string) =>
      resultsGET(
        request(`/api/revisions/${revisionId}/results`),
        ctxFor(revisionId),
      ).then(answer);

    // ─── Reading the stored run ────────────────────────────────────────────────

    /** CALC-7's seven fields for one `run_id`, as an ordered array of tuples. */
    async function resultTuples(runId: string): Promise<Tuple[]> {
      const rows = await getTestDb().execute<Tuple>(sql`
      ${RESULT_TUPLE_SQL}
        FROM calculation
       WHERE run_id = ${runId}
       ORDER BY activity_table, activity_row_id, coalesce(reporting_basis, '')`);
      return [...rows];
    }

    /** Everything else on the row except `id`, `run_id` and `calculated_at`. */
    async function resultRest(runId: string): Promise<Tuple[]> {
      const rows = await getTestDb().execute<Tuple>(sql`
      ${RESULT_REST_SQL}
        FROM calculation
       WHERE run_id = ${runId}
       ORDER BY activity_table, activity_row_id, coalesce(reporting_basis, '')`);
      return [...rows];
    }

    // ─── "Nothing was written" — every per-tenant table, counted and hashed ────

    /**
     * `count(*)` for EVERY per-tenant application table, plus the bytes of every
     * row in it.
     *
     * THE LIST IS `APP_TABLES`, and that is the argument for it. Choosing the
     * tables "the attempt could have touched" by hand is exactly how a refused
     * write that left an audit row, a `validation_result` or a new `calculation`
     * goes unnoticed — the obvious table is the one the author remembers. The
     * harness's list is checked MECHANICALLY (`harness-fixtures.integration`:
     * every schema table carrying a `company_id` must appear in it), so this probe
     * inherits that completeness instead of restating it.
     *
     * THE BYTES ARE HERE BECAUSE A COUNT CANNOT SEE AN UPDATE. A repeat `approve`
     * that went through would set `approved_by`/`approved_at` on a row that already
     * exists; `count(*)` would be identical and the report would have been
     * re-approved. `to_jsonb(t)` is the whole row, ordered by its own text so the
     * digest does not depend on physical order.
     */
    async function tenantState(): Promise<Record<string, string>> {
      const probes = APP_TABLES.map(
        (name) =>
          `SELECT '${name}' AS t,
                count(*)::int AS n,
                coalesce(md5(string_agg(j, E'\\n' ORDER BY j)), '') AS d
           FROM (SELECT to_jsonb(x)::text AS j FROM ${name} x) s`,
      ).join(" UNION ALL ");
      const rows = await getTestDb().execute<{
        t: string;
        n: number;
        d: string;
      }>(sql.raw(probes));
      return Object.fromEntries(
        [...rows].map((row) => [row.t, `${row.n}:${row.d}`]),
      );
    }

    /** Just the counts, which is what the acceptance criterion asks about. */
    const countsOf = (state: Record<string, string>): Record<string, string> =>
      Object.fromEntries(
        Object.entries(state).map(([table, value]) => [
          table,
          value.split(":")[0],
        ]),
      );

    // ─── The scenario ──────────────────────────────────────────────────────────

    interface Scenario {
      companyId: string;
      userId: string;
      entityId: string;
      facilityId: string;
      periodId: string;
      revisionId: string;
      gasRowId: string;
      powerRowId: string;
      /** The run made in `draft`, before the lock. */
      draftRunId: string;
    }

    /**
     * The whole flow, through the routes: enter → approve the rows → calculate →
     * submit → start review → approve → lock.
     *
     * `starter` because F1/PG-3 gates the LOCK on the facility limit and a `trial`
     * company would be refused with a 402 before any of this is reached. One
     * facility is well inside the limit, so the gate passes for the right reason.
     *
     * The DQ assessments are not decoration: DQ-4/AC-7 (VAL-041) refuses to approve
     * a revision holding a row with no evidence and no admissible assumption, so
     * every row carries a tier and a sentence. Without them the flow stops one step
     * before the thing under test.
     */
    async function scenario(): Promise<Scenario> {
      const company = await insertCompany({ plan: "starter" });
      const { user } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });
      const ctx = await resolveSessionContext(getTestDb(), user.id);
      getSessionMock.mockResolvedValue({
        userId: user.id,
        email: "u@example.com",
        name: "U",
        ...ctx,
      });

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
        createdBy: user.id,
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        reportingYear: 2024,
      });
      const revision = await insertRevision(company.id, {
        periodId: period.id,
        createdBy: user.id,
      });

      // ── Enter the data ─────────────────────────────────────────────────────
      const gas = await postEmission({
        revision_id: revision.id,
        legal_entity_id: entity.id,
        facility_id: site.id,
        activity_category: "stationary_combustion",
        source_name: "Boiler 1",
        activity_type: "natural_gas",
        activity_value: 1000,
        method: "fuel_based",
        unit: "kWh_gross",
        year_month: "2024-03",
      });
      expect(gas.status).toBe(200);

      const power = await postEnergy({
        revision_id: revision.id,
        legal_entity_id: entity.id,
        facility_id: site.id,
        energy_type: "electricity",
        supplier: "Elektro Ljubljana",
        consumption: 1000,
        unit: "kWh",
        renewable_share: 40,
        year_month: "2024-03",
      });
      expect(power.status).toBe(200);

      const gasRowId: string = gas.body.data.id;
      const powerRowId: string = power.body.data.id;

      // ── DQ-4/AC-7: an admissible assumption, tier AND sentence ─────────────
      for (const [type, id] of [
        ["emission_activity", gasRowId],
        ["purchased_energy_activity", powerRowId],
      ] as const) {
        const assessed = await putDq(type, id, {
          is_overridden: false,
          quality_tier: "estimate",
          quality_comment: "supplier statement, filed with the annual invoice",
        });
        expect(assessed.status).toBe(200);
      }

      // ── Approve the rows (LC-4 — a version, not a flag) ────────────────────
      expect((await approveEmission(gasRowId)).status).toBe(200);
      expect((await approveEnergy(powerRowId)).status).toBe(200);

      // ── Calculate, then walk the revision to `locked` ──────────────────────
      const draftRun = await calculate(revision.id);
      expect(draftRun.status).toBe(200);
      expect(draftRun.body.data.run.status).toBe("ok");

      for (const action of ["submit", "start_review", "approve", "lock"]) {
        const moved = await postTransition(revision.id, action);
        expect({
          action,
          status: moved.status,
          body: moved.body,
        }).toMatchObject({
          action,
          status: 200,
        });
      }

      const [stored] = await getTestDb()
        .select()
        .from(reportRevision)
        .where(eq(reportRevision.id, revision.id));
      expect(stored.status).toBe("locked");
      expect(stored.frozenScope).not.toBeNull();

      return {
        companyId: company.id,
        userId: user.id,
        entityId: entity.id,
        facilityId: site.id,
        periodId: period.id,
        revisionId: revision.id,
        gasRowId,
        powerRowId,
        draftRunId: draftRun.body.data.run.runId,
      };
    }

    // ─── AC-8 — two runs, the same bytes ───────────────────────────────────────

    describe("AC-8 — calculating a locked revision twice", () => {
      it("produces a byte-identical ordered set of result tuples", async () => {
        const s = await scenario();

        const first = await calculate(s.revisionId);
        const second = await calculate(s.revisionId);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(first.body.data.run.status).toBe("ok");
        // CALC-6: a second run is a SECOND run, not an amendment of the first.
        expect(second.body.data.run.runId).not.toBe(first.body.data.run.runId);

        const a = await resultTuples(first.body.data.run.runId);
        const b = await resultTuples(second.body.data.run.runId);

        // The fixture is a real one: three lines (one Scope 1, and К-20's two
        // Scope-2 bases over one energy row). A one-line set would make "the
        // ordered sets are equal" true for an uninteresting reason.
        expect(a).toHaveLength(3);
        expect(a.map((row) => `${row.scope}/${row.reporting_basis}`)).toEqual([
          "scope1/∅",
          "scope2/location_based",
          "scope2/market_based",
        ]);
        // Every snapshot is a RESOLVED one — a set of three unresolved lines would
        // also compare equal, and would prove nothing at all.
        for (const row of a) {
          expect(JSON.parse(row.factor_snapshot as string).resolved).toBe(true);
        }

        // THE ASSERTION. Whole tuples, in order, as strings.
        expect(b).toEqual(a);

        // …and every other column too, except the three that IDENTIFY the run.
        expect(await resultRest(second.body.data.run.runId)).toEqual(
          await resultRest(first.body.data.run.runId),
        );
      });

      it("reproduces the run that was made BEFORE the lock", async () => {
        const s = await scenario();
        const after = await calculate(s.revisionId);

        // Locking copies the period and the boundary into `frozen_scope`; if the
        // copy were not faithful, the first run AFTER the lock would differ from
        // the last one before it — and every later run would agree with each other
        // about the wrong number, which the test above could never see.
        expect(await resultTuples(after.body.data.run.runId)).toEqual(
          await resultTuples(s.draftRunId),
        );
      });

      it("keeps the earlier run's rows intact (CALC-6, append-only)", async () => {
        const s = await scenario();
        const before = await resultTuples(s.draftRunId);
        await calculate(s.revisionId);
        await calculate(s.revisionId);

        expect(await resultTuples(s.draftRunId)).toEqual(before);
        const [{ runs }] = [
          ...(await getTestDb().execute<{ runs: number }>(sql`
          SELECT count(DISTINCT run_id)::int AS runs
            FROM calculation WHERE revision_id = ${s.revisionId}`)),
        ];
        expect(runs).toBe(3);
      });
    });

    // ─── AC-11 — the run reads `frozen_scope`, not the live tables ─────────────

    describe("AC-11 — the boundary moved by direct SQL between two runs", () => {
      it("does not move the result", async () => {
        const s = await scenario();
        const db = getTestDb();

        const before = await calculate(s.revisionId);
        const beforeTuples = await resultTuples(before.body.data.run.runId);
        expect(before.body.data.aggregates.intensity.fxYear).toBe("2024");
        expect(before.body.data.aggregates.byLegalEntity).toHaveLength(1);

        // ── AROUND THE APPLICATION, ON PURPOSE ─────────────────────────────────
        // VAL-106 would refuse both of these through the API, and that refusal is
        // proved separately below. What is under test HERE is what the CALCULATION
        // reads, so the edit is made with SQL the application would never issue:
        // if the run consulted `period_scope`/`reporting_period` it would now see
        // an empty boundary, a stranger in it, and a 2023 period.
        const stranger = await insertLegalEntity(s.companyId, {
          country: "AT",
          reportingCurrency: "EUR",
          turnover: "9000000",
        });
        await db.execute(sql`
        UPDATE period_scope
           SET status = 'excluded',
               exclusion_reason = 'moved by hand, behind the application''s back',
               updated_at = now()
         WHERE period_id = ${s.periodId} AND legal_entity_id = ${s.entityId}`);
        await db.execute(sql`
        INSERT INTO period_scope (id, company_id, period_id, legal_entity_id, status, updated_by)
        VALUES (gen_random_uuid(), ${s.companyId}, ${s.periodId}, ${stranger.id},
                'included', ${s.userId})`);
        await db.execute(sql`
        UPDATE reporting_period
           SET start_date = '2023-01-01', end_date = '2023-12-31',
               base_year = 2019, updated_at = now()
         WHERE id = ${s.periodId}`);

        // The edit really happened — otherwise the assertion below would pass
        // because nothing moved rather than because the snapshot held.
        const live = await db
          .select({
            legalEntityId: periodScope.legalEntityId,
            status: periodScope.status,
          })
          .from(periodScope)
          .where(eq(periodScope.periodId, s.periodId));
        expect(
          live.find((row) => row.legalEntityId === s.entityId)?.status,
        ).toBe("excluded");
        expect(
          live.find((row) => row.legalEntityId === stranger.id)?.status,
        ).toBe("included");
        const [livePeriod] = await db
          .select()
          .from(reportingPeriod)
          .where(eq(reportingPeriod.id, s.periodId));
        expect(livePeriod.endDate).toBe("2023-12-31");

        // …and the snapshot the run is supposed to read now DISAGREES with it.
        const [locked] = await db
          .select()
          .from(reportRevision)
          .where(eq(reportRevision.id, s.revisionId));
        const frozen = locked.frozenScope as FrozenScope;
        expect(frozen.period.end_date).toBe("2024-12-31");
        expect(frozen.scope).toHaveLength(1);
        expect(frozen.scope[0]).toMatchObject({
          legal_entity_id: s.entityId,
          status: "included",
        });

        // ── THE ASSERTION (AC-8 + AC-11) ──────────────────────────────────────
        const after = await calculate(s.revisionId);
        expect(after.status).toBe(200);
        expect(await resultTuples(after.body.data.run.runId)).toEqual(
          beforeTuples,
        );

        // And the observables that would have moved with a live read: the FX year
        // is the frozen period's, the partition still has exactly the frozen
        // boundary's one entity, and the stranger contributes nothing.
        expect(after.body.data.aggregates.intensity.fxYear).toBe("2024");
        expect(after.body.data.aggregates.byLegalEntity).toHaveLength(1);
        expect(after.body.data.aggregates.byLegalEntity[0].legalEntityId).toBe(
          s.entityId,
        );
        // A read of the LIVE boundary would have dropped every row out of scope,
        // so a zero-line run is the shape the failure would have taken.
        expect(after.body.data.run.lineCount).toBe(3);
        expect(after.body.data.excluded).toEqual([]);

        // AND THE PERIOD AXIS HAS TEETH TOO, which is worth stating because it is
        // not obvious: the seeded set prices natural gas for BOTH years, so a run
        // that had taken the live 2023 period would have resolved 0.18316 instead
        // of 0.18290 and every Scope-1 figure would have moved. The assertion
        // below pins that counterfactual, so the AC-11 claim above cannot quietly
        // become "the two years happen to cost the same".
        const [alternative] = await db.execute<{ v: string }>(sql`
        SELECT factor_value::text AS v FROM emission_factor
         WHERE activity_type = 'natural_gas' AND geography = 'GLOBAL'
           AND applicable_year = 2023 AND input_unit = 'kWh_gross'`);
        expect(alternative.v).not.toBe(
          JSON.parse(beforeTuples[0].factor_snapshot as string).factor_value,
        );
        expect(
          JSON.parse(
            (await resultTuples(after.body.data.run.runId))[0]
              .factor_snapshot as string,
          ).applicable_year,
        ).toBe(2024);
      });

      it("reads the frozen boundary for `GET …/results` too", async () => {
        const s = await scenario();
        const run = await calculate(s.revisionId);
        const db = getTestDb();

        await db.execute(sql`
        UPDATE period_scope SET status = 'excluded',
               exclusion_reason = 'moved by hand', updated_at = now()
         WHERE period_id = ${s.periodId}`);

        const read = await results(s.revisionId);
        expect(read.status).toBe(200);
        expect(read.body.data.run.runId).toBe(run.body.data.run.runId);
        // The read path re-derives the aggregate from the stored lines, and it
        // resolves the boundary through the SAME `loadRunPeriod`. If it took the
        // live one, the per-entity partition of a locked report would empty out
        // the moment somebody edited next year's boundary.
        expect(read.body.data.aggregates.byLegalEntity).toHaveLength(1);
        expect(read.body.data.aggregates.totals).toEqual(
          run.body.data.aggregates.totals,
        );
      });
    });

    // ─── DM-29 — the snapshot outlives the factor ─────────────────────────────

    describe("the factor row the run used", () => {
      /** The `emission_factor` id every resolved line of `runId` points at. */
      async function factorIdsOf(runId: string): Promise<string[]> {
        const rows = await getTestDb()
          .select({ factorId: calculation.factorId })
          .from(calculation)
          .where(eq(calculation.runId, runId));
        return [
          ...new Set(
            rows
              .map((row) => row.factorId)
              .filter((id): id is string => id !== null),
          ),
        ];
      }

      it("cannot be DELETED while a run still points at it (lineage FK)", async () => {
        const s = await scenario();
        const run = await calculate(s.revisionId);
        const ids = await factorIdsOf(run.body.data.run.runId);
        expect(ids.length).toBeGreaterThan(0);
        const before = await resultTuples(run.body.data.run.runId);

        // `calculation.factor_id REFERENCES emission_factor(id)` with no ON DELETE
        // clause (0004 §4.19) — so the DELETE the acceptance criterion asks for is
        // refused by the DATABASE, one layer below the snapshot. That is a
        // STRONGER guarantee than "the result does not change", not a weaker one,
        // and it is asserted rather than assumed because a later migration that
        // added `ON DELETE SET NULL` (or, worse, CASCADE) would silently change
        // what a locked report is made of.
        const refusal = await getTestDb()
          .execute(sql`DELETE FROM emission_factor WHERE id = ${ids[0]}`)
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(pgErrorCode(refusal)).toBe("23503"); // foreign_key_violation

        // Deleting the whole SET reaches the same wall: `emission_factor` cascades
        // from `factor_set`, so the cascade runs into the same lineage FK.
        const setRefusal = await getTestDb()
          .execute(
            sql`DELETE FROM factor_set WHERE id = (
                SELECT factor_set_id FROM emission_factor WHERE id = ${ids[0]})`,
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(pgErrorCode(setRefusal)).toBe("23503");

        expect(await resultTuples(run.body.data.run.runId)).toEqual(before);
      });

      it("can be CHANGED, and the stored run does not move (DM-29)", async () => {
        const s = await scenario();
        const run = await calculate(s.revisionId);
        const ids = await factorIdsOf(run.body.data.run.runId);
        const before = await resultTuples(run.body.data.run.runId);
        const readBefore = await results(s.revisionId);

        // The realistic version of the same event: an administrator corrects the
        // factor tomorrow. Every FIGURE the locked report prints is re-derivable
        // from `factor_snapshot` alone, so nothing moves — and the snapshot still
        // carries the OLD value, which is what makes the report auditable.
        const [original] = await getTestDb()
          .select()
          .from(emissionFactor)
          .where(eq(emissionFactor.id, ids[0]));
        await getTestDb()
          .update(emissionFactor)
          .set({ factorValue: "99999", sourceName: "rewritten" })
          .where(eq(emissionFactor.id, ids[0]));

        try {
          expect(await resultTuples(run.body.data.run.runId)).toEqual(before);
          const readAfter = await results(s.revisionId);
          expect(readAfter.body.data.aggregates.totals).toEqual(
            readBefore.body.data.aggregates.totals,
          );
          const snapshots = before.map((row) =>
            JSON.parse(row.factor_snapshot as string),
          );
          expect(
            snapshots.some(
              (snapshot) => snapshot.factor_value === original.factorValue,
            ),
          ).toBe(true);
          expect(
            snapshots.every((snapshot) => snapshot.source_name !== "rewritten"),
          ).toBe(true);
        } finally {
          // `emission_factor` is REFERENCE data — `resetAppTables()` never
          // truncates it, so a mutation left behind would poison every later
          // suite in the same process.
          await getTestDb()
            .update(emissionFactor)
            .set({
              factorValue: original.factorValue,
              sourceName: original.sourceName,
            })
            .where(eq(emissionFactor.id, ids[0]));
        }
      });
    });

    // ─── §0.6 — six mutations, six refusals, nothing written ──────────────────

    describe("every mutation against the locked revision is refused", () => {
      it("answers 422 with a named rule and writes NOTHING, six times", async () => {
        const s = await scenario();
        await calculate(s.revisionId);

        // Created BEFORE the baseline: making the document is a legitimate write
        // (a file is not part of any report until it is linked), and the attempt
        // under test is the LINK.
        const doc = await insertDocument(s.companyId);

        /** The six §5.3 surfaces, with the rule each one is answerable to. */
        const attempts: {
          name: string;
          rule: string;
          run: () => Promise<{ status: number; body: unknown }>;
        }[] = [
          {
            name: "an input row",
            rule: "VAL-010",
            run: () => patchEmission(s.gasRowId, { activity_value: 9999 }),
          },
          {
            name: "a DQ assessment",
            rule: "VAL-010",
            run: () =>
              putDq("emission_activity", s.gasRowId, {
                is_overridden: true,
                quality_tier: "high_primary",
                override_reason: "reviewed after the fact",
              }),
          },
          {
            name: "an evidence link",
            rule: "VAL-010",
            run: () =>
              link({
                documentId: doc.id,
                objectType: "emission_activity",
                objectId: s.gasRowId,
              }),
          },
          {
            name: "the boundary",
            rule: "VAL-106",
            run: () =>
              putScope(s.periodId, {
                entries: [
                  {
                    legal_entity_id: s.entityId,
                    status: "excluded",
                    exclusion_reason: "second thoughts",
                  },
                ],
              }),
          },
          {
            name: "the period's calculation-bearing fields",
            rule: "VAL-106",
            run: () => patchPeriod(s.periodId, { start_date: "2024-02-01" }),
          },
          {
            name: "a repeat approve",
            rule: "VAL-010",
            run: () => postTransition(s.revisionId, "approve"),
          },
        ];

        const seen: { name: string; status: number; rules: string[] }[] = [];
        for (const attempt of attempts) {
          const before = await tenantState();
          const res = await attempt.run();
          const after = await tenantState();

          seen.push({
            name: attempt.name,
            status: res.status,
            rules: codes(res.body as { rules?: { code: string }[] }),
          });

          // The acceptance criterion, literally: `count(*)` over every affected
          // table, before and after. Compared as a WHOLE MAP so the diff names the
          // table that moved instead of failing on the one the author checked.
          expect({ attempt: attempt.name, counts: countsOf(after) }).toEqual({
            attempt: attempt.name,
            counts: countsOf(before),
          });
          // And the bytes, which is the half a count cannot do (see `tenantState`).
          expect({ attempt: attempt.name, state: after }).toEqual({
            attempt: attempt.name,
            state: before,
          });
        }

        // All six verdicts asserted at once, so a failure shows the whole table
        // and not just the first row that broke.
        expect(seen).toEqual(
          attempts.map((attempt) => ({
            name: attempt.name,
            status: 422,
            rules: [attempt.rule],
          })),
        );
      });

      it("and the probe that says so can SEE a write (its own control)", async () => {
        // Six "nothing changed" assertions are worth exactly as much as the probe
        // behind them. A `tenantState()` that returned a constant — a typo in the
        // table list, an aggregate that swallowed its rows — would make all six
        // pass while the report was being rewritten underneath. So the probe is
        // pointed at a write that IS allowed and must notice it, in both halves:
        // the count and the bytes.
        const s = await scenario();
        const before = await tenantState();

        const doc = await insertDocument(s.companyId);
        const afterInsert = await tenantState();
        expect(countsOf(afterInsert)).not.toEqual(countsOf(before));
        expect(afterInsert.document).not.toBe(before.document);

        // An in-place UPDATE moves no count — this is the half the acceptance
        // criterion's `count(*)` cannot do on its own.
        const counted = await tenantState();
        await getTestDb().execute(
          sql`UPDATE document SET file_name = 'renamed.pdf' WHERE id = ${doc.id}`,
        );
        const updated = await tenantState();
        expect(countsOf(updated)).toEqual(countsOf(counted));
        expect(updated.document).not.toBe(counted.document);
      });

      it("leaves the revision itself byte-for-byte unchanged", async () => {
        const s = await scenario();
        const db = getTestDb();
        const snapshot = async () =>
          (
            await db.execute<{ row: string }>(sql`
            SELECT to_jsonb(r)::text AS row FROM report_revision r
             WHERE id = ${s.revisionId}`)
          )[0].row;

        const before = await snapshot();
        // A repeat approve would UPDATE `approved_by`/`approved_at` in place; the
        // count-based check above cannot see that, and this is the assertion that
        // makes "no write" mean what it says for the one attempt that mutates
        // rather than inserts.
        const repeated = await postTransition(s.revisionId, "approve");
        expect(repeated.status).toBe(422);
        expect(repeated.body.transition).toMatchObject({
          from: "locked",
          allowed: [],
          reason: "transition_not_allowed",
        });
        expect(await snapshot()).toBe(before);
      });

      it("still refuses after a recalculation (the run is not a way in)", async () => {
        const s = await scenario();
        // Calculating a locked revision is allowed — it is a READ that appends its
        // own rows (CALC-6). It must not thaw anything: a preparer who can press
        // Calculate must not thereby be able to edit a published report.
        expect((await calculate(s.revisionId)).status).toBe(200);

        const edited = await patchEmission(s.gasRowId, { activity_value: 1 });
        expect(edited.status).toBe(422);
        expect(codes(edited.body)).toEqual(["VAL-010"]);

        const [row] = await getTestDb()
          .select()
          .from(reportRevision)
          .where(eq(reportRevision.id, s.revisionId));
        expect(row.status).toBe("locked");
      });
    });

    // ─── The control: the same edits DO move an open revision ─────────────────

    it("the control — an OPEN revision reads the live boundary", async () => {
      const s = await scenario();
      const db = getTestDb();

      // Everything above says "the numbers did not move". This is the test that
      // says they WOULD have: the identical SQL edit, against a revision that is
      // not locked, empties the run. Without it, a `loadRunPeriod` that returned a
      // constant would pass every assertion in this file.
      const open = await insertRevision(s.companyId, {
        periodId: s.periodId,
        revisionNo: 2,
        isCurrent: false,
        createdBy: s.userId,
      });
      await insertEmissionActivity(s.companyId, {
        revisionId: open.id,
        legalEntityId: s.entityId,
        facilityId: s.facilityId,
        activityType: "natural_gas",
        activityValue: "1000",
        unit: "kWh_gross",
        yearMonth: "2024-03",
        state: "approved",
        actorId: s.userId,
      });

      const beforeEdit = await calculate(open.id);
      expect(beforeEdit.body.data.run.lineCount).toBe(1);

      await db
        .update(periodScope)
        .set({ status: "excluded", exclusionReason: "moved by hand" })
        .where(
          and(
            eq(periodScope.periodId, s.periodId),
            eq(periodScope.legalEntityId, s.entityId),
          ),
        );

      const afterEdit = await calculate(open.id);
      expect(afterEdit.body.data.run.lineCount).toBe(0);
      expect(afterEdit.body.data.excluded).toHaveLength(1);
    });

    // ─── A sanity check on the fixture itself ────────────────────────────────

    it("the scenario really is a locked report of real figures", async () => {
      const s = await scenario();
      const run = await calculate(s.revisionId);
      const totals = run.body.data.aggregates.totals;

      // 1000 kWh_gross × 0.18290 (natural_gas, GLOBAL, 2024) — the same hand
      // figure `calc.integration` pins, so a change to the seeded factor set
      // breaks this file loudly instead of letting it compare two wrong numbers
      // to each other.
      expect(totals.scope1Co2e).toBe("182.900000");
      expect(totals.scope2LocationBasedCo2e).toBe("212.000000");
      expect(run.body.data.aggregates.status).toBe("ok");

      const [entity] = await getTestDb()
        .select()
        .from(legalEntity)
        .where(eq(legalEntity.id, s.entityId));
      expect(entity.turnover).toBe("1000000");
    });
  },
);
