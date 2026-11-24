// [LOCAL-DB] F03: a run owns its organisation and FX inputs, not today's registry.
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
const getSessionMock = vi.fn();
vi.mock("@/server/auth/session", async () => ({
  ...(await vi.importActual<typeof import("@/server/auth/session")>(
    "@/server/auth/session",
  )),
  getSession: () => getSessionMock(),
}));
vi.mock("@/server/db", async () =>
  (await import("@/server/db/__tests__/harness")).testDbModule(),
);

import { POST as calculatePOST } from "@/app/api/revisions/[id]/calculate/route";
import { GET as resultsGET } from "@/app/api/revisions/[id]/results/route";
import { resolveSessionContext } from "@/server/auth/session";
import { loadDashboard } from "@/server/dashboard/dashboard";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertEmissionActivity,
  insertEnergyActivity,
  insertFacility,
  insertLegalEntity,
  insertPeriod,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  auditLog,
  calculation,
  calculationRunContext,
  purchasedEnergyActivity,
  facility,
  fxRates,
  legalEntity,
  reportRevision,
} from "@/server/db/schema";
import {
  loadRenderInput,
  renderVsmeBasicPdf,
} from "@/server/render/vsme-basic";
import { renderVsmeBasicXlsx } from "@/server/render/xlsx";
import { loadReadiness } from "@/server/readiness/readiness";
import { loadVesg } from "@/server/vesg/vesg";
import { createRevision } from "@/server/revisions/revisions";
import { buildFrozenScope } from "@/server/revisions/frozen";
import { calculateRevision, loadLatestRun } from "../run";

async function fixture(currency = "EUR") {
  const db = getTestDb();
  const company = await insertCompany({ plan: "starter" });
  const { user } = await insertUserWithProfile({ companyId: company.id });
  getSessionMock.mockResolvedValue({
    userId: user.id,
    ...(await resolveSessionContext(db, user.id)),
  });
  const entity = await insertLegalEntity(company.id, {
    turnover: "1000",
    reportingCurrency: currency,
    country: "SI",
  });
  const site = await insertFacility(company.id, {
    legalEntityId: entity.id,
    country: "SI",
  });
  const { period } = await insertPeriod(company.id, {
    legalEntityId: entity.id,
  });
  const revision = await insertRevision(company.id, {
    periodId: period.id,
    createdBy: user.id,
  });
  await insertEmissionActivity(company.id, {
    revisionId: revision.id,
    legalEntityId: entity.id,
    facilityId: site.id,
    unit: "kWh_gross",
    state: "approved",
  });
  await insertEnergyActivity(company.id, {
    revisionId: revision.id,
    legalEntityId: entity.id,
    facilityId: site.id,
    state: "approved",
    renewableShare: "40",
  });
  return { db, company, user, entity, site, period, revision };
}

