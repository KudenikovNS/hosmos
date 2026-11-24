import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderInput } from "./types";
import { OWN_SECTION_CODES, disclosureCodes, disclosureTable } from "./shared";

/** B2 and B4…B11 — everything else the Basic module asks for (К-26). */
export function disclosuresSection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  const codes = disclosureCodes(input).filter(
    (code) => OWN_SECTION_CODES[code] === undefined,
  );
  if (codes.length === 0) {
    return [{ kind: "paragraph", text: t("disclosures.noCatalogue") }];
  }
  const blocks: RenderBlock[] = [
    { kind: "paragraph", text: t("disclosures.intro") },
  ];
  for (const code of codes) {
    const title =
      input.disclosures.find((row) => row.disclosureCode === code)
        ?.disclosureTitle ?? code;
    blocks.push({ kind: "subheading", text: `${code} — ${title}` });
    blocks.push(...disclosureTable(ctx, input, code));
  }
  return blocks;
}
