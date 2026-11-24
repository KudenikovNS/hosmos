// THE DASHBOARD HUB (T3.7 + T5.9, О-6, UI-6) — the state of the report a company
// is currently writing, plus the figures of the last one it approved.
//
// See docs/decisions/server-dashboard-dashboard.md for the full account.
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type {
  EnergySplit,
  IntensityAggregate,
  ScopeTotals,
} from "@/server/calc/aggregate";
import {
  loadLatestRun,
  loadRunPeriod,
  type RunStalenessSource,
} from "@/server/calc/run";
import type { DbClient } from "@/server/db/client";
import { facility, reportingPeriod, reportRevision } from "@/server/db/schema";
import {
  countInventory,
  type InventoryCount,
} from "@/server/inventory/inventory";
import type { InputTableName } from "@/server/inventory/tables";
import { countFacilities } from "@/server/org/facilities";
import { countLegalEntities } from "@/server/org/legal-entities";
import { loadCurrentRevision } from "@/server/periods/lifecycle";
import {
  listPeriods,
  serialisePeriod,
  type PeriodDto,
} from "@/server/periods/periods";
import {
  getRevision,
  serialiseRevision,
  type RevisionDto,
  type RevisionRow,
} from "@/server/revisions/revisions";
import {
  blockingFailures,
  listValidationResults,
} from "@/server/validation/run";
import type { WorkflowStatus } from "@/shared/enums";

// ─── The scope grouping (a reporting decision, not a schema one) ─────────────

/**
 * The three buckets the hub counts rows in.
 *
 * They are NOT the four input tables and not `ValidationScope`: a reader of a
 * dashboard thinks in "Scope 1 / Scope 2 / what we disclosed", while the schema
 * thinks in tables — and Scope 2 is two of them (§4.10 consumption, §4.11 the
 * instruments that make a market-based figure claimable). Grouping them here
 * rather than on the screen means the API answers the question the UI asks, and
 * a second screen asking it gets the same answer.
 */
const DASHBOARD_SCOPES = ["scope1", "scope2", "disclosures"] as const;

/** One of the three buckets above. */
type DashboardScope = (typeof DASHBOARD_SCOPES)[number];

/**
 * Which bucket each input table falls in. TOTAL over `InputTableName`, so a
 * fifth input table stops this file compiling instead of silently vanishing
 * from the counters.
 */
const SCOPE_OF_TABLE: Readonly<Record<InputTableName, DashboardScope>> = {
  emission_activity: "scope1",
  purchased_energy_activity: "scope2",
  contractual_instrument: "scope2",
  disclosure_record: "disclosures",
};

// ─── Wire contract ───────────────────────────────────────────────────────────

/** The row counters of one bucket. */
interface DashboardScopeCounts {
  scope: DashboardScope;
  total: number;
  approved: number;
  /** Awaiting approval — the `?queue` of `/api/inventory` (DM-14, UI-3). */
  draft: number;
}

/** Row counters of the current revision: the whole, and the three buckets. */
interface DashboardRowCounts {
  total: number;
  approved: number;
  draft: number;
  /** Always all three, in `DASHBOARD_SCOPES` order — an empty one is a zero. */
  by_scope: DashboardScopeCounts[];
}

/**
 * What validation has ALREADY said about the current revision (VR-3).
 *
 * `blocking` and `warnings` are counted separately because they mean different
 * things to a user: a blocking failure stops the submit/approve/lock, a warning
 * never does. `results` is every stored row, passed ones included, so "0
 * blocking" can be told apart from "nothing has been evaluated yet".
 */
interface DashboardValidationSummary {
  results: number;
  blocking: number;
  warnings: number;
  /** The codes a screen has to explain — deduplicated, in code order. */
  blocking_codes: string[];
}

// ─── The KPI block (T5.9, UI-6) ──────────────────────────────────────────────

