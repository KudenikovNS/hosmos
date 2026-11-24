// [LOCAL-DB] Подтверждённые дефекты ревью 06.11.2026
// (docs/reviews/2026-11-06_18-42-16_project.md, F01–F12).
// Дополнение 12.11.2026: ошибка завершения регистрации, docs/bug-tracker.md BUG-004.
//
// Каждый тест описывает ПРАВИЛЬНОЕ поведение. Пока дефект открыт, тест зелёный
// (см. `known-defect.ts`); после исправления он падает с просьбой заменить
// `knownDefect` на `regressionTest` (те же аргументы) — и с этого момента
// охраняет от регрессии. На голый `it` заменять нельзя: он не выполнит
// проверку, которую возвращает arrange.
//
// Идентификаторы — стабильные slug'и корневой причины, а не номера F01…: номера
// отчёта меняются от запуска к запуску, slug — нет. Соответствие указано в
// заголовке каждого блока.
//
// `describeIntegration` = `describe.skip` без DATABASE_URL. Harness делает
// TRUNCATE — запускать только на одноразовой базе:
//   scripts/review-db.sh run -- ./node_modules/.bin/vitest run src/server/__tests__/review
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { eq, inArray } from "drizzle-orm";
import { PgDatabase } from "drizzle-orm/pg-core";
import type { NextRequest } from "next/server";
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

const chargeMock = vi.fn();
const orderMock = vi.fn();
vi.mock("@/server/billing/revolut", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/billing/revolut")
  >("@/server/billing/revolut");
  return {
    ...actual,
    chargeSavedMethod: (...args: unknown[]) => chargeMock(...args),
    createOrder: (...args: unknown[]) => orderMock(...args),
  };
});

import { POST as registerPOST } from "@/app/api/register/route";
import { resolveSessionContext } from "@/server/auth/session";
import { runBillingCron } from "@/server/billing/cron";
import { calculateRevision, loadLatestRun } from "@/server/calc/run";
import { computeScope1 } from "@/server/calc/scope1";
import { convertUnit } from "@/server/calc/units";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertEmissionActivity,
  insertLegalEntity,
  insertPeriod,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  companyMembers,
  companySubscription,
  document,
  emissionFactor,
  factorSet,
  legalEntity,
  payments,
  reportRender,
  reportRevision,
  unitConversion,
} from "@/server/db/schema";
import { getAssessment, putAssessment } from "@/server/dq/assessments";
import { deleteDocument } from "@/server/evidence/documents";
import {
  createFactor,
  createFactorSet,
  parseNewFactor,
} from "@/server/factors/factor-sets";
import { editRow } from "@/server/inventory/rows";
import { updateLegalEntity } from "@/server/org/legal-entities";
import { replacePeriodScope } from "@/server/periods/scope";
import { loadReadiness } from "@/server/readiness/readiness";
import { loadRenderInput } from "@/server/render/vsme-basic";
import { buildFrozenScope } from "@/server/revisions/frozen";
import { createRevision } from "@/server/revisions/revisions";
import { LocalFilesystemDocumentStorage } from "@/server/storage/document-storage";

import { knownDefect, regressionTest } from "./known-defect";

// ─── Fixture ─────────────────────────────────────────────────────────────────

async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  if (!ctx.company) throw new Error("fixture user has no active company");
  return {
    userId,
    email: "u@example.com",
    name: "U",
    ...ctx,
    company: ctx.company,
  };
}

/** Компания с одним esg_admin, юрлицом (оборот 1000 EUR), периодом и черновой ревизией. */
async function baseFixture() {
  const company = await insertCompany();
  const { user } = await insertUserWithProfile({ companyId: company.id });
  const entity = await insertLegalEntity(company.id, {
    turnover: "1000",
    reportingCurrency: "EUR",
  });
  const { period } = await insertPeriod(company.id, {
    legalEntityId: entity.id,
  });
  const revision = await insertRevision(company.id, {
    periodId: period.id,
    createdBy: user.id,
  });
  const session = await sessionFor(user.id);
  getSessionMock.mockResolvedValue(session);
  const actor = { userId: user.id, role: "esg_admin" as const };
  return { company, user, entity, period, revision, session, actor };
}

