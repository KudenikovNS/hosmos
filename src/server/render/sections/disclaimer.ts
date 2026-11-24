import { buildDisclaimer } from "../disclaimer";
import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderInput } from "./types";

/** REN-2a's four points, as a numbered list on the page. */
export function disclaimerSection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  return [
    { kind: "paragraph", text: ctx.t("disclaimer.intro") },
    { kind: "list", items: buildDisclaimer(ctx, input.coverage) },
  ];
}
