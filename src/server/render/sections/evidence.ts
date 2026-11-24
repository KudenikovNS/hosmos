import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderInput } from "./types";

/** The evidence appendix (REN-2). */
export function evidenceSection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  if (input.evidence.length === 0) {
    return [{ kind: "paragraph", text: t("evidence.none") }];
  }
  return [
    {
      kind: "paragraph",
      text: t("evidence.intro", { count: ctx.count(input.evidence.length) }),
    },
    {
      kind: "table",
      columns: [
        t("evidence.columns.file"),
        t("evidence.columns.type"),
        t("evidence.columns.hash"),
        t("evidence.columns.uploaded"),
        t("evidence.columns.links"),
      ],
      rows: input.evidence.map((doc) => [
        doc.fileName,
        doc.fileType,
        doc.fileHash ?? ctx.notCollected(),
        ctx.date(doc.uploadedAt),
        ctx.count(doc.linkCount),
      ]),
    },
  ];
}
