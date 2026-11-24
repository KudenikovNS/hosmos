// The revision state machine (§5.1, LC-*): one transition matrix, each action
// owned by one capability and guarded by named preconditions (blocking rules,
// a green calculation, the plan's facility limit). Refusals carry the rule
// codes so the UI explains rather than guesses.
//
// See docs/decisions/revision-transitions.md for the full account.
import { and, desc, eq, ne } from "drizzle-orm";

import { requireCapability } from "@/server/auth/capabilities";
import { runFreshness } from "@/server/calc/run";
import { approvalDisclosure, logAudit } from "@/server/db/audit";
import type { DbClient } from "@/server/db/client";
import { reportRevision } from "@/server/db/schema";
import { currentRowIds } from "@/server/inventory/tables";
import { REVISION_LOCK_FIELD } from "@/server/periods/lifecycle";
import type { ValidationScope } from "@/server/validation/rules";
import {
  blockingFailures,
  runValidation,
  storedBlockingFailures,
  type ValidationResultRecord,
} from "@/server/validation/run";
import { ruleRef, type RuleRef } from "@/server/validation/write";
import type { WorkflowStatus } from "@/shared/enums";
import type { Capability, CompanyRole } from "@/shared/roles";

import { buildFrozenScope } from "./frozen";
import {
  countRevisionRows,
  getRevision,
  type RevisionActor,
  type RevisionRow,
} from "./revisions";

/**
 * Every action of the machine (§5.1). Six of them are the wire's
 * (`POST /api/revisions/[id]/transition`, §12.2); `resume` is the seventh row of
 * the matrix — `rejected → draft` — and is called by the SERVICE that edits a
 * row of a rejected revision (T3.1), never by a client. Spelling it as a member
 * of the matrix rather than as an implicit side effect of an edit is LC-1's
 * whole point: it is audited, it is capability-gated, and it cannot be done by
 * anything but this function.
 */
export type RevisionAction =
  | "submit"
  | "start_review"
  | "approve"
  | "reject"
  | "resume"
  | "lock"
  | "abandon";

/** The actions a CLIENT may name (§12.2). `resume` is service-only (above). */
export const WIRE_ACTIONS: readonly RevisionAction[] = [
  "submit",
  "start_review",
  "approve",
  "reject",
  "lock",
  "abandon",
];

/** Is `value` an action a client may send? (Parser-level guard, §0.8.) */
export function isWireAction(value: unknown): value is RevisionAction {
  return (
    typeof value === "string" &&
    (WIRE_ACTIONS as readonly string[]).includes(value)
  );
}

/** One row of the §5.1 matrix. */
export interface TransitionRule {
  readonly action: RevisionAction;
  readonly from: WorkflowStatus;
  /** The status afterwards — `null` when the action changes currency, not state. */
  readonly to: WorkflowStatus | null;
  readonly capability: Capability;
}

/**
 * §5.1, VERBATIM AND AS DATA. Read it as the table it is: an (action, from) pair
 * that is not here is forbidden, and that is the entire definition of forbidden.
 *
 * `abandon` is the one row with no `to` (LC-1a): abandoning does not change a
 * status — the revision stays a draft, keeps its rows and its files (D6) — it
 * gives `is_current` back to the highest-numbered survivor. "Deleted" is not a
 * state this product has.
 *
 * Creation (`— → draft`, the matrix's first row) is NOT here because it is not a
 * transition OF a revision: it is a rule about the current one, and it lives
 * with the insert in `./revisions` (`REVISION_CREATION_ALLOWED_FROM`).
 */
export const ALLOWED_TRANSITIONS: readonly TransitionRule[] = [
  {
    action: "submit",
    from: "draft",
    to: "submitted",
    capability: "data.submit",
  },
  {
    action: "start_review",
    from: "submitted",
    to: "in_review",
    capability: "data.review",
  },
  {
    action: "approve",
    from: "in_review",
    to: "approved",
    capability: "data.approve",
  },
  {
    action: "reject",
    from: "in_review",
    to: "rejected",
    capability: "data.review",
  },
  { action: "resume", from: "rejected", to: "draft", capability: "data.write" },
  {
    action: "lock",
    from: "approved",
    to: "locked",
    capability: "data.approve",
  },
  { action: "abandon", from: "draft", to: null, capability: "data.write" },
];

