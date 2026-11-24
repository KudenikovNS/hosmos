// =============================================================================
// WHICH TRANSITIONS THIS SCREEN OFFERS, AND WHAT A REFUSED ONE MEANS — two pure
// functions, and the only place `/review` decides either (T4.6; §5.1, §5.4,
// LC-1, F1/PG-3).
//
// WHY THE §5.1 MATRIX IS RESTATED HERE. `ALLOWED_TRANSITIONS` is a RUNTIME const
// in `@/server/revisions/transition`, and that module reaches `@/server/db/audit`
// (which carries `server-only`) and the drizzle schema: importing it for its
// value would drag the server into the browser bundle. So the matrix is restated
// as data — and the copy is not left to trust: it is annotated
// `readonly TransitionRule[]` (the SERVER's type, imported type-only, so a
// changed field stops this file compiling) and `__tests__/transitions.test.ts`
// asserts it EQUALS the server's list row for row. A seventh row added on the
// server therefore fails a test here rather than producing a screen that quietly
// stops offering an action. This is the same device `inventory/_lib/tabs` uses
// for `ENERGY_TYPE_VALUES`, with the equality check the tabs file could not have.
//
// AND WHY A COPY IS SAFE EVEN SO. The matrix here decides which BUTTONS render.
// The server decides what happens: an (action, from) pair it does not know is
// 422 `transition_not_allowed` carrying `allowed`, the list of what WOULD have
// worked — and `transitionNotice` renders that list rather than the copy. The
// screen can be out of date about what to offer; it cannot be out of date about
// what happened.
//
// §0.1 IN ONE LINE: THE INPUT IS A CAPABILITY LIST, NEVER A ROLE. There is no
// `CompanyRole` in this file and no import that could supply one. Hiding a
// button is UX; `transitionRevision` requires the matrix's capability itself and
// answers 403 to a direct POST regardless of what `actionOffers` said.
//
// THE 402 IS A BRANCH OF ITS OWN, and that is the point of `transitionNotice`.
// `plan_facility_limit` is the ONLY precondition in the whole machine that
// returns `PLAN_REQUIRED`, so a 402 out of `POST …/transition` can only ever be
// F1 — and F1 is a sales conversation, not a malfunction. It is therefore
// classified BEFORE anything looks at a rule list or a reason string, and it
// leaves with the two numbers the sentence needs. Nothing else can produce it: a
// blocking rule is a 422 with codes, a missing comment is a 422 with a field.
// =============================================================================
import type { WorkflowStatus } from "@/shared/enums";
import type { Capability } from "@/shared/roles";

import type {
  RevisionAction,
  Refusal,
  RuleRef,
  TransitionOutcome,
  TransitionRule,
} from "./api";

/**
 * §5.1, VERBATIM AND AS DATA — the restated matrix (see the header for why it is
 * restated and what stops it drifting).
 *
 * `resume` is included although no client may send it: the equality test
 * compares the WHOLE list, and a copy that silently dropped the row a service
 * uses would be a copy that no longer describes the machine.
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
 * The actions a CLIENT may name (§12.2), in the order the workflow runs them —
 * which is also the order the buttons appear in.
 *
 * `resume` is absent: it is performed by the SERVICE that edits a row of a
 * rejected revision (T3.1), so a client naming it is a 422 like any other
 * unknown action. The screen says so where a rejected revision is shown, rather
 * than offering a button that cannot exist.
 */
export const WIRE_ACTIONS: readonly RevisionAction[] = [
  "submit",
  "start_review",
  "approve",
  "reject",
  "lock",
  "abandon",
];

/**
 * The actions whose §5.1 side-effect column demands a comment before the
 * transition is even attempted (`review_comment_required`).
 *
 * The server is still the authority — `reject` without one is 422
 * `reject_needs_comment` — and the form asking first is the same belt-and-braces
 * shape `/inventory` uses for LC-5's `change_reason`. This is not the client
 * refusing what the server would accept: the server would refuse this exact
 * request.
 */
export const ACTIONS_NEEDING_COMMENT: readonly RevisionAction[] = ["reject"];

/** One action as the panel renders it. */
export interface ActionOffer {
  readonly action: RevisionAction;
  /** The status the revision lands in, or `null` (`abandon` moves currency). */
  readonly to: WorkflowStatus | null;
  /** The capability §5.4 assigns the action — read out of the matrix, never a role. */
  readonly capability: Capability;
  /**
   * May THIS session perform it?
   *
   * THE PREDICATE THE ACCEPTANCE LEANS ON. False without the capability under
   * every combination of the other inputs — see `__tests__/transitions.test.ts`.
   */
  readonly permitted: boolean;
  /** The comment is a precondition (§5.1), so the form demands it first. */
  readonly needsComment: boolean;
}

/** Is `capability` in the set the SERVER resolved for this session? */
function granted(
  capabilities: readonly Capability[],
  capability: Capability,
): boolean {
  return capabilities.includes(capability);
}

/**
 * The wire actions legal from `status`, with the capability each needs.
 *
 * `status` is `null` while the revision loads, and while a period has no
 * revision at all — both mean "nothing to offer yet" rather than "offer
 * everything", so the list is empty and the panel says which of the two it is.
 */
export function actionOffers(input: {
  /** Straight from `useCapabilities().capabilities`. Never a role. */
  readonly capabilities: readonly Capability[];
  readonly status: WorkflowStatus | null;
}): ActionOffer[] {
  const { capabilities, status } = input;
  if (status === null) return [];
  return WIRE_ACTIONS.flatMap((action) => {
    const rule = ALLOWED_TRANSITIONS.find(
      (row) => row.action === action && row.from === status,
    );
    if (!rule) return [];
    return [
      {
        action,
        to: rule.to,
        capability: rule.capability,
        permitted: granted(capabilities, rule.capability),
        needsComment: ACTIONS_NEEDING_COMMENT.includes(action),
      },
    ];
  });
}

