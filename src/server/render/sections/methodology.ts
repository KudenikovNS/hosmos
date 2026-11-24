import { ACTIVITY_CATEGORIES } from "@/server/inventory/emission-activity";
import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderInput } from "./types";
import {
  factorSetLabel,
  factorBasisLabel,
  substitutionText,
  joinOrNotCollected,
} from "./shared";

/**
 * The methodology section — and AC-4's half of the ownership question.
 *
 * ── WHY ALL FIVE CATEGORIES ARE NAMED, EVEN THE EMPTY ONES ──────────────────
 * AC-4 is "all applicable Scope 1 sources assessed", and the gap it closes is
 * SILENCE. A report that lists the two categories a company happened to fill in
 * is indistinguishable from a report by a company that only has those two — and
 * the reader cannot tell which, because refrigerant leakage and process
 * emissions are exactly the sources an SME forgets it has. So the table below is
 * driven by `ACTIVITY_CATEGORIES` (the same constant the CHECK constraint pairs
 * with, imported rather than re-typed) and every one of the five gets a sentence
 * saying either that it was assessed or that this organisation does not have it.
 * The second sentence is a POSITIVE STATEMENT OF ABSENCE, which is a claim the
 * preparer makes and an auditor can challenge; a blank row is neither.
 */
export function methodologySection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  const byCategory = new Map(
    input.scope1Categories.map((entry) => [entry.category, entry]),
  );
  const blocks: RenderBlock[] = [
    {
      kind: "keyValues",
      rows: [
        {
          label: t("methodology.version"),
          value: input.period.methodologyVersion,
        },
        {
          label: t("methodology.factorSet"),
          value: factorSetLabel(ctx, input),
        },
        {
          label: t("methodology.factorSource"),
          value: joinOrNotCollected(ctx, input.factorSet?.sources),
        },
        {
          label: t("methodology.gwpBasis"),
          value: joinOrNotCollected(ctx, input.factorSet?.gwpBases),
        },
        {
          label: t("methodology.factorBasis"),
          value: factorBasisLabel(ctx, input),
        },
        {
          label: t("methodology.consolidation"),
          value: t(`basis.reportingBasis.${input.period.reportingBasis}`),
        },
        {
          label: t("methodology.formulaVersion"),
          value: input.run?.formulaVersion ?? ctx.notCalculated(),
        },
        {
          label: t("methodology.roundingRule"),
          value: input.run?.roundingRule ?? ctx.notCalculated(),
        },
        {
          label: t("methodology.calculatedAt"),
          value: input.run
            ? ctx.dateTime(input.run.calculatedAt)
            : ctx.notCalculated(),
        },
      ],
    },
    { kind: "subheading", text: t("methodology.scope1Heading") },
    { kind: "paragraph", text: t("methodology.scope1Intro") },
    {
      kind: "table",
      columns: [
        t("methodology.columns.category"),
        t("methodology.columns.statement"),
      ],
      // AC-4, literally: five rows, always, one per §4.9 category.
      rows: ACTIVITY_CATEGORIES.map((category) => {
        const entry = byCategory.get(category);
        const name = t(`methodology.categories.${category}`);
        if (entry === undefined || entry.rowCount === 0) {
          return [
            name,
            t("methodology.categoryNotPresent", { category: name }),
          ];
        }
        return [
          name,
          t("methodology.categoryAssessed", {
            category: name,
            rows: ctx.count(entry.rowCount),
            calculated: ctx.count(entry.calculatedCount),
          }),
        ];
      }),
    },
  ];

  // THE SUBSTITUTIONS, IN THE SECTION THAT DESCRIBES THE METHOD — because that
  // is what they are about. A figure priced by a global default where the set
  // holds a national factor is not a wrong number, it is a number produced under
  // a weaker method than the pinned catalogue offers, and the paragraph that
  // names the catalogue is the paragraph that has to say so. The completeness
  // section counts them again in one line (`qualifications`); here each one says
  // which activity, which unit, which year and which factor was passed over.
  //
  // NOTHING IS PRINTED WHEN THERE IS NOTHING TO PRINT. No "no substitutions were
  // made" reassurance: the whole value of the block is that its presence means
  // something, and a paragraph that appears in every report means nothing.
  const substitutions = input.factorSet?.substitutions ?? [];
  if (substitutions.length > 0) {
    blocks.push(
      { kind: "subheading", text: t("methodology.substitutionHeading") },
      { kind: "paragraph", text: t("methodology.substitutionIntro") },
      {
        kind: "list",
        items: substitutions.map((entry) => substitutionText(ctx, entry)),
      },
    );
  }

  return blocks;
}
