import { renderContext, type RenderContext } from "../i18n";
import {
  RENDER_SECTIONS,
  type RenderSectionId,
  type RenderBlock,
  type RenderSection,
  type RenderInput,
} from "./types";
import { titleSection } from "./title";
import { executiveSection } from "./executive";
import { basisSection } from "./basis";
import { methodologySection } from "./methodology";
import { energySection } from "./energy";
import { scope3Section } from "./scope3";
import { disclosuresSection } from "./disclosures";
import { comprehensiveSection } from "./comprehensive";
import { dataQualitySection } from "./data-quality";
import { completenessSection } from "./completeness";
import { evidenceSection } from "./evidence";
import { disclaimerSection } from "./disclaimer";
import { gapPlanSection } from "./gap-plan";
import { esrsIndexBlocks } from "./esrs-index";

// =============================================================================
// REN-2 — THE SECTIONS OF THE VSME BASIC REPORT, AS A DOCUMENT MODEL.
//
// This module turns a {@link RenderInput} into an ordered list of sections made
// of five kinds of block. It touches no database, no clock and no PDF library:
// `vsme-basic.ts` gathers the input, this file decides what the report SAYS, and
// only then does pdfmake decide what it looks like.
//
// ── WHY AN INTERMEDIATE MODEL AND NOT A pdfmake DOCUMENT DIRECTLY ────────────
// Because the acceptance criteria are about WORDS. "The methodology section
// names all five Scope-1 categories" (AC-4), "an excluded legal entity appears
// with its reason" (AC-3), "no full-conformity wording at `partial`" (REN-4) —
// every one of those is a statement about text, and the only way to check text
// inside a PDF is to parse a PDF, which means a content-stream decoder standing
// between the assertion and the defect it is looking for. {@link sectionsToText}
// gives the same words with nothing in between, and the PDF is then checked for
// what only a PDF can be checked for: that it is a valid, non-empty file.
//
// ── WHAT "not collected" IS FOR, AND WHY IT IS NOT AN EMPTY ROW ─────────────
// REN-2 says the Basic disclosures B2 and B4…B11 are printed "as far as the data
// exists, with a `not collected` mark otherwise". The mark is the point. A
// report that silently omits the metrics nobody answered looks complete; a
// report that lists them and says nobody answered is the only one whose reader
// can tell the difference between "zero" and "we did not ask". So the disclosure
// sections are driven by the CATALOGUE (`metric_catalog`, every Basic metric)
// and joined to `disclosure_record`, never the other way round.
//
// ── THE SAME RULE ONE LEVEL UP: A FAILED RUN PRINTS NO FIGURES ──────────────
// `calc/aggregate.ts` publishes `null` for every total of a failed run rather
// than the sum of the lines that worked. `RenderContext.quantity` turns that
// `null` into the words "not published", never into `0`. A report that printed
// zeros for a run that could not price half its fuel would be a plausible,
// signed, wrong inventory — which is the failure §0.7 is about, and the reason
// the executive summary opens with a refusal rather than a table when the run
// did not complete.
// =============================================================================

const BUILDERS: Readonly<
  Record<
    RenderSectionId,
    (ctx: RenderContext, input: RenderInput) => RenderBlock[]
  >
> = {
  title: titleSection,
  executiveSummary: executiveSection,
  basis: basisSection,
  methodology: methodologySection,
  energyEmissions: energySection,
  scope3: scope3Section,
  disclosures: disclosuresSection,
  comprehensive: comprehensiveSection,
  dataQuality: dataQualitySection,
  completeness: completenessSection,
  gapPlan: gapPlanSection,
  esrsIndex: (ctx, input) => esrsIndexBlocks(ctx, input.esrs),
  disclaimer: disclaimerSection,
  evidence: evidenceSection,
};

/**
 * REN-2's sections, in order, in the render's language.
 *
 * Pure. The same input gives the same words for ever, which is what lets the
 * acceptance test assert on them without a database and what lets T5.7 hash the
 * result and call it an identity.
 */
export function buildSections(input: RenderInput): readonly RenderSection[] {
  const ctx = renderContext(input.language);
  return RENDER_SECTIONS.map((id) => ({
    id,
    // The cover names both modules when the Comprehensive one is in the report.
    heading:
      id === "title" && input.comprehensive
        ? ctx.t("sections.titleComprehensive")
        : ctx.t(`sections.${id}`),
    blocks:
      input.historicalContext === "partial" &&
      [
        "scope3",
        "disclosures",
        "comprehensive",
        "gapPlan",
        "esrsIndex",
      ].includes(id)
        ? [{ kind: "paragraph", text: ctx.t("history.partial") }]
        : BUILDERS[id](ctx, input),
  }));
}

/**
 * The sections as plain text — the layer the acceptance criteria are written
 * against (see the header).
 *
 * Every string of every block appears, including table headers and cells: an
 * assertion about "the text of the report" must not be silently blind to the
 * half of it that lives in tables, which is where AC-3's exclusion reasons and
 * AC-4's five categories both are.
 */
export function sectionsToText(sections: readonly RenderSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(section.heading);
    for (const block of section.blocks) {
      switch (block.kind) {
        case "paragraph":
        case "subheading":
          lines.push(block.text);
          break;
        case "keyValues":
          for (const row of block.rows)
            lines.push(`${row.label}: ${row.value}`);
          break;
        case "table":
          lines.push(block.columns.join(" | "));
          for (const row of block.rows) lines.push(row.join(" | "));
          break;
        case "list":
          for (const item of block.items) lines.push(item);
          break;
      }
    }
  }
  return lines.join("\n");
}
export * from "./types";
export { esrsIndexBlocks } from "./esrs-index";
