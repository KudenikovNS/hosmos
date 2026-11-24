/**
 * [LOCAL-DB] T1.7 — the integration harness itself, under test.
 *
 * `harness.ts` is imported by 30-odd suites, so a defect in it does not fail
 * here: it fails somewhere else, intermittently, as a row that "should not be
 * there". Risk R-6 in one sentence. This suite is the place where the harness's
 * own invariants are stated positively, so that a future task extending it
 * breaks THIS file rather than someone else's.
 *
 * Four things are proved:
 *
 *   1. `APP_TABLES` IS COMPLETE — not "complete as far as the author remembered"
 *      but complete against `information_schema`: every table in the schema that
 *      carries a `company_id` column must be named in the list. That check is
 *      what makes the decision "enumerate, never lean on `TRUNCATE … CASCADE`"
 *      enforceable, and it keeps working when S2–S5 add tables.
 *   2. THE RESET REALLY EMPTIES THEM. Test one fills every Phase-1 tenant table,
 *      test two — after the `beforeEach` reset — finds each of them at zero and
 *      the four reference catalogues untouched. Two tests, deliberately, because
 *      "between two tests" is the only situation the isolation exists for.
 *   3. THE FIXTURES BUILD ROWS THE APPLICATION WOULD ACCEPT: the tenant key, the
 *      actor and the revision are filled, a period is pinned to the seeded
 *      `legacy-v1` factor set and comes with its boundary row, and a revision is
 *      the single current one of its period.
 *   4. `setupDocumentsDir()` ISOLATES THE FILESYSTEM: one temporary root per
 *      suite under `os.tmpdir()`, invisible to the next suite, removed
 *      afterwards, and the previous value of `DOCUMENTS_DIR` restored — whether
 *      it was set or unset.
 *
 * The filesystem half needs no database and sits outside `describeIntegration`.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LEGACY_FACTOR_SET } from "../seed-data/factor-set-v1";
import * as schema from "../schema";
import {
  APP_TABLES,
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertAsset,
  insertCompany,
  insertDisclosure,
  insertDocument,
  insertDq,
  insertEmissionActivity,
  insertEnergyActivity,
  insertEvidenceLink,
  insertFacility,
  insertInstrument,
  insertLegalEntity,
  insertPeriod,
  insertRevision,
  resetAppTables,
  setupDocumentsDir,
  setupSchema,
} from "./harness";

/**
 * The 16 per-tenant tables of the Phase-1 model (spec §4), written out by hand
 * rather than derived from `APP_TABLES` — a list compared against itself proves
 * nothing. The four reference catalogues are NOT here: they must survive.
 */
const PHASE1_TENANT_TABLES = [
  "legal_entity",
  "facility",
  "asset",
  "reporting_period",
  "period_scope",
  "report_revision",
  "emission_activity",
  "purchased_energy_activity",
  "contractual_instrument",
  "disclosure_record",
  "document",
  "evidence_link",
  "dq_assessment",
  "validation_result",
  "calculation",
  "report_render",
] as const;

/**
 * Seeded reference data — `setupSchema()` fills it, nothing may empty it.
 *
 * A LOWER BOUND, not an equality, for everything except the catalogue. Reference
 * tables are never truncated, which is the whole point, but it also means the
 * rows another suite deliberately leaves behind stay visible: `schema-0004`
 * proves the `COALESCE(activity_context,'--')` unique index by inserting two
 * throwaway `unit_conversion` rows, and `factor-set-v1` does the same with a
 * scratch factor set. Pinning `= 38` here would turn "the harness kept the
 * catalogues" into "no other suite ever writes reference data", and the failure
 * would land on this file for something it does not own.
 *
 * `metric_catalog` IS pinned exactly — 141 VSME rows (the T1.7 acceptance
 * criterion) plus the 50 simplified-ESRS rows 0019 added — and it holds because
 * `metric_key` is a business primary key: a test cannot add a row by accident,
 * only by inventing one.
 */
const METRIC_CATALOGUE_ROWS = 141 + 50; // T1.4 VSME + 0019 simplified ESRS
const REFERENCE_ROW_MINIMA = {
  emission_factor: 440, // T1.5, factor set `legacy-v1`
  unit_conversion: 38, // T1.5
  factor_set: 1,
} as const;

async function countRows(table: string): Promise<number> {
  const conn = getTestDb();
  const [{ n }] = await conn.execute<{ n: number }>(
    sql.raw(`SELECT count(*)::int AS n FROM ${table}`),
  );
  return n;
}

