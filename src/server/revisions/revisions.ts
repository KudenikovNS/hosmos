// REPORT REVISIONS (DM-10, D22) — creating them, reading them, and the summary
// every screen above them asks for.
//
// See docs/decisions/server-revisions-revisions.md for the full account.
import { and, asc, count, eq, sql } from "drizzle-orm";

import { latestRunOf } from "@/server/calc/run";
import { textOrNull, uuidOrNull, type ParseResult } from "@/server/api/parse";
import { logAudit } from "@/server/db/audit";
import type { DbClient } from "@/server/db/client";
import {
  contractualInstrument,
  disclosureRecord,
  emissionActivity,
  purchasedEnergyActivity,
  reportingPeriod,
  reportRevision,
} from "@/server/db/schema";
import { seedRevisionRows } from "@/server/inventory/rows";
import {
  derivePeriodStatus,
  hasLockedRevision,
  loadCurrentRevision,
} from "@/server/periods/lifecycle";
import {
  blockingFailures,
  listValidationResults,
} from "@/server/validation/run";
import type { PeriodStatus, WorkflowStatus } from "@/shared/enums";
import type { CompanyRole } from "@/shared/roles";

/** A `report_revision` row as Drizzle returns it. */
export type RevisionRow = typeof reportRevision.$inferSelect;

/** Who is acting — the LC-10 half of every revision write (from the session). */
export interface RevisionActor {
  userId: string;
  /** The actor's role AT THE TIME, snapshotted into the audit row (§11.1). */
  role: CompanyRole | null;
}

/**
 * The statuses of a period's CURRENT revision that allow a NEW one (§5.1, row 1).
 * DATA, like the transition matrix: the three that permit it are listed, and
 * everything else — the three review-in-flight statuses — is refused by not
 * being here.
 */
export const REVISION_CREATION_ALLOWED_FROM: readonly WorkflowStatus[] = [
  "draft",
  "rejected",
  "locked",
];

/** The status a restatement is made FROM, and the one that demands a reason. */
const RESTATEMENT_FROM: WorkflowStatus = "locked";

// ─── Wire contract (§4.7 — DD names) ─────────────────────────────────────────

/** One revision as the API speaks it (`company_id` absent — PATTERN 3). */
export interface RevisionDto {
  id: string;
  period_id: string;
  revision_no: number;
  status: WorkflowStatus;
  is_current: boolean;
  assigned_to: string | null;
  review_comment: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  change_reason: string | null;
  seeded_from_revision_id: string | null;
  /** Frozen boundary only; internal calculation/render snapshots stay server-side. */
  frozen_scope: unknown;
  created_by: string | null;
  created_at: string | null;
}

/** THE serialiser. Every response about a revision goes through it. */
export function serialiseRevision(row: RevisionRow): RevisionDto {
  return {
    id: row.id,
    period_id: row.periodId,
    revision_no: row.revisionNo,
    status: row.status as WorkflowStatus,
    is_current: row.isCurrent,
    assigned_to: row.assignedTo,
    review_comment: row.reviewComment,
    reviewed_by: row.reviewedBy,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    approved_by: row.approvedBy,
    approved_at: row.approvedAt?.toISOString() ?? null,
    submitted_by: row.submittedBy,
    submitted_at: row.submittedAt?.toISOString() ?? null,
    locked_by: row.lockedBy,
    locked_at: row.lockedAt?.toISOString() ?? null,
    change_reason: row.changeReason,
    seeded_from_revision_id: row.seededFromRevisionId,
    frozen_scope: publicFrozenScope(row.frozenScope),
    created_by: row.createdBy,
    created_at: row.createdAt?.toISOString() ?? null,
  };
}

function publicFrozenScope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const {
    render_context: _render,
    calculation_context: _calculation,
    ...boundary
  } = value as Record<string, unknown>;
  return boundary;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** One revision of THIS company, or `undefined` (foreign ids read as absent). */
