/**
 * Партия 18 — the two things that tell a user how to fill a disclosure:
 * the choice lists the standard names, and the answers the Organisation screen
 * already knows.
 */
import { describe, expect, it } from "vitest";

import vsmeRows from "@/server/db/seed-data/vsme-metrics.json";
import type { FacilityDto } from "@/server/org/facilities";
import type { LegalEntityDto } from "@/server/org/legal-entities";

import { EMPTY_DRAFT } from "../disclosures/_lib/catalog";
import { METRIC_CHOICES, choicesFor, isListed } from "@/shared/catalog/options";
import {
  suggestionApplied,
  suggestionFor,
  type SuggestContext,
} from "../disclosures/_lib/suggest";

const byKey = new Map(
  (vsmeRows as { metric_key: string; value_type: string }[]).map((r) => [
    r.metric_key,
    r,
  ]),
);

describe("choice lists", () => {
  it("exist only for choice-type datapoints of the catalogue", () => {
    for (const key of Object.keys(METRIC_CHOICES)) {
      const row = byKey.get(key);
      expect(row, key).toBeDefined();
      expect(["enum", "multi_enum"], key).toContain(row!.value_type);
    }
  });

  it("have unique stored values and labels in every catalogue language", () => {
    for (const [key, choices] of Object.entries(METRIC_CHOICES)) {
      const values = choices.options.map((o) => o.value);
      expect(new Set(values).size, key).toBe(values.length);
      for (const o of choices.options) {
        expect(o.label.en.trim(), key).not.toBe("");
        expect(o.label.sl.trim(), key).not.toBe("");
        expect(o.label.ru.trim(), key).not.toBe("");
        for (const locale of ["de", "it", "sr", "hr"]) {
          const label = choicesFor(key, locale)!.options.find(
            (c) => c.value === o.value,
          )!.label;
          // Codes (B2…C9) are the same everywhere; every worded label is translated.
          if (o.label.en !== o.value || !/^[BC]\d+$/.test(o.value))
            expect(label, `${key} ${o.value} ${locale}`).not.toBe(o.label.en);
        }
      }
    }
  });

  it("offer OPTION A / OPTION B for the reporting option, labelled per language", () => {
    const sl = choicesFor("VSME-001", "sl")!;
    expect(sl.options.map((o) => o.value)).toEqual([
      "OPTION A: Basic Module",
      "OPTION B: Basic and Comprehensive Modules",
    ]);
    expect(sl.options[0].label).toMatch(/^Možnost A/);
    expect(choicesFor("VSME-001", "de")!.options[0].label).toMatch(/^Option A/);
    expect(choicesFor("VSME-001", "ru")!.options[0].label).toMatch(
      /^Вариант A/,
    );
    expect(choicesFor("VSME-009", "sl")).toBeNull();
  });

  it("recognise a stored value, not a typed variant", () => {
    expect(isListed("VSME-003", "Individual basis")).toBe(true);
    expect(isListed("VSME-003", "individual")).toBe(false);
  });
});

const entity = (over: Partial<LegalEntityDto> = {}): LegalEntityDto => ({
  id: "e1",
  organisation_name: "Celjske mesnine d.o.o.",
  registration_number: "5150949000",
  vat_number: "SI73291978",
  registered_address: "Cesta v Trnovlje 17, 3000 Celje",
  country: "SI",
  nace_code: "10.13",
  reporting_currency: "EUR",
  employee_count: 348,
  average_fte: 347.72,
  turnover: 104833186,
  group_structure_type: "standalone",
  parent_organisation_id: null,
  consolidation_method: null,
  ownership_percentage: null,
  effective_from: null,
  effective_to: null,
  exclusion_reason: null,
  created_at: null,
  updated_at: null,
  ...over,
});

const site = (over: Partial<FacilityDto>): FacilityDto => ({
  id: "f",
  legal_entity_id: "e1",
  facility_name: "Obrat",
  facility_type: "plant",
  address: "Cesta v Trnovlje 17",
  country: "SI",
  postal_code: "3000",
  latitude: null,
  longitude: null,
  tenure: "owned",
  control_status: null,
  floor_area: null,
  opening_date: null,
  closing_date: null,
  included_in_boundary: true,
  boundary_classification: null,
  created_at: null,
  updated_at: null,
  ...over,
});

