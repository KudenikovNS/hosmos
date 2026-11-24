import { QUALITY_TIERS } from "@/shared/enums";
import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderInput } from "./types";

/** The DQ summary (REN-2). */
export function dataQualitySection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  const dq = input.dataQuality;
  const blocks: RenderBlock[] = [
    {
      kind: "paragraph",
      text: t("dataQuality.intro", {
        assessed: ctx.count(dq.assessedCount),
        rows: ctx.count(dq.rowCount),
      }),
    },
    {
      kind: "keyValues",
      rows: [
        {
          label: t("dataQuality.averagePedigree"),
          value:
            dq.averagePedigree === null
              ? ctx.notCollected()
              : ctx.quantity(dq.averagePedigree, t("dataQuality.pedigreeUnit")),
        },
        {
          label: t("dataQuality.overridden"),
          value: ctx.count(dq.overriddenCount),
        },
        {
          label: t("dataQuality.unassessed"),
          value: ctx.count(Math.max(dq.rowCount - dq.assessedCount, 0)),
        },
      ],
    },
    {
      kind: "table",
      columns: [t("dataQuality.columns.tier"), t("dataQuality.columns.rows")],
      rows: [
        ...QUALITY_TIERS.map((tier) => [
          t(`dataQuality.tier.${tier}`),
          ctx.count(dq.byTier[tier]),
        ]),
        [t("dataQuality.tier.none"), ctx.count(dq.untieredCount)],
      ],
    },
  ];
  return blocks;
}
