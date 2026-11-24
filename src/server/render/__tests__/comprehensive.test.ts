import { describe, expect, it } from "vitest";

import { REPORT_LANGUAGES as LOCALES } from "@/i18n/locales";
import { renderContext } from "@/server/render/i18n";
import {
  RENDER_SECTIONS,
  sectionsToText,
  type RenderBlock,
  type RenderDisclosure,
  type RenderInput,
} from "@/server/render/sections";
import { comprehensiveSection } from "@/server/render/sections/comprehensive";

const ROWS: RenderDisclosure[] = [
  {
    metricKey: "VSME-120",
    disclosureCode: "C1",
    disclosureTitle:
      "Strategy: business model and sustainability-related initiatives",
    title: "Significant products and markets",
    unit: null,
    requirementType: "mandatory",
    value: "Bakery products, Slovenia and Austria",
    decision: null,
  },
  {
    metricKey: "VSME-121",
    disclosureCode: "C1",
    disclosureTitle:
      "Strategy: business model and sustainability-related initiatives",
    title: "Sustainability-related initiatives",
    unit: null,
    requirementType: "mandatory",
    value: null,
    decision: null,
  },
  {
    metricKey: "VSME-150",
    disclosureCode: "C9",
    disclosureTitle: "Gender diversity in governance bodies",
    title: "Female-to-male ratio",
    unit: "ratio",
    requirementType: "mandatory",
    value: null,
    decision: { status: "not_applicable", reason: "No governance body" },
  },
];

const text = (blocks: RenderBlock[]) =>
  sectionsToText([{ id: "comprehensive", heading: "x", blocks }]);

const input = (comprehensive: RenderInput["comprehensive"]) =>
  ({ comprehensive }) as unknown as RenderInput;

describe("comprehensive section (партия 16)", () => {
  it("sits right after the Basic disclosures, before data quality", () => {
    const at = RENDER_SECTIONS.indexOf("comprehensive");
    expect(at).toBe(RENDER_SECTIONS.indexOf("disclosures") + 1);
    expect(at).toBeLessThan(RENDER_SECTIONS.indexOf("dataQuality"));
    for (const locale of LOCALES) {
      expect(renderContext(locale).t("sections.comprehensive")).toContain("C1");
    }
  });

  describe.each(LOCALES)("%s", (locale) => {
    const ctx = renderContext(locale);

    it("prints only the «not included» sentence without the module", () => {
      for (const absent of [null, undefined]) {
        const blocks = comprehensiveSection(ctx, input(absent));
        expect(blocks).toEqual([
          { kind: "paragraph", text: ctx.t("comprehensive.notIncluded") },
        ]);
      }
    });

    it("prints every C code with its table: answers, decisions and «not collected»", () => {
      const out = text(comprehensiveSection(ctx, input(ROWS)));
      expect(out).toContain(ctx.t("comprehensive.intro"));
      expect(out).toContain("C1 — Strategy");
      expect(out).toContain("C9 — Gender diversity");
      expect(out.indexOf("C1 — ")).toBeLessThan(out.indexOf("C9 — "));
      expect(out).toContain("Bakery products, Slovenia and Austria");
      expect(out).toContain(ctx.notCollected());
      expect(out).toContain(
        ctx.t("disclosures.notApplicable", { reason: "No governance body" }),
      );
      expect(out).toContain(
        ctx.t("disclosures.collectedOf", {
          collected: ctx.count(1),
          total: ctx.count(2),
          code: "C1",
        }),
      );
    });
  });
});
