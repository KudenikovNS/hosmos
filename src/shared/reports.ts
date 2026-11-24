// =============================================================================
// THE TWO CLOSED LISTS A REPORT IS DESCRIBED BY — shared, because the server
// GATE and the `/reports` wizard must not hold separate copies of them
// (К-22, REN-3, D22, T5.7/T5.8).
//
// WHY HERE AND NOT IN `@/server/render/persist` (where they started). That
// module is `server-only`: importing it from a client component is a build
// error, so a screen that needed the same lists could only re-type them. Two
// spellings of "the formats this product can produce" would mean a wizard that
// offers `docx` the route answers 422 to, or — worse — a wizard that hides a
// format the plan actually sells. The lists moved here; `persist.ts` re-exports
// them, so every existing server importer is unchanged.
//
// WHY NOT IN `@/shared/enums` with the other value lists. That barrel indexes
// every list it exports in `PHASE1_ENUMS` and asserts the index is total. Its
// members are the workbook's Enums-sheet vocabularies; neither list below is one
// — `RENDER_FORMATS` is the set of renderers this codebase has WRITTEN, and
// `RENDERABLE_REVISION_STATUSES` is a two-element SUBSET of `WorkflowStatus`
// rather than a vocabulary of its own. Registering them there would say
// something false about both.
// =============================================================================

import type { WorkflowStatus } from "@/shared/enums";

/**
 * The formats a Phase-1 render can be produced in (К-22).
 *
 * The values match the `report_render_format_check` CONSTRAINT and the
 * `reportFormats` entitlement, and they are written out here rather than derived
 * from either: the plan catalogue is data an administrator edits, and a format
 * nobody implemented must not become renderable by a row update.
 */
export const RENDER_FORMATS = ["pdf", "xlsx"] as const;

/** One of {@link RENDER_FORMATS}. */
export type RenderFormat = (typeof RENDER_FORMATS)[number];

/** Is this wire value a format this product can actually produce? */
export function isRenderFormat(value: unknown): value is RenderFormat {
  return (
    typeof value === "string" &&
    (RENDER_FORMATS as readonly string[]).includes(value)
  );
}

/**
 * The revision statuses REN-3 admits — a report is a finished thing.
 *
 * `renderGate` refuses everything else with `revision_not_approved`, and the
 * wizard greys the same revisions out with the same explanation. One list, so
 * "the screen offered it and the server refused it" cannot happen.
 */
export const RENDERABLE_REVISION_STATUSES: readonly WorkflowStatus[] = [
  "approved",
  "locked",
];

/** Would REN-3 let a revision in this status be rendered? */
export function isRenderableStatus(status: string): boolean {
  return (RENDERABLE_REVISION_STATUSES as readonly string[]).includes(status);
}

/**
 * Why REN-3 refused a render (`renderGate`), in the order a preparer would fix
 * them.
 *
 * Shared for the same reason the two lists above are: the reason is the CONTRACT
 * the `/reports` screen explains, one message key per value, and the i18n suite
 * checks the keys against THIS list. A seventh reason added to the gate then
 * fails a test instead of printing `period_blocking_errors` at a user.
 */
export const RENDER_GATE_REASONS = [
  /** The revision is not `approved`/`locked` — there is no report to render. */
  "revision_not_approved",
  /** No calculation run, or the latest one did not price every line (CALC-6). */
  "no_green_run",
  /** Blocking `period`-scope validation failures stand against this period. */
  "period_blocking_errors",
  /** No trustworthy historical period/boundary exists for this old revision. */
  "historical_context_missing",
  /** This locked run predates correct output-unit handling; restatement needed. */
  "historical_formula_unsupported",
] as const;

/** One of {@link RENDER_GATE_REASONS}. */
export type RenderGateReason = (typeof RENDER_GATE_REASONS)[number];

/** What D14 can say about a report's coverage (`report_render.coverage_claim`). */
export const COVERAGE_CLAIMS = ["full", "partial"] as const;

/** One of {@link COVERAGE_CLAIMS}. */
export type CoverageClaim = (typeof COVERAGE_CLAIMS)[number];

/** The kinds of record a plan limit can keep out of a report (REN-4/D14). */
export const PLAN_EXCLUSION_TYPES = ["legal_entity", "facility"] as const;

/** One of {@link PLAN_EXCLUSION_TYPES}. */
export type PlanExclusionType = (typeof PLAN_EXCLUSION_TYPES)[number];