const ctx = (over: Partial<SuggestContext> = {}): SuggestContext => ({
  entity: entity(),
  entities: [entity()],
  facilities: [
    site({
      id: "a",
      facility_name: "Obrat",
      latitude: 46.2513,
      longitude: 15.2749,
    }),
    site({ id: "b", facility_name: "Mesninček Lava", address: "Lava 7f" }),
    site({ id: "c", facility_name: "Izven meje", included_in_boundary: false }),
  ],
  reportingBasis: "individual",
  comprehensive: false,
  ...over,
});

describe("suggestionFor — what the organisation already says", () => {
  it("fills the B1 basics from the legal entity", () => {
    expect(suggestionFor("VSME-007", ctx())?.draft).toEqual({ lines: "10.13" });
    expect(suggestionFor("VSME-009", ctx())?.draft).toEqual({
      text: "104833186",
    });
    expect(suggestionFor("VSME-010", ctx())?.draft).toEqual({ text: "348" });
    expect(suggestionFor("VSME-011", ctx())?.draft).toEqual({ text: "SI" });
  });

  it("reads the reporting option from the plan and the basis from the period", () => {
    expect(suggestionFor("VSME-001", ctx())?.draft.text).toBe(
      "OPTION A: Basic Module",
    );
    expect(
      suggestionFor("VSME-001", ctx({ comprehensive: true }))?.draft.text,
    ).toBe("OPTION B: Basic and Comprehensive Modules");
    expect(suggestionFor("VSME-003", ctx())?.draft.text).toBe(
      "Individual basis",
    );
    expect(
      suggestionFor("VSME-003", ctx({ reportingBasis: "consolidated" }))?.draft
        .text,
    ).toBe("Consolidated basis");
    expect(suggestionFor("VSME-003", ctx({ reportingBasis: null }))).toBeNull();
  });

  it("stores a suggested choice as one of the listed values", () => {
    for (const key of ["VSME-001", "VSME-003", "VSME-006"]) {
      const s = suggestionFor(key, ctx());
      expect(s, key).not.toBeNull();
      expect(isListed(key, s!.draft.text!), key).toBe(true);
    }
  });

  it("recognises Slovenian legal forms in the name", () => {
    const form = (name: string) =>
      suggestionFor(
        "VSME-006",
        ctx({ entity: entity({ organisation_name: name }) }),
      )?.draft.text ?? null;
    expect(form("Celjske mesnine d.o.o.")).toMatch(/^d\.o\.o\./);
    expect(form("Krka, d. d.")).toMatch(/^d\.d\./);
    expect(form("Janez Novak s.p.")).toMatch(/^s\.p\./);
    expect(form("Acme GmbH")).toBeNull();
  });

  it("lists sites in the boundary only, with coordinates where known", () => {
    const sites = suggestionFor("VSME-012", ctx())!;
    expect(sites.draft.lines).toContain("Obrat, Cesta v Trnovlje 17, 3000, SI");
    expect(sites.draft.lines).toContain("Mesninček Lava, Lava 7f");
    expect(sites.draft.lines).not.toContain("Izven meje");
    expect(suggestionFor("VSME-013", ctx())?.draft.text).toBe(
      "Obrat: 46.2513, 15.2749",
    );
  });

  it("suggests subsidiaries only for a consolidated period", () => {
    const sub = entity({
      id: "e2",
      organisation_name: "Hči d.o.o.",
      group_structure_type: "subsidiary",
    });
    const group = ctx({ entities: [entity(), sub] });
    expect(suggestionFor("VSME-004", group)).toBeNull();
    expect(
      suggestionFor("VSME-004", { ...group, reportingBasis: "consolidated" })
        ?.draft.lines,
    ).toBe("Hči d.o.o.");
  });

  it("offers nothing when nothing is known, and never for other datapoints", () => {
    expect(
      suggestionFor("VSME-009", ctx({ entity: entity({ turnover: null }) })),
    ).toBeNull();
    expect(suggestionFor("VSME-008", ctx())).toBeNull();
    expect(suggestionFor("VSME-030", ctx())).toBeNull();
  });

  it("knows when the draft already holds the suggestion", () => {
    const s = suggestionFor("VSME-011", ctx())!;
    expect(suggestionApplied(s, EMPTY_DRAFT)).toBe(false);
    expect(suggestionApplied(s, { ...EMPTY_DRAFT, text: "SI" })).toBe(true);
  });
});
