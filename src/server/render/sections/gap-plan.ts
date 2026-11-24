import type { RenderContext } from "../i18n";
import { type RenderBlock, isOpenDatapoint, type RenderInput } from "./types";
import { disclosureCodes } from "./shared";

/** One builder per {@link RENDER_SECTIONS} entry — exhaustive by type. */
/**
 * The gap plan (stage 1, §5.6 / §8.7): every datapoint still open, disclosure
 * by disclosure, plus the decisions taken — what was declared not applicable
 * and what was omitted as sensitive (B1 §24(b)), each with its reason. This is
 * the "list of actions to complete B4–B11" the pilot package promises, built
 * from the same rows the disclosure tables print.
 */
export function gapPlanSection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  const rows = input.disclosures;
  const decided = rows.filter((row) => row.decision);
  const applicable = rows.filter((row) => !row.decision);
  const answered = applicable.filter((row) => row.value !== null);
  const open = applicable.filter(isOpenDatapoint);
  const blocks: RenderBlock[] = [
    {
      kind: "paragraph",
      text: t("gapPlan.intro", {
        answered: ctx.count(answered.length),
        applicable: ctx.count(applicable.length),
        open: ctx.count(open.length),
      }),
    },
  ];
  if (open.length === 0) {
    blocks.push({ kind: "paragraph", text: t("gapPlan.nothingOpen") });
  } else {
    for (const code of disclosureCodes(input)) {
      const missing = open.filter((row) => row.disclosureCode === code);
      if (missing.length === 0) continue;
      const title =
        rows.find((row) => row.disclosureCode === code)?.disclosureTitle ??
        code;
      blocks.push({ kind: "subheading", text: `${code} — ${title}` });
      blocks.push({
        kind: "table",
        columns: [
          t("gapPlan.columns.metric"),
          t("gapPlan.columns.requirement"),
          t("gapPlan.columns.action"),
        ],
        rows: missing.map((row) => [
          row.title,
          row.requirementType,
          t(
            row.requirementType === "mandatory"
              ? "gapPlan.actionMandatory"
              : "gapPlan.actionConditional",
          ),
        ]),
      });
    }
  }
  blocks.push({ kind: "subheading", text: t("gapPlan.decisionsHeading") });
  if (decided.length === 0) {
    blocks.push({ kind: "paragraph", text: t("gapPlan.noDecisions") });
  } else {
    blocks.push({
      kind: "table",
      columns: [
        t("gapPlan.columns.metric"),
        t("gapPlan.columns.decision"),
        t("gapPlan.columns.reason"),
      ],
      rows: decided.map((row) => [
        `${row.disclosureCode} · ${row.title}`,
        t(
          row.decision!.status === "not_applicable"
            ? "gapPlan.decisionNotApplicable"
            : "gapPlan.decisionSensitive",
        ),
        row.decision!.reason,
      ]),
    });
  }
  return blocks;
}
