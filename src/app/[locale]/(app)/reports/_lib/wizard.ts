// =============================================================================
// THE DECISIONS OF THE `/reports` WIZARD, AS PURE FUNCTIONS (T5.8 — UI-5,
// AC-13, REN-3, PG-2/PG-5, F1, D14, О-14).
//
// Everything this screen has to be RIGHT about is decided here and tested here,
// so `page.tsx` renders answers rather than computing them. There are four
// questions and each has exactly one rule:
//
//   1. WHICH REVISION MAY BE RENDERED (`revisionChoices`). `approved`/`locked`,
//      from `@/shared/reports` — the same list `renderGate` refuses on. A
//      `draft` is LISTED, disabled and explained: hiding it would leave "why is
//      my period not here" unanswered, and the answer ("nobody has approved
//      these numbers yet") is the next action.
//   2. WHICH FORMAT MAY BE ASKED FOR (`formatChoices`). Every format this
//      product can produce is shown; the ones the plan does not sell are shown
//      BLOCKED with an upgrade CTA, never hidden (PG-5). The allowed set is
//      `usePlan().features.reportFormats` — what the SERVER resolved — and the
//      402 is still the server's to give.
//   3. WHETHER TO WARN ABOUT F1 (`lockWarning`). Read straight off the preview's
//      `lock_gate`, which is `facilityGateVerdict` — VAL-105's own verdict. This
//      module does not know which plans F1 hard-gates and must not learn: the
//      one thing it adds is that an ALREADY LOCKED revision is not warned about,
//      because for that one the gate has already been passed.
//   4. WHAT THE PLAN LEAVES OUT (`exclusionCounts`). A tally of the preview's
//      `excluded_by_plan` for the heading — the LIST itself is rendered from the
//      same array, and the array is the server's (see `renderPreview`). Nothing
//      here recomputes an exclusion.
//
// NOTHING IN THIS FILE REFUSES ANYTHING. Every function answers "what should the
// screen say"; the gates are `renderGate`, `requireReportFormat` and the F1
// precondition, all server-side, all still consulted.
// =============================================================================

import { REPORT_LANGUAGES, type ReportLanguage } from "@/i18n/locales";
import {
  isRenderableStatus,
  RENDER_FORMATS,
  type RenderFormat,
} from "@/shared/reports";

import type { PlanExclusion, RenderPreviewDto, RevisionDto } from "./api";

// ─── 1. The revision ─────────────────────────────────────────────────────────

/**
 * Why a revision cannot be rendered.
 *
 * ONE VALUE TODAY, and a list rather than a bare union so the i18n suite can
 * check `reports.scope.blocked.*` against it: a second reason added here would
 * otherwise print its own token at a user in both REPORT_LANGUAGES identically, which
 * whole-file parity cannot notice.
 */
export const REVISION_BLOCK_REASONS = ["not_approved"] as const;

/** One of {@link REVISION_BLOCK_REASONS}. */
type RevisionBlockReason = (typeof REVISION_BLOCK_REASONS)[number];

/** One revision as the picker offers it. */
export interface RevisionChoice {
  readonly id: string;
  readonly revisionNo: number;
  readonly status: string;
  readonly isCurrent: boolean;
  /** May REN-3 render it? `false` ⇒ shown, disabled, and `reason` explains it. */
  readonly renderable: boolean;
  readonly reason: RevisionBlockReason | null;
}

/**
 * Every revision of the chosen period, each labelled with whether a report can
 * be made from it (REN-3).
 *
 * The order is the server's (`GET /api/periods/[id]/revisions`, ascending by
 * `revision_no`); this function relabels, it never reorders — a picker whose
 * order disagreed with the revision history would make "revision 3" ambiguous.
 */
export function revisionChoices(
  revisions: readonly RevisionDto[],
  currentRevisionId: string | null,
): RevisionChoice[] {
  return revisions.map((revision) => {
    const renderable = isRenderableStatus(revision.status);
    return {
      id: revision.id,
      revisionNo: revision.revision_no,
      status: revision.status,
      isCurrent: revision.id === currentRevisionId,
      renderable,
      reason: renderable ? null : "not_approved",
    };
  });
}

/**
 * The revision the wizard is working on: the one picked, if it is still there
 * and still renderable, otherwise the newest renderable one, otherwise none.
 *
 * AN EXPRESSION, NOT SYNCHRONISED STATE — the same discipline as the other five
 * screens. A revision that has just been approved becomes selectable without an
 * effect, and a pick that is no longer in the list simply stops being the pick
 * instead of pointing at something that is not on screen.
 *
 * "Newest renderable" is the LAST renderable entry, because the list ascends by
 * revision number: a restatement (LC-9) supersedes what it restates, and
 * defaulting to revision 1 of a period that has three would be a report nobody
 * asked for.
 */
export function pickedRevision(
  choices: readonly RevisionChoice[],
  picked: string | null,
): RevisionChoice | null {
  const chosen = choices.find(
    (choice) => choice.id === picked && choice.renderable,
  );
  if (chosen) return chosen;
  const renderable = choices.filter((choice) => choice.renderable);
  return renderable.length > 0 ? renderable[renderable.length - 1] : null;
}

// ─── 2. The format (PG-2 / PG-5) ─────────────────────────────────────────────

/** One format as the wizard offers it. */
export interface FormatChoice {
  readonly format: RenderFormat;
  /** Does the plan sell it? `false` ⇒ visible, blocked, with an upgrade CTA. */
  readonly allowed: boolean;
}