/**
 * The capability an action needs (§5.4) — DERIVED from the matrix, never a
 * second list. Each action appears with exactly one capability, so the first row
 * that names it is the answer; an action absent from the matrix is a programming
 * error, not a 403.
 */
function capabilityFor(action: RevisionAction): Capability {
  const rule = ALLOWED_TRANSITIONS.find((row) => row.action === action);
  if (!rule) throw new Error(`No transition matrix row for action: ${action}`);
  return rule.capability;
}

/** The transition row for (action, from), or `undefined` — i.e. "forbidden". */
export function transitionFor(
  action: RevisionAction,
  from: WorkflowStatus,
): TransitionRule | undefined {
  return ALLOWED_TRANSITIONS.find(
    (row) => row.action === action && row.from === from,
  );
}

/** Which actions are legal from `status` — what a refusal tells the client. */
function actionsFrom(status: WorkflowStatus): RevisionAction[] {
  return ALLOWED_TRANSITIONS.filter((row) => row.from === status).map(
    (row) => row.action,
  );
}

// ─── The precondition registry ───────────────────────────────────────────────

/** The extra values a transition can carry (§5.1's side-effect column). */
export interface TransitionInput {
  /** `reject` — mandatory (§5.1); stored as `review_comment`. */
  readonly comment?: string | null;
  /** Any transition may record why; a restatement MUST (see `./revisions`). */
  readonly changeReason?: string | null;
  /** `start_review` — defaults to the actor taking the revision up. */
  readonly assignedTo?: string | null;
}

/** Everything a precondition may look at. */
interface PreconditionContext {
  /** The caller's handle — NOT a transaction (see the header). */
  readonly db: DbClient;
  readonly companyId: string;
  readonly revision: RevisionRow;
  readonly input: TransitionInput;
}

/**
 * Why a precondition refused. `PLAN_REQUIRED` is a 402 with an upgrade path,
 * `VALIDATION` a 422; both may name rules and both may carry a `detail` the UI
 * renders. A check returns `null` when it is satisfied.
 */
type PreconditionFailure = {
  readonly error: "VALIDATION" | "PLAN_REQUIRED";
  readonly rules?: RuleRef[];
  readonly detail?: Record<string, unknown>;
};

/** One named precondition. The NAME is the contract the stage test asserts. */
export interface PreconditionCheck {
  readonly name: string;
  readonly check: (
    ctx: PreconditionContext,
  ) => Promise<PreconditionFailure | null>;
}

/**
 * §5.1 — "все текущие строки `state='approved'`".
 *
 * Real query, empty population when it was registered (see `countRevisionRows`):
 * in S2 it always passed because nothing wrote an input row yet, and it started
 * biting the day T3.1 did — with no edit here. That is the difference between
 * registering a check that is vacuously true and postponing the check.
 *
 * "CURRENT" IS `superseded_by_id IS NULL AND NOT is_deleted`, the definition of
 * the partial index of §4.21 — so an old version of an edited row does not hold
 * a submit up (it is history, and its state is frozen at whatever it was), and a
 * TOMBSTONE does not either (LC-6: a deleted figure is not in the report, and
 * demanding its approval would make deletion impossible after a rejection).
 */
const allRowsApproved: PreconditionCheck = {
  name: "all_rows_approved",
  async check({ db, companyId, revision }) {
    const counts = await countRevisionRows(db, companyId, revision.id);
    if (counts.pending === 0) return null;
    return {
      error: "VALIDATION",
      detail: {
        reason: "rows_not_approved",
        rows: counts.total,
        approved: counts.approved,
        pending: counts.pending,
      },
    };
  },
};

/**
 * §5.1 — a rejection states why. Not a parser rule: the comment is a
 * PRECONDITION of the transition (a body carrying it for `approve` is simply
 * ignored), and it is what the author reads to know what to fix.
 */
const reviewCommentRequired: PreconditionCheck = {
  name: "review_comment_required",
  async check({ input }) {
    if (input.comment?.trim()) return null;
    return {
      error: "VALIDATION",
      detail: { field: "comment", reason: "reject_needs_comment" },
    };
  },
};

