// =============================================================================
// WHICH CONTROLS THE DRAWER RENDERS — one pure function, and the only place this
// screen decides it.
//
// WHY A FUNCTION AND NOT THREE `&&`s INSIDE THE JSX. Two acceptance criteria of
// T3.5 are statements about the ABSENCE of a control ("without `data.approve`
// the approve button is hidden") and about a FORM DEMANDING something ("editing
// an approved row requires a `change_reason`). The suite runs in `node` and
// includes only `*.test.ts` — there is no DOM harness to assert a button is not
// in the document with. So the decision is lifted out of the component into a
// function whose whole input is data, the component has exactly ONE reference to
// each gate, and `__tests__/actions.test.ts` pins the function across the entire
// role × capability matrix. What the test proves is the thing that could
// actually regress: not that a button was rendered, but that the predicate
// behind it ever answers `true` without the capability. It never does.
//
// §0.1 IN ONE LINE: THE INPUT IS A CAPABILITY LIST, NEVER A ROLE. There is no
// `CompanyRole` in this file and no import that could supply one. The list comes
// from `useCapabilities()`, which reads what the SERVER resolved (matrix ∪ the
// D13 compensating grant) — so the client and the routes decide on the same set,
// and a role the matrix later changes needs no edit here. Hiding a control is
// still UX and never the guard: `/api/activities/*/[id]/approve` requires
// `data.approve` itself and answers 403 to a direct request regardless of what
// this function said.
//
// LC-5 IS THE OTHER HALF. A row may only be mutated while its revision is
// `draft` or `rejected`; against `submitted`/`in_review`/`approved`/`locked` the
// server refuses with VAL-010, and the screen says so up front instead of
// offering a Save that cannot land.
// =============================================================================
import type { WorkflowStatus } from "@/shared/enums";
import type { Capability } from "@/shared/roles";

/**
 * The revision statuses an input row may be written against (LC-5, VAL-010).
 *
 * `rejected` is included on purpose and is not an oversight: editing a row of a
 * rejected revision RESUMES it to `draft` (LC-1, the seventh row of §5.1), which
 * `rows.ts` performs by calling the state machine. The screen must therefore
 * offer the edit, not refuse it.
 */
export const MUTABLE_REVISION_STATUSES: readonly WorkflowStatus[] = [
  "draft",
  "rejected",
];

/** The version the drawer is looking at, reduced to what a gate depends on. */
export interface GatedRow {
  /** `draft` | `approved` (`ROW_STATES`, §4.8). */
  readonly state: string;
  /** Non-null means this version has already been replaced (LC-6). */
  readonly superseded_by_id: string | null;
  /** A tombstone: the row left the listing and nothing may be written on it. */
  readonly is_deleted: boolean;
}

export interface RowActionGates {
  /** The revision is open, so any write at all is possible (LC-5). */
  readonly revisionOpen: boolean;
  /** Show the create form / the Save-draft button (`data.write`). */
  readonly canSaveDraft: boolean;
  /**
   * Show the Approve button (`data.approve`, LC-4).
   *
   * THE ONE PREDICATE THE ACCEPTANCE NAMES. False without the capability, under
   * every combination of the other inputs — see `__tests__/actions.test.ts`.
   */
  readonly canApprove: boolean;
  /**
   * LC-5 — the version being superseded is `approved`, so the edit must state
   * WHY. The form makes the field required; the server refuses without it.
   */
  readonly needsChangeReason: boolean;
}

/** Is `capability` in the set the SERVER resolved for this session? */
function granted(
  capabilities: readonly Capability[],
  capability: Capability,
): boolean {
  return capabilities.includes(capability);
}

/**
 * THE gates of one drawer. `row` is `null` for the create form — nothing has a
 * state yet, so there is nothing to approve and no reason to give.
 */
export function rowActionGates(input: {
  /** Straight from `useCapabilities().capabilities`. Never a role. */
  readonly capabilities: readonly Capability[];
  /** The status of the revision being edited, or `null` while it loads. */
  readonly revisionStatus: WorkflowStatus | null;
  readonly row: GatedRow | null;
}): RowActionGates {
  const { capabilities, revisionStatus, row } = input;

  const revisionOpen =
    revisionStatus !== null &&
    MUTABLE_REVISION_STATUSES.includes(revisionStatus);
  // A superseded version is a historical record and a tombstone is a deletion;
  // neither is a head, and `rows.ts` answers NOT_FOUND for both.
  const live =
    row === null || (row.superseded_by_id === null && !row.is_deleted);

  return {
    revisionOpen,
    canSaveDraft: revisionOpen && live && granted(capabilities, "data.write"),
    canApprove:
      revisionOpen &&
      live &&
      row !== null &&
      row.state !== "approved" &&
      granted(capabilities, "data.approve"),
    needsChangeReason: row !== null && row.state === "approved",
  };
}
