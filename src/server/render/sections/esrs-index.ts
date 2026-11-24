import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderDisclosure, RenderEsrsIndex } from "./types";

/** `ESRS E1-7` → sortable parts: the standard, then the number. */
function referenceOrder(reference: string): string {
  return reference
    .replace(/^ESRS\s*/i, "")
    .replace(/(\d+)/g, (n) => n.padStart(3, "0"));
}

function esrsRowState(row: {
  readonly value: string | null;
  readonly decision?: RenderDisclosure["decision"];
}): "answered" | "decided" | "open" {
  if (row.value !== null) return "answered";
  if (row.decision) return "decided";
  return "open";
}

/**
 * The simplified-ESRS cross-reference appendix. Exported on its own (not only
 * through `buildSections`) so a test can feed it an index without composing a
 * whole `RenderInput`.
 */
export function esrsIndexBlocks(
  ctx: RenderContext,
  esrs: RenderEsrsIndex | null | undefined,
): RenderBlock[] {
  const { t } = ctx;
  if (!esrs) return [{ kind: "paragraph", text: t("esrsIndex.notIncluded") }];
  const blocks: RenderBlock[] = [
    { kind: "paragraph", text: t("esrsIndex.intro") },
  ];
  if (esrs.regulatoryStatus) {
    blocks.push({
      kind: "paragraph",
      text: t("esrsIndex.regulatory", { status: esrs.regulatoryStatus }),
    });
  }

  blocks.push({ kind: "subheading", text: t("esrsIndex.crossHeading") });
  const cross = [...esrs.cross].sort(
    (a, b) =>
      referenceOrder(a.reference).localeCompare(referenceOrder(b.reference)) ||
      a.metricKey.localeCompare(b.metricKey),
  );
  blocks.push({
    kind: "paragraph",
    text: t("esrsIndex.crossIntro", {
      answered: ctx.count(cross.filter((r) => r.state !== "open").length),
      total: ctx.count(cross.length),
    }),
  });
  if (cross.length === 0) {
    blocks.push({ kind: "paragraph", text: t("esrsIndex.noRows") });
  } else {
    blocks.push({
      kind: "table",
      columns: [
        t("esrsIndex.columns.reference"),
        t("esrsIndex.columns.datapoint"),
        t("esrsIndex.columns.status"),
      ],
      rows: cross.map((row) => [
        row.reference,
        `${row.disclosureCode} · ${row.title}`,
        t(`esrsIndex.${row.state}`),
      ]),
    });
  }

  blocks.push({ kind: "subheading", text: t("esrsIndex.additionalHeading") });
  const additional = esrs.additional;
  blocks.push({
    kind: "paragraph",
    text: t("esrsIndex.additionalIntro", {
      answered: ctx.count(
        additional.filter((r) => esrsRowState(r) !== "open").length,
      ),
      total: ctx.count(additional.length),
    }),
  });
  if (additional.length === 0) {
    blocks.push({ kind: "paragraph", text: t("esrsIndex.noRows") });
  } else {
    blocks.push({
      kind: "table",
      columns: [
        t("esrsIndex.columns.reference"),
        t("esrsIndex.columns.datapoint"),
        t("esrsIndex.columns.appliesWhen"),
        t("esrsIndex.columns.answer"),
      ],
      rows: additional.map((row) => [
        row.reference ?? row.disclosureCode,
        `${row.disclosureCode} · ${row.title}`,
        row.appliesWhen ?? "—",
        row.value ??
          (row.decision
            ? t(
                row.decision.status === "not_applicable"
                  ? "disclosures.notApplicable"
                  : "disclosures.sensitiveOmitted",
                { reason: row.decision.reason },
              )
            : ctx.notCollected()),
      ]),
    });
  }
  return blocks;
}