/**
 * F1/PG-3 — the Starter hard gate, and the ONLY 402 in the machine.
 *
 * IT DELEGATES TO THE RULE rather than counting facilities itself: the run
 * evaluates VAL-105 (which is gated on `REVISION_LOCK_FIELD`, so this is the
 * only run in the product that makes it speak) and the record it writes is both
 * the decision here and the explanation the UI reads afterwards. One
 * computation, two consumers, no chance of the screen and the gate disagreeing.
 *
 * It looks at VAL-105 AND NOTHING ELSE from that run. The other `period` rules
 * are evaluated and stored — a boundary problem is worth recording at lock — but
 * refusing on them belongs to the "no blocking rules" precondition of `approve`
 * that S4 registers, one step earlier in the flow. A lock that refused on a
 * boundary warning under the F1 name would be a 402 for a non-plan problem,
 * which is the one thing a payment status must never say.
 */
const planFacilityLimit: PreconditionCheck = {
  name: "plan_facility_limit",
  async check({ db, companyId, revision }) {
    const records = await runValidation(db, {
      companyId,
      scope: "period",
      targetId: revision.periodId,
      mutatedFields: [REVISION_LOCK_FIELD],
    });
    const f1 = records.find((record) => record.ruleCode === "VAL-105");
    if (!f1 || f1.passed) return null;
    return {
      error: "PLAN_REQUIRED",
      rules: [ruleRef("VAL-105")],
      detail: { reason: "facility_limit", period_id: revision.periodId },
    };
  },
};

/**
 * §5.1 — "прогон расчёта существует и `ok`" (CALC-6). THE LAST ENTRY THE
 * REGISTRY WAS BUILT FOR, and the seam held: this file gains one constant and
 * one line of the table, and nothing else changes.
 *
 * THREE REFUSALS, NOT ONE, because a preparer can act on each differently:
 *   • `missing`  — the revision was never calculated. Press Calculate.
 *   • `failed`   — the run exists and some line did not compute (§0.7's three
 *                  failures). Fix the factor set or the unit, then recalculate.
 *                  This is the refusal that stops AC-6's missing-factor report
 *                  from being approved with a hole in it.
 *   • `stale`    — a green run exists, but an INPUT moved after it. `sources`
 *                  names which of the three (rows / period / boundary), so the
 *                  message can say what changed rather than "recalculate".
 *
 * "OVER THE CURRENT ROWS" IS THE WHOLE POINT OF THE THIRD. §5.1's precondition
 * is not "a green run exists" — a run from before the boundary was redrawn is
 * green about a report that no longer exists. `runFreshness` is the single
 * implementation of that comparison (CALC-6), shared with `GET …/results`, so
 * the "recalculate" the screen shows and the refusal the gate gives are the same
 * computation and cannot disagree.
 *
 * IT NAMES NO VAL-* CODE, deliberately. The freshness of a run is a
 * PRECONDITION of the transition, not a rule about an object: there is no row it
 * could be filed against (`validation_result` keys on an object) and no screen
 * that should show it as a permanent finding — it stops being true the moment
 * the user presses Calculate. VAL-034/VAL-035 judge the CONTENT of a run and do
 * have codes; whether one has been made recently enough is this check's.
 */
function calculationRunGreen(requireEmptyRun = false): PreconditionCheck {
  return {
    name: "calculation_run_green",
    async check({ db, companyId, revision }) {
      const freshness = await runFreshness(db, companyId, revision);
      // Approval can accept a disclosure-only revision. Lock additionally needs
      // an explicit (possibly empty) run to pin the historical export.
      if (!requireEmptyRun && !freshness.calculable) return null;
      if (!freshness.run) {
        return {
          error: "VALIDATION",
          detail: { reason: "calculation_run_missing" },
        };
      }
      if (freshness.run.status !== "ok") {
        return {
          error: "VALIDATION",
          detail: {
            reason: "calculation_run_failed",
            run_id: freshness.run.runId,
            failed: freshness.run.failedCount,
          },
        };
      }
      if (freshness.stale) {
        return {
          error: "VALIDATION",
          detail: {
            reason: "calculation_run_stale",
            run_id: freshness.run.runId,
            calculated_at: freshness.run.calculatedAt,
            sources: [...freshness.staleSources],
            inputs_changed_at: freshness.inputsChangedAt,
          },
        };
      }
      return null;
    },
  };
}

