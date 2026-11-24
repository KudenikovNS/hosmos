// REN-2a — THE FOUR-POINT DISCLAIMER, AND THE PROHIBITION THAT GUARDS IT.
//
// See docs/decisions/server-render-disclaimer.md for the full account.
import type { CoverageClaim, PlanExclusionType } from "@/shared/reports";

import type { RenderContext } from "./i18n";

/** The four points of REN-2a, in the order the report prints them. */
export const DISCLAIMER_POINTS = [
  "offsets",
  "scope3",
  "coverage",
  "notFullVsme",
] as const;

/** Something the subscription plan kept out of the report (D14, REN-4). */
export interface PlanExclusion {
  readonly type: PlanExclusionType;
  readonly id: string;
  readonly name: string;
}

/**
 * The completeness stamp a render carries (D14 / DM-31).
 *
 * IT IS AN INPUT, NOT A DERIVATION. `T5.7` computes it — it is the one that
 * knows the plan's limits — and the CHECK `report_render_coverage_claim_d14`
 * makes `full` with a non-empty {@link RenderCoverage.excludedByPlan} physically
 * unwritable. The renderer's job is only to print what it was handed, honestly
 * and in the right words.
 */
export interface RenderCoverage {
  readonly claim: CoverageClaim;
  readonly completenessNote: string | null;
  readonly excludedByPlan: readonly PlanExclusion[];
}

/**
 * THE TWO message keys that may carry full-conformity vocabulary, and why.
 *
 * Keys are relative to the `render` namespace, i.e. `render.<key>` in
 * `messages/{en,sl}.json`. Layer 3 of the prohibition (see the header) treats
 * this object as a closed allow-list: any OTHER `render.*` value that matches
 * {@link CONFORMITY_PATTERNS} fails the acceptance test.
 *
 * There are two rather than one because REN-2a's fourth disclaimer point is a
 * DENIAL of full conformity ("this is not a full VSME report until…"), and a
 * denial is made of the same words as a claim. Excluding it from the sweep by
 * hand would be a hole; declaring it here is the same decision, written down,
 * with the rule attached: the claim may appear only in a `full` render, the
 * denial must appear in EVERY render, and the test asserts both.
 */
export const CONFORMITY_KEYS = {
  /** The CLAIM. Emitted by one branch of `completenessSection`, at `full`. */
  claim: "completeness.conformity.full",
  /** The DENIAL — REN-2a point 4, printed by every render of either claim. */
  denial: "disclaimer.notFullVsme",
} as const;

/**
 * The vocabulary of a full-conformity claim, in both render locales.
 *
 * Patterns rather than phrases: what REN-4 forbids is the CLAIM, and a claim is
 * a family of sentences. Deliberately generous — a false positive here is a
 * five-minute rewording of a heading, a false negative is a partial report that
 * says it is a complete VSME disclosure.
 */
const CONFORMITY_PATTERNS: readonly RegExp[] = [
  // English: "full VSME", "complete VSME report", "fully compliant with VSME",
  // "in full conformity with the VSME standard", "meets all VSME requirements".
  /\bfull(?:y)?\b[^.]{0,40}\bvsme\b/i,
  /\bcomplete(?:s|d|ly)?\b[^.]{0,40}\bvsme\b/i,
  /\bvsme\b[^.]{0,40}\bin full\b/i,
  /\bconform(?:s|ity|ing|ance)?\b[^.]{0,40}\bvsme\b/i,
  /\bvsme\b[^.]{0,40}\bconform(?:s|ity|ing|ance)?\b/i,
  /\bcompliant\b[^.]{0,40}\bvsme\b/i,
  /\bvsme\b[^.]{0,40}\bcompliant\b/i,
  /\ball\b[^.]{0,20}\bvsme\b[^.]{0,30}\b(?:requirements|datapoints|disclosures)\b/i,
  // Slovenian: "popolno skladen z VSME", "v celoti skladno s standardom VSME",
  // "celovito poročilo VSME", "izpolnjuje vse zahteve VSME".
  /\bpopoln\w*\b[^.]{0,40}\bvsme\b/i,
  /\bvsme\b[^.]{0,40}\bpopoln\w*\b/i,
  /\bv celoti\b[^.]{0,40}\bvsme\b/i,
  /\bvsme\b[^.]{0,40}\bv celoti\b/i,
  /\bcelovit\w*\b[^.]{0,40}\bvsme\b/i,
  /\bskladn\w*\b[^.]{0,40}\bvsme\b/i,
  /\bvsme\b[^.]{0,40}\bskladn\w*\b/i,
  /\bvse\b[^.]{0,20}\bzahteve\b[^.]{0,20}\bvsme\b/i,
];

/**
 * Does this text claim conformity with the whole of VSME?
 *
 * Layer 2 of the prohibition. Used by the acceptance test against the rendered
 * text of a `partial` report, and against every `render.*` message value.
 */
export function claimsFullConformity(text: string): boolean {
  return CONFORMITY_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The four points, in order, as the strings the PDF prints and the row stores.
 *
 * Point 3 interpolates `completenessNote` when there is one, because a bare
 * "coverage is partial" is a statement nobody can act on: D14's whole purpose is
 * that the reader learns WHAT was left out.
 */
export function buildDisclaimer(
  ctx: RenderContext,
  coverage: RenderCoverage,
): readonly string[] {
  const { t } = ctx;
  return DISCLAIMER_POINTS.map((point) => {
    if (point !== "coverage") return t(`disclaimer.${point}`);
    if (coverage.claim === "full") return t("disclaimer.coverage.full");
    return t("disclaimer.coverage.partial", {
      note: coverage.completenessNote ?? t("completeness.noteMissing"),
      excluded: ctx.count(coverage.excludedByPlan.length),
    });
  });
}

/**
 * The four points as ONE string — what `report_render.disclaimer_text` holds.
 *
 * Numbered, so that "all four points are present" is legible in the stored
 * column and not only in the laid-out page.
 */
export function disclaimerText(
  ctx: RenderContext,
  coverage: RenderCoverage,
): string {
  return buildDisclaimer(ctx, coverage)
    .map((point, index) => `${index + 1}. ${point}`)
    .join("\n\n");
}