describeIntegration("harness — APP_TABLES and the Phase-1 fixtures", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  // ─── 1. Completeness of APP_TABLES ─────────────────────────────────────────

  it("names every table that carries a company_id", async () => {
    const conn = getTestDb();
    const rows = await conn.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'company_id'
      ORDER BY table_name
    `);
    const tenantTables = rows.map((r) => r.table_name);
    // The list quotes `"user"` (reserved word); compare on bare names.
    const listed = new Set(APP_TABLES.map((t) => t.replaceAll('"', "")));

    const missing = tenantTables.filter((t) => !listed.has(t));
    expect(missing).toEqual([]);
    // Sanity: the query found something. A typo in `column_name` would make the
    // assertion above pass vacuously.
    expect(tenantTables.length).toBeGreaterThanOrEqual(
      PHASE1_TENANT_TABLES.length,
    );
    for (const table of PHASE1_TENANT_TABLES)
      expect(listed.has(table)).toBe(true);
    // Identity tables have no company_id but are per-test state all the same.
    for (const table of [
      "companies",
      "user",
      "session",
      "account",
      "profiles",
    ]) {
      expect(listed.has(table)).toBe(true);
    }
  });

  // ─── 2. Fill everything, then prove the reset empties it ────────────────────

  it("fills every Phase-1 tenant table through the fixtures", async () => {
    const company = await insertCompany();
    const conn = getTestDb();

    const entity = await insertLegalEntity(company.id);
    await insertFacility(company.id, { legalEntityId: entity.id });
    await insertAsset(company.id, { legalEntityId: entity.id });
    const { period } = await insertPeriod(company.id, {
      legalEntityId: entity.id,
    });
    const revision = await insertRevision(company.id, { periodId: period.id });

    const links = { revisionId: revision.id, legalEntityId: entity.id };
    const activity = await insertEmissionActivity(company.id, links);
    await insertEnergyActivity(company.id, links);
    await insertInstrument(company.id, links);
    await insertDisclosure(company.id, links);

    const document = await insertDocument(company.id);
    await insertEvidenceLink(company.id, {
      documentId: document.id,
      linkedObjectType: "emission_activity",
      linkedObjectId: activity.id,
    });
    await insertDq(company.id, {
      objectType: "emission_activity",
      objectId: activity.id,
    });

    // The three tables with no fixture of their own (they are written by the
    // engines of S2/S5, not by a test author): inserted directly, so that the
    // reset is proved over all 16 and not merely over the 13 with a factory.
    await conn.insert(schema.validationResult).values({
      companyId: company.id,
      ruleCode: "VAL-001",
      scope: "revision",
      revisionId: revision.id,
      passed: true,
      severity: "error",
      blocking: true,
      message: "ok",
    });
    const runId = crypto.randomUUID();
    await conn.insert(schema.calculation).values({
      companyId: company.id,
      revisionId: revision.id,
      runId,
      activityTable: "emission_activity",
      activityRowId: activity.id,
      methodCode: "fuel_based",
      formulaVersion: "v1",
      inputValue: "1000",
      inputUnit: "kWh",
      factorSnapshot: {},
      scope: "scope1",
      co2eResult: "184",
      roundingRule: "half_up",
      calculationStatus: "ok",
    });
    await conn.insert(schema.reportRender).values({
      companyId: company.id,
      revisionId: revision.id,
      format: "pdf",
      language: "en",
      storageKey: `${company.id}/render`,
      fileHash: "0".repeat(64),
      coverageClaim: "full",
      disclaimerText: "-",
      calcRunId: runId,
      renderedBy: revision.createdBy,
    });

    for (const table of PHASE1_TENANT_TABLES) {
      expect({ table, n: await countRows(table) }).toEqual({ table, n: 1 });
    }
  });

  it("empties all of them between tests, leaving the catalogues seeded", async () => {
    // No setup: the `beforeEach` reset is the only thing that ran since the
    // test above filled every table.
    for (const table of PHASE1_TENANT_TABLES) {
      expect({ table, n: await countRows(table) }).toEqual({ table, n: 0 });
    }
    expect({
      table: "metric_catalog",
      n: await countRows("metric_catalog"),
    }).toEqual({ table: "metric_catalog", n: METRIC_CATALOGUE_ROWS });
    for (const [table, minimum] of Object.entries(REFERENCE_ROW_MINIMA)) {
      const n = await countRows(table);
      // Object-wrapped so a failure names the table instead of two bare numbers.
      expect({ table, seeded: n >= minimum }).toEqual({ table, seeded: true });
    }
  });

  // ─── 3. The fixtures build rows the application would accept ───────────────

  it("insertPeriod creates exactly one period, pinned to the seeded legacy-v1", async () => {
    const company = await insertCompany();
    const { period, scope } = await insertPeriod(company.id);

    expect(await countRows("reporting_period")).toBe(1);
    expect(period.factorSetId).toBe(LEGACY_FACTOR_SET.id);
    expect(LEGACY_FACTOR_SET.code).toBe("legacy-v1");

    const conn = getTestDb();
    const [set] = await conn
      .select({ code: schema.factorSet.code, status: schema.factorSet.status })
      .from(schema.factorSet)
      .where(eq(schema.factorSet.id, period.factorSetId));
    expect(set).toEqual({ code: "legacy-v1", status: "active" });

    // …and its boundary row, for the root legal entity (DM-8).
    expect(await countRows("period_scope")).toBe(1);
    expect(scope.periodId).toBe(period.id);
    expect(scope.status).toBe("included");
    expect(scope.companyId).toBe(company.id);
    const [entity] = await conn
      .select({ companyId: schema.legalEntity.companyId })
      .from(schema.legalEntity)
      .where(eq(schema.legalEntity.id, scope.legalEntityId));
    expect(entity.companyId).toBe(company.id);
  });

  it("insertRevision leaves exactly one current revision per period", async () => {
    const company = await insertCompany();
    const { period } = await insertPeriod(company.id);
    const revision = await insertRevision(company.id, { periodId: period.id });

    expect(revision.isCurrent).toBe(true);
    expect(revision.revisionNo).toBe(1);
    expect(revision.status).toBe("draft");
    expect(revision.createdBy).toBeTruthy();

    const conn = getTestDb();
    const current = await conn
      .select({ id: schema.reportRevision.id })
      .from(schema.reportRevision)
      .where(
        and(
          eq(schema.reportRevision.periodId, period.id),
          eq(schema.reportRevision.isCurrent, true),
        ),
      );
    expect(current).toEqual([{ id: revision.id }]);

    // A superseded revision is fine; a SECOND current one is not — the partial
    // unique index is what the state machine of S2 relies on.
    await insertRevision(company.id, {
      periodId: period.id,
      revisionNo: 2,
      isCurrent: false,
    });
    expect(await countRows("report_revision")).toBe(2);
    await expect(
      insertRevision(company.id, {
        periodId: period.id,
        revisionNo: 3,
        isCurrent: true,
      }),
    ).rejects.toThrow();
  });

  it("stamps company, actor and revision on every input row", async () => {
    const company = await insertCompany();
    const rows = [
      await insertEmissionActivity(company.id),
      await insertEnergyActivity(company.id),
      await insertInstrument(company.id),
      await insertDisclosure(company.id),
    ];
    const conn = getTestDb();

    for (const row of rows) {
      expect(row.companyId).toBe(company.id);
      expect(row.actorId).toBeTruthy();
      expect(row.revisionId).toBeTruthy();
      expect(row.legalEntityId).toBeTruthy();
      expect(row.state).toBe("draft");
      expect(row.isDeleted).toBe(false);
      expect(row.supersededById).toBeNull();

      // The actor is a `profiles` row (DM-13) and the revision belongs to the
      // same tenant — the two things a hand-written fixture gets wrong.
      const [profile] = await conn
        .select({ id: schema.profiles.id })
        .from(schema.profiles)
        .where(eq(schema.profiles.id, row.actorId));
      expect(profile).toBeDefined();
      const [rev] = await conn
        .select({ companyId: schema.reportRevision.companyId })
        .from(schema.reportRevision)
        .where(eq(schema.reportRevision.id, row.revisionId));
      expect(rev.companyId).toBe(company.id);
    }

    // One default actor per company, not one per fixture call.
    expect(await countRows("profiles")).toBe(1);
  });

  it("attributes an auto-created input row to an entity inside the boundary", async () => {
    const company = await insertCompany();
    const row = await insertEmissionActivity(company.id);
    const conn = getTestDb();
    const [scope] = await conn
      .select({ legalEntityId: schema.periodScope.legalEntityId })
      .from(schema.periodScope);
    expect(row.legalEntityId).toBe(scope.legalEntityId);
  });

  it("insertDisclosure points at a real catalogue metric", async () => {
    const company = await insertCompany();
    const row = await insertDisclosure(company.id);
    const conn = getTestDb();
    const [metric] = await conn
      .select({ valueType: schema.metricCatalog.valueType })
      .from(schema.metricCatalog)
      .where(eq(schema.metricCatalog.metricKey, row.metricKey!));
    // DM-19: the filled value column matches the declared type.
    expect(metric.valueType).toBe("text");
    expect(row.valueType).toBe("text");
    expect(row.valueText).toBeTruthy();
    expect(row.valueNumeric).toBeNull();
  });

  it("insertDocument and insertEvidenceLink produce a linked pair", async () => {
    const company = await insertCompany();
    const activity = await insertEmissionActivity(company.id);
    const link = await insertEvidenceLink(company.id, {
      linkedObjectType: "emission_activity",
      linkedObjectId: activity.id,
    });
    expect(link.companyId).toBe(company.id);
    expect(link.createdBy).toBeTruthy();
    // The document was created by the link fixture, not demanded from the test.
    const conn = getTestDb();
    const [doc] = await conn
      .select({
        companyId: schema.document.companyId,
        storageKey: schema.document.storageKey,
        uploadedBy: schema.document.uploadedBy,
        fileHash: schema.document.fileHash,
      })
      .from(schema.document)
      .where(eq(schema.document.id, link.documentId));
    expect(doc.companyId).toBe(company.id);
    expect(doc.uploadedBy).toBeTruthy();
    expect(doc.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.storageKey).toBe(`${company.id}/${doc.fileHash}`);
  });

  it("overrides win over every default", async () => {
    const company = await insertCompany();
    const facility = await insertFacility(company.id, {
      facilityName: "Named site",
      country: "AT",
    });
    expect(facility.facilityName).toBe("Named site");
    expect(facility.country).toBe("AT");

    const dq = await insertDq(company.id, {
      reliabilityScore: 5,
      qualityTier: "high_primary",
    });
    expect(dq.reliabilityScore).toBe(5);
    expect(dq.qualityTier).toBe("high_primary");
  });
});

// ─── 4. setupDocumentsDir — filesystem isolation ─────────────────────────────
// No database involved. Sibling `describe` blocks run in order, so suite A's
// `afterAll` has already run by the time suite B's tests start: that ordering is
// exactly what "one suite cannot see another's files" means here.

const SENTINEL = "/nonexistent/previous-documents-dir";
let dirA = "";
let dirB = "";
const FILE_NAME = "leaked.txt";

describe("setupDocumentsDir", () => {
  let original: string | undefined;
  let hadOriginal = false;

  beforeAll(() => {
    hadOriginal = "DOCUMENTS_DIR" in process.env;
    original = process.env.DOCUMENTS_DIR;
    // Start from "the variable was never set" — the case a developer running
    // `npm test` locally is actually in.
    delete process.env.DOCUMENTS_DIR;
  });

  afterAll(() => {
    if (hadOriginal && original !== undefined) {
      process.env.DOCUMENTS_DIR = original;
    } else {
      delete process.env.DOCUMENTS_DIR;
    }
  });

  describe("suite A", () => {
    const docs = setupDocumentsDir();

    it("gets its own directory inside os.tmpdir() and DOCUMENTS_DIR points at it", async () => {
      dirA = docs.path;
      expect(dirA).not.toBe("");
      expect(path.dirname(dirA)).toBe(os.tmpdir());
      expect(path.basename(dirA)).toMatch(/^hosmos-docs-/);
      expect(process.env.DOCUMENTS_DIR).toBe(dirA);
      expect(existsSync(dirA)).toBe(true);

      await writeFile(path.join(dirA, FILE_NAME), "suite A bytes");
      expect(await readFile(path.join(dirA, FILE_NAME), "utf8")).toBe(
        "suite A bytes",
      );
    });
  });

  describe("between the suites", () => {
    it("removed suite A's directory and unset the previously unset variable", () => {
      expect(dirA).not.toBe("");
      expect(existsSync(dirA)).toBe(false);
      expect("DOCUMENTS_DIR" in process.env).toBe(false);
    });
  });

  describe("suite B", () => {
    // Registered BEFORE the harness hook, so `setupDocumentsDir` sees the
    // sentinel as the previous value and has to put it back.
    beforeAll(() => {
      process.env.DOCUMENTS_DIR = SENTINEL;
    });
    const docs = setupDocumentsDir();

    it("gets a different directory and cannot see suite A's file", () => {
      dirB = docs.path;
      expect(dirB).not.toBe("");
      expect(dirB).not.toBe(dirA);
      expect(process.env.DOCUMENTS_DIR).toBe(dirB);
      expect(existsSync(path.join(dirB, FILE_NAME))).toBe(false);
    });
  });

  describe("after suite B", () => {
    it("removed suite B's directory and restored the previous value", () => {
      expect(dirB).not.toBe("");
      expect(existsSync(dirB)).toBe(false);
      expect(process.env.DOCUMENTS_DIR).toBe(SENTINEL);
    });
  });
});
