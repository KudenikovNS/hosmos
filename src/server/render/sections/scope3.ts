import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderInput } from "./types";

/**
 * The Scope 3 coverage statement (REN-2).
 *
 * Three claims, always printed, whether or not there is a single spend line:
 * the METHOD is a spend-based estimate, N categories are covered, and these
 * estimates are OUTSIDE the gross Scope 1 + Scope 2 totals. The third is the one
 * that has to be said out loud — a reader who adds the Scope 3 figure to the
 * headline would double-count an estimate against an inventory.
 */
export function scope3Section(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  const blocks: RenderBlock[] = [
    { kind: "paragraph", text: t("scope3.method") },
    {
      kind: "paragraph",
      text: t("scope3.categoriesCovered", {
        count: ctx.count(input.scope3.length),
      }),
    },
    { kind: "paragraph", text: t("scope3.excludedFromTotals") },
  ];
  if (input.scope3.length === 0) {
    blocks.push({ kind: "paragraph", text: t("scope3.none") });
    return blocks;
  }
  blocks.push({
    kind: "table",
    columns: [
      t("scope3.columns.category"),
      t("scope3.columns.name"),
      t("scope3.columns.tco2e"),
      t("scope3.columns.quality"),
    ],
    rows: input.scope3.map((row) => [
      ctx.count(row.categoryId),
      row.categoryName,
      ctx.quantity(String(row.tco2e), t("units.tco2e")),
      row.dataQuality ?? ctx.notCollected(),
    ]),
  });
  return blocks;
}