/**
 * LC-1a — abandoning is about CURRENCY, so there must be some to hand back. A
 * revision that is already not current has been abandoned (or superseded by a
 * newer one); repeating the action would silently promote an older revision.
 */
const abandonRequiresCurrent: PreconditionCheck = {
  name: "abandon_requires_current",
  async check({ revision }) {
    if (revision.isCurrent) return null;
    return {
      error: "VALIDATION",
      detail: { reason: "not_current", revision_id: revision.id },
    };
  },
};

/**
 * VR-3, AS A GATE — "нет непройденных блокирующих правил" of the scopes an
 * advancement is answerable for (§5.1). ONE check, parameterised by scope, is
 * registered three times: submit answers for `record`/`revision`/
 * `reference_org`, approve and lock for `revision`/`period`.
 *
 * WHY IT RE-EVALUATES INSTEAD OF READING THE TABLE, for the two scopes it can.
 * VR-2 names the submit and approve attempts as TRIGGERS of a run, and it has to:
 * `validation_result` holds the verdict of the last evaluation, and a rule about
 * a row can go stale without the row being touched — a facility's operating dates
 * move (VAL-007), the pinned factor set loses a refrigerant (VAL-019), the file
 * behind an approved figure disappears (VAL-036). A gate that read yesterday's
 * verdicts would let a report through on data that no longer passes, which is the
 * silent hole R-12 exists to prevent, one level up.
 *
 * WHAT IS BOUNDED, and it is bounded on purpose. `revision` and `period` are ONE
 * target each. `record` is the CURRENT rows of this revision — the set the submit
 * is about, and nothing else in the company. `reference_org` is the only scope
 * read rather than run, because its subjects include the global factor catalogue;
 * `storedBlockingFailures` argues that one where it lives.
 *
 * IT NEVER TURNS A 402 INTO A 422. At `lock` this check runs AFTER
 * `planFacilityLimit`, so a Starter company over the site limit gets its payment
 * answer from the rule that is about payment. The order in the registry is the
 * whole mechanism — and the period run made here declares no `mutatedFields`, so
 * VAL-105 stays silent in it (it speaks only for a write that declares
 * `locked_at`) and cannot be re-read as a generic blocking failure.
 */
const noBlockingRules = (
  scopes: readonly ValidationScope[],
): PreconditionCheck => ({
  name: "no_blocking_rules",
  async check({ db, companyId, revision }) {
    const failures: { code: string; scope: string; object: string | null }[] =
      [];
    const collect = (records: readonly ValidationResultRecord[]) => {
      for (const record of blockingFailures(records)) {
        failures.push({
          code: record.ruleCode,
          scope: record.scope,
          object: record.objectId,
        });
      }
    };

    if (scopes.includes("record")) {
      for (const row of await currentRowIds(db, companyId, revision.id)) {
        collect(
          await runValidation(db, {
            companyId,
            scope: "record",
            targetId: row.id,
          }),
        );
      }
    }
    if (scopes.includes("revision")) {
      collect(
        await runValidation(db, {
          companyId,
          scope: "revision",
          targetId: revision.id,
        }),
      );
    }
    if (scopes.includes("period")) {
      collect(
        await runValidation(db, {
          companyId,
          scope: "period",
          targetId: revision.periodId,
        }),
      );
    }
    if (scopes.includes("reference_org")) {
      collect(await storedBlockingFailures(db, companyId, "reference_org"));
    }

    if (failures.length === 0) return null;
    const codes = [...new Set(failures.map((failure) => failure.code))].sort();
    return {
      error: "VALIDATION",
      // The API-1 payload: one `RuleRef` per CODE, read from the inventory, so
      // ten failing rows of one rule do not come back as ten identical rules.
      rules: codes.map((code) => ruleRef(code)),
      detail: {
        reason: "blocking_rules",
        scopes: [...scopes],
        // Per OBJECT, so the review screen can link to the thing to fix (UI-3)
        // instead of showing a code the user has to go looking for.
        failures,
      },
    };
  },
});

