/**
 * VSME readiness (stage 1, 13.08.2026 §5.2) — where does the company stand on
 * every applicable Basic datapoint, and what is the next thing to do.
 *
 * ── WHAT THIS IS BUILT FROM ─────────────────────────────────────────────────
 * Nothing new. The catalogue (`metric_catalog`), the current revision's
 * `disclosure_record`s, evidence links on them, the `disclosure_applicability`
 * decisions (0016), the organisation (for B1) and the latest calculation run
 * (for B3). The one judgement — which status a datapoint has — is the pure
 * function in `./status.ts`, tested on its own.
 *
 * ── B1 AND B3 ARE DERIVED, LIKE IN THE REPORT ───────────────────────────────
 * The renderer (`render/sections.ts`) prints B1 from the organisation and B3
 * from the calculation rather than from typed answers; readiness judges the
 * same datapoints from the same sources, so "ready" here means "the report can
 * print it". A B1 datapoint the organisation has no column for (legal form,
 * balance-sheet total) is typed like any other — `DERIVED` simply has no entry
 * for it.
 *
 * ── THE JOURNEY ─────────────────────────────────────────────────────────────
 * The eight steps of the stage-1 user flow (§7), each `done` / `current` /
 * `todo`, derived from the same facts. `current` is the first step not done;
 * every screen the steps point at already exists.
 */
import {
  conditionTexts,
  type ConditionTexts,
} from "@/server/catalog/metric-text";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { loadCompanyModules } from "@/server/billing/modules";
import { loadLatestRun } from "@/server/calc/run";
import type { DbClient } from "@/server/db/client";
import {
  disclosureApplicability,
  disclosureRecord,
  evidenceLink,
  facility,
  legalEntity,
  metricCatalog,
  periodScope,
  reportRender,
  type reportRevision,
} from "@/server/db/schema";
import { countInventory } from "@/server/inventory/inventory";
import { loadCurrentRevision } from "@/server/periods/lifecycle";
import { listPeriods } from "@/server/periods/periods";
import { getRevision } from "@/server/revisions/revisions";
import type { WorkflowStatus } from "@/shared/enums";
import type { PlanId } from "@/shared/plans";

import {
  datapointStatus,
  emptyCounts,
  isApplicable,
  readinessPercent,
  type DatapointStatus,
  type RequirementType,
  type StatusCounts,
} from "./status";

type DatapointSource =
  "plan" | "period" | "organisation" | "calculation" | "disclosure";

export interface ReadinessDatapoint {
  readonly metric_key: string;
  readonly title_en: string;
  readonly title_sl: string | null;
  readonly requirement_type: RequirementType;
  readonly value_type: string;
  readonly status: DatapointStatus;
  readonly source: DatapointSource;
  readonly record_id: string | null;
  readonly evidence_count: number;
  /** The stored reason of a `not_applicable` / `sensitive_omitted` decision. */
  readonly reason: string | null;
  /** Where the datapoint is worked on. */
  readonly href: string;
  /**
   * 0019 — the simplified-ESRS disclosure this datapoint also serves
   * (`ESRS E1-7`), or `null` for the 20 VSME-only datapoints. On an ESRS
   * datapoint it names the datapoint's own disclosure.
   */
  readonly esrs_reference: string | null;
  /** The catalogue's applicability condition («If climate material»). */
  readonly applicability_condition: string | null;
  /** Партия 18 — the same condition per UI language (`conditionTexts`). */
  readonly applicability_text: ConditionTexts | null;
}

type ReadinessModule = "basic" | "comprehensive" | "simplified_esrs";

export interface ReadinessDisclosure {
  readonly code: string;
  readonly module: ReadinessModule;
  readonly title_en: string;
  readonly title_sl: string | null;
  readonly datapoints: readonly ReadinessDatapoint[];
  readonly counts: StatusCounts;
  readonly applicable: number;
  readonly percent: number;
  readonly href: string;
}

