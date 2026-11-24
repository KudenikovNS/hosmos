// THE APPEND-ONLY ROW SERVICE (§0.4, D5/D23, LC-3…LC-8) — one service over the
// four input tables, and the ONLY place a row version is written.
//
// See docs/decisions/server-inventory-rows.md for the full account.
import { calculationInputsEditable } from "@/server/periods/lifecycle";
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import { approvalDisclosure, logAudit } from "@/server/db/audit";
import type { DbClient } from "@/server/db/client";
import { reportRevision } from "@/server/db/schema";
import { carryDqAssessment } from "@/server/dq/assessments";
import { carryEvidenceLinks } from "@/server/evidence/links";
import {
  transitionRevision,
  type TransitionSession,
} from "@/server/revisions/transition";
import { runValidation } from "@/server/validation/run";
import {
  refuseValidation,
  ruleRef,
  writeValidated,
  type RuleRef,
} from "@/server/validation/write";
import type { WorkflowStatus } from "@/shared/enums";

import {
  INPUT_TABLES,
  INPUT_TABLE_NAMES,
  type InputRow,
  type InputTableName,
} from "./tables";

/**
 * The session facts a row mutation reads (PATTERN 3 — identity is never a body).
 * It IS `TransitionSession`: the service delegates `resume` to the state machine
 * and would otherwise need a second, structurally identical shape.
 */
export type RowSession = TransitionSession;

/**
 * Who wrote this version, as the mixin records it (`actor_id`/`actor_role`).
 *
 * Exported because `seedRevisionRows` is called by `@/server/revisions/revisions`
 * — which holds a `RevisionActor`, structurally this, and no session at all.
 */
export interface RowActor {
  readonly userId: string;
  readonly role: string | null;
}

/** The actor of a mutation, read off the session and nowhere else. */
function actorOf(session: RowSession): RowActor {
  return { userId: session.userId, role: session.membership?.role ?? null };
}

// ─── Wire-facing shapes ──────────────────────────────────────────────────────

/**
 * Column values of ONE table, keyed by Drizzle column name.
 *
 * Opaque on purpose (see the header): the values come from the table's parser,
 * which is the only thing that knows what a `refrigerant_added` is. The service
 * checks WHICH columns may be present, never what is in them — that is the
 * record rules' job, run inside the same transaction by `writeValidated`.
 */
export type RowValues = Readonly<Record<string, unknown>>;

/** A create: the body plus the two placements the service must resolve. */
export type NewRowValues = RowValues & {
  readonly revisionId: string;
  readonly legalEntityId: string;
};

/** An edit (LC-5): the changed columns, plus WHY when the row was approved. */
export interface RowEdit {
  readonly values: RowValues;
  /** Mandatory when the version being superseded is `approved` (LC-5). */
  readonly changeReason?: string | null;
}

/**
 * Outcome of a row mutation.
 *
 * `WriteResult` with one addition: a `detail` beside the rules. Two refusals of
 * this service have no rule of record and still have to say what went wrong —
 * a missing `change_reason` (LC-5) and an approve of a row that is not a draft
 * — and `{rules: []}` alone would leave the form with nothing to render. Same
 * distinction `createRevision` draws (`@/server/revisions/revisions`).
 */
export type RowWriteResult =
  | { ok: true; row: InputRow }
  | { ok: false; error: "NOT_FOUND" }
  | {
      ok: false;
      error: "VALIDATION";
      rules: RuleRef[];
      detail?: Record<string, unknown>;
    };

// ─── The version columns: what the service owns, what a parser may set ───────

/**
 * The mixin columns the SERVICE writes. A parser may never produce them, and a
 * body that somehow carries one is stripped rather than trusted: `state`,
 * `approved_by` and `actor_id` decide whether a row counts as approved and by
 * whom, so accepting them from a request body would let a client self-approve
 * by typing a field name (§0.1, PATTERN 3).
 */
const SERVICE_OWNED_COLUMNS: readonly string[] = [
  "id",
  "companyId",
  "state",
  "approvedBy",
  "approvedAt",
  "previousVersionId",
  "supersededById",
  "changeReason",
  "isDeleted",
  "actorId",
  "actorRole",
  "createdAt",
];

/**
 * The version columns — the ones a NEW version stamps fresh instead of copying.
 * Everything else on the predecessor (placement, unit, notes, and the whole
 * table-specific body) carries forward, which is what makes an edit a DELTA
 * rather than a re-entry of the row.
 */