/**
 * THE REGISTRY. Later stages APPEND to these lists and change nothing else:
 * S5 adds `calculation_run_green` to `approve` (CALC-6 — §5.1's "прогон расчёта
 * существует и `ok`", the one half of the approve row VAL-041 deliberately does
 * not answer for). Every entry is named, and the stage test pins the set — a
 * check that is written but never registered is caught by that test rather than
 * by an auditor.
 *
 * WHAT T4.4 ADDED, and where each one sits in its list:
 *   submit  → `no_blocking_rules` AFTER `all_rows_approved`. "You have unapproved
 *             rows" is the answer a user can act on directly; re-running every
 *             rule to say it in a longer way first would be slower and worse.
 *   approve → `no_blocking_rules` (revision + period) — VAL-041 is the rule of
 *             record inside it, and DQ-4/AC-7 inside that.
 *   lock    → `no_blocking_rules` AFTER `plan_facility_limit`, so the 402 keeps
 *             its priority over the 422 (see the check's own comment).
 */
export const TRANSITION_PRECONDITIONS: Record<
  RevisionAction,
  readonly PreconditionCheck[]
> = {
  submit: [
    allRowsApproved,
    noBlockingRules(["record", "revision", "reference_org"]),
  ],
  start_review: [],
  // T5.4 appends `calculation_run_green` AFTER the rule sweep, and the order is
  // part of the contract: "your data does not validate" is the answer a preparer
  // can act on directly, and a run made over data that does not validate would
  // have to be made again afterwards anyway. Recalculating is also the more
  // expensive of the two to ask for.
  approve: [noBlockingRules(["revision", "period"]), calculationRunGreen()],
  reject: [reviewCommentRequired],
  resume: [],
  lock: [
    planFacilityLimit,
    noBlockingRules(["revision", "period"]),
    calculationRunGreen(true),
  ],
  abandon: [abandonRequiresCurrent],
};

// ─── The service ─────────────────────────────────────────────────────────────

/** The session facts a transition reads (PATTERN 3 — identity is never a body). */
export interface TransitionSession {
  readonly userId: string;
  readonly company: { readonly id: string };
  readonly membership?: {
    readonly role: CompanyRole;
    readonly hasIndependentApprover?: boolean;
    readonly activeMemberCount?: number;
  } | null;
  readonly capabilities?: Capability[];
}

/** What a refusal tells the client about WHERE in the machine it happened. */
export interface TransitionDetail {
  action: RevisionAction;
  from: WorkflowStatus;
  /** The actions that WOULD be legal from here — the UI's next step. */
  allowed: RevisionAction[];
  /** The precondition that refused, when one did (never a role or a plan id). */
  precondition?: string;
  [key: string]: unknown;
}

/** Outcome of a transition attempt. */
export type TransitionResult =
  | { ok: true; row: RevisionRow; from: WorkflowStatus }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "FORBIDDEN" }
  | {
      ok: false;
      error: "VALIDATION" | "PLAN_REQUIRED";
      rules: RuleRef[];
      detail: TransitionDetail;
    };

/** The column changes of one transition (its §5.1 side-effect cell). */
type RevisionUpdate = Partial<typeof reportRevision.$inferInsert>;

/**
 * The side effects of each action, as data-shaped as they can be: everything
 * except `lock` is a set of stamps, and `lock` additionally snapshots the
 * boundary (which needs the transaction, so it is applied by the caller).
 */
