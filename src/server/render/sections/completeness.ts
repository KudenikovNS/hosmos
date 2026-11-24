import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderInput } from "./types";
import { qualifications, qualificationText } from "./shared";

/**
 * Exclusions and completeness (D14) — and the ONE place a conformity claim may
 * be made.
 *
 * See `disclaimer.ts` for why the claim lives in a single message key and what
 * stops a rephrasing from smuggling it into a `partial` report.
 */
export function completenessSection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  const coverage = input.coverage;
  const blocks: RenderBlock[] = [
    {
      kind: "paragraph",
      text:
        coverage.claim === "full"
          ? t("completeness.conformity.full")
          : t("completeness.conformity.partial"),
    },
  ];

  if (coverage.claim === "partial") {
    blocks.push({
      kind: "paragraph",
      text:
        coverage.completenessNote === null
          ? t("completeness.noteMissing")
          : t("completeness.note", { note: coverage.completenessNote }),
    });
  }

  const excludedByScope = input.scope.filter(
    (entry) => entry.status !== "included",
  );
  blocks.push({ kind: "subheading", text: t("completeness.boundaryHeading") });
  if (excludedByScope.length === 0) {
    blocks.push({ kind: "paragraph", text: t("completeness.noneExcluded") });
  } else {
    blocks.push({
      kind: "table",
      columns: [
        t("basis.columns.entity"),
        t("basis.columns.status"),
        t("basis.columns.exclusionReason"),
      ],
      rows: excludedByScope.map((entry) => [
        entry.name,
        t(`basis.status.${entry.status}`),
        entry.exclusionReason ?? ctx.notCollected(),
      ]),
    });
  }

  blocks.push({ kind: "subheading", text: t("completeness.planHeading") });
  if (input.historicalContext === "partial") {
    blocks.push({ kind: "paragraph", text: t("history.partial") });
  } else if (coverage.excludedByPlan.length === 0) {
    blocks.push({ kind: "paragraph", text: t("completeness.noneByPlan") });
  } else {
    blocks.push({
      kind: "table",
      columns: [t("completeness.columns.type"), t("completeness.columns.name")],
      rows: coverage.excludedByPlan.map((entry) => [entry.type, entry.name]),
    });
  }

  if (input.run !== null && input.run.failedCount > 0) {
    blocks.push({
      kind: "paragraph",
      text: t("completeness.failedLines", {
        failed: ctx.count(input.run.failedCount),
        lines: ctx.count(input.run.lineCount),
      }),
    });
  }

  // EVERY warning the aggregate raised, in one place, in the section a reader
  // goes to for "what is not in this report". Printed only when there IS an
  // aggregate: a revision that was never calculated has nothing to qualify, and
  // "no figure was withheld" would be a false reassurance about a report that
  // published no figure at all.
  if (input.aggregates !== null) {
    const entries = qualifications(input);
    blocks.push({
      kind: "subheading",
      text: t("qualifications.heading"),
    });
    if (entries.length === 0) {
      blocks.push({ kind: "paragraph", text: t("qualifications.none") });
    } else {
      blocks.push({ kind: "paragraph", text: t("qualifications.intro") });
      blocks.push({
        kind: "list",
        items: entries.map((entry) => qualificationText(ctx, input, entry)),
      });
    }
  }

  return blocks;
}