describeIntegration("calculation context [LOCAL-DB]", () => {
  beforeAll(setupSchema);
  beforeEach(resetAppTables);
  afterAll(closeTestDb);

  it("results, dashboard and export keep the saved inputs until a new open run", async () => {
    const f = await fixture();
    const first = await calculateRevision(f.db, f.company.id, f.revision);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("fixture calculation failed");
    await f.db
      .update(reportRevision)
      .set({ status: "approved" })
      .where(eq(reportRevision.id, f.revision.id));
    const approved = { ...f.revision, status: "approved" };
    await f.db
      .update(legalEntity)
      .set({
        turnover: "4000",
        reportingCurrency: "USD",
        country: "RS",
        name: "Changed entity",
      })
      .where(eq(legalEntity.id, f.entity.id));
    await f.db
      .update(facility)
      .set({ country: "RS", facilityName: "Changed site" })
      .where(eq(facility.id, f.site.id));

    const response = await resultsGET(
      new Request("http://localhost/api/revisions/x/results") as NextRequest,
      { params: Promise.resolve({ id: f.revision.id }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.aggregates).toEqual(first.aggregates);
    expect(body.data.freshness.staleSources).toContain("organisation");
    const dashboard = await loadDashboard(f.db, f.company.id);
    expect(dashboard.emissions?.intensity).toEqual(first.aggregates.intensity);
    expect(dashboard.emissions?.state).toBe("stale");
    const render = await loadRenderInput(f.db, f.company.id, approved, {
      language: "en",
      coverage: { claim: "full", completenessNote: null, excludedByPlan: [] },
    });
    expect(render?.aggregates).toEqual(first.aggregates);

    const next = await calculateRevision(f.db, f.company.id, f.revision);
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error("second calculation failed");
    expect(next.aggregates.intensity.turnoverEur).not.toBe(
      first.aggregates.intensity.turnoverEur,
    );
    expect(
      (await loadLatestRun(f.db, f.company.id, f.revision))?.freshness.stale,
    ).toBe(false);
  });

  it("FX edits do not rewrite a run and do invalidate an open revision", async () => {
    const f = await fixture("USD");
    const originals = await f.db
      .select()
      .from(fxRates)
      .where(eq(fxRates.currencyCode, "USD"));
    expect(originals.length).toBeGreaterThan(0);
    try {
      const first = await calculateRevision(f.db, f.company.id, f.revision);
      if (!first.ok) throw new Error("fixture calculation failed");
      await f.db
        .update(fxRates)
        .set({ rateToEur: "2" })
        .where(eq(fxRates.currencyCode, "USD"));
      const stored = await loadLatestRun(f.db, f.company.id, f.revision);
      expect(stored?.aggregates).toEqual(first.aggregates);
      expect(stored?.freshness.staleSources).toContain("fx");
      const next = await calculateRevision(f.db, f.company.id, f.revision);
      if (!next.ok) throw new Error("second calculation failed");
      expect(next.aggregates.intensity.turnoverEur).toBe("2000.00");
      const frozenScope = await buildFrozenScope(
        f.db,
        f.company.id,
        f.period.id,
      );
      const [locked] = await f.db
        .update(reportRevision)
        .set({ status: "locked", frozenScope })
        .where(eq(reportRevision.id, f.revision.id))
        .returning();
      await f.db
        .update(fxRates)
        .set({ rateToEur: "3" })
        .where(eq(fxRates.currencyCode, "USD"));
      const historical = await calculateRevision(f.db, f.company.id, locked);
      if (!historical.ok) throw new Error("historical FX calculation failed");
      expect(historical.aggregates).toEqual(next.aggregates);
      expect(
        (await loadLatestRun(f.db, f.company.id, locked))?.freshness.stale,
      ).toBe(false);
    } finally {
      for (const row of originals)
        await f.db
          .update(fxRates)
          .set({ rateToEur: row.rateToEur })
          .where(eq(fxRates.id, row.id));
    }
  });

  it("locked recalculation uses the pinned geography, turnover, currency and FX", async () => {
    const f = await fixture();
    const first = await calculateRevision(f.db, f.company.id, f.revision);
    if (!first.ok) throw new Error("fixture calculation failed");
    const frozenScope = await buildFrozenScope(f.db, f.company.id, f.period.id);
    const [locked] = await f.db
      .update(reportRevision)
      .set({ status: "locked", frozenScope })
      .where(eq(reportRevision.id, f.revision.id))
      .returning();
    await f.db
      .update(legalEntity)
      .set({ turnover: "99999", reportingCurrency: "USD", country: "RS" })
      .where(
        and(
          eq(legalEntity.companyId, f.company.id),
          eq(legalEntity.id, f.entity.id),
        ),
      );
    await f.db
      .update(facility)
      .set({ country: "RS" })
      .where(eq(facility.id, f.site.id));
    const rerun = await calculateRevision(f.db, f.company.id, locked);
    if (!rerun.ok) throw new Error("locked calculation failed");
    expect(rerun.aggregates).toEqual(first.aggregates);
    expect(rerun.lines.map((line) => line.factorSnapshot)).toEqual(
      first.lines.map((line) => line.factorSnapshot),
    );
    expect(
      (await loadLatestRun(f.db, f.company.id, locked))?.freshness.stale,
    ).toBe(false);
  });

  it("keeps a run's energy split when a row gets a new version", async () => {
    const f = await fixture();
    const first = await calculateRevision(f.db, f.company.id, f.revision);
    if (!first.ok) throw new Error("fixture calculation failed");
    const [old] = await f.db
      .select()
      .from(purchasedEnergyActivity)
      .where(eq(purchasedEnergyActivity.revisionId, f.revision.id));
    const next = await insertEnergyActivity(f.company.id, {
      revisionId: f.revision.id,
      legalEntityId: f.entity.id,
      facilityId: f.site.id,
      previousVersionId: old.id,
      consumption: "9000",
      renewableShare: "90",
      state: "approved",
    });
    await f.db
      .update(purchasedEnergyActivity)
      .set({ supersededById: next.id })
      .where(eq(purchasedEnergyActivity.id, old.id));
    const stored = await loadLatestRun(f.db, f.company.id, f.revision);
    expect(stored?.aggregates.energy).toEqual(first.aggregates.energy);
    expect(stored?.freshness.staleSources).toContain("rows");
  });

  it("does not reconstruct legacy results from today's registry; an open run can be replaced", async () => {
    const f = await fixture();
    const first = await calculateRevision(f.db, f.company.id, f.revision);
    if (!first.ok) throw new Error("fixture calculation failed");
    await f.db
      .delete(calculationRunContext)
      .where(eq(calculationRunContext.runId, first.run.runId));
    await f.db
      .update(legalEntity)
      .set({ turnover: "99999" })
      .where(eq(legalEntity.id, f.entity.id));
    const legacy = await loadLatestRun(f.db, f.company.id, f.revision);
    expect(legacy?.contextStatus).toBe("missing");
    expect(legacy?.aggregates.byLegalEntity[0]?.name).toBeNull();
    for (const language of ["en", "sl"] as const) {
      const input = await loadRenderInput(f.db, f.company.id, f.revision, {
        language,
        coverage: { claim: "full", completenessNote: null, excludedByPlan: [] },
      });
      if (!input) throw new Error("fixture render input missing");
      const pdf = await renderVsmeBasicPdf(input);
      const xlsx = await renderVsmeBasicXlsx(input);
      expect(pdf.pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(xlsx.xlsx.subarray(0, 2).toString()).toBe("PK");
      for (const report of [pdf, xlsx]) {
        const energy = report.sections.find(
          (section) => section.id === "energyEmissions",
        );
        if (!energy) throw new Error("B3 section missing");
        const labels = energy.blocks.flatMap((block) =>
          block.kind === "table" ? block.rows.map((row) => row[0]) : [],
        );
        expect(labels).toContain(
          language === "en"
            ? "Legal entity — historical name not recorded"
            : "Pravna oseba — zgodovinsko ime ni shranjeno",
        );
        expect(labels).not.toContain(f.entity.id);
        expect(labels).not.toContain(f.entity.name);
      }
    }

    expect(legacy?.aggregates.totals).toEqual(first.aggregates.totals);
    expect(legacy?.aggregates.intensity.turnoverEur).toBeNull();
    expect(legacy?.aggregates.intensity.locationBasedIntensity).toBeNull();
    expect(legacy?.aggregates.energy.totalMwh).toBeNull();
    expect(legacy?.aggregates.warnings).toContainEqual(
      expect.objectContaining({ code: "historical_context_missing" }),
    );
    expect(legacy?.freshness.staleSources).toContain("context");
    expect(await f.db.select().from(calculationRunContext)).toHaveLength(0);
    const next = await calculateRevision(f.db, f.company.id, f.revision);
    expect(next.ok).toBe(true);
    const stored = await loadLatestRun(f.db, f.company.id, f.revision);
    expect(stored?.contextStatus).toBe("recorded");
    expect(stored?.aggregates.intensity.turnoverEur).toBe("99999.00");
    expect(stored?.freshness.stale).toBe(false);
  });

  it("refuses a legacy locked recalculation without inventing historical inputs", async () => {
    const f = await fixture();
    const first = await calculateRevision(f.db, f.company.id, f.revision);
    if (!first.ok) throw new Error("fixture calculation failed");
    const frozenScope = await buildFrozenScope(f.db, f.company.id, f.period.id);
    delete frozenScope.calculation_context;
    await f.db
      .update(reportRevision)
      .set({ status: "locked", frozenScope })
      .where(eq(reportRevision.id, f.revision.id));
    await f.db
      .delete(calculationRunContext)
      .where(eq(calculationRunContext.runId, first.run.runId));
    const response = await calculatePOST(
      new Request("http://localhost/api/revisions/x/calculate", {
        method: "POST",
      }) as NextRequest,
      { params: Promise.resolve({ id: f.revision.id }) },
    );
    const readiness = await loadReadiness(f.db, f.company.id);
    expect(
      readiness.journey.find((step) => step.id === "calculation")?.state,
    ).not.toBe("done");
    const vesg = await loadVesg(f.db, f.company.id, { canConfirm: false });
    expect(vesg.items.find((item) => item.id === "data_quality")?.status).toBe(
      "attention",
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      reason: "historical_context_missing",
    });
    const rows = await f.db.select().from(calculation);
    expect(rows).toHaveLength(first.lines.length);
    expect(rows.every((row) => row.runId === first.run.runId)).toBe(true);
    expect(await f.db.select().from(calculationRunContext)).toHaveLength(0);
  });

  it("a restatement uses new organisation inputs while its locked predecessor keeps its own", async () => {
    const f = await fixture();
    const first = await calculateRevision(f.db, f.company.id, f.revision);
    if (!first.ok) throw new Error("fixture calculation failed");
    const frozenScope = await buildFrozenScope(f.db, f.company.id, f.period.id);
    const [locked] = await f.db
      .update(reportRevision)
      .set({ status: "locked", frozenScope })
      .where(eq(reportRevision.id, f.revision.id))
      .returning();
    const successor = await createRevision(
      f.db,
      f.company.id,
      f.period.id,
      { changeReason: "Context regression", seedFrom: locked.id },
      { userId: f.user.id, role: "esg_admin" },
    );
    if (!successor.ok) throw new Error("fixture restatement failed");
    await f.db
      .update(legalEntity)
      .set({ turnover: "2000" })
      .where(eq(legalEntity.id, f.entity.id));
    const next = await calculateRevision(f.db, f.company.id, successor.row);
    if (!next.ok) throw new Error("restatement calculation failed");
    expect(next.aggregates.intensity.turnoverEur).toBe("2000.00");
    const historical = await calculateRevision(f.db, f.company.id, locked);
    if (!historical.ok) throw new Error("historical calculation failed");
    expect(historical.aggregates).toEqual(first.aggregates);
  });

  it("keeps the context of an empty run and does not read another tenant's run", async () => {
    const f = await fixture();
    const other = await insertCompany();
    const { period } = await insertPeriod(other.id);
    const revision = await insertRevision(other.id, { periodId: period.id });
    const run = await calculateRevision(f.db, other.id, revision);
    if (!run.ok) throw new Error("empty calculation failed");
    expect(run.lines).toHaveLength(0);
    const stored = await loadLatestRun(f.db, other.id, revision);
    expect(stored?.run.runId).toBe(run.run.runId);
    expect(stored?.aggregates).toEqual(run.aggregates);
    expect(await loadLatestRun(f.db, f.company.id, revision)).toBeNull();
  });

  it("pins the requested revision's run rather than its successor's context", async () => {
    const f = await fixture();
    const first = await calculateRevision(f.db, f.company.id, f.revision);
    if (!first.ok) throw new Error("fixture calculation failed");
    await f.db
      .update(reportRevision)
      .set({ isCurrent: false })
      .where(eq(reportRevision.id, f.revision.id));
    await f.db
      .update(legalEntity)
      .set({ turnover: "8000" })
      .where(eq(legalEntity.id, f.entity.id));
    const successor = await insertRevision(f.company.id, {
      periodId: f.period.id,
      revisionNo: 2,
      createdBy: f.user.id,
    });
    const next = await calculateRevision(f.db, f.company.id, successor);
    expect(next.ok).toBe(true);
    const own = await buildFrozenScope(
      f.db,
      f.company.id,
      f.period.id,
      f.revision.id,
    );
    expect(own.calculation_context?.entities[0]?.turnover).toBe("1000");
    const current = await buildFrozenScope(
      f.db,
      f.company.id,
      f.period.id,
      successor.id,
    );
    expect(current.calculation_context?.entities[0]?.turnover).toBe("8000");
  });

  it("retries a real concurrent lock with a fresh snapshot and writes one successful run", async () => {
    const f = await fixture();
    const first = await calculateRevision(f.db, f.company.id, f.revision);
    if (!first.ok) throw new Error("fixture calculation failed");
    const frozenScope = await buildFrozenScope(
      f.db,
      f.company.id,
      f.period.id,
      f.revision.id,
    );
    const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: (pid: number) => void;
    let failed!: (error: unknown) => void;
    const holding = new Promise<number>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    const locker = f.db.transaction(async (tx) => {
      const [{ pid }] = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`,
      );
      await tx
        .update(reportRevision)
        .set({ status: "locked", frozenScope })
        .where(eq(reportRevision.id, f.revision.id));
      await tx
        .update(legalEntity)
        .set({ turnover: "9000" })
        .where(eq(legalEntity.id, f.entity.id));
      ready(pid);
      await gate;
    });
    void locker.catch(failed);
    let request: Promise<Response> | undefined;
    try {
      const pid = await holding;
      request = calculatePOST(
        new Request("http://localhost/api/revisions/x/calculate", {
          method: "POST",
        }) as NextRequest,
        { params: Promise.resolve({ id: f.revision.id }) },
      );
      const deadline = Date.now() + 5000;
      for (;;) {
        const [{ waiting }] = await observer`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
              AND query ILIKE '%for share%') AS waiting`;
        if (waiting) break;
        if (Date.now() > deadline)
          throw new Error("calculation never waited on the revision row lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      release();
      await locker;
      const response = await request;
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.aggregates).toEqual(first.aggregates);
      const contexts = await f.db.select().from(calculationRunContext);
      expect(contexts).toHaveLength(2);
      expect(await f.db.select().from(calculation)).toHaveLength(
        first.lines.length * 2,
      );
      expect(
        await f.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.entity, "calculation")),
      ).toHaveLength(1);
    } finally {
      release();
      await locker;
      await request;
      await observer.end();
    }
  }, 15000);

  it("returns 409 after two wrapped serialization failures and does not retry other errors", async () => {
    const f = await fixture();
    const conflict = new Error("driver wrapper", {
      cause: Object.assign(new Error("concurrent update"), { code: "40001" }),
    });
    const transaction = vi
      .spyOn(f.db, "transaction")
      .mockRejectedValue(conflict);
    try {
      const response = await calculatePOST(
        new Request("http://localhost/api/revisions/x/calculate", {
          method: "POST",
        }) as NextRequest,
        { params: Promise.resolve({ id: f.revision.id }) },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        ok: false,
        error: "CONCURRENT_MODIFICATION",
      });
      expect(transaction).toHaveBeenCalledTimes(2);
      transaction.mockClear();
      const other = Object.assign(new Error("unrelated database error"), {
        code: "23514",
      });
      transaction.mockRejectedValue(other);
      await expect(
        calculateRevision(f.db, f.company.id, f.revision),
      ).rejects.toBe(other);
      expect(transaction).toHaveBeenCalledTimes(1);
    } finally {
      transaction.mockRestore();
    }
    expect(await f.db.select().from(calculationRunContext)).toHaveLength(0);
    expect(await f.db.select().from(calculation)).toHaveLength(0);
  });

  it("rolls back the context if persisting a result line fails", async () => {
    const f = await fixture();
    await f.db.execute(
      sql`ALTER TABLE calculation ADD CONSTRAINT context_test_failure CHECK (false)`,
    );
    try {
      await expect(
        calculateRevision(f.db, f.company.id, f.revision),
      ).rejects.toThrow();
      expect(await f.db.select().from(calculationRunContext)).toHaveLength(0);
      expect(await f.db.select().from(calculation)).toHaveLength(0);
    } finally {
      await f.db.execute(
        sql`ALTER TABLE calculation DROP CONSTRAINT context_test_failure`,
      );
    }
  });
});
