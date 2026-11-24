// =============================================================================
// WORKFLOW EVALUATORS (spec §6.2, §5.1) — the two rules whose SUBJECT is the
// `report_revision` itself: VAL-040 (segregation of duties) and VAL-041 (the
// approval preconditions, DQ-4/AC-7 inside it).
//
// THEY ARRIVE WITH T4.4 FOR THE USUAL REASON, in its strongest form. Both are
// rules ABOUT AN APPROVAL: VAL-040 asks who approved what, VAL-041 asks whether
// anything still stands in the way. Neither had anything to judge until the
// gates existed — the transition matrix moved a status and nothing consulted a
// rule on the way — and neither can be written twice, because the refusal and
// the record must agree (the mistake `plan-gate` was built to avoid).
//
// THE PAIR IS THE WHOLE OF §5.1's APPROVE ROW, SPLIT BY SEVERITY:
//   • VAL-040 is a WARNING and does not block. LC-7 is explicit and it is a
//     PRODUCT decision, not an oversight: in a company with one ESG person there
//     is nobody else to approve, and refusing would make the product unusable
//     for its most common customer. So self-approval is DISCLOSED — here as a
//     stored warning the report and the review screen render, and in
//     `audit_log.summary.self_approved` (§11.2, already written by
//     `approvalDisclosure`) — and never prevented.
//   • VAL-041 is a BLOCKING error and is the gate itself: "нет критических
//     ошибок и дыр в эвиденсе". It is the only rule of the inventory that
//     AGGREGATES others, which is exactly why it is written as three named
//     questions below rather than as one query nobody can re-derive.
//
// WHAT VAL-041 DOES *NOT* DO, and why the distinction is the substance of EV-5.
// A broken evidence file blocks the approval of the ROWS it backs (VAL-036,
// `record` scope, `./evidence`) — per row, at the moment of approval. VAL-041's
// evidence half is the RE-CHECK at revision approve/lock, over the documents
// those rows still cite, because a file can vanish between the day a row was
// approved and the day the report is closed. Two rules, one implementation of
// the check (`brokenDocumentIds`), two different things blocked.
// =============================================================================
import { and, eq, inArray, sql } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import {
  dqAssessment,
  evidenceLink,
  reportRevision,
  validationResult,
} from "@/server/db/schema";
import {
  INPUT_TABLE_NAMES,
  currentRowIds,
  isInputTableName,
} from "@/server/inventory/tables";
import { calculationInputsEditable } from "@/server/periods/lifecycle";
import type { WorkflowStatus } from "@/shared/enums";

import type { EvaluatorContext, RuleFinding } from "../types";

import { evidenceHoles } from "./dq";
import { brokenDocumentIds, documentsOfRevision } from "./evidence";