const JOURNEY_STEPS = [
  "organisation",
  "boundary",
  "applicability",
  "data",
  "evidence",
  "calculation",
  "review",
  "report",
] as const;
export type JourneyStepId = (typeof JOURNEY_STEPS)[number];

export interface JourneyStep {
  readonly id: JourneyStepId;
  readonly state: "done" | "current" | "todo";
  readonly href: string;
}

export interface ReadinessDto {
  readonly has_legal_entity: boolean;
  readonly period: {
    readonly id: string;
    readonly name: string;
    readonly start_date: string;
    readonly end_date: string;
    readonly reporting_year: number;
    readonly reporting_basis: string;
  } | null;
  readonly revision: {
    readonly id: string;
    readonly revision_no: number;
    readonly status: WorkflowStatus;
  } | null;
  readonly plan: {
    readonly id: PlanId;
    readonly module: "basic" | "basic_comprehensive";
    /** 0021 — the plan includes the simplified-ESRS layer. */
    readonly simplified_esrs: boolean;
  };
  readonly summary: ReadinessSummary;
  readonly disclosures: readonly ReadinessDisclosure[];
  readonly journey: readonly JourneyStep[];
  readonly next: JourneyStepId | null;
  /** Decisions may be recorded — there is a current revision and it is not locked. */
  readonly can_decide: boolean;
  /**
   * The simplified-ESRS block (партия 9). Always present, so the hub can show
   * what the layer contains on a plan that does not have it: the count of the
   * additional datapoints and how many VSME datapoints already map onto ESRS.
   */
  readonly esrs: EsrsReadiness;
}

type ReadinessSummary = StatusCounts & {
  readonly applicable: number;
  readonly percent: number;
};

/** How the VSME datapoints cover the simplified ESRS (0019's mapping). */
interface EsrsCoverage {
  /** VSME datapoints that carry an `esrs_reference` (121 of 141). */
  readonly vsme_mapped: number;
  /** …of which `ready`. */
  readonly vsme_mapped_ready: number;
  /** ESRS-only datapoints (50). */
  readonly additional: number;
}

type EsrsReadiness =
  | {
      readonly available: false;
      readonly required_plan: PlanId;
      readonly coverage: EsrsCoverage;
    }
  | {
      readonly available: true;
      /** The catalogue's regulatory note (C(2026)5010 adopted, not in force). */
      readonly regulatory_status: string | null;
      readonly coverage: EsrsCoverage;
      readonly summary: ReadinessSummary;
      readonly disclosures: readonly ReadinessDisclosure[];
    };

type RevisionRow = typeof reportRevision.$inferSelect;

/** What the organisation and the calculation say, for the derived datapoints. */
interface DerivedFacts {
  readonly module: "basic" | "basic_comprehensive";
  readonly reportingBasis: string;
  readonly root: typeof legalEntity.$inferSelect | null;
  readonly includedEntities: number;
  readonly includedWithAddress: number;
  readonly facilities: readonly (typeof facility.$inferSelect)[];
  readonly run: Awaited<ReturnType<typeof loadLatestRun>>;
}

type Presence = "present" | "missing";
const present = (v: unknown): Presence =>
  v === null || v === undefined || v === "" ? "missing" : "present";

/**
 * The derived datapoints, by metric key, and what "present" means for each.
 * Keys are the catalogue's (`seed-data/vsme-metrics.json`); a key that is not
 * here is a typed datapoint. Keep this in the same order as the catalogue.
 */
const DERIVED: Readonly<
  Record<
    string,
    { source: DatapointSource; check: (f: DerivedFacts) => Presence }
  >
