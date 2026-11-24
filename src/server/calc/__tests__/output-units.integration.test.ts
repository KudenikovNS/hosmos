// [LOCAL-DB] F06: canonical kilograms, truthful provenance and immutable history.
import { and, eq, like } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
vi.mock("server-only", () => ({}));
const sessionMock = vi.fn();
vi.mock("@/server/auth/session", () => ({ getSession: () => sessionMock() }));
vi.mock("@/server/db", async () =>
  (await import("@/server/db/__tests__/harness")).testDbModule(),
);
import type { NextRequest } from "next/server";
import { POST as calculatePOST } from "@/app/api/revisions/[id]/calculate/route";
import {
  GET as previewGET,
  POST as renderPOST,
} from "@/app/api/revisions/[id]/render/route";
import { GET as downloadGET } from "@/app/api/renders/[id]/download/route";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertEmissionActivity,
  insertEnergyActivity,
  insertLegalEntity,
  insertPeriod,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
  setupDocumentsDir,
} from "@/server/db/__tests__/harness";
import {
  calculation,
  emissionFactor,
  factorSet,
  reportRevision,
  reportRender,
} from "@/server/db/schema";
import { createFactor, createFactorSet } from "@/server/factors/factor-sets";
import { buildFrozenScope } from "@/server/revisions/frozen";
import {
  renderGate,
  renderRevision,
  listRenders,
} from "@/server/render/persist";
import { documentStorage } from "@/server/storage/document-storage";
import type { FrozenScope } from "@/server/revisions/frozen";
import { createRevision } from "@/server/revisions/revisions";
import { computeScope3Spend } from "@/server/scope3/compute";
import { loadSpendFactorRows } from "@/server/scope3/factors";
import {
  calculateRevision,
  loadStoredRun,
  type ResolvedFactorSnapshot,
} from "../run";

const PREFIX = "f06-test-";
async function fixture() {
  const db = getTestDb();
  const company = await insertCompany({ plan: "pro" });
  const { user } = await insertUserWithProfile({ companyId: company.id });
  const entity = await insertLegalEntity(company.id, {
    country: "SI",
    turnover: "1000",
  });
  const set = await createFactorSet(db, {
    code: PREFIX + company.id,
    name: "Output units",
  });
  if (!set.ok) throw new Error("fixture set failed");
  const addFactor = async (
    activityType: string,
    outputUnit = "tCO2e",
    inputUnit = "kWh",
  ) => {
    const result = await createFactor(db, company.id, set.row.id, {
      factorCode: activityType,
      factorName: activityType,
      activityType,
      inputUnit,
      factorValue: "1",
      outputUnit,
      sourceName: "custom",
      sourceVersion: "1",
      geography: "GLOBAL",
      applicableYear: 2024,
      status: "active",
    });
    if (!result.ok)
      throw new Error(`fixture factor failed: ${JSON.stringify(result)}`);
    return result.row;
  };
  const gas = await addFactor("natural_gas");
  await addFactor("grid:grid_electricity");
  const { period } = await insertPeriod(company.id, {
    legalEntityId: entity.id,
    factorSetId: set.row.id,
  });
  const revision = await insertRevision(company.id, { periodId: period.id });
  await insertEmissionActivity(company.id, {
    revisionId: revision.id,
    legalEntityId: entity.id,
    activityValue: "1",
    unit: "kWh",
    state: "approved",
  });
  await insertEnergyActivity(company.id, {
    revisionId: revision.id,
    legalEntityId: entity.id,
    consumption: "1",
    unit: "kWh",
    state: "approved",
  });
  sessionMock.mockResolvedValue({
    userId: user.id,
    company,
    capabilities: ["data.write", "data.read", "data.review"],
    membership: { role: "esg_admin" },
  });
  return {
    db,
    company,
    user,
    entity,
    period,
    revision,
    gas,
    addFactor,
    set: set.row,
  };
}

setupDocumentsDir();