const VERSION_COLUMNS: readonly string[] = [
  "id",
  "previousVersionId",
  "supersededById",
  "createdAt",
  "state",
  "approvedBy",
  "approvedAt",
  "changeReason",
  "isDeleted",
  "actorId",
  "actorRole",
];

/** Drop whatever the service owns; `also` adds the per-operation extras. */
function stripOwned(
  values: RowValues,
  also: readonly string[] = [],
): Record<string, unknown> {
  const clean: Record<string, unknown> = { ...values };
  for (const column of [...SERVICE_OWNED_COLUMNS, ...also])
    delete clean[column];
  return clean;
}

/** The predecessor's columns that a successor inherits (see VERSION_COLUMNS). */
function carryForward(previous: InputRow): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...previous };
  for (const column of VERSION_COLUMNS) delete copy[column];
  return copy;
}

/** The version columns of the successor, as each operation stamps them. */
interface VersionStamp {
  readonly id: string;
  readonly state: "draft" | "approved";
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly isDeleted: boolean;
  readonly changeReason: string | null;
  readonly previousVersionId: string | null;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * "The current rows of a revision" (§0.4) — the partial index's own predicate.
 *
 * EXPORTED SO THE PAIR CAN BE COMPARED (R-1). `<table>_current_idx` is a PARTIAL
 * index whose `WHERE` is this expression and nothing else, and nothing in the
 * toolchain compares the two: edit one side and the other silently stops being
 * usable, which costs a plan and no test. `activities.integration` therefore
 * reads the index's predicate out of `pg_index` and builds THIS function's SQL
 * beside it — calling the function rather than re-typing the condition, so a
 * changed predicate changes both halves of the assertion at once and the test
 * still asks a real question.
 */
export function currentOnly(table: InputTableName): SQL {
  const t = INPUT_TABLES[table];
  return isNull(t.supersededById);
}

/** One version by id, tenant-pinned. Any version — including a superseded one. */
export async function getVersion(
  db: DbClient,
  companyId: string,
  table: InputTableName,
  id: string,
): Promise<InputRow | undefined> {
  const t = INPUT_TABLES[table];
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.companyId, companyId)))
    .limit(1);
  return row;
}

/**
 * The CURRENT rows of a revision (LC-6): unsuperseded and not tombstoned.
 *
 * `superseded_by_id IS NULL` is the predicate of the partial index
 * `<table>_current_idx` (DM-12) verbatim — the listing and the index are written
 * to match, and `activities.integration` asserts the PLAN uses it rather than
 * asserting a duration. Tombstones are filtered in the same pass: a deleted row
 * is still the current version of its chain (that is what makes the deletion
 * append-only), it is simply not part of the report.
 */
export async function listCurrent(
  db: DbClient,
  companyId: string,
  table: InputTableName,
  filter: { revisionId?: string; includeDeleted?: boolean } = {},
): Promise<InputRow[]> {
  const t = INPUT_TABLES[table];
  const where: SQL[] = [eq(t.companyId, companyId), currentOnly(table)];
  if (filter.revisionId) where.push(eq(t.revisionId, filter.revisionId));
  if (!filter.includeDeleted) where.push(eq(t.isDeleted, false));
  return db
    .select()
    .from(t)
    .where(and(...where))
    .orderBy(asc(t.createdAt), asc(t.id));
}

/**
 * The depth at which a chain walk stops.
 *
 * A version chain grows by one per edit, so a real one is single digits; 500 is
 * "something is wrong" rather than "a busy row". The cap exists because
 * `previous_version_id` is a self-FK the database cannot prove acyclic: a cycle
 * written by a future bug would otherwise be an unbounded recursive query, i.e.
 * a hung request rather than a wrong answer. Both walks report when they hit it,
 * and each caller says what a truncated answer means for it.
 */
const MAX_VERSION_CHAIN = 500;

/** Ids of a version chain, and whether the walk stopped at the cap. */
interface ChainWalk {
  readonly ids: string[];
  readonly actorIds: string[];
  readonly truncated: boolean;
}

/**
 * Walk a version chain with ONE recursive CTE.
 *
 * `direction`:
 *   • `ancestors` — backwards along `previous_version_id`: every version this
 *     one grew out of. What LC-7 asks about at approve time.
 *   • `component` — both ways: the whole chain a version belongs to, which is
 *     what `GET …/history` (API-2) returns whichever version was asked for.
 *
 * `UNION` (not `UNION ALL`) is deliberate: it dedupes, so the recursion
 * terminates by producing no new rows — including on a chain that somehow
 * cycles. The `LIMIT` then bounds what comes BACK; the cap above bounds what a
 * caller is willing to believe.
 */