type Fixture = Awaited<ReturnType<typeof baseFixture>>;

/** Заморозить и закрыть ревизию так, как это делает переход `lock`. */
async function lock(fx: Fixture) {
  const frozen = await buildFrozenScope(
    getTestDb(),
    fx.company.id,
    fx.period.id,
  );
  const [locked] = await getTestDb()
    .update(reportRevision)
    .set({ status: "locked", frozenScope: frozen })
    .where(eq(reportRevision.id, fx.revision.id))
    .returning();
  return locked;
}

/** Утверждённая строка без площадки — с `notes`, иначе её правку отклонит VAL-104. */
function approvedRow(fx: Fixture, overrides: { activityValue?: string } = {}) {
  return insertEmissionActivity(fx.company.id, {
    revisionId: fx.revision.id,
    legalEntityId: fx.entity.id,
    state: "approved",
    notes: "No site: review fixture",
    ...overrides,
  });
}

/** Отказ именно по правилу `code`, а не по любому другому. */
function refusedBy(result: unknown, code: string): boolean {
  const rules = (result as { rules?: readonly { code?: string }[] }).rules;
  return rules?.some((rule) => rule.code === code) ?? false;
}

describeIntegration("Известные дефекты ревью 06.11.2026", () => {
  let fx: Fixture;
  const createdFactorSetIds: string[] = [];

  beforeAll(setupSchema);
  beforeEach(async () => {
    await resetAppTables();
    chargeMock.mockReset();
    orderMock.mockReset();
    fx = await baseFixture();
  });
  afterEach(async () => {
    // resetAppTables сохраняет справочники. Удаляем только свои наборы;
    // их факторы и конверсии удаляются по ON DELETE CASCADE.
    if (createdFactorSetIds.length > 0) {
      await getTestDb()
        .delete(factorSet)
        .where(inArray(factorSet.id, createdFactorSetIds));
      createdFactorSetIds.length = 0;
    }
  });
  afterAll(closeTestDb);

  // ─── F01 · P1 · tenant isolation ───────────────────────────────────────────
  regressionTest(
    "dq-assessment-tenant-key",
    "оценка DQ общего фактора принадлежит своей компании",
    async () => {
      const other = await insertCompany();
      const { user: otherUser } = await insertUserWithProfile({
        companyId: other.id,
      });
      const [factor] = await getTestDb().select().from(emissionFactor).limit(1);
      const values = { isOverridden: false, overrideReason: null };

      const a = await putAssessment(
        getTestDb(),
        { companyId: fx.company.id, userId: fx.user.id },
        "emission_factor",
        factor.id,
        { ...values, reliabilityScore: 1 },
      );
      expect(a.ok).toBe(true);
      const b = await putAssessment(
        getTestDb(),
        { companyId: other.id, userId: otherUser.id },
        "emission_factor",
        factor.id,
        { ...values, reliabilityScore: 5 },
      );
      const ownA = await getAssessment(
        getTestDb(),
        fx.company.id,
        "emission_factor",
        factor.id,
      );
      const ownB = await getAssessment(
        getTestDb(),
        other.id,
        "emission_factor",
        factor.id,
      );

      return () => {
        expect(b.ok).toBe(true);
        expect(ownA?.reliabilityScore).toBe(1);
        expect(ownB?.reliabilityScore).toBe(5);
      };
    },
  );

  // ─── F02 · P1 · revision freeze ────────────────────────────────────────────
  regressionTest(
    "locked-revision-mutable-after-successor",
    "строка locked-ревизии не меняется после создания следующей черновой",
    async () => {
      const row = await approvedRow(fx);
      const locked = await lock(fx);
      const successor = await createRevision(
        getTestDb(),
        fx.company.id,
        fx.period.id,
        { seedFrom: locked.id, changeReason: "Restatement" },
        fx.actor,
      );
      expect(successor.ok).toBe(true);

      const edit = await editRow(
        getTestDb(),
        fx.session,
        "emission_activity",
        row.id,
        { values: { activityValue: "2000" }, changeReason: "edit locked row" },
      );

      // Отказ по ДРУГОМУ правилу означает, что фикстура не дошла до проверки
      // заморозки, а не что дефект исправлен (VAL-104 уже ловил это однажды).
      if (!edit.ok && !refusedBy(edit, "VAL-010")) {
        throw new Error(
          `fixture: refused for another reason ${JSON.stringify(edit)}`,
        );
      }

      return () => expect(edit.ok).toBe(false);
    },
  );

  // ─── F03 · P1 · reproducibility ────────────────────────────────────────────
  regressionTest(
    "historical-intensity-reads-live-registry",
    "интенсивность locked-расчёта не меняется от правки оборота юрлица",
    async () => {
      await approvedRow(fx);
      const locked = await lock(fx);
      const first = await calculateRevision(getTestDb(), fx.company.id, locked);
      if (!first.ok) throw new Error("fixture: calculation failed");

      const updated = await updateLegalEntity(
        getTestDb(),
        fx.company.id,
        fx.entity.id,
        { turnover: "2000" },
      );
      expect(updated.ok).toBe(true);
      const latest = await loadLatestRun(getTestDb(), fx.company.id, locked);
      if (!latest) throw new Error("fixture: no stored run");

      return () =>
        expect(latest.aggregates.intensity.locationBasedIntensity).toBe(
          first.aggregates.intensity.locationBasedIntensity,
        );
    },
  );

  // ─── F04 · P1 · reproducibility ────────────────────────────────────────────
  regressionTest(
    "render-ignores-frozen-scope",
    "рендер locked-ревизии использует замороженную границу, а не живую",
    async () => {
      await approvedRow(fx);
      const locked = await lock(fx);
      await calculateRevision(getTestDb(), fx.company.id, locked);
      const successor = await createRevision(
        getTestDb(),
        fx.company.id,
        fx.period.id,
        { changeReason: "restatement" },
        fx.actor,
      );
      expect(successor.ok).toBe(true);
      const scope = await replacePeriodScope(
        getTestDb(),
        fx.company.id,
        fx.period.id,
        [
          {
            legalEntityId: fx.entity.id,
            status: "excluded",
            exclusionReason: "New boundary",
          },
        ],
        fx.actor,
      );
      expect(scope.ok).toBe(true);

      const input = await loadRenderInput(getTestDb(), fx.company.id, locked, {
        language: "en",
        coverage: { claim: "full", completenessNote: null, excludedByPlan: [] },
      });
      if (!input) throw new Error("fixture: no render input");

      return () => expect(input.scope[0]?.status).toBe("included");
    },
  );

  // ─── F05 · P1 · calculations ───────────────────────────────────────────────
  regressionTest(
    "factor-set-copy-drops-conversions",
    "копия набора факторов сохраняет его set-scoped конверсии",
    async () => {
      const [original] = await getTestDb()
        .select()
        .from(factorSet)
        .where(eq(factorSet.code, "si-2025-r5"));
      if (!original) throw new Error("fixture: si-2025-r5 is not seeded");
      const copy = await createFactorSet(getTestDb(), {
        code: `review-copy-${randomUUID()}`,
        name: "Copy",
        copyFrom: original.id,
      });
      if (!copy.ok) throw new Error("fixture: copy failed");
      createdFactorSetIds.push(copy.row.id);

      const conversions = await getTestDb().select().from(unitConversion);
      const from = convertUnit(
        "kWh",
        "kWh_net",
        "natural_gas",
        original.id,
        conversions,
      );
      const to = convertUnit(
        "kWh",
        "kWh_net",
        "natural_gas",
        copy.row.id,
        conversions,
      );
      if (from.status !== "ok")
        throw new Error("fixture: no source conversion");

      return () => {
        expect(to.status).toBe("ok");
        if (to.status === "ok")
          expect(to.conversion.multiplier).toBe(from.conversion.multiplier);
      };
    },
  );

  // ─── F06 · P1 · calculations ───────────────────────────────────────────────
  regressionTest(
    "factor-output-unit-not-normalised",
    "фактор в tCO2e принимается и пересчитывается в кг",
    async () => {
      const set = await createFactorSet(getTestDb(), {
        code: `review-output-${randomUUID()}`,
        name: "Output",
      });
      if (!set.ok) throw new Error("fixture: set");
      createdFactorSetIds.push(set.row.id);
      const parsed = parseNewFactor({
        factor_code: "review",
        factor_name: "Test",
        source_name: "review",
        source_version: "1",
        geography: "GLOBAL",
        activity_type: "natural_gas",
        input_unit: "kWh",
        factor_value: 1,
        output_unit: "tCO2e",
        status: "active",
      });
      if (!parsed.ok) throw new Error("fixture: tCO2e must be supported");
      const factor = await createFactor(
        getTestDb(),
        fx.company.id,
        set.row.id,
        parsed.values,
      );
      if (!factor.ok) throw new Error("fixture: tCO2e must be saved");

      const row = await approvedRow(fx, { activityValue: "1" });
      const result = computeScope1(
        [{ ...row, geography: "GLOBAL" }],
        [factor.row],
        [],
        {
          startDate: fx.period.startDate,
          endDate: fx.period.endDate,
          factorSetId: set.row.id,
        },
      );

      // 1 kWh × 1 tCO2e/kWh = 1000 kgCO2e
      return () => expect(Number(result.lines[0]?.co2eResult)).toBe(1000);
    },
  );

  // ─── F07 · P1 · billing ────────────────────────────────────────────────────
  knownDefect(
    "mit-charge-pending-marked-completed",
    "незавершённый MIT-платёж не продлевает подписку",
    async () => {
      const now = new Date();
      const day = 86_400_000;
      await getTestDb()
        .insert(companySubscription)
        .values({
          companyId: fx.company.id,
          planId: "starter",
          period: "annual",
          status: "active",
          currentPeriodStart: new Date(now.getTime() - 366 * day),
          currentPeriodEnd: new Date(now.getTime() - day),
          revolutCustomerId: "review-customer",
          savedPaymentMethodId: "review-method",
        });
      orderMock.mockResolvedValue({
        id: "review-order",
        state: "pending",
        token: "test",
        type: "payment",
      });
      chargeMock.mockResolvedValue({
        id: "review-payment",
        order_id: "review-order",
        state: "pending",
      });

      const summary = await runBillingCron(now);
      const [payment] = await getTestDb()
        .select()
        .from(payments)
        .where(eq(payments.companyId, fx.company.id));

      return () => {
        expect(summary.renewed).toBe(0);
        expect(payment?.status).not.toBe("completed");
      };
    },
  );

  // ─── F08 · P1 · evidence/storage ───────────────────────────────────────────
  describe("blob storage", () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "hosmos-known-defects-"));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    regressionTest(
      "evidence-delete-removes-shared-render-blob",
      "удаление evidence не удаляет файл сохранённого отчёта с теми же байтами",
      async () => {
        const storage = new LocalFilesystemDocumentStorage(root);
        const stored = await storage.put(
          new TextEncoder().encode("%PDF-review-shared-bytes"),
          { companyId: fx.company.id },
        );
        await getTestDb().insert(reportRender).values({
          companyId: fx.company.id,
          revisionId: fx.revision.id,
          format: "pdf",
          language: "en",
          storageKey: stored.key,
          fileHash: stored.sha256,
          coverageClaim: "full",
          disclaimerText: "test",
          calcRunId: randomUUID(),
          renderedBy: fx.user.id,
        });
        const [doc] = await getTestDb()
          .insert(document)
          .values({
            companyId: fx.company.id,
            fileName: "reuploaded-report.pdf",
            fileType: "pdf",
            storageKey: stored.key,
            sizeBytes: stored.sizeBytes,
            fileHash: stored.sha256,
            uploadedBy: fx.user.id,
          })
          .returning();

        await deleteDocument(getTestDb(), fx.company.id, doc.id, storage);
        const blob = await storage.stat(stored.key);

        return () => expect(blob).not.toBeNull();
      },
    );
  });

  // ─── F11 · P2 · plan limits ────────────────────────────────────────────────
  regressionTest(
    "register-bypasses-max-companies",
    "повторная регистрация не создаёт вторую компанию сверх maxCompanies",
    async () => {
      const { user } = await insertUserWithProfile();
      getSessionMock.mockResolvedValue({
        userId: user.id,
        email: user.email,
        name: user.name,
        ...(await resolveSessionContext(getTestDb(), user.id)),
      });
      for (const name of ["Review A", "Review B"]) {
        const req = new Request("http://localhost/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ company: name }),
        }) as unknown as NextRequest;
        await registerPOST(req);
      }
      const memberships = await getTestDb()
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.userId, user.id));

      return () => expect(memberships.length).toBeLessThanOrEqual(1);
    },
  );

  // ─── BUG-004 · P1 · registration failure ───────────────────────────────────
  regressionTest(
    "register-company-failure-reported-as-success",
    "ошибка создания компании не считается успешным завершением регистрации",
    async () => {
      const { user } = await insertUserWithProfile();
      getSessionMock.mockResolvedValue({
        userId: user.id,
        email: user.email,
        name: user.name,
        ...(await resolveSessionContext(getTestDb(), user.id)),
      });
      const insertError = new Error("review: company insert failed");
      // The company write runs on the transaction's `tx`, so the spy sits on the
      // shared prototype rather than on the pool instance.
      const insertSpy = vi
        .spyOn(PgDatabase.prototype, "insert")
        .mockImplementationOnce(() => {
          throw insertError;
        });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let response: Response;

      try {
        response = await registerPOST(
          new Request("http://localhost/api/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ company: "Review registration company" }),
          }) as unknown as NextRequest,
        );
        // The failure must be the intended company write, not session setup
        // or request validation; a setup error must not count as a live defect.
        expect(insertSpy).toHaveBeenCalledOnce();
        expect(errorSpy).toHaveBeenCalledWith(
          "POST /api/register: company create/link failed:",
          insertError,
        );
      } finally {
        insertSpy.mockRestore();
        errorSpy.mockRestore();
      }

      const context = await resolveSessionContext(getTestDb(), user.id);
      expect(context.company).toBeNull();
      expect(context.membership).toBeNull();
      const body = await response.json();

      return () => {
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(body.ok).toBe(false);
      };
    },
  );

  // ─── F12 · P2 · readiness ──────────────────────────────────────────────────
  regressionTest(
    "readiness-intensity-checks-any-field",
    "VSME-032 не считается готовой без значения интенсивности",
    async () => {
      await getTestDb()
        .update(legalEntity)
        .set({ turnover: null })
        .where(eq(legalEntity.id, fx.entity.id));
      await approvedRow(fx);
      const calc = await calculateRevision(
        getTestDb(),
        fx.company.id,
        fx.revision,
      );
      if (!calc.ok) throw new Error("fixture: calculation failed");
      expect(calc.aggregates.intensity.locationBasedIntensity).toBeNull();

      const readiness = await loadReadiness(getTestDb(), fx.company.id);
      const metric = readiness.disclosures
        .flatMap((d) => d.datapoints)
        .find((d) => d.metric_key === "VSME-032");
      if (!metric) throw new Error("fixture: VSME-032 not in readiness");

      return () => expect(metric.status).not.toBe("ready");
    },
  );

  // The other half of F12: the fix must not make VSME-032 unreachable. With the
  // fixture's turnover in place the quotient exists, and the datapoint is ready.
  it("VSME-032 готова, когда интенсивность посчитана", async () => {
    await approvedRow(fx);
    const calc = await calculateRevision(
      getTestDb(),
      fx.company.id,
      fx.revision,
    );
    if (!calc.ok) throw new Error("fixture: calculation failed");
    expect(calc.aggregates.intensity.locationBasedIntensity).not.toBeNull();

    const readiness = await loadReadiness(getTestDb(), fx.company.id);
    const metric = readiness.disclosures
      .flatMap((d) => d.datapoints)
      .find((d) => d.metric_key === "VSME-032");
    expect(metric?.status).toBe("ready");
  });
});