/**
 * The statuses whose figures the KPI block will show (UI-6).
 *
 * A DRAFT'S NUMBERS ARE NOT PUT ON A DASHBOARD. A run over a draft revision is a
 * preparer's working total — half the rows may still be unapproved, a reviewer
 * has objected to none of it — and a headline figure is read as the company's
 * answer. `/inventory` and `/review` are where a work-in-progress total belongs;
 * this block reports what somebody signed off. It is the same list `/reports`
 * renders from (`isRenderableStatus`), for the same reason.
 */
export const PUBLISHED_STATUSES: readonly WorkflowStatus[] = [
  "approved",
  "locked",
];

/**
 * What the KPI block is showing, as one word. FOUR STATES, AND NOT ONE OF THEM
 * IS A ZERO — that is the whole point of enumerating them:
 *
 *   • `ok`      — a completed run that still describes the current inputs.
 *   • `stale`   — a completed run whose inputs moved afterwards (CALC-6). The
 *                 figures ARE shown, because they are what the approved run
 *                 published, and they are labelled with what moved.
 *   • `failed`  — a run in which at least one line could not be priced. Every
 *                 figure is `null` (§0.7, `calc/aggregate.ts`) and the block
 *                 says which lines to fix. The sum of the lines that worked is
 *                 never shown: it is a plausible number that is silently too
 *                 small.
 *   • `no_run`  — the revision was approved but has never been calculated.
 *
 * The fifth case is not a state of this union: a company with NO approved
 * revision at all has no `emissions` object (see {@link loadEmissions}), because
 * there is no period, no revision and no boundary to report about.
 */
export const DASHBOARD_EMISSION_STATES = [
  "ok",
  "stale",
  "failed",
  "no_run",
] as const;

/** One value of {@link DASHBOARD_EMISSION_STATES}. */
export type DashboardEmissionState = (typeof DASHBOARD_EMISSION_STATES)[number];

/**
 * HOW MUCH OF THE UNDERTAKING THE FIGURES ABOVE DESCRIBE (DM-8, D15).
 *
 * A total is meaningless without its boundary, and the boundary of a report is
 * NOT the company's registry: a period may legitimately exclude a subsidiary,
 * and a locked revision's boundary is the frozen one (CALC-7), not today's. Both
 * halves are therefore reported, so "1 200 t" can be read as "…for three of our
 * five entities" rather than as the group's answer.
 */
interface DashboardCoverage {
  /** Legal entities the run's boundary INCLUDES (`period_scope`, or frozen). */
  legal_entities_included: number;
  /** Legal entities on the company's registry — the denominator. */
  legal_entities_total: number;
  /** Facilities belonging to those included entities. */
  facilities_included: number;
  /** Facilities on the company's registry. */
  facilities_total: number;
}

/** The latest run of the KPI block's revision, as the screen labels it. */
interface DashboardRunSummary {
  run_id: string;
  calculated_at: string;
  line_count: number;
  /** Lines that could not be priced — non-zero iff `state` is `failed`. */
  failed_count: number;
}

/**
 * THE KPI BLOCK (T5.9, UI-6) — the aggregates of the latest Approved/Locked run.
 *
 * `totals`, `energy` and `intensity` ARE `GET /api/revisions/[id]/results`'
 * OWN OBJECTS, passed through byte for byte. They are not re-summed, not
 * re-rounded, not renamed into this module's snake_case and not converted into
 * another unit: the acceptance criterion is that the dashboard and `/results`
 * agree, and the only way to make that true by construction rather than by
 * coincidence is to have exactly one implementation of the sum
 * (`calc/aggregate.ts`) and no transformation between it and the screen. The kg
 * the totals carry become tonnes in the BROWSER, through the one shared shift
 * (`@/shared/units`), where a display decision belongs.
 */
