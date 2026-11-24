// [LOCAL-DB] F04: a closed report owns its period, boundary and descriptions.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertEmissionActivity,
  insertLegalEntity,
  insertPeriod,
  insertPeriodScope,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
  setupDocumentsDir,
} from "@/server/db/__tests__/harness";
import {
  companies,
  factorSet,
  legalEntity,
  reportingPeriod,
  reportRevision,
  reportRender,
  validationResult,
} from "@/server/db/schema";
import type { FrozenScope } from "@/server/revisions/frozen";
import { documentStorage } from "@/server/storage/document-storage";
import { calculateRevision } from "@/server/calc/run";
import { buildFrozenScope } from "@/server/revisions/frozen";
import { createRevision } from "@/server/revisions/revisions";
import { replacePeriodScope } from "@/server/periods/scope";
import { loadRenderInput, renderVsmeBasicPdf } from "../vsme-basic";
import { renderVsmeBasicXlsx } from "../xlsx";
import {
  renderPreview,
  renderRevision,
  getRender,
  listRenders,
  serialiseRender,
} from "../persist";

async function fixture() {
  const db = getTestDb();
  const company = await insertCompany({
    name: "Historical company",
    plan: "pro",
  });
  const { user } = await insertUserWithProfile({ companyId: company.id });
  const entity = await insertLegalEntity(company.id, {
    name: "Historical entity",
    country: "SI",
    turnover: "1000",
    registrationNumber: "OLD-REG",
    registeredAddress: "Historical address",
    ownershipPercentage: "75",
    consolidationMethod: "operational_control",
    groupStructureType: "subsidiary",
  });
  const excluded = await insertLegalEntity(company.id, {
    name: "Excluded historical entity",
  });
  const { period } = await insertPeriod(company.id, {
    legalEntityId: entity.id,
    periodName: "Historical period",
  });
  await insertPeriodScope(company.id, {
    periodId: period.id,
    legalEntityId: excluded.id,
    status: "excluded",
    exclusionReason: "Historical exclusion reason",
  });
  const revision = await insertRevision(company.id, {
    periodId: period.id,
    createdBy: user.id,
  });
  await insertEmissionActivity(company.id, {
    revisionId: revision.id,
    legalEntityId: entity.id,
    state: "approved",
    unit: "kWh_gross",
  });
  const calculated = await calculateRevision(db, company.id, revision);
  if (!calculated.ok) throw new Error("fixture calculation failed");
  const frozenScope = await buildFrozenScope(
    db,
    company.id,
    period.id,
    revision.id,
  );
  const [locked] = await db
    .update(reportRevision)
    .set({ status: "locked", frozenScope, lockedAt: new Date() })
    .where(eq(reportRevision.id, revision.id))
    .returning();
  return { db, company, user, entity, excluded, period, locked };
}
const options = (language: "en" | "sl") => ({
  language,
  generatedAt: new Date("2026-01-01T00:00:00Z"),
  coverage: {
    claim: "full" as const,
    completenessNote: null,
    excludedByPlan: [],
  },
});

setupDocumentsDir();

