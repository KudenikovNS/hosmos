// =============================================================================
// WHICH CONTROLS THE DQ EDITOR RENDERS — one pure function, and the only place
// this screen decides it (T4.5 acceptance; DQ-2, DQ-3, VAL-038, VAL-039, §5.3).
//
// THE ACCEPTANCE CRITERION IS A STATEMENT ABOUT AN ABSENCE: "without
// `data.review` the override control is hidden, and a direct request answers
// 403". Both halves are needed and neither substitutes for the other — the UI
// not offering it is what stops a user walking into a refusal, and the ROUTE
// requiring `data.review` (`/api/dq/[objectType]/[objectId]`, which reads the
// body's `is_overridden` AND the stored row before it decides) is what makes the
// rule true regardless of what any client rendered. This file is only the first
// half, and the suite that pins it (`__tests__/dq.test.ts`) asserts the thing
// that could actually regress: that the predicate never answers `true` without
// the capability.
//
// §0.1 IN ONE LINE: THE INPUT IS A CAPABILITY LIST, NEVER A ROLE. There is no
// `CompanyRole` in this file and no import that could supply one.
//
// THE THIRD GATE IS THE ONE THAT IS EASY TO MISS. `needsReviewCapability`
// (`@/server/dq/assessments`) requires `data.review` when the assessment is
// overridden BEFORE **or** AFTER the write — clearing somebody else's override
// is a review act too, because otherwise the person being overridden could erase
// the judgement. So an ALREADY-overridden assessment is not editable at all by a
// session without `data.review`: every PUT it could send, including one that
// only fixes a typo in the comment, is a 403. `lockedByOverride` is that fact,
// and the editor states it instead of offering a Save that cannot land.
//
// AND THE ONE BEFORE ALL OF THEM: the route's FIRST guard is `data.write`
// (editing scores is recording data, DQ-2), so `data.review` alone — which is
// what a `reviewer` holds — grants nothing here. Both capabilities are required
// for an override, in that order, and the gates below say so.
// =============================================================================
import type { WorkflowStatus } from "@/shared/enums";
import type { Capability } from "@/shared/roles";

import { MUTABLE_REVISION_STATUSES } from "../../inventory/_lib/actions";

/** The four pedigree scores of DM-27 — integers 1–5, CHECKed by the column. */
export const PEDIGREE_SCORES = [
  "reliability_score",
  "temporal_score",
  "geographical_score",
  "technology_score",
] as const;

/** The three percentage fields of DM-27 — numeric 0–100. */
export const PERCENT_SCORES = [
  "completeness_score",
  "coverage_score",
  "estimate_uncertainty",
] as const;

/** The `QualityTier` vocabulary (§4.17) — what DQ-4/VAL-041 reads. */
export const QUALITY_TIERS = [
  "high_primary",
  "medium_calculated",
  "low_proxy",
  "estimate",
] as const;

/** The assessment reduced to what a gate depends on. `null` = none stored yet. */
export interface GatedAssessment {
  readonly is_overridden: boolean;
}

export interface DqEditorGates {
  /** The revision is open, so §5.3's freeze (VAL-010) does not apply. */
  readonly revisionOpen: boolean;
  /** Render the score controls and the Save bar. */
  readonly canEdit: boolean;
  /**
   * Render the override control at all (DQ-2).
   *
   * THE PREDICATE THE ACCEPTANCE NAMES. False without `data.review` under every
   * combination of the other inputs — see `__tests__/dq.test.ts`.
   */
  readonly canOverride: boolean;
  /**
   * A reviewer's override stands on this assessment and this session may not
   * touch it (see the header). The editor says so; it does not pretend the
   * fields are editable.
   */
  readonly lockedByOverride: boolean;
}

/** Is `capability` in the set the SERVER resolved for this session? */
function granted(
  capabilities: readonly Capability[],
  capability: Capability,
): boolean {
  return capabilities.includes(capability);
}

/**
 * THE gates of one DQ editor.
 *
 * `revisionStatus` is `null` while the revision loads and for the three object
 * types that have no revision (`legal_entity`, `facility`, `emission_factor`,
 * §4.17) — this screen assesses input ROWS, which always have one, so a null
 * reads as "not open yet" and the editor waits rather than offering a write
 * against a revision nobody has resolved.
 */
export function dqEditorGates(input: {
  /** Straight from `useCapabilities().capabilities`. Never a role. */
  readonly capabilities: readonly Capability[];
  readonly revisionStatus: WorkflowStatus | null;
  readonly assessment: GatedAssessment | null;
}): DqEditorGates {
  const { capabilities, revisionStatus, assessment } = input;

  const revisionOpen =
    revisionStatus !== null &&
    MUTABLE_REVISION_STATUSES.includes(revisionStatus);
  const writes = granted(capabilities, "data.write");
  const reviews = granted(capabilities, "data.review");
  const lockedByOverride = assessment?.is_overridden === true && !reviews;

  return {
    revisionOpen,
    canEdit: revisionOpen && writes && !lockedByOverride,
    canOverride: revisionOpen && writes && reviews,
    lockedByOverride,
  };
}

/**
 * The PUT body of one save (DQ-2), built from the form's own values.
 *
 * WHY THE WHOLE ASSESSMENT AND NOT A PATCH. `is_overridden` is MANDATORY on
 * every body — it is the field the `data.review` guard reads, and a body that
 * omitted it would leave the request's meaning implicit (`@/server/dq/assessments`
 * spells this out). A diff-shaped payload would drop it on any save that did not
 * touch it, so the editor states the resulting state in full and the guard stays
 * exact rather than inferred. The DRAFT is still a diff — that is what keeps a
 * refused save from ever reading as saved (`organisation/_lib/useAutosave`) —
 * only the payload is complete.
 *
 * `""` CLEARS A COLUMN and is passed through as such: the service parsers
 * (`@/server/api/parse`) already read a blank string as `null`, so a conversion
 * layer here would be a second, silent copy of that contract.
 *
 * `override_reason` is sent ONLY with an override. An explanation for something
 * that is not happening is a dangling sentence in an audit trail, and the parser
 * drops it anyway — sending it would be asking for a difference of opinion.
 */
export function dqBody(
  values: Record<string, string>,
  overridden: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = { is_overridden: overridden };
  for (const field of [...PEDIGREE_SCORES, ...PERCENT_SCORES]) {
    body[field] = values[field] ?? "";
  }
  body.quality_tier = values.quality_tier ?? "";
  body.quality_comment = values.quality_comment ?? "";
  if (overridden) body.override_reason = values.override_reason ?? "";
  return body;
}

/**
 * May this save be attempted? VAL-039 in the form.
 *
 * An override with no reason is refused by the server with a rule CODE (the rule
 * is the authority, and `putAssessment` does not pre-check it), so the editor
 * asks for the reason first and disables Save until there is one — the same
 * belt-and-braces shape `/inventory` uses for LC-5's `change_reason`. This is
 * not the client refusing what the server would accept: the server would refuse
 * this exact write.
 */
export function overrideReasonGiven(
  overridden: boolean,
  reason: string,
): boolean {
  return !overridden || reason.trim() !== "";
}
