// =============================================================================
// DM-7a AND LC-2 — what the period's CURRENT REVISION permits, and the period
// status derived from it (К-4).
//
// WHY THIS IS ITS OWN MODULE, and a LEAF one. Both facts are needed in two
// places that must not import each other:
//   • `@/server/periods/periods` (the service) — it decides what a PATCH may
//     touch and serialises `period_status`;
//   • `@/server/validation/evaluators/periods` — VAL-106 judges the same thing
//     from inside the write transaction.
// The service imports `validation/write` → `run` → `registry` → the evaluators,
// so an evaluator importing the service would close a cycle around the registry's
// import-time coverage check (R-12) and take the whole graph down. Same reason
// `validation/types.ts` is a leaf. This file therefore imports the schema and the
// enums and nothing else of ours.
//
// K-4 IN ONE SENTENCE: there is no `period_status` column (D22, §0.5). The
// status of a period IS the status of its current revision, and this is the only
// place that mapping is written down.
// =============================================================================
import { and, eq, inArray } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import { reportRevision } from "@/server/db/schema";
import type { PeriodStatus, WorkflowStatus } from "@/shared/enums";

/**
 * The CALCULATION-BEARING fields of a period (DM-7a), by API field name.
 *
 * These six are exactly the inputs a locked calculation reproduces from
 * (`factor_set_id` pins the factors, the dates pin the window, `reporting_basis`
 * and `base_year` pin what is being reported, `methodology_version` pins the
 * formulas). Everything else on the row — `period_name`, `reporting_year`,
 * `comparative_period_id` — is labelling, editable at any time. The spec names
 * these six and only these; do not "round it up" to the whole row.
 *
 * `period_scope` is the seventh member and is not a period column at all: DM-9
 * freezes the BOUNDARY on the same condition, so T2.5's boundary PUT declares
 * the sentinel below instead of a field name.
 */
export const CALCULATION_BEARING_FIELDS = [
  "factor_set_id",
  "start_date",
  "end_date",
  "reporting_basis",
  "methodology_version",
  "base_year",
] as const;

/**
 * The sentinel a boundary write declares as its mutated "field" (DM-9, T2.5).
 * It is not a column of `reporting_period`, which is the point: the rows of
 * `period_scope` freeze together, as one thing, with the period they describe.
 */
export const PERIOD_SCOPE_FIELD = "period_scope";

/** The whole frozen surface of DM-7a: the six fields plus the boundary. */
const FROZEN_SURFACE: ReadonlySet<string> = new Set<string>([
  ...CALCULATION_BEARING_FIELDS,
  PERIOD_SCOPE_FIELD,
]);

/**
 * The field a LOCK transition declares as mutated (T2.6), and the trigger of
 * VAL-105.
 *
 * WHY A SENTINEL AND NOT A ROUTE-LEVEL `if`. The F1 hard gate (PG-3) is a fact
 * about ONE moment — the attempt to lock — and about nothing else: a starter
 * company with four includable facilities must still be able to edit its period,
 * redraw its boundary and submit for review; what it may not do is CLOSE the
 * report. VAL-105 is blocking, so an evaluator that judged the state
 * unconditionally would refuse every `period`-scope write and leave the customer
 * unable even to fix the boundary that is over the limit — a deadlock dressed as
 * a rule. `mutatedFields` is the mechanism that already exists for exactly this
 * distinction (see `@/server/validation/types`): VAL-106 speaks only when a
 * frozen field is being changed, VAL-105 only when `locked_at` is being written.
 * `locked_at` IS the column the transition sets, so this is a declaration of
 * what the write does, not a flag invented to steer a rule.
 */
export const REVISION_LOCK_FIELD = "locked_at";

/** Which of `fields` DM-7a freezes once the current revision leaves draft. */
export function frozenAmong(
  fields: readonly string[] | undefined,
): readonly string[] {
  return (fields ?? []).filter((field) => FROZEN_SURFACE.has(field));
}

/** The facts DM-7a and LC-2 read off the period's current revision. */
export interface CurrentRevision {
  readonly id: string;
  readonly status: WorkflowStatus;
  readonly revisionNo: number;
}

/**
 * The `is_current` revision of each of `periodIds`, keyed by period — absent
 * from the map when a period has none yet (LC-1a guarantees at most one).
 *
 * Tenant-pinned: periods of another company contribute nothing, so a foreign id
 * reads as "no revisions" rather than as somebody else's status.
 */
