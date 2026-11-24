// F04: the render's mutable inputs, captured at lock. Numbers remain owned by
// the pinned F03 run; locale, format and generation time remain render inputs.
import type { ReportLanguage } from "@/i18n/locales";
import type { DbClient } from "@/server/db/client";
import type { FacilityGateVerdict } from "@/server/periods/plan-gate";
import type { FrozenScope } from "@/server/revisions/frozen";
import type { RevisionRow } from "@/server/revisions/revisions";
import { isReportingBasis } from "@/shared/enums";
import type { RenderCoverage } from "./disclaimer";
import { renderContext } from "./i18n";
import type { RenderInput } from "./sections";

type RenderMetadata = Omit<
  RenderInput,
  | "language"
  | "generatedAt"
  | "revision"
  | "run"
  | "aggregates"
  | "historicalContext"
>;

export interface HistoricalRenderContext {
  readonly version: 1;
  readonly company_id: string;
  readonly revision_id: string;
  readonly captured_at: string;
  readonly run_id: string | null;
  readonly lock_gate: FacilityGateVerdict;
  readonly data: Readonly<Record<ReportLanguage, RenderMetadata>>;
}

/** Even legacy exports must have a real historical period and boundary. */
export function frozenRenderBoundary(
  revision: RevisionRow,
): FrozenScope | null {
  const frozen = revision.frozenScope as FrozenScope | null;
  if (
    revision.status !== "locked" ||
    frozen?.version !== 1 ||
    frozen.period_id !== revision.periodId ||
    !Array.isArray(frozen.scope) ||
    typeof frozen.period?.start_date !== "string" ||
    typeof frozen.period.end_date !== "string" ||
    typeof frozen.period.factor_set_id !== "string" ||
    !isReportingBasis(frozen.period.reporting_basis)
  )
    return null;
  return frozen;
}

export function historicalRenderContext(
  companyId: string,
  revision: RevisionRow,
): HistoricalRenderContext | null {
  if (revision.companyId !== companyId) return null;
  const context = frozenRenderBoundary(revision)?.render_context;
  return context?.version === 1 &&
    context.company_id === companyId &&
    context.revision_id === revision.id &&
    context.data?.en?.period?.id === revision.periodId &&
    context.data.sl?.period?.id === revision.periodId &&
    Array.isArray(context.data.en.scope) &&
    Array.isArray(context.data.sl.scope) &&
    context.data.en.coverage &&
    context.data.sl.coverage &&
    context.lock_gate &&
    (context.run_id === null || typeof context.run_id === "string")
    ? context
    : null;
}

/** Coverage is part of the historical report, not today's subscription/registry. */
export function historicalRenderCoverage(
  companyId: string,
  revision: RevisionRow,
  language: ReportLanguage,
): RenderCoverage | null {
  if (revision.status !== "locked") return null;
  return (
    historicalRenderContext(companyId, revision)?.data[language].coverage ?? {
      claim: "partial",
      excludedByPlan: [],
      completenessNote: renderContext(language).t("history.partial"),
    }
  );
}

/** Called inside the lock transaction, before the revision changes to locked. */
export async function captureHistoricalRenderContext(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
): Promise<HistoricalRenderContext> {
  // Keep the state-machine import independent of the PDF renderer at startup.
  const [{ loadLiveRenderInput }, { planCoverage }, { facilityGateVerdict }] =
    await Promise.all([
      import("./vsme-basic"),
      import("./persist"),
      import("@/server/periods/plan-gate"),
    ]);
  const capture = async (language: ReportLanguage) => {
    const input = await loadLiveRenderInput(db, companyId, revision, {
      language,
      coverage: await planCoverage(db, companyId, language),
    });
    if (!input) throw new Error("render context: company or period not found");
    const {
      language: _language,
      generatedAt: _generated,
      revision: _revision,
      run,
      aggregates: _aggregates,
      historicalContext: _history,
      ...metadata
    } = input;
    return { runId: run?.runId ?? null, metadata };
  };
  const en = await capture("en");
  const sl = await capture("sl");
  if (en.runId !== sl.runId)
    throw new Error("render context: calculation changed during capture");
  return {
    version: 1,
    company_id: companyId,
    revision_id: revision.id,
    captured_at: new Date().toISOString(),
    run_id: en.runId,
    lock_gate: await facilityGateVerdict(db, companyId, revision.periodId),
    data: { en: en.metadata, sl: sl.metadata },
  };
}
