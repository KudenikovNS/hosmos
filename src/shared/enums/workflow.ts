// =============================================================================
// Workflow lists — the ONE state machine (`report_revision.status`, D22) and
// the derived period status the API keeps serving (К-4, LC-2).
//
// These two are the exception the general rule in `./index.ts` names: the
// schema DOES carry a CHECK on `report_revision.status`, because the state
// machine branches on it. `period_status` carries no CHECK at all — it is not a
// column (К-4), it is computed.
// =============================================================================

import { enumGuard } from "./guard";

/**
 * `report_revision.status` (spec §4.7 / DM-10) — six values, the only stateful
 * workflow column in Phase 1 (§0.5, D22). Order is the workbook's sort order
 * (ENUM-076…081); the values are the spec's CHECK literals.
 *
 * The allowed TRANSITIONS between these are NOT here: they are the
 * `ALLOWED_TRANSITIONS` matrix of `transitionRevision` (LC-1), which owns the
 * preconditions and capabilities. This list is only the alphabet.
 *
 * THE ORDER IS NOT THE SPEC'S. The spec's CHECK lists the same six with
 * `locked` before `rejected`; the order here is the workbook's sort order. Both
 * are correct and neither is load-bearing — a CHECK is a set, and the state
 * machine reads names, not indices. Do not "fix" either to match the other:
 * the pinned assertion in `__tests__/enums.test.ts` would then fail for a
 * change that means nothing.
 */
export const WORKFLOW_STATUSES = [
  "draft",
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "locked",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const isWorkflowStatus = enumGuard(WORKFLOW_STATUSES);

/**
 * `period_status` — a DERIVED API field, never a column (К-4, D22): the status
 * of the period's `is_current` revision, mapped by LC-2.
 *
 * CASING IS DELIBERATE and unlike every other list here. К-4 commits the API to
 * "точные значения enum'а workbook" — the workbook's PeriodStatus labels
 * (ENUM-043…048) verbatim, spaces and capitals included — so the mapping stays
 * legible to the workbook's readers. Do not snake_case these to match their
 * neighbours; that would silently change the API contract.
 *
 * `Reopened` has no `WorkflowStatus` counterpart: LC-2 emits it for a draft
 * revision with `revision_no > 1` over a locked one.
 */
export const PERIOD_STATUSES = [
  "Draft",
  "Submitted",
  "In review",
  "Approved",
  "Locked",
  "Reopened",
] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
export const isPeriodStatus = enumGuard(PERIOD_STATUSES);