export async function getRevision(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<RevisionRow | undefined> {
  const [row] = await db
    .select()
    .from(reportRevision)
    .where(
      and(eq(reportRevision.id, id), eq(reportRevision.companyId, companyId)),
    )
    .limit(1);
  return row;
}

/** Every revision of one period, oldest first. */
export async function listRevisions(
  db: DbClient,
  companyId: string,
  periodId: string,
): Promise<RevisionRow[]> {
  return db
    .select()
    .from(reportRevision)
    .where(
      and(
        eq(reportRevision.companyId, companyId),
        eq(reportRevision.periodId, periodId),
      ),
    )
    .orderBy(asc(reportRevision.revisionNo));
}

/**
 * The four input tables of the D23 mixin — the subject of "all rows approved"
 * (§5.1) and of the counters on the summary.
 *
 * A LIST, ITERATED, not four hand-written queries: T3.1…T3.3 give each of them a
 * write path, and a counter that silently covered three tables would understate
 * a report rather than fail. Every one of them carries the same mixin columns,
 * which is exactly what makes the loop possible (§4.8).
 */
const INPUT_TABLES = [
  emissionActivity,
  purchasedEnergyActivity,
  contractualInstrument,
  disclosureRecord,
] as const;

/** How many CURRENT input rows a revision holds, and how many are approved. */
export interface RevisionRowCounts {
  /** Current versions (`superseded_by_id IS NULL`), tombstones excluded (LC-6). */
  readonly total: number;
  readonly approved: number;
  /** `total - approved` — what `draft → submitted` waits for (§5.1). */
  readonly pending: number;
}

/**
 * Count the CURRENT rows of a revision across the four input tables.
 *
 * "Current" is `superseded_by_id IS NULL AND NOT is_deleted` — the same
 * definition as the partial index of §4.21 and of `listCurrent` (T3.1). A
 * superseded version is history and a tombstone is a deletion; neither is a row
 * the report contains, so neither may hold up a submit.
 *
 * IN S2 THIS ALWAYS ANSWERS ZERO, and that is the point rather than a caveat:
 * nothing writes an input row until T3.1, so the `all_rows_approved`
 * precondition is VACUOUSLY true today and becomes real the moment rows exist —
 * with no edit to `./transition`.
 */
export async function countRevisionRows(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<RevisionRowCounts> {
  let total = 0;
  let approved = 0;
  for (const table of INPUT_TABLES) {
    const [row] = await db
      .select({
        total: count(),
        approved: sql<number>`count(*) filter (where ${table.state} = 'approved')`,
      })
      .from(table)
      .where(
        and(
          eq(table.companyId, companyId),
          eq(table.revisionId, revisionId),
          sql`${table.supersededById} is null`,
          eq(table.isDeleted, false),
        ),
      );
    total += Number(row?.total ?? 0);
    approved += Number(row?.approved ?? 0);
  }
  return { total, approved, pending: total - approved };
}

/** The latest calculation run of a revision (CALC-6), or `null` (S2: always). */
interface RevisionRunSummary {
  run_id: string;
  calculated_at: string | null;
  rows: number;
  failed: number;
  /** CALC-6's "green run" — every row of the run computed. */
  ok: boolean;
}

/**
 * The most recent run over this revision, or `null` when it has never been
 * calculated. Grouped by `run_id` because a run IS a set of rows (append-only,
 * CALC-6) and its freshness is the newest row it wrote.
 */
async function latestRun(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<RevisionRunSummary | null> {
  const run = await latestRunOf(db, companyId, revisionId);
  if (!run) return null;
  return {
    run_id: run.runId,
    calculated_at: run.calculatedAt,
    rows: run.lineCount,
    failed: run.failedCount,
    ok: run.status === "ok",
  };
}

/** What `GET /api/revisions/[id]` answers (§12.2 — status, counters, validation, run). */
export interface RevisionSummaryDto {
  revision: RevisionDto;
  /** LC-2, for the period this revision belongs to (derived, never stored). */
  period_status: PeriodStatus;
  rows: RevisionRowCounts;
  validation: {
    results: number;
    blocking: number;
    /** The codes a screen has to explain — deduplicated, in code order. */
    blocking_codes: string[];
  };
  run: RevisionRunSummary | null;
}

/**
 * The summary of one revision. Independent tenant-pinned reads, none of which
 * re-runs anything: like `GET /api/revisions/[id]/validation` (T2.1) this
 * endpoint REPORTS state and never computes it, so opening a screen can neither
 * cost an unpredictable amount nor flip a result under a reviewer.
 *
 * `period_status` is the PERIOD's (LC-2), read off its current revision — which
 * is not necessarily the one being summarised: an abandoned draft is still
 * readable, and what it should say about its period is what the period says.
 */
export async function summariseRevision(
  db: DbClient,
  companyId: string,
  row: RevisionRow,
): Promise<RevisionSummaryDto> {
  const results = await listValidationResults(db, companyId, row.id);
  const blocking = blockingFailures(results);
  return {
    revision: serialiseRevision(row),
    period_status: derivePeriodStatus(
      await loadCurrentRevision(db, companyId, row.periodId),
      {
        hasLockedRevision: await hasLockedRevision(db, companyId, row.periodId),
      },
    ),
    rows: await countRevisionRows(db, companyId, row.id),
    validation: {
      results: results.length,
      blocking: blocking.length,
      blocking_codes: [...new Set(blocking.map((r) => r.ruleCode))].sort(),
    },
    run: await latestRun(db, companyId, row.id),
  };
}

// ─── Create (§5.1, row 1) ────────────────────────────────────────────────────

/** The body of `POST /api/periods/[id]/revisions` (§12.2). */
export interface NewRevisionValues {
  /** LC-9 — the revision to copy the current rows of (see `createRevision`). */
  seedFrom?: string;
  /** §5.1 — mandatory when the current revision is `locked` (a restatement). */
  changeReason?: string | null;
}

/** Outcome of a create: the row, or why it was refused. */
export type RevisionWriteResult =
  | { ok: true; row: RevisionRow }
  | { ok: false; error: "NOT_FOUND" }
  | {
      ok: false;
      error: "VALIDATION";
      /** Empty here: no `revision`-scope rule is implemented yet (see header). */
      rules: never[];
      /** WHY, in a shape the boundary screen can render (API-1). */
      detail: Record<string, unknown>;
    };

/** Wire → values. Shape only; the STATE rules are decided inside the write. */
export function parseNewRevision(
  body: unknown,
): ParseResult<NewRevisionValues> {
  if (body === null || body === undefined) return { ok: true, values: {} };
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, field: "body" };
  }
  const input = body as Record<string, unknown>;
  const values: NewRevisionValues = {};

  if (input.seedFrom !== undefined && input.seedFrom !== null) {
    const id = uuidOrNull(input.seedFrom);
    if (id === undefined || id === null)
      return { ok: false, field: "seedFrom" };
    values.seedFrom = id;
  }
  if (input.change_reason !== undefined) {
    const reason = textOrNull(input.change_reason);
    if (reason === undefined) return { ok: false, field: "change_reason" };
    values.changeReason = reason;
  }
  return { ok: true, values };
}

/**
 * Create a revision of one period (§5.1, row 1) — the ONE place a
 * `report_revision` row is inserted.
 *
 * THE PERIOD ROW IS LOCKED `FOR UPDATE` FIRST, and it is the reason the whole
 * body is in a transaction rather than three statements. `revision_no = max + 1`
 * and "exactly one `is_current`" are both read-then-write, and two concurrent
 * creates on one period would otherwise race into the `(period_id, revision_no)`
 * unique key and surface as a driver 500. Serialising on the PERIOD (not on the
 * revisions — the first create has none to lock) makes the second request wait
 * and then correctly refuse or number itself.
 *
 * `seedFrom` (LC-9) — THE RESTATEMENT PATH. The source must be a revision of
 * THIS period, which is one lookup rather than two: `listRevisions` is already
 * tenant-pinned and period-pinned, so a revision of another company and a
 * revision of another period read the same way — absent — and both are refused
 * on the FIELD (API-1) without a row being written. Requiring the same period is
 * the rule and not an accident: §5.5 is about restating, reopening and starting
 * a period again, and copying last year's rows into this year's report would
 * carry `year_month` values outside the period they are now claimed for.
 *
 * The copy itself is `seedRevisionRows` (`@/server/inventory/rows`, the only
 * writer of an input row) and it runs in THIS transaction, after the new
 * revision exists and is current — so `seeded_from_revision_id` and the rows it
 * promises are committed together or not at all. That is what T2.6 refused to
 * approximate: a stamped, empty revision looks exactly like a restatement whose
 * data vanished.
 */
export async function createRevision(
  db: DbClient,
  companyId: string,
  periodId: string,
  values: NewRevisionValues,
  actor: RevisionActor,
): Promise<RevisionWriteResult> {
  return db.transaction(async (tx): Promise<RevisionWriteResult> => {
    const [period] = await tx
      .select({ id: reportingPeriod.id })
      .from(reportingPeriod)
      .where(
        and(
          eq(reportingPeriod.id, periodId),
          eq(reportingPeriod.companyId, companyId),
        ),
      )
      .limit(1)
      .for("update");
    if (!period) return { ok: false, error: "NOT_FOUND" };

    const existing = await listRevisions(tx, companyId, periodId);
    const current = existing.find((row) => row.isCurrent);
    const currentStatus = current?.status as WorkflowStatus | undefined;

    if (
      currentStatus !== undefined &&
      !REVISION_CREATION_ALLOWED_FROM.includes(currentStatus)
    ) {
      return {
        ok: false,
        error: "VALIDATION",
        rules: [],
        detail: {
          reason: "review_in_flight",
          current_status: currentStatus,
          allowed_from: [...REVISION_CREATION_ALLOWED_FROM],
        },
      };
    }

    // LC-9 — the seed source, resolved among the revisions of THIS period (see
    // the header). Checked BEFORE anything is written, so a bad `seedFrom`
    // leaves no revision behind.
    const source = values.seedFrom
      ? existing.find((row) => row.id === values.seedFrom)
      : undefined;
    if (values.seedFrom !== undefined && !source) {
      return {
        ok: false,
        error: "VALIDATION",
        rules: [],
        detail: { field: "seedFrom", reason: "unknown_revision" },
      };
    }

    // §5.1's last row: a restatement over a LOCKED revision states why. The
    // locked report is published; a new one that silently replaces it without a
    // recorded reason is the thing an auditor asks about first.
    const changeReason = values.changeReason?.trim() || null;
    if (currentStatus === RESTATEMENT_FROM && !changeReason) {
      return {
        ok: false,
        error: "VALIDATION",
        rules: [],
        detail: { field: "change_reason", reason: "restatement_needs_reason" },
      };
    }

    if (current) {
      await tx
        .update(reportRevision)
        .set({ isCurrent: false })
        .where(eq(reportRevision.id, current.id));
    }

    const revisionNo =
      existing.reduce((max, row) => Math.max(max, row.revisionNo), 0) + 1;
    const [row] = await tx
      .insert(reportRevision)
      .values({
        companyId,
        periodId,
        revisionNo,
        status: "draft",
        isCurrent: true,
        changeReason,
        seededFromRevisionId: source?.id ?? null,
        createdBy: actor.userId,
      })
      .returning();

    // LC-9. After the insert (the rows need a revision to point at) and inside
    // the same transaction (see the header).
    const seeded = source
      ? await seedRevisionRows(tx, companyId, actor, source.id, row.id)
      : null;

    await logAudit(tx, {
      companyId,
      userId: actor.userId,
      actorRole: actor.role,
      entity: "report_revision",
      entityId: row.id,
      action: "create",
      summary: {
        period_id: periodId,
        revision_no: revisionNo,
        seeded_from_revision_id: source?.id ?? null,
        // The counts are the audit trail of a restatement: "revision 2 was
        // seeded from revision 1" is not answerable later from the rows alone,
        // because every one of them has since been editable.
        ...(seeded
          ? { seeded_rows: seeded.total, seeded_by_table: seeded.counts }
          : {}),
        previous_revision_id: current?.id ?? null,
        previous_status: currentStatus ?? null,
        change_reason: changeReason,
      },
    });

    return { ok: true, row };
  });
}