> = {
  // B1 §24(a) — the module option is the plan's, not an answer.
  "VSME-001": { source: "plan", check: () => "present" },
  // B1 §24(c) — individual or consolidated: the period says.
  "VSME-003": { source: "period", check: (f) => present(f.reportingBasis) },
  // B1 §24(c) — the subsidiaries and their addresses come from the boundary.
  "VSME-004": {
    source: "organisation",
    check: (f) =>
      f.reportingBasis === "consolidated"
        ? f.includedEntities >= 2
          ? "present"
          : "missing"
        : "present",
  },
  "VSME-005": {
    source: "organisation",
    check: (f) =>
      f.reportingBasis === "consolidated"
        ? f.includedWithAddress === f.includedEntities && f.includedEntities > 0
          ? "present"
          : "missing"
        : "present",
  },
  "VSME-007": {
    source: "organisation",
    check: (f) => present(f.root?.naceCode),
  },
  "VSME-009": {
    source: "organisation",
    check: (f) => present(f.root?.turnover),
  },
  "VSME-010": {
    source: "organisation",
    check: (f) =>
      f.root && (f.root.employeeCount !== null || f.root.averageFte !== null)
        ? "present"
        : "missing",
  },
  "VSME-011": {
    source: "organisation",
    check: (f) => present(f.root?.country),
  },
  "VSME-012": {
    source: "organisation",
    check: (f) => (f.facilities.length > 0 ? "present" : "missing"),
  },
  "VSME-013": {
    source: "organisation",
    check: (f) =>
      f.facilities.length > 0 &&
      f.facilities.every((s) => s.latitude !== null && s.longitude !== null)
        ? "present"
        : "missing",
  },
  // B3 §29–§31 — the energy split, the totals and the intensity of the latest
  // completed run. A failed run yields nothing (§0.7 forbids a partial total).
  "VSME-023": {
    source: "calculation",
    check: (f) => energy(f, "renewableMwh"),
  },
  "VSME-024": {
    source: "calculation",
    check: (f) => energy(f, "nonRenewableMwh"),
  },
  "VSME-025": {
    source: "calculation",
    check: (f) => energy(f, "renewableMwh"),
  },
  "VSME-026": {
    source: "calculation",
    check: (f) => energy(f, "nonRenewableMwh"),
  },
  "VSME-027": {
    source: "calculation",
    check: (f) => energy(f, "renewableMwh"),
  },
  "VSME-028": {
    source: "calculation",
    check: (f) => energy(f, "nonRenewableMwh"),
  },
  "VSME-029": { source: "calculation", check: (f) => energy(f, "totalMwh") },
  "VSME-030": { source: "calculation", check: (f) => totals(f, "scope1Co2e") },
  "VSME-031": {
    source: "calculation",
    check: (f) => totals(f, "scope2LocationBasedCo2e"),
  },
  // GHG intensity = (Scope 1 + Scope 2 location-based) ÷ turnover in EUR (the
  // catalogue's definition). Only that quotient answers the datapoint: the
  // emissions numerator and `fxYear` are filled for every ok run, so asking
  // "is anything in the intensity block set" would call a missing turnover,
  // currency or FX rate ready.
  "VSME-032": {
    source: "calculation",
    check: (f) => {
      const run = f.run;
      if (!run || run.aggregates.status !== "ok") return "missing";
      return present(run.aggregates.intensity?.locationBasedIntensity);
    },
  },
};

function energy(
  f: DerivedFacts,
  key: "totalMwh" | "renewableMwh" | "nonRenewableMwh",
): Presence {
  const run = f.run;
  if (!run || run.aggregates.status !== "ok") return "missing";
  return present(run.aggregates.energy[key]);
}

function totals(
  f: DerivedFacts,
  key: "scope1Co2e" | "scope2LocationBasedCo2e",
): Presence {
  const run = f.run;
  if (!run || run.aggregates.status !== "ok") return "missing";
  return present(run.aggregates.totals[key]);
}

const QUANTITATIVE = new Set(["integer", "decimal", "percentage"]);

/** Where each disclosure is worked on. B1 and B3 are derived; the rest typed. */
function disclosureHref(code: string): string {
  if (code === "B1") return "/organisation";
  if (code === "B3") return "/inventory";
  return `/inventory/disclosures#${code}`;
}

/** The cheapest plan (by `PLAN_ORDER`) that includes the ESRS layer. */
const ESRS_REQUIRED_PLAN: PlanId = "pro";

type MetricRow = typeof metricCatalog.$inferSelect;