describeIntegration("output-unit persistence [LOCAL-DB]", () => {
  beforeAll(setupSchema);
  beforeEach(resetAppTables);
  afterEach(async () => {
    await resetAppTables();
    await getTestDb()
      .delete(factorSet)
      .where(like(factorSet.code, `${PREFIX}%`));
  });
  afterAll(closeTestDb);

  it("stores kg aggregates with original factor values/units and the applied output conversion", async () => {
    const f = await fixture();
    const run = await calculateRevision(f.db, f.company.id, f.revision);
    if (!run.ok) throw new Error("fixture run failed");
    expect(run.run.status).toBe("ok");
    expect(run.lines).toHaveLength(3);
    expect(run.aggregates.totals).toMatchObject({
      scope1Co2e: "1000.000000",
      scope2LocationBasedCo2e: "1000.000000",
      scope2MarketBasedCo2e: "1000.000000",
    });
    for (const line of run.lines) {
      expect(line.co2eResult).toBe("1000.000000");
      expect(line.factorSnapshot).toMatchObject({
        factor_value: "1",
        output_unit: "tCO2e",
        output_conversion: {
          from_unit: "tCO2e",
          to_unit: "kgCO2e",
          multiplier: "1000",
        },
        formula_version: "hosmos-calc-1.5.0",
      });
    }
    expect(
      (await loadStoredRun(f.db, f.company.id, f.revision, run.run.runId))
        ?.freshness.staleSources,
    ).not.toContain("formula");
    await f.db
      .update(emissionFactor)
      .set({ factorValue: "2" })
      .where(eq(emissionFactor.id, f.gas.id));
    const stored = await loadStoredRun(
      f.db,
      f.company.id,
      f.revision,
      run.run.runId,
    );
    expect(stored?.lines).toEqual(run.lines);
    expect(stored?.aggregates).toEqual(run.aggregates);
  });

  it("fails a legacy factor with an unsupported numerator rather than storing successful emissions", async () => {
    const f = await fixture();
    await f.db
      .update(emissionFactor)
      .set({ outputUnit: "unknown" })
      .where(eq(emissionFactor.factorSetId, f.set.id));
    const run = await calculateRevision(f.db, f.company.id, f.revision);
    if (!run.ok) throw new Error("fixture run failed");
    expect(run.run.status).toBe("failed");
    expect(
      run.lines.every(
        (line) =>
          line.calculationStatus === "failed_unit" && line.co2eResult === null,
      ),
    ).toBe(true);
    expect(run.aggregates.totals.scope1Co2e).toBeNull();
    expect(
      run.lines.every((line) => line.factorSnapshot.resolved === false),
    ).toBe(true);
  });

  it("requires restatement for a locked pre-fix tonne result and leaves its old rows unchanged", async () => {
    const f = await fixture();
    const run = await calculateRevision(f.db, f.company.id, f.revision);
    if (!run.ok) throw new Error("fixture run failed");
    const frozenScope = await buildFrozenScope(
      f.db,
      f.company.id,
      f.period.id,
      f.revision.id,
    );
    for (const line of run.lines) {
      const { output_conversion: _conversion, ...legacy } =
        line.factorSnapshot as ResolvedFactorSnapshot;
      await f.db
        .update(calculation)
        .set({
          co2eResult: "1",
          formulaVersion: "hosmos-calc-1.4.0",
          factorSnapshot: { ...legacy, formula_version: "hosmos-calc-1.4.0" },
        })
        .where(eq(calculation.id, line.id));
    }
    const [approved] = await f.db
      .update(reportRevision)
      .set({ status: "approved" })
      .where(eq(reportRevision.id, f.revision.id))
      .returning();
    expect(await renderGate(f.db, f.company.id, approved)).toMatchObject({
      reason: "no_green_run",
    });
    await f.db
      .update(reportRevision)
      .set({ status: "locked", lockedAt: new Date(), frozenScope })
      .where(eq(reportRevision.id, f.revision.id));
    const original = await f.db
      .select()
      .from(calculation)
      .where(eq(calculation.revisionId, f.revision.id))
      .orderBy(calculation.id);
    expect(
      (await loadStoredRun(f.db, f.company.id, f.revision, run.run.runId))
        ?.freshness.staleSources,
    ).toContain("formula");
    const response = await calculatePOST(
      new Request(`http://localhost/api/revisions/${f.revision.id}/calculate`, {
        method: "POST",
      }) as NextRequest,
      { params: Promise.resolve({ id: f.revision.id }) },
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      reason: "historical_formula_unsupported",
      requires_restatement: true,
    });
    const next = await createRevision(
      f.db,
      f.company.id,
      f.period.id,
      { changeReason: "Correct output units", seedFrom: f.revision.id },
      { userId: f.user.id, role: "esg_admin" },
    );
    if (!next.ok) throw new Error("fixture restatement failed");
    const corrected = await calculateRevision(f.db, f.company.id, next.row);
    if (!corrected.ok) throw new Error("corrected calculation failed");
    expect(
      corrected.lines.every((line) => line.co2eResult === "1000.000000"),
    ).toBe(true);
    expect(
      await f.db
        .select()
        .from(calculation)
        .where(eq(calculation.revisionId, f.revision.id))
        .orderBy(calculation.id),
    ).toEqual(original);
  });

  it("blocks new exports of affected locked runs but keeps archived downloads unchanged", async () => {
    const f = await fixture();
    const run = await calculateRevision(f.db, f.company.id, f.revision);
    if (!run.ok) throw new Error("fixture run failed");
    const frozenScope = await buildFrozenScope(
      f.db,
      f.company.id,
      f.period.id,
      f.revision.id,
    );
    const [locked] = await f.db
      .update(reportRevision)
      .set({ status: "locked", lockedAt: new Date(), frozenScope })
      .where(eq(reportRevision.id, f.revision.id))
      .returning();
    expect(await renderGate(f.db, f.company.id, locked)).toBeNull();
    const archive = await renderRevision(f.db, f.company.id, locked, {
      format: "pdf",
      language: "en",
      renderedBy: f.user.id,
    });
    if (!archive.ok) throw new Error("fixture archive failed");
    const bytes = Buffer.from(
      await new Response(
        await documentStorage.getStream(archive.row.storageKey),
      ).arrayBuffer(),
    );
    for (const line of run.lines) {
      const { output_conversion: _conversion, ...legacy } =
        line.factorSnapshot as ResolvedFactorSnapshot;
      await f.db
        .update(calculation)
        .set({
          co2eResult: "1",
          formulaVersion: "hosmos-calc-1.4.0",
          factorSnapshot: { ...legacy, formula_version: "hosmos-calc-1.4.0" },
        })
        .where(eq(calculation.id, line.id));
    }
    const ctx = { params: Promise.resolve({ id: locked.id }) };
    for (const language of ["en", "sl"]) {
      const preview = await previewGET(
        new Request(
          `http://localhost/api/revisions/${locked.id}/render?language=${language}`,
        ) as NextRequest,
        ctx,
      );
      expect(preview.status).toBe(200);
      expect((await preview.json()).data.preview).toMatchObject({
        renderable: false,
        gate_reason: "historical_formula_unsupported",
        gate_detail: { requires_restatement: true },
      });
      for (const format of ["pdf", "xlsx"]) {
        const refused = await renderPOST(
          new Request(`http://localhost/api/revisions/${locked.id}/render`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ format, language }),
          }) as NextRequest,
          ctx,
        );
        expect(refused.status).toBe(422);
        expect(await refused.json()).toMatchObject({
          reason: "historical_formula_unsupported",
          requires_restatement: true,
        });
      }
    }
    expect(
      await f.db
        .select()
        .from(reportRender)
        .where(eq(reportRender.revisionId, locked.id)),
    ).toEqual([archive.row]);
    expect(await listRenders(f.db, f.company.id)).toHaveLength(1);
    const downloaded = await downloadGET(
      new Request(
        `http://localhost/api/renders/${archive.row.id}/download`,
      ) as NextRequest,
      { params: Promise.resolve({ id: archive.row.id }) },
    );
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    const { render_context: _render, ...legacyScope } =
      locked.frozenScope as FrozenScope;
    const [legacyLocked] = await f.db
      .update(reportRevision)
      .set({ frozenScope: legacyScope })
      .where(eq(reportRevision.id, locked.id))
      .returning();
    expect(await renderGate(f.db, f.company.id, legacyLocked)).toMatchObject({
      reason: "historical_formula_unsupported",
    });
  });

  it("also normalises spend factors before the separate Scope 3 engine uses them", async () => {
    const f = await fixture();
    const factor = await f.addFactor(
      "scope3_spend:s3_c1_electronics",
      "tCO2e",
      "EUR_1000",
    );
    const rows = await loadSpendFactorRows(f.db, f.set.id);
    expect(rows).toMatchObject([{ id: factor.id, value: 1000 }]);
    const totals = computeScope3Spend(
      [
        {
          category: 1,
          commodityKey: "s3_c1_electronics",
          spendAmount: 1000,
          currency: "EUR",
        },
      ],
      rows,
      new Map([["EUR", 1]]),
      "2024",
    );
    expect(totals).toEqual({ cat1: 1, cat2: 0, warnings: [] });
    await f.db
      .update(emissionFactor)
      .set({ outputUnit: "unknown" })
      .where(
        and(
          eq(emissionFactor.factorSetId, f.set.id),
          eq(emissionFactor.id, factor.id),
        ),
      );
    expect(await loadSpendFactorRows(f.db, f.set.id)).toEqual([]);
  });
});