export interface DashboardEmissions {
  /** The revision the figures belong to — never necessarily the current one. */
  revision_id: string;
  revision_no: number;
  /** One of {@link PUBLISHED_STATUSES}. */
  status: WorkflowStatus;
  /** Its period — named, because it may not be the period card's period. */
  period_id: string;
  period_name: string;
  period_start: string;
  period_end: string;
  state: DashboardEmissionState;
  run: DashboardRunSummary | null;
  /** Which CALC-6 inputs moved after the run — empty unless `state` is `stale`. */
  stale_sources: readonly RunStalenessSource[];
  /** `null` only when there is no run at all — never an object of zeros. */
  totals: ScopeTotals | null;
  energy: EnergySplit | null;
  intensity: IntensityAggregate | null;
  coverage: DashboardCoverage;
}

/** `GET /api/dashboard` — the hub, in one object. */
export interface DashboardDto {
  /** The newest reporting period, or `null` — the empty state with a CTA. */
  period: PeriodDto | null;
  /** Its `is_current` revision (LC-1a), or `null` when it has none yet. */
  revision: RevisionDto | null;
  rows: DashboardRowCounts;
  validation: DashboardValidationSummary;
  /**
   * The KPI block, or `null` when the company has approved NOTHING yet.
   *
   * `null` IS NOT ZERO AND THE SCREEN MAY NOT RENDER IT AS ONE. A company that
   * has simply not finished entering data would be shown `0 t CO₂e` — the most
   * visible possible version of the lie the whole calculation layer refuses to
   * tell (§0.7). The screen renders a "no approved run" state with a route into
   * `/inventory` instead.
   */
  emissions: DashboardEmissions | null;
}

// ─── Assembly ────────────────────────────────────────────────────────────────

/** Zero counters — a company with no period, or a period with no revision. */
const NO_ROWS: DashboardRowCounts = {
  total: 0,
  approved: 0,
  draft: 0,
  by_scope: DASHBOARD_SCOPES.map((scope) => ({
    scope,
    total: 0,
    approved: 0,
    draft: 0,
  })),
};

/** Nothing evaluated — distinct from "evaluated and clean" (`results > 0`). */
const NO_VALIDATION: DashboardValidationSummary = {
  results: 0,
  blocking: 0,
  warnings: 0,
  blocking_codes: [],
};

/** Fold the four per-table counts into the three buckets plus the total. */
function groupByScope(
  counts: Record<InputTableName, InventoryCount>,
): DashboardRowCounts {
  const byScope = new Map<DashboardScope, { total: number; approved: number }>(
    DASHBOARD_SCOPES.map((scope) => [scope, { total: 0, approved: 0 }]),
  );
  for (const [table, count] of Object.entries(counts) as [
    InputTableName,
    InventoryCount,
  ][]) {
    const bucket = byScope.get(SCOPE_OF_TABLE[table]);
    if (!bucket) continue;
    bucket.total += count.total;
    bucket.approved += count.approved;
  }

  const by_scope = DASHBOARD_SCOPES.map((scope) => {
    const bucket = byScope.get(scope) ?? { total: 0, approved: 0 };
    return {
      scope,
      total: bucket.total,
      approved: bucket.approved,
      draft: bucket.total - bucket.approved,
    };
  });
  const total = by_scope.reduce((sum, entry) => sum + entry.total, 0);
  const approved = by_scope.reduce((sum, entry) => sum + entry.approved, 0);
  return { total, approved, draft: total - approved, by_scope };
}