/** One entry of `transition.failures` — a blocking rule and the object it is about. */
export interface TransitionFailure {
  readonly code: string;
  readonly scope: string;
  /** The failing object's id. The TYPE is not in this payload — see `./blocking`. */
  readonly object: string | null;
}

/**
 * What a transition attempt ended in, in the register each outcome deserves.
 *
 * Exactly one branch per outcome, and the discriminator is the thing the user
 * has to understand — not the HTTP code, and never a generic "could not save".
 */
export type TransitionNotice =
  /** It happened. */
  | { kind: "done"; action: RevisionAction; from: string; to: string }
  /**
   * F1/PG-3 — the plan's site ceiling at `lock`, stated with the numbers and an
   * upgrade CTA (PG-5). `limit <= 0` means the numbers could not be resolved on
   * the client, and the sentence drops to the version without them rather than
   * printing a wrong one.
   */
  | { kind: "plan"; facilities: number; limit: number }
  /** VR-3 — blocking rules. The codes; the OBJECTS come from `./blocking`. */
  | {
      kind: "blocked";
      rules: readonly RuleRef[];
      failures: TransitionFailure[];
    }
  /** §5.1's `all_rows_approved` — with the count that is in the way. */
  | { kind: "rowsPending"; total: number; approved: number; pending: number }
  /** §5.1 — a rejection states why. */
  | { kind: "needsComment" }
  /** The (action, from) pair is not a row of the matrix; `allowed` is what is. */
  | { kind: "notAllowed"; from: string; allowed: readonly string[] }
  /** LC-1a — abandoning a revision that is no longer the current one. */
  | { kind: "notCurrent" }
  /** Somebody else moved this revision first (the `FOR UPDATE` re-read lost). */
  | { kind: "raced" }
  /** No completed calculation stands behind the rows (or it is stale). */
  | { kind: "calculationMissing" }
  /** The latest calculation did not price every line. */
  | { kind: "calculationFailed"; failed: number }
  /** Everything else, in the vocabulary `../../_lib/refusal` owns. */
  | { kind: "refused"; refusal: Refusal };

/** `detail.failures` narrowed — the payload is `Record<string, unknown>`. */
function readFailures(value: unknown): TransitionFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.code !== "string") return [];
    return [
      {
        code: row.code,
        scope: typeof row.scope === "string" ? row.scope : "",
        object: typeof row.object === "string" ? row.object : null,
      },
    ];
  });
}

/** A count out of the detail payload, or `0` — never `NaN` on a screen. */
function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * THE outcome of one transition, as the panel renders it.
 *
 * ORDER OF BRANCHES, and it is the order §0.2 gives the refusals themselves:
 *
 *   1. success;
 *   2. **402 — F1, before anything reads a rule or a reason.** It is the only
 *      402 the machine can answer (`plan_facility_limit` is its only
 *      `PLAN_REQUIRED` precondition), the classifier decided it from the HTTP
 *      status, and it leaves this function as a PLAN branch that the components
 *      render with `PlanNote` — never in the error list. That is the whole of
 *      "the 402 on Lock shows as an upgrade, not as an error";
 *   3. 401/403 — the session's rights moved (R-11), benign copy;
 *   4. the named preconditions, each carrying its own numbers;
 *   5. anything left, classified but unnamed.
 *
 * `facilityFacts` is the CLIENT's count of the two numbers F1 is about (see
 * `./plan`). It is used ONLY to word the 402 — the refusal itself is the
 * server's, and when the client cannot resolve the numbers the sentence says the
 * plan caps the sites without claiming how many.
 */
export function transitionNotice(
  outcome: TransitionOutcome,
  action: RevisionAction,
  facilityFacts: { facilities: number; limit: number },
): TransitionNotice {
  if (outcome.ok) {
    return {
      kind: "done",
      action,
      from: outcome.data.from,
      to: outcome.data.to,
    };
  }

  // (2) The plan boundary. Decided by the HTTP status alone, ahead of every
  // reason string, so no future precondition reason can shadow it.
  if (outcome.refusal.kind === "plan_required") {
    return {
      kind: "plan",
      facilities: facilityFacts.facilities,
      limit: facilityFacts.limit,
    };
  }
  // (3) Rights, not data.
  if (outcome.refusal.kind === "access_changed") {
    return { kind: "refused", refusal: outcome.refusal };
  }

  const detail = outcome.detail;
  const reason = typeof detail?.reason === "string" ? detail.reason : null;

  switch (reason) {
    case "rows_not_approved":
      return {
        kind: "rowsPending",
        total: readCount(detail?.rows),
        approved: readCount(detail?.approved),
        pending: readCount(detail?.pending),
      };
    case "reject_needs_comment":
      return { kind: "needsComment" };
    case "blocking_rules":
      return {
        kind: "blocked",
        rules: outcome.refusal.kind === "rules" ? outcome.refusal.rules : [],
        failures: readFailures(detail?.failures),
      };
    case "transition_not_allowed":
      return {
        kind: "notAllowed",
        from: detail?.from ?? "",
        allowed: detail?.allowed ?? [],
      };
    case "not_current":
      return { kind: "notCurrent" };
    case "concurrent_transition":
      return { kind: "raced" };
    case "calculation_run_missing":
    case "calculation_run_stale":
      return { kind: "calculationMissing" };
    case "calculation_run_failed":
      return { kind: "calculationFailed", failed: readCount(detail?.failed) };
    default:
      return { kind: "refused", refusal: outcome.refusal };
  }
}
