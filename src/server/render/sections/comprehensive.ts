import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderInput } from "./types";
import { codesOf, disclosureTableFor } from "./shared";

/**
 * C1…C9 — the Comprehensive module (партия 16).
 *
 * Catalogue-driven like the Basic disclosures: every Comprehensive metric is a
 * row, answered or «not collected». Without the module in the plan the
 * section prints one sentence saying so, the way the ESRS appendix does, so a
 * Starter report still has the chapter and a reader can see what the upgrade
 * adds.
 */
export function comprehensiveSection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  const rows = input.comprehensive;
  if (!rows) {
    return [{ kind: "paragraph", text: t("comprehensive.notIncluded") }];
  }
  const codes = codesOf(rows);
  if (codes.length === 0) {
    return [{ kind: "paragraph", text: t("comprehensive.noCatalogue") }];
  }
  const blocks: RenderBlock[] = [
    { kind: "paragraph", text: t("comprehensive.intro") },
  ];
  for (const code of codes) {
    const title =
      rows.find((row) => row.disclosureCode === code)?.disclosureTitle ?? code;
    blocks.push({ kind: "subheading", text: `${code} — ${title}` });
    blocks.push(...disclosureTableFor(ctx, rows, code));
  }
  return blocks;
}