/** The stored results of one revision, summarised for the hub. */
async function summariseValidation(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<DashboardValidationSummary> {
  const results = await listValidationResults(db, companyId, revisionId);
  const blocking = blockingFailures(results);
  return {
    results: results.length,
    blocking: blocking.length,
    // A warning is a FAILED result of `severity = 'warning'`; a passed one is
    // not a warning the user has to read, it is a check that held.
    warnings: results.filter(
      (result) => !result.passed && result.severity === "warning",
    ).length,
    blocking_codes: [
      ...new Set(blocking.map((result) => result.ruleCode)),
    ].sort(),
  };
}

// ─── The KPI block's assembly (T5.9) ─────────────────────────────────────────

/**
 * WHICH APPROVED REVISION THE HEADLINE BELONGS TO, when several periods have one.
 *
 * THE ORDER IS THE PERIOD'S, NOT THE APPROVAL'S, and that is the whole decision.
 * Sorting by `approved_at` would make a restatement of FY2022, signed off this
 * morning, replace the FY2024 figures at the top of the screen — the newest
 * ACTION, but the wrong REPORT. A dashboard headline answers "where are we now",
 * so the newest period wins, and only inside a period does recency decide:
 *
 *   1. `end_date` descending — the most recently CLOSED reporting period;
 *   2. `start_date` descending — separates two periods that end together (a
 *      quarter inside a year);
 *   3. `revision_no` descending — inside one period, a restatement supersedes
 *      what it restates (LC-9), so revision 3 beats the locked revision 1;
 *   4. `id` descending — a total order, so two identical rows cannot make the
 *      screen flicker between two answers on consecutive loads.
 *
 * Tenant-pinned on BOTH tables: the join carries `company_id` as well as the FK,
 * so a revision cannot be reached through another company's period.
 */
async function latestPublishedRevision(
  db: DbClient,
  companyId: string,
): Promise<{ revision: RevisionRow; period: PeriodRow } | null> {
  const [row] = await db
    .select({ revision: reportRevision, period: reportingPeriod })
    .from(reportRevision)
    .innerJoin(
      reportingPeriod,
      and(
        eq(reportingPeriod.id, reportRevision.periodId),
        eq(reportingPeriod.companyId, companyId),
      ),
    )
    .where(
      and(
        eq(reportRevision.companyId, companyId),
        inArray(reportRevision.status, [...PUBLISHED_STATUSES]),
      ),
    )
    .orderBy(
      desc(reportingPeriod.endDate),
      desc(reportingPeriod.startDate),
      desc(reportRevision.revisionNo),
      desc(reportRevision.id),
    )
    .limit(1);
  return row ?? null;
}

/** A `reporting_period` row, as the join above returns it. */
type PeriodRow = typeof reportingPeriod.$inferSelect;

/**
 * WHICH OF THE FOUR STATES the block is in — pure, so it is tested without a
 * database and cannot drift from the copy the screen writes for each one.
 *
 * `failed` OUTRANKS `stale`, deliberately. A run that published no figure at all
 * cannot be usefully described as "out of date": there is nothing to be out of
 * date. Saying "recalculate, your rows moved" over a run that failed for a
 * missing FACTOR would also send the user to fix the wrong thing.
 */
export function emissionState(input: {
  /** `null` when the revision has never been calculated. */
  readonly hasRun: boolean;
  /** `calc/aggregate.ts`'s verdict — `failed` iff at least one line failed. */
  readonly aggregateStatus: "ok" | "failed" | null;
  /** CALC-6's verdict. */
  readonly stale: boolean;
}): DashboardEmissionState {
  if (!input.hasRun) return "no_run";
  if (input.aggregateStatus === "failed") return "failed";
  return input.stale ? "stale" : "ok";
}

/** Facilities belonging to the entities the boundary includes. */
async function countIncludedFacilities(
  db: DbClient,
  companyId: string,
  includedEntityIds: readonly string[],
): Promise<number> {
  if (includedEntityIds.length === 0) return 0;
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(facility)
    .where(
      and(
        eq(facility.companyId, companyId),
        inArray(facility.legalEntityId, [...includedEntityIds]),
      ),
    );
  return row?.total ?? 0;
}

/**
 * THE KPI BLOCK (UI-6), or `null` when the company has approved nothing yet.
 *
 * IT CALLS `loadLatestRun` — THE FUNCTION `GET …/results` CALLS. Not a query
 * shaped like it, not a lighter version that sums only the four headline
 * figures: the same function, whose aggregate is `calc/aggregate.ts`'s single
 * implementation of the sum. That is why "the dashboard agrees with `/results`"
 * is a property of the code rather than a thing a test hopes for; the test
 * (`dashboard.integration.test.ts`) compares the two responses field by field
 * and would catch a transformation sneaking in here.
 *
 * THE BOUNDARY IS READ SEPARATELY, and on purpose: it is the one fact the KPI
 * block still needs when there is NO run, and `loadRunPeriod` is also the
 * function that knows a LOCKED revision reads its frozen scope rather than the
 * live tables (CALC-7). Coverage of a locked report is the boundary it was
 * locked with, whatever the organisation looks like today.
 */
async function loadEmissions(
  db: DbClient,
  companyId: string,
): Promise<DashboardEmissions | null> {
  const published = await latestPublishedRevision(db, companyId);
  if (!published) return null;
  const { revision, period } = published;

  const [result, runPeriod, legalEntitiesTotal, facilitiesTotal] =
    await Promise.all([
      loadLatestRun(db, companyId, revision),
      loadRunPeriod(db, companyId, revision),
      countLegalEntities(db, companyId),
      countFacilities(db, companyId),
    ]);

  const includedEntityIds = runPeriod?.includedEntityIds ?? [];
  const coverage: DashboardCoverage = {
    legal_entities_included: includedEntityIds.length,
    legal_entities_total: legalEntitiesTotal,
    facilities_included: await countIncludedFacilities(
      db,
      companyId,
      includedEntityIds,
    ),
    facilities_total: facilitiesTotal,
  };

  const state = emissionState({
    hasRun: result !== null,
    aggregateStatus: result?.aggregates.status ?? null,
    stale: result?.freshness.stale ?? false,
  });

  return {
    revision_id: revision.id,
    revision_no: revision.revisionNo,
    status: revision.status as WorkflowStatus,
    period_id: period.id,
    period_name: period.periodName,
    period_start: period.startDate,
    period_end: period.endDate,
    state,
    run: result
      ? {
          run_id: result.run.runId,
          calculated_at: result.run.calculatedAt,
          line_count: result.run.lineCount,
          failed_count: result.run.failedCount,
        }
      : null,
    stale_sources:
      state === "stale" ? (result?.freshness.staleSources ?? []) : [],
    // VERBATIM. See the interface — one sum, no transformation, no defaults.
    totals: result?.aggregates.totals ?? null,
    energy: result?.aggregates.energy ?? null,
    intensity: result?.aggregates.intensity ?? null,
    coverage,
  };
}

/**
 * THE hub read. Tenant-pinned in every one of its queries (PATTERN 3 — the
 * caller passes the session's `companyId` and nothing from the wire).
 *
 * A company with NO PERIOD is not an error and not an empty object: it is a
 * fully-formed answer whose `period` is `null`, which is the state the screen
 * renders a CTA for. Same for a period with no revision — the counters and the
 * validation summary are zeros over a revision that does not exist yet, rather
 * than counts over "all revisions" that would mean nothing.
 */
export async function loadDashboard(
  db: DbClient,
  companyId: string,
): Promise<DashboardDto> {
  // RESOLVED ONCE, FOR EVERY BRANCH BELOW, because the KPI block is NOT about
  // the newest period (see the module header): a company whose newest period has
  // no revision yet may still have last year's report approved, and a `null`
  // taken from the wrong branch would hide it behind a "nothing here yet".
  const [periods, emissions] = await Promise.all([
    listPeriods(db, companyId),
    loadEmissions(db, companyId),
  ]);
  // Chronological ascending (`listPeriods`) — the newest is the last.
  const newest = periods[periods.length - 1];
  if (!newest) {
    return {
      period: null,
      revision: null,
      rows: NO_ROWS,
      validation: NO_VALIDATION,
      emissions,
    };
  }

  const period = await serialisePeriod(db, companyId, newest);
  const current = await loadCurrentRevision(db, companyId, newest.id);
  if (!current) {
    return {
      period,
      revision: null,
      rows: NO_ROWS,
      validation: NO_VALIDATION,
      emissions,
    };
  }

  const row = await getRevision(db, companyId, current.id);
  const counts = await countInventory(db, companyId, {
    revisionId: current.id,
  });
  return {
    period,
    revision: row ? serialiseRevision(row) : null,
    rows: groupByScope(counts),
    validation: await summariseValidation(db, companyId, current.id),
    emissions,
  };
}
