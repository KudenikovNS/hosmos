// =============================================================================
// Партия 9 — the simplified-ESRS cross-reference appendix, DB-less.
//
// `esrsIndexBlocks` is exported on its own so this file can feed it an index
// without composing a whole `RenderInput`; the DB half (that `loadRenderInput`
// fills `input.esrs` only on a plan with the layer) lives in
// `render.integration.test.ts`'s territory. Three things are pinned here:
// the section exists and sits between the gap plan and the disclaimer; a plan
// without the layer gets a «not included» paragraph and nothing else; and with
// an index every reference, every title and every state word is printed, in
// both report languages, in tables the xlsx writer can hold (≤ 6 columns).
// =============================================================================
import { describe, expect, it } from "vitest";

import { REPORT_LANGUAGES as LOCALES } from "@/i18n/locales";
import { renderContext } from "@/server/render/i18n";
import {
  esrsIndexBlocks,
  RENDER_SECTIONS,
  sectionsToText,
  type RenderBlock,
  type RenderEsrsIndex,
} from "@/server/render/sections";

const INDEX: RenderEsrsIndex = {
  regulatoryStatus: "C(2026)5010 adopted 03.07.2026; not in force (test)",
  cross: [
    {
      reference: "ESRS E1-7",
      metricKey: "VSME-030",
      disclosureCode: "B3",
      title: "Gross Scope 1 GHG emissions",
      state: "answered",
    },
    {
      reference: "ESRS S1-6",
      metricKey: "VSME-080",
      disclosureCode: "B8",
      title: "Number of employees",
      state: "open",
    },
    {
      reference: "ESRS E1-1",
      metricKey: "VSME-020",
      disclosureCode: "B2",
      title: "Transition plan",
      state: "decided",
    },
  ],
  additional: [
    {
      reference: "ESRS E1-4",
      metricKey: "ESRS-010",
      disclosureCode: "E1-4",
      title: "Targets related to climate change mitigation",
      appliesWhen: "If climate material",
      value: "Net zero by 2045",
    },
    {
      reference: "ESRS S2-1",
      metricKey: "ESRS-034",
      disclosureCode: "S2-1",
      title: "Policies related to value chain workers",
      appliesWhen: "If value-chain workers material",
      value: null,
      decision: { status: "not_applicable", reason: "no value-chain workers" },
    },
    {
      reference: "ESRS G1-6",
      metricKey: "ESRS-050",
      disclosureCode: "G1-6",
      title: "Payment practices",
      appliesWhen: "If payment practices material",
      value: null,
    },
  ],
};

function textOf(blocks: readonly RenderBlock[]): string {
  return sectionsToText([{ id: "esrsIndex", heading: "x", blocks }]);
}

describe("партия 9 — the ESRS cross-reference is a section of the report", () => {
  it("sits between the gap plan and the disclaimer, with a heading in both languages", () => {
    const at = RENDER_SECTIONS.indexOf("esrsIndex");
    expect(at).toBeGreaterThan(RENDER_SECTIONS.indexOf("gapPlan"));
    expect(at).toBeLessThan(RENDER_SECTIONS.indexOf("disclaimer"));
    for (const locale of LOCALES) {
      const heading = renderContext(locale).t("sections.esrsIndex");
      expect(heading).toMatch(/ESRS/);
    }
  });

  it.each(LOCALES)(
    "%s: without the layer it is one «not included» paragraph — never an empty table",
    (locale) => {
      const ctx = renderContext(locale);
      for (const absent of [null, undefined]) {
        const blocks = esrsIndexBlocks(ctx, absent);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
          kind: "paragraph",
          text: ctx.t("esrsIndex.notIncluded"),
        });
      }
    },
  );

  it.each(LOCALES)(
    "%s: with an index every reference, title, state and answer is printed",
    (locale) => {
      const ctx = renderContext(locale);
      const blocks = esrsIndexBlocks(ctx, INDEX);
      const text = textOf(blocks);

      for (const row of INDEX.cross) {
        expect(text).toContain(row.reference);
        expect(text).toContain(row.title);
        expect(text).toContain(ctx.t(`esrsIndex.${row.state}`));
      }
      for (const row of INDEX.additional) {
        expect(text).toContain(row.reference!);
        expect(text).toContain(row.title);
        expect(text).toContain(row.appliesWhen!);
      }
      expect(text).toContain("Net zero by 2045");
      expect(text).toContain("no value-chain workers");
      expect(text).toContain(ctx.notCollected());
      expect(text).toContain(INDEX.regulatoryStatus!);
      // Two of three mapped datapoints have something; one of three additional.
      expect(text).toContain(
        ctx.t("esrsIndex.crossIntro", { answered: "2", total: "3" }),
      );
      expect(text).toContain(
        ctx.t("esrsIndex.additionalIntro", { answered: "2", total: "3" }),
      );
    },
  );

  it("sorts the cross-reference by ESRS standard and number, not by VSME order", () => {
    const blocks = esrsIndexBlocks(renderContext("en"), INDEX);
    const table = blocks.find((b) => b.kind === "table");
    expect(table && table.kind === "table" ? table.rows[0][0] : null).toBe(
      "ESRS E1-1",
    );
    expect(table && table.kind === "table" ? table.rows[2][0] : null).toBe(
      "ESRS S1-6",
    );
  });

  it("keeps every table within the six columns the xlsx writer lays out", () => {
    for (const block of esrsIndexBlocks(renderContext("en"), INDEX)) {
      if (block.kind !== "table") continue;
      expect(block.columns.length).toBeLessThanOrEqual(6);
      for (const row of block.rows)
        expect(row).toHaveLength(block.columns.length);
    }
  });
});