async function walkChain(
  db: DbClient,
  companyId: string,
  table: InputTableName,
  id: string,
  direction: "ancestors" | "component",
): Promise<ChainWalk> {
  const rel = sql.identifier(table);
  const step =
    direction === "ancestors"
      ? sql`n.id = c.previous_version_id`
      : sql`n.id = c.previous_version_id OR n.previous_version_id = c.id`;

  const rows = await db.execute<{ id: string; actor_id: string }>(sql`
    WITH RECURSIVE chain(id, previous_version_id, actor_id) AS (
      SELECT r.id, r.previous_version_id, r.actor_id
        FROM ${rel} r
       WHERE r.id = ${id} AND r.company_id = ${companyId}
      UNION
      SELECT n.id, n.previous_version_id, n.actor_id
        FROM ${rel} n
        JOIN chain c ON ${step}
    )
    SELECT id, actor_id FROM chain LIMIT ${MAX_VERSION_CHAIN + 1}
  `);

  const all = [...rows];
  const truncated = all.length > MAX_VERSION_CHAIN;
  const kept = truncated ? all.slice(0, MAX_VERSION_CHAIN) : all;
  return {
    ids: kept.map((row) => row.id),
    actorIds: kept.map((row) => row.actor_id),
    truncated,
  };
}

/** A version chain as `GET …/[id]/history` returns it (API-2). */
export interface RowHistory {
  /** Every version of the chain, oldest first. */
  readonly versions: InputRow[];
  /** The walk hit {@link MAX_VERSION_CHAIN} — the list is a prefix, not the chain. */
  readonly truncated: boolean;
}

/**
 * The whole version chain of a row, oldest first (API-2, LC-10).
 *
 * Any version of the chain identifies it — a client holding a superseded id
 * (a stale tab, a link in an audit note) gets the same history as one holding
 * the head. The per-row audit trail IS this list: LC-10 is explicit that the
 * version chain replaces a per-entry audit table.
 */
export async function history(
  db: DbClient,
  companyId: string,
  table: InputTableName,
  id: string,
): Promise<RowHistory> {
  const walk = await walkChain(db, companyId, table, id, "component");
  if (walk.ids.length === 0) return { versions: [], truncated: false };
  const t = INPUT_TABLES[table];
  const versions = await db
    .select()
    .from(t)
    .where(and(eq(t.companyId, companyId), inArray(t.id, walk.ids)))
    .orderBy(asc(t.createdAt), asc(t.id));
  return { versions, truncated: walk.truncated };
}

// ─── The freeze gate (VAL-010) and the resume it may trigger ─────────────────

/** The revision a mutation is aimed at, with the period that decides its fate. */
interface TargetRevision {
  readonly id: string;
  readonly periodId: string;
  readonly status: WorkflowStatus;
  readonly isCurrent: boolean;
}