function effectsOf(
  rule: TransitionRule,
  actor: RevisionActor,
  input: TransitionInput,
  now: Date,
): RevisionUpdate {
  const changeReason = input.changeReason?.trim() || undefined;
  const base: RevisionUpdate = {
    ...(rule.to ? { status: rule.to } : {}),
    ...(changeReason ? { changeReason } : {}),
  };
  switch (rule.action) {
    case "submit":
      return { ...base, submittedBy: actor.userId, submittedAt: now };
    case "start_review":
      // §5.1's precondition IS this effect: a revision in review has a reviewer.
      // The actor taking it up is the default and the only shape the API needs
      // in Phase 1 — assignment to somebody else is a UI feature, not a rule.
      return { ...base, assignedTo: input.assignedTo ?? actor.userId };
    case "approve":
      return { ...base, approvedBy: actor.userId, approvedAt: now };
    case "reject":
      return {
        ...base,
        reviewComment: input.comment?.trim() ?? null,
        reviewedBy: actor.userId,
        reviewedAt: now,
      };
    case "resume":
      // The rejection stays on the row: `review_comment` is what the author is
      // fixing, and erasing it on resume would lose the reason mid-repair.
      return base;
    case "lock":
      return { ...base, lockedBy: actor.userId, lockedAt: now };
    case "abandon":
      return { ...base, isCurrent: false };
  }
}

/**
 * The audit summary of a transition (LC-10). `approve` and `lock` additionally
 * carry the SELF-APPROVAL DISCLOSURE (§11.2, LC-7) — the sleeping `data.approve`
 * consumer the roles layer promised, wired here at the REVISION level:
 * `actor_also_authored` compares the approver against the two actors already on
 * the row (who created the revision, who submitted it). Segregation of duties is
 * DISCLOSED, not enforced: VAL-040 is a warning and arrives with T4.4, and the
 * per-ROW version of the same question is T3.1's (LC-4).
 */
function auditSummary(
  rule: TransitionRule,
  revision: RevisionRow,
  session: TransitionSession,
  input: TransitionInput,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    action: rule.action,
    from: rule.from,
    to: rule.to,
    period_id: revision.periodId,
    revision_no: revision.revisionNo,
    ...(input.comment?.trim() ? { comment: input.comment.trim() } : {}),
    ...(input.changeReason?.trim()
      ? { change_reason: input.changeReason.trim() }
      : {}),
  };

  const membership = session.membership;
  if ((rule.action === "approve" || rule.action === "lock") && membership) {
    Object.assign(
      summary,
      approvalDisclosure({
        role: membership.role,
        approversCount: membership.hasIndependentApprover === false ? 0 : 1,
        activeMemberCount: membership.activeMemberCount ?? 1,
        actorAlsoAuthored:
          revision.submittedBy === session.userId ||
          revision.createdBy === session.userId,
      }),
    );
  }
  return summary;
}

/**
 * Move one revision through the §5.1 matrix — THE mutation point of `status`.
 *
 * ORDER OF REFUSALS (§0.2 and the matrix, in that order):
 *   404 the revision is not this company's (a foreign id never confirms itself)
 *   403 the role lacks the action's capability — decided BEFORE the plan gate,
 *       because an upgrade cannot help someone whose role denies the action
 *   422 the (action, from) pair is not a row of the matrix
 *   402 / 422 a precondition refused, named
 *   200 the effect is applied, `is_current` is maintained, the audit row written
 *
 * The db handle is a parameter (as in every other service) although §5.1 writes
 * the signature as `transitionRevision(session, revisionId, action)`: the spec is
 * eliding the handle, not asking the service to reach for the singleton — the
 * caller's handle is what makes this callable from inside T3.1's row-edit
 * transaction.
 */