/**
 * Every format this product can produce, each marked with whether the plan sells
 * it (PG-2), in the fixed order of `RENDER_FORMATS`.
 *
 * PG-5 IS THE WHOLE POINT OF RETURNING THE BLOCKED ONES. A trial company that
 * cannot see `xlsx` at all has no way to learn that it exists, let alone that an
 * upgrade would buy it; a trial company that sees it padlocked has both.
 */
export function formatChoices(
  allowed: readonly string[] | undefined,
): FormatChoice[] {
  const sold = new Set(allowed ?? []);
  return RENDER_FORMATS.map((format) => ({
    format,
    allowed: sold.has(format),
  }));
}

/**
 * The format the wizard will submit: the one picked when the plan sells it,
 * otherwise the first one it does.
 *
 * `null` only when the plan sells NONE of the formats this product implements —
 * a catalogue an administrator would have had to break by hand. The screen shows
 * every format blocked in that case rather than an empty picker.
 */
export function pickedFormat(
  choices: readonly FormatChoice[],
  picked: string | null,
): RenderFormat | null {
  const chosen = choices.find(
    (choice) => choice.format === picked && choice.allowed,
  );
  if (chosen) return chosen.format;
  return choices.find((choice) => choice.allowed)?.format ?? null;
}

// ─── 3. The language (О-14) ──────────────────────────────────────────────────

/**
 * The languages a render can be produced in — the app's REPORT_LANGUAGES, because the
 * renderer's message namespace is the app's message file.
 *
 * О-14: the choice is EXPLICIT even though it is defaulted from the interface
 * locale. The value lands in an immutable row and in the bytes; a reader who
 * later switches the UI to the other language must not find that "their" report
 * has changed language, and the only way to promise that is to make the language
 * an input of the render rather than a view of it.
 */
export const RENDER_LANGUAGES: readonly ReportLanguage[] = REPORT_LANGUAGES;

/** The interface locale when it is a render language; the first one otherwise. */
export function defaultLanguage(uiLocale: string): ReportLanguage {
  return (
    RENDER_LANGUAGES.find((locale) => locale === uiLocale) ??
    RENDER_LANGUAGES[0]
  );
}

// ─── 4. F1, before the Lock (PG-3) ───────────────────────────────────────────

/** The two numbers the F1 warning is about, or `null` for "say nothing". */
export interface LockWarning {
  /** Includable facilities of this period's boundary — §11.3's count. */
  readonly facilities: number;
  /** `maxFacilities` of the plan the LOCK will be judged against. */
  readonly limit: number;
  /** The plan id, for the sentence ("…on Starter…"). */
  readonly plan: string;
}

/**
 * Should the wizard warn that this report will not be closable?
 *
 * THREE CONDITIONS, and each rules out a sentence that would be false:
 *   • `applies` — F1 is a hard gate on trial and starter only; on pro an
 *     over-limit site is a D14 stamp, and warning there would tell a paying
 *     customer about a refusal that will never come. The server decides this.
 *   • `!passed` — the count is actually over the cap.
 *   • the revision is not ALREADY `locked` — for that one the gate was passed
 *     when it was locked, and re-warning would contradict a fact on screen.
 *
 * It is a WARNING and it blocks nothing: D14 renders the report anyway, stamped
 * `partial`. The two are the same story from opposite ends — you may publish
 * what your plan covers, you may not declare it final.
 */
export function lockWarning(
  preview: RenderPreviewDto | null,
  revisionStatus: string | null,
): LockWarning | null {
  if (!preview) return null;
  const gate = preview.lock_gate;
  if (!gate.applies || gate.passed) return null;
  if (revisionStatus === "locked") return null;
  return {
    facilities: gate.facilities,
    limit: gate.limit,
    plan: gate.plan,
  };
}

// ─── 5. What the plan leaves out (D14) ───────────────────────────────────────

/** How many records of each kind the plan excludes from the report. */
export interface ExclusionCounts {
  readonly legalEntities: number;
  readonly facilities: number;
  readonly total: number;
}

/**
 * A tally of the preview's `excluded_by_plan`, for the section heading.
 *
 * The tally is over the SERVER's array — the same array that becomes the row's
 * `excluded_by_plan` — so it cannot disagree with the list rendered beside it or
 * with the stamp in the file. An unknown `type` still counts towards `total`: a
 * future exclusion kind must inflate the "N records" heading rather than vanish
 * from it.
 */
export function exclusionCounts(
  excluded: readonly PlanExclusion[],
): ExclusionCounts {
  return {
    legalEntities: excluded.filter((e) => e.type === "legal_entity").length,
    facilities: excluded.filter((e) => e.type === "facility").length,
    total: excluded.length,
  };
}

// ─── Presentation helpers ────────────────────────────────────────────────────

/** How much of a sha256 a person can compare by eye without a scrollbar. */
const HASH_PREFIX = 12;

/**
 * A `file_hash` as the list shows it: the first {@link HASH_PREFIX} characters.
 *
 * TRUNCATED FOR READING, NEVER FOR COMPARING. The full digest is in the DOM as
 * the element's `title` and in the API response; this is the label, and the
 * ellipsis is what stops it reading as the whole hash.
 */
export function shortHash(hash: string): string {
  return hash.length <= HASH_PREFIX ? hash : `${hash.slice(0, HASH_PREFIX)}…`;
}
