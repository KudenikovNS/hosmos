import type { RenderContext } from "../i18n";
import { type RenderBlock, isOpenDatapoint, type RenderInput } from "./types";
import { factorSetLabel } from "./shared";

/** REN-2's cover: who the report is for and what it was computed against. */
export function titleSection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  const openMandatory = input.disclosures.filter(
    (row) => row.requirementType === "mandatory" && isOpenDatapoint(row),
  ).length;
  return [
    {
      kind: "paragraph",
      text: t(
        input.comprehensive
          ? "document.subtitleComprehensive"
          : "document.subtitle",
      ),
    },
    // What this document IS (stage 1, 13.08.2026 §5.6): until every applicable
    // Basic datapoint has an answer, it is a readiness report — a draft —
    // and says so before anything else.
    {
      kind: "paragraph",
      text:
        input.historicalContext === "partial"
          ? t("history.partial")
          : openMandatory > 0
            ? t("document.statusGaps", { count: ctx.count(openMandatory) })
            : t("document.statusReady"),
    },
    {
      kind: "keyValues",
      rows: [
        { label: t("document.preparedFor"), value: input.company.name },
        {
          label: t("document.reportingPeriod"),
          value: `${input.period.name} · ${ctx.date(input.period.startDate)} – ${ctx.date(input.period.endDate)}`,
        },
        {
          label: t("document.reportingYear"),
          value:
            input.period.reportingYear === null
              ? ctx.notCollected()
              : ctx.count(input.period.reportingYear),
        },
        {
          label: t("document.revision"),
          value: t("document.revisionNo", {
            number: ctx.count(input.revision.revisionNo),
            status: input.revision.status,
          }),
        },
        {
          label: t("document.reportingBasisLabel"),
          value: t(`basis.reportingBasis.${input.period.reportingBasis}`),
        },
        {
          label: t("document.methodologyVersion"),
          value: input.period.methodologyVersion,
        },
        { label: t("document.factorSet"), value: factorSetLabel(ctx, input) },
        { label: t("document.language"), value: ctx.localeName },
        {
          label: t("document.generatedAt"),
          value: ctx.dateTime(input.generatedAt),
        },
      ],
    },
  ];
}