/** Datapoints grouped into disclosures, in catalogue order, with their counts. */
function groupDisclosures(
  datapoints: readonly ReadinessDatapoint[],
  meta: ReadonlyMap<
    string,
    { module: ReadinessModule; title_en: string; title_sl: string | null }
  >,
  disclosureCodeOf: (datapoint: ReadinessDatapoint) => string,
): { disclosures: ReadinessDisclosure[]; summary: ReadinessSummary } {
  const byCode = new Map<string, ReadinessDatapoint[]>();
  for (const datapoint of datapoints) {
    const code = disclosureCodeOf(datapoint);
    const list = byCode.get(code);
    if (list) list.push(datapoint);
    else byCode.set(code, [datapoint]);
  }
  const counts = emptyCounts();
  const disclosures: ReadinessDisclosure[] = [...byCode.entries()].map(
    ([code, list]) => {
      const own = emptyCounts();
      for (const d of list) {
        own[d.status] += 1;
        counts[d.status] += 1;
      }
      const m = meta.get(code)!;
      return {
        code,
        module: m.module,
        title_en: m.title_en,
        title_sl: m.title_sl,
        datapoints: list,
        counts: own,
        applicable: list.filter((d) => isApplicable(d.status)).length,
        percent: readinessPercent(own),
        href: disclosureHref(code),
      };
    },
  );
  const applicable = disclosures.reduce((n, d) => n + d.applicable, 0);
  return {
    disclosures,
    summary: { ...counts, applicable, percent: readinessPercent(counts) },
  };
}