/** Load the mutation's revision, tenant-pinned. A foreign id reads as absent. */
async function loadRevision(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<TargetRevision | undefined> {
  const [row] = await db
    .select({
      id: reportRevision.id,
      periodId: reportRevision.periodId,
      status: reportRevision.status,
      isCurrent: reportRevision.isCurrent,
    })
    .from(reportRevision)
    .where(
      and(
        eq(reportRevision.id, revisionId),
        eq(reportRevision.companyId, companyId),
      ),
    )
    .limit(1);
  return row ? { ...row, status: row.status as WorkflowStatus } : undefined;
}

/**
 * LC-5 / LC-8(2) — refuse the mutation when the period's report is closed.
 *
 * IT DELEGATES TO THE RULE rather than reading a status itself, for the reason
 * `planFacilityLimit` does with VAL-105: one computation, two consumers. The run
 * declares the TABLE being written as its mutated field, which is what makes
 * VAL-010 speak at all (see `inputTableAmong`), and only VAL-010 is consulted —
 * the other `period` rules are evaluated and stored (a boundary problem is worth
 * recording) but refusing on them here would answer a row edit with somebody
 * else's registered address.
 *
 * It runs INSIDE the write transaction, so a refusal rolls the VAL-010 record
 * back with the row it was judging; the refusal travels in the response payload,
 * exactly as for every other blocking rule on a write path (VR-3).
 */
async function assertRevisionMutable(
  tx: DbClient,
  companyId: string,
  table: InputTableName,
  revision: TargetRevision,
): Promise<void> {
  // Партия 25 — THE TARGET, NOT ONLY THE PERIOD. VAL-010 judges the period's
  // CURRENT revision, which is right for the period's own fields and wrong for a
  // row write aimed at an OLDER revision: once a restatement is open (revision
  // 4, draft) the period reads as editable, and a write sent to revision 3 —
  // locked, superseded, the revision a published report was rendered from —
  // went through. Found on prod by the smoke test of 25.09.2026, which wrote a
  // value into a locked revision. A row may change only in the CURRENT revision,
  // and only while that revision is editable; anything else is the same freeze
  // and is refused with the same rule, before a byte is written.
  if (
    !revision.isCurrent ||
    !calculationInputsEditable({
      id: revision.id,
      status: revision.status,
      revisionNo: 0,
    })
  ) {
    refuseValidation([ruleRef("VAL-010")]);
  }

  const records = await runValidation(tx, {
    companyId,
    scope: "period",
    targetId: revision.periodId,
    mutatedFields: [table],
  });
  const frozen = records.find((record) => record.ruleCode === "VAL-010");
  if (frozen && !frozen.passed) refuseValidation([ruleRef("VAL-010")]);
}

/**
 * LC-1, the seventh row of the §5.1 matrix — editing a row of a REJECTED
 * revision puts the revision back into `draft`.
 *
 * The transition is not performed here: `transitionRevision` is called, with the
 * write's own transaction handle, so `report_revision.status` keeps exactly one
 * writer and the resume is audited, capability-gated and rolled back with the
 * edit if the edit is refused. `resume` is deliberately off the wire (T2.6) —
 * this is its only caller.
 */
async function resumeIfRejected(
  tx: DbClient,
  session: RowSession,
  revision: TargetRevision,
): Promise<void> {
  if (revision.status !== "rejected" || !revision.isCurrent) return;
  const result = await transitionRevision(tx, session, revision.id, "resume");
  if (!result.ok) {
    // The only realistic failure is a capability the route already required, or
    // a concurrent transition. Either way the edit must not proceed on a
    // revision whose status it could not move.
    refuseValidation(result.error === "VALIDATION" ? result.rules : []);
  }
}

// ─── The S4 seam: what a new version carries with it ─────────────────────────

/** Everything a carry hook gets. `db` is the write transaction, never the pool. */
export interface VersionCarryContext {
  readonly db: DbClient;
  readonly companyId: string;
  readonly table: InputTableName;
  /**
   * The version being superseded, or `null` when there is none — a row that was
   * just CREATED (LC-3).
   *
   * T4.3 WIDENED IT, and the widening is what kept the auto-create of DQ-1 on
   * this seam instead of on a second one. A `dq_assessment` must exist from the
   * moment its row does (a row with none is a hole VAL-038 cannot report on,
   * since VAL-038 judges assessments), and it must be written in the SAME
   * transaction as the row or a rolled-back write leaves one behind. Both are
   * already true of this registry — it runs inside `writeValidated`'s
   * transaction — so the only thing missing was a call on the create path and a
   * way to say "there is no predecessor". A hook with nothing to do for a
   * created row returns (`carryEvidenceLinks` does exactly that).
   */
  readonly fromId: string | null;
  /** The version that replaces it — or, on a create, the row itself. */
  readonly toId: string;
  readonly actor: RowActor;
  /**
   * Which mutation produced the new version.
   *
   * `seed` (LC-9) is the one that is NOT a new version of a row in the same
   * revision but a copy of it into a NEW revision — and it is in this union
   * because LC-9 requires evidence links and DQ assessments to travel with the
   * copy exactly as they travel with an edit. A hook registered by T4.2/T4.3
   * therefore covers the restatement path for free; one that must not may branch
   * on this field.
   *
   * `create` is the one case where `fromId` is `null`: nothing is being
   * superseded, so a hook either has a rule-driven answer for a fresh row (DQ-1)
   * or has nothing to do.
   */
  readonly reason: "create" | "edit" | "approve" | "delete" | "seed";
}

/** One named side effect of superseding a version. The NAME is the contract. */
export interface VersionCarryHook {
  readonly name: string;
  readonly carry: (ctx: VersionCarryContext) => Promise<void>;
}

/**
 * THE S4 SEAM, DECLARED NOW SO S4 DOES NOT REWRITE THIS SERVICE.
 *
 * LC-4 and §4.16/§4.17 say evidence links and DQ assessments follow a row onto
 * its new version: a DQ assessment is per VERSION (К-16, its UNIQUE is
 * `(company_id, object_type, object_id)`), and evidence links point at row ids.
 * A new version starts with neither unless something carries them. Neither table has a
 * write path before T4.1/T4.3, so implementing the carry now would be a copy of
 * nothing.
 *
 * What CAN exist now is the call site, and it is the part that would otherwise
 * be retrofitted into four operations at once. The registry is empty and named,
 * the runner is wired into `newVersion`, and the stage test pins the set BY NAME
 * — so T4.2 (`carry_evidence_links`) and T4.3 (`carry_dq_assessment`) append an
 * entry here and touch nothing else. Same mechanism, and the same reasoning, as
 * `TRANSITION_PRECONDITIONS` in `@/server/revisions/transition`.
 *
 * T4.2 APPENDED THE FIRST ENTRY and changed nothing else in this file, which is
 * what the seam was for. `carry_evidence_links` COPIES a version's
 * `evidence_link` rows onto its successor — for all four reasons, deliberately;
 * `@/server/evidence/links` argues each one, including why a tombstone keeps its
 * evidence and why a seeded restatement inherits it.
 *
 * T4.3 APPENDED THE SECOND and widened `fromId`/`reason` by one case each (see
 * `VersionCarryContext`), which is the only change it made to this service.
 * `carry_dq_assessment` (`@/server/dq/assessments`) covers BOTH ends of DQ-1 and
 * DQ-5 with one function: the rule-driven pre-fill of a created row and the copy
 * onto every later version. Putting the auto-create here rather than in
 * `createRow` is deliberate — "what does a version of this row get" then has one
 * answer in one place, and it is answered inside the write transaction for free.
 */
export const VERSION_CARRY_HOOKS: readonly VersionCarryHook[] = [
  { name: "carry_evidence_links", carry: carryEvidenceLinks },
  { name: "carry_dq_assessment", carry: carryDqAssessment },
];

// ─── The write primitives ────────────────────────────────────────────────────

/**
 * Insert one version. THE only insert into an input table.
 *
 * The cast is the price of the generic (see the header): `values()` wants the
 * `$inferInsert` of ONE table and `table` is a union of four. What keeps it
 * honest is that nothing here invents a column — the values are the
 * predecessor's own columns plus a parser's output plus the stamp — and the
 * schema's NOT NULLs and CHECKs judge the result either way.
 */
async function insertVersion(
  tx: DbClient,
  table: InputTableName,
  values: Record<string, unknown>,
): Promise<InputRow> {
  const [row] = await tx
    .insert(INPUT_TABLES[table])
    .values(values as never)
    .returning();
  return row as InputRow;
}

/**
 * Stamp `superseded_by_id` on the predecessor — THE one mutation §0.4 allows on
 * an input row, and the only `UPDATE` this codebase issues against these tables.
 *
 * `WHERE superseded_by_id IS NULL` is not belt-and-braces: two concurrent edits
 * both hold the row's chain in view, and the loser must be told rather than
 * quietly producing a second successor of the same predecessor. No row updated →
 * somebody else got there first → the transaction is refused and rolled back.
 */
async function supersedeVersion(
  tx: DbClient,
  table: InputTableName,
  companyId: string,
  previousId: string,
  successorId: string,
): Promise<boolean> {
  const t = INPUT_TABLES[table];
  const updated = await tx
    .update(t)
    .set({ supersededById: successorId } as never)
    .where(
      and(
        eq(t.id, previousId),
        eq(t.companyId, companyId),
        isNull(t.supersededById),
      ),
    )
    .returning({ id: t.id });
  return updated.length === 1;
}

/**
 * Supersede `previous` with a new version (LC-4/LC-5/LC-6) — the three-step
 * protocol of the header, in one place.
 */
async function newVersion(
  tx: DbClient,
  session: RowSession,
  table: InputTableName,
  previous: InputRow,
  changes: RowValues,
  stamp: Omit<VersionStamp, "id" | "previousVersionId">,
  reason: VersionCarryContext["reason"],
): Promise<InputRow> {
  const companyId = session.company.id;
  const actor = actorOf(session);
  const id = randomUUID();

  const row = await insertVersion(tx, table, {
    ...carryForward(previous),
    // `revisionId` is NOT among the strippable columns by accident: an edit
    // makes a new VERSION of the same row in the same revision. Moving rows
    // between revisions is seeding (LC-9, T3.4), not editing.
    ...stripOwned(changes, ["revisionId"]),
    ...stamp,
    id,
    companyId,
    previousVersionId: previous.id,
    actorId: actor.userId,
    actorRole: actor.role,
  });

  if (!(await supersedeVersion(tx, table, companyId, previous.id, id))) {
    refuseValidation();
  }

  await runCarryHooks(tx, {
    companyId,
    table,
    fromId: previous.id,
    toId: id,
    actor,
    reason,
  });
  return row;
}

/** Run every registered carry hook over one predecessor → successor pair. */
async function runCarryHooks(
  tx: DbClient,
  ctx: Omit<VersionCarryContext, "db">,
): Promise<void> {
  for (const hook of VERSION_CARRY_HOOKS) {
    await hook.carry({ ...ctx, db: tx });
  }
}

/**
 * Load the version a mutation targets, locked, and refuse anything that is not
 * a live head.
 *
 * `FOR UPDATE` is taken before the successor is written so two edits of one row
 * serialise on the predecessor rather than on the unique-ish shape of the chain.
 * A SUPERSEDED version is refused because the alternative is a second current
 * row; a TOMBSTONE is refused because there is nothing left to edit (§0.4,
 * LC-6) — both read as `NOT_FOUND`, which is also what a foreign id reads as.
 */
async function loadHeadForUpdate(
  tx: DbClient,
  companyId: string,
  table: InputTableName,
  id: string,
): Promise<InputRow | undefined> {
  const t = INPUT_TABLES[table];
  const [row] = await tx
    .select()
    .from(t)
    .where(
      and(eq(t.id, id), eq(t.companyId, companyId), isNull(t.supersededById)),
    )
    .limit(1)
    .for("update");
  if (!row || row.isDeleted) return undefined;
  return row;
}

/** LC-5 — superseding an APPROVED version states why. */
function changeReasonFor(
  previous: InputRow,
  changeReason: string | null | undefined,
): string | null {
  const reason = changeReason?.trim() || null;
  if (previous.state === "approved" && !reason) {
    throw new MissingChangeReason();
  }
  return reason;
}

/** Thrown by {@link changeReasonFor}; carried out as a `detail`, not a rule. */
class MissingChangeReason extends Error {
  constructor() {
    super("change_reason is required when superseding an approved row");
    this.name = "MissingChangeReason";
  }
}

/** `WriteResult` → `RowWriteResult`, with the operation's `detail` attached. */
function refusalWith(
  result: { ok: false; error: "NOT_FOUND" | "VALIDATION"; rules?: RuleRef[] },
  detail?: Record<string, unknown>,
): RowWriteResult {
  if (result.error === "NOT_FOUND") return { ok: false, error: "NOT_FOUND" };
  return {
    ok: false,
    error: "VALIDATION",
    rules: result.rules ?? [],
    ...(detail ? { detail } : {}),
  };
}

/**
 * Every mutation runs through here: the freeze gate, the resume, the write, and
 * the `record` rules of the row that came out (VR-3).
 *
 * `writeValidated` supplies the transaction and the rollback; what this adds is
 * the two things that must happen INSIDE it and BEFORE the row exists — the
 * VAL-010 gate and the `resume` — plus the translation of `MissingChangeReason`
 * into a refusal with a `detail`.
 */
async function mutate(
  db: DbClient,
  session: RowSession,
  table: InputTableName,
  revisionId: string,
  write: (tx: DbClient) => Promise<InputRow | undefined>,
): Promise<RowWriteResult> {
  const companyId = session.company.id;
  const revision = await loadRevision(db, companyId, revisionId);
  if (!revision) return { ok: false, error: "NOT_FOUND" };

  let missingReason = false;
  const result = await writeValidated(
    db,
    { companyId, scope: "record", mutatedFields: [table] },
    async (tx) => {
      await assertRevisionMutable(tx, companyId, table, revision);
      await resumeIfRejected(tx, session, revision);
      try {
        return await write(tx);
      } catch (error) {
        if (!(error instanceof MissingChangeReason)) throw error;
        missingReason = true;
        return refuseValidation();
      }
    },
  );

  if (result.ok) return { ok: true, row: result.row };
  return refusalWith(
    result,
    missingReason
      ? { field: "change_reason", reason: "approved_row_needs_reason" }
      : undefined,
  );
}

// ─── The four operations (LC-3…LC-6) ─────────────────────────────────────────

/**
 * LC-3 — create a row: `state='draft'`, actor from the session, no predecessor.
 *
 * The `revision_id` and `legal_entity_id` in `values` are TARGETS, not identity
 * (PATTERN 3): the revision is resolved tenant-pinned by `mutate` (a foreign one
 * reads as absent), and the legal entity is left to the FK plus the record rules
 * — every input table declares `legal_entity_id NOT NULL REFERENCES
 * legal_entity`, and a legal entity of another tenant cannot be reached from a
 * revision of this one without the caller already knowing an id it should not.
 *
 * THE CARRY HOOKS RUN HERE TOO (T4.3), with `fromId: null`. A create has no
 * predecessor, but it does have the one thing DQ-1 needs — a row — and running
 * the registry on this path is what puts the auto-created `dq_assessment` inside
 * the SAME transaction as its row: a refused create rolls the assessment back
 * with it, and a committed row is never without one.
 */
export async function createRow(
  db: DbClient,
  session: RowSession,
  table: InputTableName,
  values: NewRowValues,
): Promise<RowWriteResult> {
  const companyId = session.company.id;
  const actor = actorOf(session);
  return mutate(db, session, table, values.revisionId, async (tx) => {
    const row = await insertVersion(tx, table, {
      ...stripOwned(values),
      companyId,
      id: randomUUID(),
      state: "draft",
      isDeleted: false,
      previousVersionId: null,
      supersededById: null,
      approvedBy: null,
      approvedAt: null,
      changeReason: null,
      actorId: actor.userId,
      actorRole: actor.role,
    });
    await runCarryHooks(tx, {
      companyId,
      table,
      fromId: null,
      toId: row.id,
      actor,
      reason: "create",
    });
    return row;
  });
}

/**
 * LC-5 — edit a row: a NEW version in `draft`, `previous_version_id` at the one
 * it replaces, `superseded_by_id` on the one it replaced.
 *
 * The successor is a DRAFT even when the predecessor was approved: an approved
 * figure that changes has to be approved again (that is the whole point of
 * per-row approval), and the reason it changed is recorded on the successor.
 */
export async function editRow(
  db: DbClient,
  session: RowSession,
  table: InputTableName,
  id: string,
  edit: RowEdit,
): Promise<RowWriteResult> {
  const companyId = session.company.id;
  const head = await getVersion(db, companyId, table, id);
  if (!head) return { ok: false, error: "NOT_FOUND" };

  return mutate(db, session, table, head.revisionId, async (tx) => {
    const previous = await loadHeadForUpdate(tx, companyId, table, id);
    if (!previous) return undefined;
    return newVersion(
      tx,
      session,
      table,
      previous,
      edit.values,
      {
        state: "draft",
        approvedBy: null,
        approvedAt: null,
        isDeleted: false,
        changeReason: changeReasonFor(previous, edit.changeReason),
      },
      "edit",
    );
  });
}

/**
 * LC-6 — delete a row: a new version with `is_deleted = true` (К-21).
 *
 * The row leaves `listCurrent` and stays in the database, which is the only
 * shape of deletion §0.4 allows: a report that was submitted with a figure must
 * keep the figure, and "who removed it, when and why" is the tombstone itself.
 */
export async function deleteRow(
  db: DbClient,
  session: RowSession,
  table: InputTableName,
  id: string,
  input: { changeReason?: string | null } = {},
): Promise<RowWriteResult> {
  const companyId = session.company.id;
  const head = await getVersion(db, companyId, table, id);
  if (!head) return { ok: false, error: "NOT_FOUND" };

  return mutate(db, session, table, head.revisionId, async (tx) => {
    const previous = await loadHeadForUpdate(tx, companyId, table, id);
    if (!previous) return undefined;
    return newVersion(
      tx,
      session,
      table,
      previous,
      {},
      {
        state: "draft",
        approvedBy: null,
        approvedAt: null,
        isDeleted: true,
        changeReason: changeReasonFor(previous, input.changeReason),
      },
      "delete",
    );
  });
}

/**
 * LC-7 — did the approver also write any earlier version of this row?
 *
 * Walked BACKWARDS from the version being approved, in the approve transaction,
 * so it sees the chain as it is being superseded rather than as it was when the
 * request arrived. `approvalDisclosure` reduces it to `self_approved`.
 *
 * WHEN THE CHAIN IS LONGER THAN THE CAP the answer is `true`, not `false`. A
 * truncated walk cannot prove the approver is absent from the part it did not
 * read, and the two errors are not symmetric: claiming `independent_review` on a
 * report where one person did both is a false assurance in an audit trail, while
 * claiming `self_approved` on a genuinely independent approval understates it.
 * The conservative direction is the one that never overstates independence.
 */
async function actorAlsoAuthored(
  tx: DbClient,
  companyId: string,
  table: InputTableName,
  headId: string,
  userId: string,
): Promise<boolean> {
  const walk = await walkChain(tx, companyId, table, headId, "ancestors");
  if (walk.truncated) return true;
  // The head itself is in the walk; its actor is the person who wrote the
  // version being approved, which is precisely LC-7's "actor of the source
  // version". Every earlier author counts too — the question is whether this
  // person touched the figure at all, not whether they touched it last.
  return walk.actorIds.includes(userId);
}

/**
 * LC-4 — approve a row: a NEW version with `state='approved'` and
 * `approved_by`/`approved_at`.
 *
 * WHY APPROVE IS ALSO A NEW VERSION. `state` is the one mixin column that would
 * otherwise have to change in place, and §0.4 permits exactly one in-place
 * mutation (`superseded_by_id`). Making approval a version keeps the chain the
 * complete audit trail LC-10 relies on — and it has a second consequence the
 * spec spells out: the head version's `actor_id` is the APPROVER, and the author
 * of the data stays visible one link back.
 *
 * THIS IS `data.approve`'s FIRST CONSUMER (USERS-ROLES-PLAN §7 п.3). The audit
 * row carries the §11.2 disclosure — `approval_grant`, `self_approved`,
 * `independent_review`, `approvers_count`, `active_member_count` — computed from
 * the acting membership plus the chain walk above, in the same transaction as
 * the approval it describes.
 */
export async function approveRow(
  db: DbClient,
  session: RowSession,
  table: InputTableName,
  id: string,
): Promise<RowWriteResult> {
  const companyId = session.company.id;
  const actor = actorOf(session);
  const head = await getVersion(db, companyId, table, id);
  if (!head) return { ok: false, error: "NOT_FOUND" };
  if (head.supersededById !== null || head.isDeleted) {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (head.state === "approved") {
    return {
      ok: false,
      error: "VALIDATION",
      rules: [],
      detail: { reason: "already_approved", state: head.state },
    };
  }

  const now = new Date();
  return mutate(db, session, table, head.revisionId, async (tx) => {
    const previous = await loadHeadForUpdate(tx, companyId, table, id);
    if (!previous || previous.state === "approved") return undefined;

    const alsoAuthored = await actorAlsoAuthored(
      tx,
      companyId,
      table,
      previous.id,
      session.userId,
    );
    const row = await newVersion(
      tx,
      session,
      table,
      previous,
      {},
      {
        state: "approved",
        approvedBy: actor.userId,
        approvedAt: now,
        isDeleted: false,
        changeReason: null,
      },
      "approve",
    );

    const membership = session.membership;
    await logAudit(tx, {
      companyId,
      userId: actor.userId,
      actorRole: membership?.role ?? null,
      entity: table,
      entityId: row.id,
      action: "update",
      summary: {
        action: "approve_row",
        table,
        revision_id: previous.revisionId,
        previous_version_id: previous.id,
        ...(membership
          ? approvalDisclosure({
              role: membership.role,
              approversCount:
                membership.hasIndependentApprover === false ? 0 : 1,
              activeMemberCount: membership.activeMemberCount ?? 1,
              actorAlsoAuthored: alsoAuthored,
            })
          : {}),
      },
    });
    return row;
  });
}

// ─── LC-9 — seeding a revision from another one ──────────────────────────────

/** How many rows a seed copied, per table. Zero everywhere is a legal answer. */
type SeedCounts = Record<InputTableName, number>;

/** A seed's result: the per-table counts and their sum. */
export interface SeedResult {
  readonly counts: SeedCounts;
  readonly total: number;
}

/**
 * LC-9 — copy the CURRENT, non-deleted rows of one revision into another as
 * NEW rows, `state='draft'`, `previous_version_id` at the row they came from.
 *
 * See docs/decisions/server-inventory-rows-L1042.md for the full account.
 */
export async function seedRevisionRows(
  tx: DbClient,
  companyId: string,
  actor: RowActor,
  fromRevisionId: string,
  toRevisionId: string,
): Promise<SeedResult> {
  const counts = Object.fromEntries(
    INPUT_TABLE_NAMES.map((table) => [table, 0]),
  ) as SeedCounts;

  for (const table of INPUT_TABLE_NAMES) {
    const sources = await listCurrent(tx, companyId, table, {
      revisionId: fromRevisionId,
    });
    for (const source of sources) {
      const id = randomUUID();
      await insertVersion(tx, table, {
        ...carryForward(source),
        id,
        companyId,
        revisionId: toRevisionId,
        previousVersionId: source.id,
        supersededById: null,
        state: "draft",
        approvedBy: null,
        approvedAt: null,
        changeReason: null,
        isDeleted: false,
        actorId: actor.userId,
        actorRole: actor.role,
      });
      await runCarryHooks(tx, {
        companyId,
        table,
        fromId: source.id,
        toId: id,
        actor,
        reason: "seed",
      });
      counts[table] += 1;
    }
  }

  return {
    counts,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
  };
}