export async function transitionRevision(
  db: DbClient,
  session: TransitionSession,
  revisionId: string,
  action: RevisionAction,
  input: TransitionInput = {},
): Promise<TransitionResult> {
  const companyId = session.company.id;
  const revision = await getRevision(db, companyId, revisionId);
  if (!revision) return { ok: false, error: "NOT_FOUND" };

  const from = revision.status as WorkflowStatus;
  const detail = (extra: Record<string, unknown> = {}): TransitionDetail => ({
    action,
    from,
    allowed: actionsFrom(from),
    ...extra,
  });

  // 403 before everything but existence: no role branching — the capability is
  // read out of the matrix and judged by the shared guard.
  if (requireCapability(session, capabilityFor(action))) {
    return { ok: false, error: "FORBIDDEN" };
  }

  const rule = transitionFor(action, from);
  if (!rule) {
    return {
      ok: false,
      error: "VALIDATION",
      // The one forbidden transition that HAS a rule of record: a locked
      // revision is immutable, and VAL-010 says exactly that ("любая мутация
      // против locked"). Everything else the matrix forbids is a workflow
      // ordering problem with no VAL-* code, and `rules: []` with the detail
      // below is the documented shape for a refusal that has none.
      rules: from === "locked" ? [ruleRef("VAL-010")] : [],
      detail: detail({ reason: "transition_not_allowed" }),
    };
  }

  const actor: RevisionActor = {
    userId: session.userId,
    role: session.membership?.role ?? null,
  };

  for (const precondition of TRANSITION_PRECONDITIONS[action]) {
    const failure = await precondition.check({
      db,
      companyId,
      revision,
      input,
    });
    if (failure) {
      return {
        ok: false,
        error: failure.error,
        rules: failure.rules ?? [],
        detail: detail({
          precondition: precondition.name,
          ...(failure.detail ?? {}),
        }),
      };
    }
  }

  const now = new Date();
  const applied = await db
    .transaction(
      async (
        tx,
      ): Promise<RevisionRow | "raced" | { failure: PreconditionFailure }> => {
        // Re-read under a row lock: the preconditions ran outside the transaction
        // (they must survive a refusal — see the header), so this is where a
        // concurrent transition is discovered.
        const [locked] = await tx
          .select()
          .from(reportRevision)
          .where(
            and(
              eq(reportRevision.id, revisionId),
              eq(reportRevision.companyId, companyId),
            ),
          )
          .limit(1)
          .for("update");
        if (!locked || locked.status !== from) return "raced";

        if (action === "lock") {
          const failure = await calculationRunGreen(true).check({
            db: tx,
            companyId,
            revision: locked,
            input,
          });
          if (failure) return { failure };
        }
        const update = effectsOf(rule, actor, input, now);
        if (rule.action === "lock") {
          // DM-9/CALC-7 — the boundary and the six DM-7a fields, copied inside the
          // transaction that locks, so the snapshot is of the state being locked.
          update.frozenScope = await buildFrozenScope(
            tx,
            companyId,
            locked.periodId,
            locked.id,
          );
        }

        const [row] = await tx
          .update(reportRevision)
          .set(update)
          .where(eq(reportRevision.id, revisionId))
          .returning();

        // LC-1a — currency goes back to the highest-numbered survivor. Done AFTER
        // this revision has dropped the flag, so the partial unique index never
        // sees two current revisions of one period.
        let successorId: string | null = null;
        if (rule.action === "abandon") {
          const [successor] = await tx
            .select({ id: reportRevision.id })
            .from(reportRevision)
            .where(
              and(
                eq(reportRevision.companyId, companyId),
                eq(reportRevision.periodId, locked.periodId),
                ne(reportRevision.id, revisionId),
              ),
            )
            .orderBy(desc(reportRevision.revisionNo))
            .limit(1);
          if (successor) {
            await tx
              .update(reportRevision)
              .set({ isCurrent: true })
              .where(eq(reportRevision.id, successor.id));
            successorId = successor.id;
          }
        }

        await logAudit(tx, {
          companyId,
          userId: actor.userId,
          actorRole: actor.role,
          entity: "report_revision",
          entityId: revisionId,
          action: "update",
          summary: {
            ...auditSummary(rule, locked, session, input),
            ...(rule.action === "abandon"
              ? { is_current_moved_to: successorId }
              : {}),
          },
        });

        return row;
      },
      action === "lock" ? { isolationLevel: "repeatable read" } : undefined,
    )
    .catch((error) => {
      // A lock snapshot must be coherent across organisation/catalogue queries.
      // A concurrent status update can invalidate its first FOR UPDATE snapshot.
      for (let cause = error; cause instanceof Error; cause = cause.cause) {
        if ((cause as { code?: string }).code === "40001")
          return "raced" as const;
      }
      throw error;
    });

  if (applied === "raced") {
    return {
      ok: false,
      error: "VALIDATION",
      rules: [],
      detail: detail({ reason: "concurrent_transition" }),
    };
  }
  if ("failure" in applied) {
    return {
      ok: false,
      error: applied.failure.error,
      rules: applied.failure.rules ?? [],
      detail: detail({
        precondition: "calculation_run_green",
        ...applied.failure.detail,
      }),
    };
  }
  return { ok: true, row: applied, from };
}