/** The revision a run is about, or `undefined` — silence, never a pass. */
async function loadRevision(ctx: EvaluatorContext) {
  const [row] = await ctx.db
    .select()
    .from(reportRevision)
    .where(
      and(
        eq(reportRevision.id, ctx.targetId),
        eq(reportRevision.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  return row;
}

/** One finding about one revision, filed under it (DM-28's key). */
function finding(revisionId: string, passed: boolean): RuleFinding[] {
  return [
    {
      passed,
      objectType: "report_revision",
      objectId: revisionId,
      revisionId,
    },
  ];
}

// ─── VAL-040 — segregation of duties (LC-7). A WARNING. ──────────────────────

/**
 * How many CURRENT rows of the revision were approved by somebody who had
 * already touched them — LC-7's `approved_by ≠ actor_id версии-источника`, in
 * one round trip over the four tables.
 *
 * THE COMPARISON IS WITH THE PREDECESSOR, not with the head's own `actor_id`,
 * and LC-4 is why: approval is a NEW VERSION whose `actor_id` IS the approver,
 * so comparing the head with itself would report every approval as
 * self-approval. The version one link back (`previous_version_id`) is the one
 * that carries the figure as the author left it — "the source version" of LC-7.
 *
 * A ROW WITH NO PREDECESSOR CANNOT BE JUDGED and is not counted. It was created
 * and approved without an intervening edit; the join finds nothing, and the
 * conservative reading would be to guess. The revision-level test below does not
 * guess either: it compares the actors §5.1 records on the revision row.
 */
async function selfApprovedRows(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<number> {
  const probes = INPUT_TABLE_NAMES.map(
    (name) => sql`
      SELECT count(*)::int AS n
        FROM ${sql.identifier(name)} head
        JOIN ${sql.identifier(name)} prev
          ON prev.id = head.previous_version_id
         AND prev.company_id = head.company_id
       WHERE head.company_id = ${companyId}
         AND head.revision_id = ${revisionId}
         AND head.superseded_by_id IS NULL
         AND head.is_deleted = false
         AND head.state = 'approved'
         AND head.approved_by = prev.actor_id`,
  );
  const rows = await db.execute<{ n: number }>(
    sql.join(probes, sql` UNION ALL `),
  );
  return [...rows].reduce((total, row) => total + Number(row.n), 0);
}

/**
 * VAL-040 — "разделение обязанностей (вносил ≠ утверждает)" (LC-7). A WARNING,
 * and one that is DELIBERATELY not blocking (see the header).
 *
 * IT ASKS THE QUESTION AT TWO LEVELS, because §5.1 records the actors at two:
 *   • per ROW — the approver of a figure had already written it (the query
 *     above). This is the half that speaks AT the revision's approval, since
 *     the rows were approved during the draft and their actors are on record;
 *   • per REVISION — `approved_by` is the person who created or submitted it.
 *     `approved_by` is NULL while the approval is still being decided (the gate
 *     runs before the transition writes it), so this half is silent on the
 *     attempt and speaks on every run afterwards, which is when the report and
 *     the audit trail are read.
 * One failure is enough: both describe one person doing both jobs.
 *
 * A PASS IS WRITTEN, not silence — for the reason VAL-103 gives. Only a written
 * row supersedes an earlier warning once an independent approver takes over.
 */
export async function evaluateVal040(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const revision = await loadRevision(ctx);
  if (!revision) return [];

  const rows = await selfApprovedRows(ctx.db, ctx.companyId, revision.id);
  const approver = revision.approvedBy;
  const revisionLevel =
    approver !== null &&
    (approver === revision.submittedBy || approver === revision.createdBy);

  return finding(revision.id, rows === 0 && !revisionLevel);
}

// ─── VAL-041 — the approval preconditions. BLOCKING. ─────────────────────────

/** One stored failure that still describes something the revision contains. */
interface CriticalError {
  readonly ruleCode: string;
  readonly objectType: string | null;
  readonly objectId: string | null;
}

/**
 * The rule codes VAL-041 does not aggregate, and why each is excluded.
 *
 * `VAL-041` itself — a rule that read its own last verdict could never recover
 * from one failure, since its stored row would keep failing it for ever.
 * `VAL-036` — the evidence integrity of the revision is RE-COMPUTED below
 * (EV-5 checks files at approve/lock, not whenever a result was last written),
 * so reading a stale row of it would answer with yesterday's disk.
 */
const NOT_AGGREGATED: readonly string[] = ["VAL-041", "VAL-036"];

/**
 * The BLOCKING failures stored against this revision that are still about
 * something it holds — "нет критических ошибок" (§6.2), made precise.
 *
 * WHY STORED RESULTS ARE ENOUGH HERE, and this is the load-bearing argument.
 * Every write of an input row goes through `writeValidated`, which runs the
 * `record` rules inside the transaction and ROLLS IT BACK on a blocking failure
 * (VR-3) — so a row cannot enter a revision failing one. The submit gate then
 * re-evaluates every current row (`TRANSITION_PRECONDITIONS.submit`), and from
 * `submitted` onwards the rows are FROZEN (LC-5): they cannot be edited in
 * `submitted`/`in_review`. The stored results a revision reaches its approval
 * with are therefore as fresh as the last thing that could have changed them.
 * The one thing that CAN change with nobody writing a row is the evidence on
 * disk — which is why that half is re-computed rather than read.
 *
 * "OF THIS REVISION" IS NOT ONE COLUMN, and assuming it was is the mistake this
 * function is written around. `revision_id` on a result is OPTIONAL — a finding
 * about an input row is filed under the ROW (`object_type` + `object_id`), and
 * most `record` evaluators fill nothing else, because the row already knows
 * which revision it belongs to. Reading `WHERE revision_id = $1` alone would
 * therefore find the evidence and DQ findings (which do carry it, so they surface
 * on the revision screen) and MISS every rule about a figure — i.e. exactly the
 * critical errors this aggregate exists for. So it asks twice: once by
 * `revision_id`, and once by the CURRENT ROWS of the revision.
 *
 * WHY A STALE VERSION MUST NOT COUNT. `validation_result` is keyed per OBJECT,
 * and an edit supersedes the object rather than updating it: the failing result
 * of version A stays in the table for ever, while version B (the fix) gets a
 * passing row of its own. Aggregating without this filter would mean a report
 * that can never be approved because of a problem the user already fixed — a
 * dead end with no UI that could explain it. So a result counts only when its
 * object is a CURRENT row, or hangs off one: an assessment (VAL-039) and a link
 * (VAL-037) are per version too.
 *
 * Anything else — a result with no object, or one about a period, an entity or a
 * calculation — counts as it stands: those objects are not versioned this way.
 */
async function criticalErrors(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<CriticalError[]> {
  const columns = {
    ruleCode: validationResult.ruleCode,
    objectType: validationResult.objectType,
    objectId: validationResult.objectId,
  };
  const failing = and(
    eq(validationResult.companyId, companyId),
    eq(validationResult.blocking, true),
    eq(validationResult.passed, false),
  );

  const current = new Set(
    (await currentRowIds(db, companyId, revisionId)).map((row) => row.id),
  );
  const byRevision = await db
    .select(columns)
    .from(validationResult)
    .where(and(failing, eq(validationResult.revisionId, revisionId)));
  const byRow =
    current.size === 0
      ? []
      : await db
          .select(columns)
          .from(validationResult)
          .where(
            and(failing, inArray(validationResult.objectId, [...current])),
          );

  const seen = new Set<string>();
  const relevant = [...byRevision, ...byRow].filter((row) => {
    if (NOT_AGGREGATED.includes(row.ruleCode)) return false;
    const key = `${row.ruleCode}|${row.objectType}|${row.objectId}`;
    if (seen.has(key)) return false; // one result, found by both queries
    seen.add(key);
    return true;
  });
  if (relevant.length === 0) return [];

  /** What an assessment / a link hangs off, by that object's own id. */
  const ownerOf = new Map<string, { type: string; id: string }>();
  const idsOf = (type: string) =>
    relevant
      .filter((row) => row.objectType === type && row.objectId !== null)
      .map((row) => row.objectId as string);

  const assessmentIds = idsOf("dq_assessment");
  if (assessmentIds.length > 0) {
    const rows = await db
      .select({
        id: dqAssessment.id,
        type: dqAssessment.objectType,
        objectId: dqAssessment.objectId,
      })
      .from(dqAssessment)
      .where(
        and(
          eq(dqAssessment.companyId, companyId),
          inArray(dqAssessment.id, assessmentIds),
        ),
      );
    for (const row of rows) {
      ownerOf.set(row.id, { type: row.type, id: row.objectId });
    }
  }

  const linkIds = idsOf("evidence_link");
  if (linkIds.length > 0) {
    const rows = await db
      .select({
        id: evidenceLink.id,
        type: evidenceLink.linkedObjectType,
        objectId: evidenceLink.linkedObjectId,
      })
      .from(evidenceLink)
      .where(
        and(
          eq(evidenceLink.companyId, companyId),
          inArray(evidenceLink.id, linkIds),
        ),
      );
    for (const row of rows) {
      ownerOf.set(row.id, { type: row.type, id: row.objectId });
    }
  }

  return relevant.filter((row) => {
    if (row.objectId === null || row.objectType === null) return true;
    if (isInputTableName(row.objectType)) return current.has(row.objectId);
    if (
      row.objectType !== "dq_assessment" &&
      row.objectType !== "evidence_link"
    )
      return true;
    const owner = ownerOf.get(row.objectId);
    // Unresolvable, or hanging off something that is not an input row (an
    // assessment of a facility, a link to a legal entity): not versioned per
    // revision, so it counts as it stands. A failure is never dropped silently.
    if (!owner || !isInputTableName(owner.type)) return true;
    return current.has(owner.id);
  });
}

/**
 * VAL-041 — "предпосылки утверждения: нет критических ошибок/дыр в эвиденсе"
 * (§6.2, §5.1's `in_review → approved` row). BLOCKING.
 *
 * See docs/decisions/server-validation-evaluators-revision-L323.md for the full account.
 */
export async function evaluateVal041(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const revision = await loadRevision(ctx);
  if (!revision) return [];
  if (
    calculationInputsEditable({
      id: revision.id,
      status: revision.status as WorkflowStatus,
      revisionNo: revision.revisionNo,
    })
  ) {
    return [];
  }

  const critical = await criticalErrors(ctx.db, ctx.companyId, revision.id);
  if (critical.length > 0) return finding(revision.id, false);

  const documentIds = await documentsOfRevision(
    ctx.db,
    ctx.companyId,
    revision.id,
  );
  const broken = await brokenDocumentIds(ctx.db, ctx.companyId, documentIds);
  if (broken.size > 0) return finding(revision.id, false);

  const holes = await evidenceHoles(ctx.db, ctx.companyId, revision.id);
  return finding(revision.id, holes.length === 0);
}