describeIntegration("historical render context [LOCAL-DB]", () => {
  beforeAll(setupSchema);
  beforeEach(resetAppTables);
  afterAll(closeTestDb);

  it("keeps both report languages/formats after restatement and registry changes", async () => {
    const f = await fixture();
    const before = await Promise.all(
      (["en", "sl"] as const).map((language) =>
        loadRenderInput(f.db, f.company.id, f.locked, options(language)),
      ),
    );
    const archived = await renderRevision(f.db, f.company.id, f.locked, {
      format: "pdf",
      language: "en",
      renderedBy: f.user.id,
      generatedAt: options("en").generatedAt,
    });
    if (!archived.ok) throw new Error("fixture archive failed");
    const archivedBytes = Buffer.from(
      await new Response(
        await documentStorage.getStream(archived.row.storageKey),
      ).arrayBuffer(),
    );
    const successor = await createRevision(
      f.db,
      f.company.id,
      f.period.id,
      { changeReason: "New report", seedFrom: f.locked.id },
      { userId: f.user.id, role: "esg_admin" },
    );
    if (!successor.ok) throw new Error("fixture restatement failed");
    const scope = await replacePeriodScope(
      f.db,
      f.company.id,
      f.period.id,
      [
        {
          legalEntityId: f.entity.id,
          status: "excluded",
          exclusionReason: "Successor reason",
        },
        {
          legalEntityId: f.excluded.id,
          status: "included",
          exclusionReason: null,
        },
      ],
      { userId: f.user.id, role: "esg_admin" },
    );
    expect(scope.ok).toBe(true);
    await f.db
      .update(companies)
      .set({ name: "Changed company", country: "RS", plan: "trial" })
      .where(eq(companies.id, f.company.id));
    await f.db
      .update(legalEntity)
      .set({
        name: "Changed entity",
        registrationNumber: "NEW-REG",
        registeredAddress: "Changed address",
        country: "RS",
        ownershipPercentage: "10",
      })
      .where(eq(legalEntity.id, f.entity.id));
    await f.db
      .update(reportingPeriod)
      .set({
        periodName: "Changed period",
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        reportingYear: 2025,
        baseYear: 2020,
        reportingBasis: "consolidated",
        methodologyVersion: "changed",
      })
      .where(eq(reportingPeriod.id, f.period.id));
    await f.db.insert(validationResult).values({
      companyId: f.company.id,
      revisionId: successor.row.id,
      ruleCode: "VAL-101",
      scope: "period",
      objectType: "reporting_period",
      objectId: f.period.id,
      severity: "error",
      passed: false,
      blocking: true,
      message: "Successor-only blocking failure",
    });
    for (const [index, language] of (["en", "sl"] as const).entries()) {
      const historical = await loadRenderInput(
        f.db,
        f.company.id,
        f.locked,
        options(language),
      );
      expect(historical).toEqual(before[index]);
      if (!historical) throw new Error("historical input missing");
      const pdf = await renderVsmeBasicPdf(historical);
      const xlsx = await renderVsmeBasicXlsx(historical);
      for (const report of [pdf, xlsx]) {
        expect(report.text).toContain("Historical company");
        expect(report.text).toContain("Historical exclusion reason");
        expect(report.text).toContain("OLD-REG");
        expect(report.text).not.toContain("Successor reason");
        expect(report.text).not.toContain("Changed company");
        expect(report.text).not.toContain("Changed address");
      }
      const preview = await renderPreview(
        f.db,
        f.company.id,
        f.locked,
        language,
      );
      expect(preview.gate).toBeNull();
      expect(preview.coverage).toEqual(historical.coverage);
    }
    const reexport = await renderRevision(f.db, f.company.id, f.locked, {
      format: "xlsx",
      language: "sl",
      renderedBy: f.user.id,
    });
    expect(reexport.ok).toBe(true);
    expect(
      await f.db
        .select()
        .from(reportRender)
        .where(eq(reportRender.id, archived.row.id)),
    ).toEqual([archived.row]);
    expect(
      Buffer.from(
        await new Response(
          await documentStorage.getStream(archived.row.storageKey),
        ).arrayBuffer(),
      ),
    ).toEqual(archivedBytes);
    expect(
      (await getRender(f.db, f.company.id, archived.row.id))?.periodName,
    ).toBe("Historical period");
    expect(
      (await listRenders(f.db, f.company.id)).every(
        (row) => !row.periodNameIsCurrent,
      ),
    ).toBe(true);
    const current = await loadRenderInput(
      f.db,
      f.company.id,
      successor.row,
      options("en"),
    );
    expect(current?.company.name).toBe("Changed company");
    expect(current?.period.name).toBe("Changed period");
    expect(
      current?.scope.find((row) => row.legalEntityId === f.entity.id)
        ?.exclusionReason,
    ).toBe("Successor reason");
    expect(current?.revision.frozen).toBe(false);
  });

  it("labels the current period name for legacy archives without changing their bytes", async () => {
    const f = await fixture();
    const archived = await renderRevision(f.db, f.company.id, f.locked, {
      format: "pdf",
      language: "en",
      renderedBy: f.user.id,
    });
    if (!archived.ok) throw new Error("fixture archive failed");
    const bytes = Buffer.from(
      await new Response(
        await documentStorage.getStream(archived.row.storageKey),
      ).arrayBuffer(),
    );
    const { render_context: _render, ...legacy } = f.locked
      .frozenScope as FrozenScope;
    await f.db
      .update(reportRevision)
      .set({ frozenScope: legacy })
      .where(eq(reportRevision.id, f.locked.id));
    await f.db
      .update(reportingPeriod)
      .set({ periodName: "Current archive period" })
      .where(eq(reportingPeriod.id, f.period.id));
    const loaded = await getRender(f.db, f.company.id, archived.row.id);
    expect(loaded).toMatchObject({
      periodName: "Current archive period",
      periodNameIsCurrent: true,
    });
    expect(await listRenders(f.db, f.company.id)).toEqual([loaded]);
    if (!loaded) throw new Error("archive missing");
    expect(serialiseRender(loaded)).toMatchObject({
      period_name: "Current archive period",
      period_name_is_current: true,
      file_name:
        "VSME-Basic_Current-archive-period_current-period-name_rev1_en.pdf",
    });
    expect(loaded.row).toEqual(archived.row);
    expect(
      Buffer.from(
        await new Response(
          await documentStorage.getStream(loaded.row.storageKey),
        ).arrayBuffer(),
      ),
    ).toEqual(bytes);
    expect(
      await getRender(f.db, (await insertCompany()).id, archived.row.id),
    ).toBeNull();
    expect(await listRenders(f.db, (await insertCompany()).id)).toEqual([]);
  });

  it("uses the run pinned at lock even after another calculation", async () => {
    const f = await fixture();
    const original = await loadRenderInput(
      f.db,
      f.company.id,
      f.locked,
      options("en"),
    );
    if (!original?.run) throw new Error("fixture original run missing");
    const later = await calculateRevision(f.db, f.company.id, f.locked);
    if (!later.ok) throw new Error("fixture later calculation failed");
    expect(later.run.runId).not.toBe(original.run.runId);
    const historical = await loadRenderInput(
      f.db,
      f.company.id,
      f.locked,
      options("en"),
    );
    expect(historical?.run?.runId).toBe(original.run.runId);
    expect(historical?.aggregates).toEqual(original.aggregates);
    const foreign = await insertCompany();
    expect(
      await loadRenderInput(f.db, foreign.id, f.locked, options("en")),
    ).toBeNull();
  });

  it("reconstructs legacy boundaries honestly without reading current descriptions", async () => {
    const f = await fixture();
    const { render_context: _context, ...legacyScope } = f.locked
      .frozenScope as FrozenScope;
    const [legacy] = await f.db
      .update(reportRevision)
      .set({ frozenScope: legacyScope })
      .where(eq(reportRevision.id, f.locked.id))
      .returning();
    await f.db
      .update(companies)
      .set({ name: "Current company must not leak" })
      .where(eq(companies.id, f.company.id));
    await f.db
      .update(legalEntity)
      .set({
        name: "Current entity must not leak",
        registeredAddress: "Current address must not leak",
      })
      .where(eq(legalEntity.id, f.entity.id));
    await f.db
      .update(reportingPeriod)
      .set({
        periodName: "Current period must not leak",
        startDate: "2025-01-01",
        endDate: "2025-12-31",
      })
      .where(eq(reportingPeriod.id, f.period.id));
    for (const language of ["en", "sl"] as const) {
      const input = await loadRenderInput(
        f.db,
        f.company.id,
        legacy,
        options(language),
      );
      if (!input) throw new Error("legacy input missing");
      expect(input.historicalContext).toBe("partial");
      expect(input.revision.frozen).toBe(true);
      expect(input.period.startDate).toBe(f.period.startDate);
      expect(input.period.reportingYear).toBeNull();
      expect(input.factorSet?.name).toBeNull();
      expect(input.factorSet?.sources.length).toBeGreaterThan(0);
      expect(
        input.scope.find((row) => row.legalEntityId === f.excluded.id)
          ?.exclusionReason,
      ).toBe("Historical exclusion reason");
      expect(
        input.scope.every(
          (row) =>
            row.registrationNumber === null && row.registeredAddress === null,
        ),
      ).toBe(true);
      const preview = await renderPreview(f.db, f.company.id, legacy, language);
      expect(preview.gate).toBeNull();
      expect(preview.coverage).toEqual(input.coverage);
      expect(preview.coverage.claim).toBe("partial");
      for (const rendered of [
        await renderVsmeBasicPdf(input),
        await renderVsmeBasicXlsx(input),
      ]) {
        expect(rendered.text).toContain(
          language === "en"
            ? "partial historical reconstruction"
            : "delna zgodovinska rekonstrukcija",
        );
        expect(rendered.text).not.toContain("must not leak");
        expect(rendered.text).not.toContain(f.excluded.id);
        expect(rendered.text).toContain("Historical exclusion reason");
      }
    }
  });

  it("retains the factor library descriptions captured at lock", async () => {
    const f = await fixture();
    const original = await loadRenderInput(
      f.db,
      f.company.id,
      f.locked,
      options("en"),
    );
    const [set] = await f.db
      .select()
      .from(factorSet)
      .where(eq(factorSet.id, f.period.factorSetId));
    try {
      await f.db
        .update(factorSet)
        .set({ name: "Changed factor set", status: "archived" })
        .where(eq(factorSet.id, set.id));
      const historical = await loadRenderInput(
        f.db,
        f.company.id,
        f.locked,
        options("en"),
      );
      expect(historical?.factorSet).toEqual(original?.factorSet);
    } finally {
      await f.db
        .update(factorSet)
        .set({ name: set.name, status: set.status })
        .where(eq(factorSet.id, set.id));
    }
  });

  it("does not claim a frozen report when no historical boundary exists", async () => {
    const f = await fixture();
    const [legacy] = await f.db
      .update(reportRevision)
      .set({ frozenScope: null })
      .where(eq(reportRevision.id, f.locked.id))
      .returning();
    expect(
      await loadRenderInput(f.db, f.company.id, legacy, options("en")),
    ).toBeNull();
    const preview = await renderPreview(f.db, f.company.id, legacy, "en");
    expect(preview.gate?.reason).toBe("historical_context_missing");
  });
});