export async function loadCurrentRevisions(
  db: DbClient,
  companyId: string,
  periodIds: readonly string[],
): Promise<Map<string, CurrentRevision>> {
  if (periodIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: reportRevision.id,
      periodId: reportRevision.periodId,
      status: reportRevision.status,
      revisionNo: reportRevision.revisionNo,
    })
    .from(reportRevision)
    .where(
      and(
        eq(reportRevision.companyId, companyId),
        inArray(reportRevision.periodId, [...periodIds]),
        eq(reportRevision.isCurrent, true),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.periodId,
      {
        id: row.id,
        status: row.status as WorkflowStatus,
        revisionNo: row.revisionNo,
      },
    ]),
  );
}

/** The `is_current` revision of ONE period, or `undefined`. */
export async function loadCurrentRevision(
  db: DbClient,
  companyId: string,
  periodId: string,
): Promise<CurrentRevision | undefined> {
  const found = await loadCurrentRevisions(db, companyId, [periodId]);
  return found.get(periodId);
}

/**
 * Which of `periodIds` already have a LOCKED revision — the fact LC-2's seventh
 * case needs and the only one `derivePeriodStatus` cannot read off the current
 * revision (T2.6 fills the seam T2.4 left).
 *
 * ONE QUERY FOR A WHOLE LIST, like `loadCurrentRevisions` and for the same
 * reason: the period screen serialises every period of the company at once, so a
 * per-row existence check would be an N+1 for ever. Tenant-pinned — a foreign
 * period contributes nothing and therefore reads as "never locked".
 */
export async function loadPeriodsWithLockedRevision(
  db: DbClient,
  companyId: string,
  periodIds: readonly string[],
): Promise<Set<string>> {
  if (periodIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ periodId: reportRevision.periodId })
    .from(reportRevision)
    .where(
      and(
        eq(reportRevision.companyId, companyId),
        inArray(reportRevision.periodId, [...periodIds]),
        eq(reportRevision.status, "locked"),
      ),
    );
  return new Set(rows.map((row) => row.periodId));
}

/** Does ONE period have a locked revision (the single-period half of the above)? */
export async function hasLockedRevision(
  db: DbClient,
  companyId: string,
  periodId: string,
): Promise<boolean> {
  const found = await loadPeriodsWithLockedRevision(db, companyId, [periodId]);
  return found.has(periodId);
}

/** The two revision statuses in which the report is still being written. */
const EDITABLE_STATUSES: readonly WorkflowStatus[] = ["draft", "rejected"];

/**
 * DM-7a — may the calculation-bearing fields (and the boundary) still change?
 *
 * NO REVISIONS AT ALL MEANS YES, and that is not a special case bolted on: a
 * period nobody has started reporting on has no locked calculation to protect,
 * so there is nothing for the rule to defend. The moment a revision exists the
 * answer is its status, and only `draft`/`rejected` — the two states in which
 * the report is being written — permit an edit. `submitted`, `in_review`,
 * `approved` and `locked` all refuse, which is what makes AC-8 hold: a locked
 * revision's inputs cannot shift underneath it.
 */
export function calculationInputsEditable(
  current: CurrentRevision | undefined,
): boolean {
  return current === undefined || EDITABLE_STATUSES.includes(current.status);
}

/** LC-2's straight `WorkflowStatus → PeriodStatus` half (six of the seven cases). */
const STATUS_MAP: Readonly<Record<WorkflowStatus, PeriodStatus>> = {
  draft: "Draft",
  submitted: "Submitted",
  in_review: "In review",
  approved: "Approved",
  locked: "Locked",
  // A rejected revision is editable again, so to a consumer of the API it is a
  // draft (LC-2 spells this one out — it is the mapping's only non-obvious row).
  rejected: "Draft",
};

/**
 * LC-2 — the derived `period_status` (К-4), from the period's current revision.
 *
 * WHAT T2.4 OWNS AND WHAT T2.6 ADDS. The seventh case of LC-2 is `Reopened`: a
 * DRAFT revision with `revision_no > 1` over a period that already has a LOCKED
 * revision — a restatement in progress. It needs a fact this task has no way to
 * produce, because nothing in T2.4 can lock a revision or create a second one:
 * the transitions are T2.6's. So it is a PARAMETER rather than a query here —
 * `hasLockedRevision` defaults to `false`, and T2.6 fills it from the same read
 * that loads the current revision. That is the whole seam: one argument, one
 * call site, no half-written state machine in the meantime.
 */
export function derivePeriodStatus(
  current: CurrentRevision | undefined,
  opts: { hasLockedRevision?: boolean } = {},
): PeriodStatus {
  // Case 1 — no revisions at all. The only case T2.4's own routes can produce,
  // and the one its acceptance pins.
  if (!current) return "Draft";
  if (
    current.status === "draft" &&
    current.revisionNo > 1 &&
    opts.hasLockedRevision === true
  ) {
    return "Reopened";
  }
  return STATUS_MAP[current.status];
}
