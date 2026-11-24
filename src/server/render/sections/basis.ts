import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderInput } from "./types";
import { disclosureTable } from "./shared";

/** B1 — the basis of preparation, and the boundary with its reasons (AC-3). */
export function basisSection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  const blocks: RenderBlock[] = [
    {
      kind: "paragraph",
      text: t("basis.intro", {
        basis: t(`basis.reportingBasis.${input.period.reportingBasis}`),
        company: input.company.name,
      }),
    },
    {
      kind: "paragraph",
      text: input.revision.frozen
        ? t("basis.boundaryFrozen")
        : t("basis.boundaryLive"),
    },
    { kind: "subheading", text: t("basis.boundaryHeading") },
    {
      kind: "table",
      columns: [
        t("basis.columns.entity"),
        t("basis.columns.registration"),
        t("basis.columns.address"),
        t("basis.columns.status"),
        t("basis.columns.exclusionReason"),
      ],
      // EVERY entity of `period_scope`, included or not, each with its reason.
      // AC-3 lives in this table: an excluded subsidiary that is simply absent
      // from the report is exactly the boundary gap the criterion closes.
      rows: input.scope.map((entry) => [
        entry.name,
        entry.registrationNumber ?? ctx.notCollected(),
        entry.registeredAddress ?? ctx.notCollected(),
        t(`basis.status.${entry.status}`),
        entry.status === "included"
          ? "—"
          : (entry.exclusionReason ?? ctx.notCollected()),
      ]),
    },
  ];

  const subsidiaries = input.scope.filter((entry) => entry.isSubsidiary);
  blocks.push({ kind: "subheading", text: t("basis.subsidiariesHeading") });
  if (subsidiaries.length === 0) {
    blocks.push({
      kind: "paragraph",
      text: input.scope.some((entry) => entry.isSubsidiary === null)
        ? t("history.relationshipsMissing")
        : t("basis.noSubsidiaries"),
    });
  } else {
    blocks.push({
      kind: "table",
      columns: [
        t("basis.columns.entity"),
        t("basis.columns.address"),
        t("basis.columns.ownership"),
        t("basis.columns.consolidation"),
      ],
      rows: subsidiaries.map((entry) => [
        entry.name,
        entry.registeredAddress ?? ctx.notCollected(),
        entry.ownershipPercentage === null
          ? ctx.notCollected()
          : ctx.percent(entry.ownershipPercentage),
        entry.consolidationMethod === null
          ? ctx.notCollected()
          : t(`basis.consolidation.${entry.consolidationMethod}`),
      ]),
    });
  }

  blocks.push(...disclosureTable(ctx, input, "B1"));
  return blocks;
}