export async function loadReadiness(
  db: DbClient,
  companyId: string,
): Promise<ReadinessDto> {
  const modules = await loadCompanyModules(db, companyId);
  const plan = {
    id: modules.planId,
    module: modules.comprehensive
      ? ("basic_comprehensive" as const)
      : ("basic" as const),
    simplified_esrs: modules.simplifiedEsrs,
  };
  const periods = await listPeriods(db, companyId);
  const newest = periods[periods.length - 1] ?? null;
  const current = newest
    ? await loadCurrentRevision(db, companyId, newest.id)
    : undefined;
  const revision: RevisionRow | undefined = current
    ? await getRevision(db, companyId, current.id)
    : undefined;

  const [entities, sites, scope, metrics] = await Promise.all([
    db
      .select()
      .from(legalEntity)
      .where(eq(legalEntity.companyId, companyId))
      .orderBy(asc(legalEntity.createdAt)),
    db
      .select()
      .from(facility)
      .where(
        and(
          eq(facility.companyId, companyId),
          eq(facility.includedInBoundary, true),
        ),
      ),
    newest
      ? db
          .select({
            legalEntityId: periodScope.legalEntityId,
            status: periodScope.status,
            registeredAddress: legalEntity.registeredAddress,
          })
          .from(periodScope)
          .innerJoin(legalEntity, eq(legalEntity.id, periodScope.legalEntityId))
          .where(
            and(
              eq(periodScope.companyId, companyId),
              eq(periodScope.periodId, newest.id),
            ),
          )
      : Promise.resolve([]),
    db
      .select()
      .from(metricCatalog)
      .where(
        and(
          eq(metricCatalog.isActive, true),
          or(
            // The VSME rows the plan's module covers …
            and(
              eq(metricCatalog.standard, "vsme"),
              plan.module === "basic_comprehensive"
                ? inArray(metricCatalog.module, ["basic", "comprehensive"])
                : eq(metricCatalog.module, "basic"),
            ),
            // … and the 50 simplified-ESRS rows (0019) on a plan that has the
            // layer (0021). Without it they are counted, not judged.
            plan.simplified_esrs
              ? eq(metricCatalog.standard, "esrs")
              : sql`false`,
          ),
        ),
      )
      .orderBy(asc(metricCatalog.sortOrder), asc(metricCatalog.metricKey)),
  ]);
  const esrsTotal = plan.simplified_esrs
    ? metrics.filter((m) => m.standard === "esrs").length
    : ((
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(metricCatalog)
          .where(
            and(
              eq(metricCatalog.standard, "esrs"),
              eq(metricCatalog.isActive, true),
            ),
          )
      )[0]?.n ?? 0);

  const [records, decisions, run, renders, rowCounts] = revision
    ? await Promise.all([
        db
          .select()
          .from(disclosureRecord)
          .where(
            and(
              eq(disclosureRecord.companyId, companyId),
              eq(disclosureRecord.revisionId, revision.id),
              isNull(disclosureRecord.supersededById),
              eq(disclosureRecord.isDeleted, false),
            ),
          ),
        db
          .select()
          .from(disclosureApplicability)
          .where(
            and(
              eq(disclosureApplicability.companyId, companyId),
              eq(disclosureApplicability.revisionId, revision.id),
            ),
          ),
        loadLatestRun(db, companyId, revision),
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(reportRender)
          .where(
            and(
              eq(reportRender.companyId, companyId),
              eq(reportRender.revisionId, revision.id),
            ),
          ),
        countInventory(db, companyId, { revisionId: revision.id }),
      ])
    : [[], [], null, [{ n: 0 }], null];

  const evidenceCounts = new Map<string, number>();
  if (records.length > 0) {
    const links = await db
      .select({
        objectId: evidenceLink.linkedObjectId,
        n: sql<number>`count(*)::int`,
      })
      .from(evidenceLink)
      .where(
        and(
          eq(evidenceLink.companyId, companyId),
          eq(evidenceLink.linkedObjectType, "disclosure_record"),
          inArray(
            evidenceLink.linkedObjectId,
            records.map((r) => r.id),
          ),
        ),
      )
      .groupBy(evidenceLink.linkedObjectId);
    for (const link of links) evidenceCounts.set(link.objectId, link.n);
  }

  const included = scope.filter((s) => s.status === "included");
  const facts: DerivedFacts = {
    module: plan.module,
    reportingBasis: newest?.reportingBasis ?? "individual",
    root:
      entities.find((e) => e.parentLegalEntityId === null) ??
      entities[0] ??
      null,
    includedEntities: included.length,
    includedWithAddress: included.filter((s) => s.registeredAddress).length,
    facilities: sites,
    run,
  };
  const recordByMetric = new Map(records.map((r) => [r.metricKey, r]));
  const decisionByMetric = new Map(decisions.map((d) => [d.metricKey, d]));

  const meta = new Map<
    string,
    { module: ReadinessModule; title_en: string; title_sl: string | null }
  >();
  const codeOf = new Map<string, string>();
  const evaluate = (metric: MetricRow): ReadinessDatapoint => {
    const derived = DERIVED[metric.metricKey];
    const record = recordByMetric.get(metric.metricKey);
    const decision = decisionByMetric.get(metric.metricKey);
    const hasValue =
      !!record &&
      (record.valueNumeric !== null ||
        record.valueText !== null ||
        record.valueBoolean !== null ||
        record.valueDate !== null ||
        record.valueJson !== null);
    const evidence = record ? (evidenceCounts.get(record.id) ?? 0) : 0;
    const status = datapointStatus({
      requirement: metric.requirementType as RequirementType,
      quantitative: QUANTITATIVE.has(metric.valueType),
      derived: derived ? derived.check(facts) : null,
      record: record
        ? {
            state: record.state as "draft" | "approved",
            hasValue,
            evidenceCount: evidence,
          }
        : null,
      decision:
        (decision?.status as "not_applicable" | "sensitive_omitted") ?? null,
    });
    codeOf.set(metric.metricKey, metric.disclosureCode);
    if (!meta.has(metric.disclosureCode))
      meta.set(metric.disclosureCode, {
        module: metric.module as ReadinessModule,
        title_en: metric.disclosureTitleEn ?? metric.disclosureTitle ?? "",
        title_sl: metric.disclosureTitleSl,
      });
    return {
      metric_key: metric.metricKey,
      title_en: metric.titleEn ?? metric.title,
      title_sl: metric.titleSl,
      requirement_type: metric.requirementType as RequirementType,
      value_type: metric.valueType,
      status,
      source: derived?.source ?? "disclosure",
      record_id: record?.id ?? null,
      evidence_count: evidence,
      reason: decision?.reason ?? null,
      href: derived
        ? disclosureHref(metric.disclosureCode)
        : `/inventory/disclosures#${metric.metricKey}`,
      esrs_reference: metric.esrsReference,
      applicability_condition: metric.applicabilityCondition,
      applicability_text: conditionTexts(metric.applicabilityCondition),
    };
  };
  const byKey = (d: ReadinessDatapoint) => codeOf.get(d.metric_key)!;

  const vsmeDatapoints = metrics
    .filter((m) => m.standard === "vsme")
    .map(evaluate);
  const esrsDatapoints = metrics
    .filter((m) => m.standard === "esrs")
    .map(evaluate);
  const { disclosures, summary } = groupDisclosures(
    vsmeDatapoints,
    meta,
    byKey,
  );

  const mapped = vsmeDatapoints.filter((d) => d.esrs_reference !== null);
  const coverage: EsrsCoverage = {
    vsme_mapped: mapped.length,
    vsme_mapped_ready: mapped.filter((d) => d.status === "ready").length,
    additional: esrsTotal,
  };
  const esrs: EsrsReadiness = plan.simplified_esrs
    ? {
        available: true,
        regulatory_status:
          metrics.find((m) => m.standard === "esrs")?.regulatoryStatus ?? null,
        coverage,
        ...groupDisclosures(esrsDatapoints, meta, byKey),
      }
    : { available: false, required_plan: ESRS_REQUIRED_PLAN, coverage };

  const totalRows = rowCounts
    ? Object.values(rowCounts).reduce((n, c) => n + c.total, 0)
    : 0;
  const hasEvidence = [...evidenceCounts.values()].some((n) => n > 0);
  const status = revision?.status ?? null;

  const done: Record<JourneyStepId, boolean> = {
    organisation: entities.length > 0 && sites.length > 0,
    boundary:
      scope.length > 0 && scope.every((s) => s.status !== "not_assessed"),
    applicability: summary.open_conditional === 0 && vsmeDatapoints.length > 0,
    data: totalRows > 0 && summary.needs_data === 0,
    evidence: summary.needs_evidence === 0 && (hasEvidence || totalRows === 0),
    calculation:
      !!run && run.aggregates.status === "ok" && !run.freshness.stale,
    review: status === "approved" || status === "locked",
    report: (renders[0]?.n ?? 0) > 0 && status === "locked",
  };
  const STEP_HREF: Record<JourneyStepId, string> = {
    organisation: "/organisation",
    boundary: "/organisation#boundary",
    applicability: "/readiness",
    data: "/inventory",
    evidence: "/evidence",
    calculation: "/review",
    review: "/review",
    report: "/reports",
  };
  let currentFound = false;
  const journey: JourneyStep[] = JOURNEY_STEPS.map((id) => {
    if (done[id]) return { id, state: "done", href: STEP_HREF[id] };
    if (!currentFound) {
      currentFound = true;
      return { id, state: "current", href: STEP_HREF[id] };
    }
    return { id, state: "todo", href: STEP_HREF[id] };
  });

  return {
    has_legal_entity: entities.length > 0,
    period: newest
      ? {
          id: newest.id,
          name: newest.periodName,
          start_date: newest.startDate,
          end_date: newest.endDate,
          reporting_year: newest.reportingYear,
          reporting_basis: newest.reportingBasis,
        }
      : null,
    revision: revision
      ? {
          id: revision.id,
          revision_no: revision.revisionNo,
          status: revision.status as WorkflowStatus,
        }
      : null,
    plan,
    summary,
    disclosures,
    journey,
    next: journey.find((s) => s.state === "current")?.id ?? null,
    can_decide:
      entities.length > 0 && !!revision && revision.status !== "locked",
    esrs,
  };
}
