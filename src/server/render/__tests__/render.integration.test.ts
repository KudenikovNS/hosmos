// =============================================================================
// [LOCAL-DB] T5.6 — THE VSME BASIC RENDERER (REN-1, REN-2, REN-2a, AC-3, AC-4,
// О-14, D14).
//
// TWO HALVES, AND ONLY THE SECOND NEEDS A POSTGRES.
//
// The first half renders a HAND-BUILT `RenderInput`. That is not a shortcut: the
// things the acceptance criteria are about — "no full-conformity wording at
// `partial`", "all five Scope-1 categories named", "a failed run prints no
// zeros" — are properties of the RENDERER, and a fixture assembled from live
// tables can only exhibit the states somebody remembered to create. A failed run
// with three unpriced lines and a `partial` claim with a completeness note are
// two lines of object literal here and a small saga through the API there.
//
// The second half proves the OTHER thing, which no literal can: that
// `loadRenderInput` reads the right columns of the right tables. An excluded
// legal entity with its reason (AC-3) and a Basic metric nobody answered are
// facts about `period_scope` and `metric_catalog`, and they are asserted against
// a real database and a real calculation run.
//
// ── HOW "NO CLAIM OF FULL VSME CONFORMITY" IS CHECKED ───────────────────────
// Not with `expect(text).not.toContain("full VSME")`, which the next rewording
// walks straight past. Three layers, described at length in `disclaimer.ts`:
//   1. the VALUE of the one message key that may make the claim, read out of the
//      message file, must be absent from a partial render — so rewording the
//      claim rewords the assertion;
//   2. a VOCABULARY of patterns in both REPORT_LANGUAGES must not match the partial
//      render's text once the declared DENIAL sentence is removed — so a new
//      sentence written anywhere in the renderer is caught;
//   3. the whole `render.*` namespace of both message files is swept with the
//      same vocabulary, and the set of matching keys must be exactly the two
//      declared in `CONFORMITY_KEYS` — so a conformity phrase added to a
//      heading, a label or an intro fails at the moment it is written.
// Layer 3 is the one that survives rephrasing: defeating 1 and 2 means saying
// the same thing in new words somewhere else, and 3 is a standing search for it.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";

import { and, eq } from "drizzle-orm";
// `fflate` is `write-excel-file`'s own zip engine (see the header of
// `render/xlsx.ts`); reading the workbook back with it needs no new dependency.
import { strFromU8, unzipSync } from "fflate";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return harness.testDbModule();
});

import type {
  AggregateWarningCode,
  CalcAggregates,
} from "@/server/calc/aggregate";
import { calculateRevision } from "@/server/calc/run";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertDisclosure,
  insertDocument,
  insertDq,
  insertEmissionActivity,
  insertEnergyActivity,
  insertEvidenceLink,
  insertFacility,
  insertLegalEntity,
  insertPeriod,
  insertPeriodScope,
  insertRevision,
  resetAppTables,
  setupDocumentsDir,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { reportRevision } from "@/server/db/schema";
import { ACTIVITY_CATEGORIES } from "@/server/inventory/emission-activity";
import { REPORT_LANGUAGES, type ReportLanguage } from "@/i18n/locales";

import {
  buildDisclaimer,
  claimsFullConformity,
  CONFORMITY_KEYS,
  DISCLAIMER_POINTS,
  type RenderCoverage,
} from "../disclaimer";
import { renderContext } from "../i18n";
import {
  buildSections,
  RENDER_SECTIONS,
  sectionsToText,
  type RenderInput,
} from "../sections";
import {
  loadRenderInput,
  RENDER_FONT_FACES,
  renderFonts,
  renderLanguage,
  renderVsmeBasicPdf,
} from "../vsme-basic";
import { renderVsmeBasicXlsx } from "../xlsx";

// ─── The message files, read as data ─────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "../../../..");

type Messages = Record<string, unknown>;

function messages(locale: ReportLanguage): Messages {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, "messages", `${locale}.json`), "utf8"),
  ) as Messages;
}

/** Every leaf `render.*` message of a locale, by dotted key without the prefix. */
function renderMessages(locale: ReportLanguage): Record<string, string> {
  const walk = (node: unknown, prefix: string): Record<string, string> => {
    if (typeof node === "string") return { [prefix]: node };
    if (!node || typeof node !== "object" || Array.isArray(node)) return {};
    return Object.entries(node as Messages).reduce<Record<string, string>>(
      (acc, [key, value]) =>
        Object.assign(acc, walk(value, prefix ? `${prefix}.${key}` : key)),
      {},
    );
  };
  return walk((messages(locale) as { render: unknown }).render, "");
}

/** `render.sections.<id>` of a locale — the headings a render must contain. */
function sectionHeadings(locale: ReportLanguage): string[] {
  const bundle = renderMessages(locale);
  return RENDER_SECTIONS.map((id) => {
    const heading = bundle[`sections.${id}`];
    if (heading === undefined) {
      throw new Error(`messages/${locale}.json has no render.sections.${id}`);
    }
    return heading;
  });
}

// ─── A hand-built input ──────────────────────────────────────────────────────

/** All-null totals — the shape `calc/aggregate.ts` publishes for a failed run. */
const NO_TOTALS: CalcAggregates["totals"] = {
  scope1Co2e: null,
  scope1BiogenicCo2: null,
  scope2LocationBasedCo2e: null,
  scope2MarketBasedCo2e: null,
};

const NO_ENERGY: CalcAggregates["energy"] = {
  totalMwh: null,
  renewableMwh: null,
  nonRenewableMwh: null,
};

/**
 * What `aggregateRun` returns for a run with a line it could not price.
 *
 * Note that the per-entity bucket is PRESENT and its figures are `null` — the
 * aggregate does not drop the partition, it withholds the numbers. So the
 * renderer meets a full-shaped object with nothing in it, which is exactly the
 * state a `?? 0` would turn into a plausible, signed, wrong inventory.
 */
const FAILED_AGGREGATES: CalcAggregates = {
  status: "failed",
  totals: NO_TOTALS,
  energy: NO_ENERGY,
  byLegalEntity: [
    {
      legalEntityId: "11111111-1111-1111-1111-111111111111",
      name: "Alpsko Podjetje d.o.o.",
      totals: NO_TOTALS,
      energy: NO_ENERGY,
    },
  ],
  byFacility: [],
  intensity: {
    turnoverEur: null,
    locationBasedTco2e: null,
    marketBasedTco2e: null,
    locationBasedIntensity: null,
    marketBasedIntensity: null,
    fxYear: "2024",
  },
  reconciliation: [],
  warnings: [],
  failedLines: [
    {
      legalEntityId: "11111111-1111-1111-1111-111111111111",
      scope: "scope1",
      reportingBasis: null,
      calculationStatus: "failed_missing_factor",
    },
  ],
};

const GREEN_AGGREGATES: CalcAggregates = {
  status: "ok",
  totals: {
    scope1Co2e: "18400.500000",
    scope1BiogenicCo2: "0.000000",
    scope2LocationBasedCo2e: "9100.250000",
    scope2MarketBasedCo2e: "7300.000000",
  },
  energy: {
    totalMwh: "412.500000",
    renewableMwh: "165.000000",
    nonRenewableMwh: "247.500000",
  },
  byLegalEntity: [
    {
      legalEntityId: "11111111-1111-1111-1111-111111111111",
      name: "Alpsko Podjetje d.o.o.",
      totals: {
        scope1Co2e: "18400.500000",
        scope1BiogenicCo2: "0.000000",
        scope2LocationBasedCo2e: "9100.250000",
        scope2MarketBasedCo2e: "7300.000000",
      },
      energy: {
        totalMwh: "412.500000",
        renewableMwh: "165.000000",
        nonRenewableMwh: "247.500000",
      },
    },
  ],
  byFacility: [],
  intensity: {
    turnoverEur: "5000000.00",
    locationBasedTco2e: "27.500750000",
    marketBasedTco2e: "25.700500000",
    locationBasedIntensity: "0.000005500150",
    marketBasedIntensity: "0.000005140100",
    fxYear: "2024",
  },
  reconciliation: [],
  warnings: [],
  failedLines: [],
};

const PARTIAL: RenderCoverage = {
  claim: "partial",
  completenessNote:
    "Two facilities of the Croatian subsidiary are beyond the limits of the current subscription and are not represented in these figures.",
  excludedByPlan: [
    { type: "facility", id: "f-1", name: "Zagreb warehouse" },
    { type: "facility", id: "f-2", name: "Rijeka depot" },
  ],
};

const FULL: RenderCoverage = {
  claim: "full",
  completenessNote: null,
  excludedByPlan: [],
};

/**
 * A complete, deliberately awkward input.
 *
 * `mobile_combustion` is the ONLY Scope-1 category with rows, so the other four
 * exercise AC-4's statement of absence. One legal entity is `excluded` with a
 * reason, which is AC-3. One catalogue metric is answered and one is not, which
 * is REN-2's "not collected".
 */
function sampleInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    language: "en",
    generatedAt: new Date("2025-03-04T09:30:00.000Z"),
    company: { name: "Alpsko Podjetje d.o.o.", country: "SI" },
    period: {
      id: "p-1",
      name: "FY2024",
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      reportingYear: 2024,
      baseYear: 2022,
      reportingBasis: "consolidated",
      methodologyVersion: "ghg-protocol-2024.1",
      comparativePeriodId: null,
    },
    factorSet: {
      code: "legacy-v1",
      name: "Legacy factor set",
      status: "active",
      sources: ["DEFRA 2024"],
      gwpBases: ["AR6"],
      // The default sample is a report with NOTHING to disclose: one basis, no
      // substitution. Every "the marker is absent" assertion rests on this.
      bases: [
        {
          tier: "site_country",
          geography: "SI",
          applicableYear: 2024,
          source: "DEFRA 2024",
          lineCount: 4,
        },
      ],
      substitutions: [],
    },
    revision: {
      id: "r-1",
      revisionNo: 2,
      status: "approved",
      approvedAt: new Date("2025-03-01T10:00:00.000Z"),
      lockedAt: null,
      frozen: false,
    },
    run: {
      runId: "run-1",
      calculatedAt: "2025-03-01T09:00:00.000Z",
      status: "ok",
      lineCount: 12,
      failedCount: 0,
      formulaVersion: "1.0.0",
      roundingRule: "half_up_6",
    },
    aggregates: GREEN_AGGREGATES,
    scope: [
      {
        legalEntityId: "11111111-1111-1111-1111-111111111111",
        name: "Alpsko Podjetje d.o.o.",
        registrationNumber: "SI-1234567",
        registeredAddress: "Dunajska cesta 1, 1000 Ljubljana",
        country: "SI",
        consolidationMethod: "operational_control",
        ownershipPercentage: null,
        isSubsidiary: false,
        status: "included",
        exclusionReason: null,
      },
      {
        legalEntityId: "22222222-2222-2222-2222-222222222222",
        name: "Jadran Logistika d.o.o.",
        registrationNumber: "HR-7654321",
        registeredAddress: "Ilica 200, 10000 Zagreb",
        country: "HR",
        consolidationMethod: "equity_share",
        ownershipPercentage: "35",
        isSubsidiary: true,
        status: "excluded",
        exclusionReason:
          "Minority holding below the operational control threshold; no data rights for the reporting period.",
      },
    ],
    scope1Categories: ACTIVITY_CATEGORIES.map((category) => ({
      category,
      rowCount: category === "mobile_combustion" ? 7 : 0,
      calculatedCount: category === "mobile_combustion" ? 7 : 0,
    })),
    scope3: [
      {
        categoryId: 1,
        categoryName: "Purchased goods and services",
        tco2e: 143.25,
        dataQuality: "secondary",
      },
    ],
    disclosures: [
      {
        metricKey: "VSME-001",
        disclosureCode: "B1",
        disclosureTitle: "Basis for preparation",
        title: "Reporting option selected",
        unit: null,
        requirementType: "mandatory",
        value: "OPTION A",
      },
      {
        metricKey: "VSME-090",
        disclosureCode: "B8",
        disclosureTitle: "Workforce — general characteristics",
        title: "Number of employees in head count",
        unit: "persons",
        requirementType: "mandatory",
        value: null,
      },
      {
        metricKey: "VSME-140",
        disclosureCode: "B11",
        disclosureTitle: "Convictions and fines for corruption and bribery",
        title: "Number of convictions",
        unit: "number",
        requirementType: "mandatory",
        value: null,
      },
    ],
    dataQuality: {
      assessedCount: 4,
      rowCount: 12,
      byTier: {
        high_primary: 1,
        medium_calculated: 3,
        low_proxy: 0,
        estimate: 0,
      },
      untieredCount: 0,
      averagePedigree: "2.75",
      overriddenCount: 1,
    },
    evidence: [
      {
        fileName: "gas-invoice-2024.pdf",
        fileType: "pdf",
        fileHash: "a".repeat(64),
        uploadedAt: new Date("2025-01-15T08:00:00.000Z"),
        linkCount: 3,
      },
    ],
    comparative: null,
    coverage: PARTIAL,
    ...overrides,
  };
}

/** The rendered text of an input, in the input's own language. */
const textOf = (input: RenderInput): string =>
  sectionsToText(buildSections(input));

// =============================================================================
// 1. THE DOCUMENT — structure, sections, and the PDF itself
// =============================================================================

describe("the VSME Basic render (REN-1, REN-2)", () => {
  it("produces a non-empty PDF that starts with %PDF-", async () => {
    const render = await renderVsmeBasicPdf(sampleInput());
    expect(render.pdf.byteLength).toBeGreaterThan(1000);
    expect(render.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("embeds the Figtree faces rather than falling back to a base-14 font", async () => {
    // The four faces must decode, and the bytes must reach PDFKit: a subset of
    // an embedded TrueType face names itself in the font descriptor, so the
    // family name appearing in the file is evidence the font was used and not
    // silently replaced by Helvetica.
    const fonts = renderFonts();
    for (const style of Object.keys(RENDER_FONT_FACES)) {
      const face = fonts.Figtree[style as keyof (typeof fonts)["Figtree"]];
      expect(Buffer.isBuffer(face)).toBe(true);
      expect((face as Buffer).byteLength).toBeGreaterThan(10_000);
    }
    const render = await renderVsmeBasicPdf(sampleInput());
    expect(render.pdf.toString("latin1")).toContain("Figtree");
  });

  it("contains EVERY section REN-2 requires, checked against the list", () => {
    const sections = buildSections(sampleInput());
    expect(sections.map((section) => section.id)).toEqual([...RENDER_SECTIONS]);
    const text = sectionsToText(sections);
    const missing = sectionHeadings("en").filter(
      (heading) => !text.includes(heading),
    );
    expect(missing).toEqual([]);
  });

  it("gives every section at least one block of content", () => {
    for (const section of buildSections(sampleInput())) {
      expect(section.blocks.length, section.id).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// 2. AC-4 — ALL FIVE SCOPE-1 CATEGORIES, NAMED, WITH A VERDICT
// =============================================================================

describe("AC-4 — the methodology section owns all five Scope-1 sources", () => {
  const methodologyText = (input: RenderInput) => {
    const section = buildSections(input).find(
      (candidate) => candidate.id === "methodology",
    );
    if (!section) throw new Error("no methodology section");
    return sectionsToText([section]);
  };

  it.each(REPORT_LANGUAGES)("names all five categories in %s", (locale) => {
    const bundle = renderMessages(locale);
    const text = methodologyText(sampleInput({ language: locale }));
    // The test walks the FIVE, one by one, and fails naming the one that is
    // absent — a section heading alone would satisfy nothing here.
    const missing = ACTIVITY_CATEGORIES.filter((category) => {
      const name = bundle[`methodology.categories.${category}`];
      if (name === undefined) throw new Error(`no name for ${category}`);
      return !text.includes(name);
    });
    expect(missing).toEqual([]);
  });

  it.each(REPORT_LANGUAGES)(
    "states the ABSENCE of a category with no data in %s, rather than staying silent",
    (locale) => {
      const bundle = renderMessages(locale);
      const ctx = renderContext(locale);
      const text = methodologyText(sampleInput({ language: locale }));

      // The fixture gives rows to `mobile_combustion` only, so the other four
      // must each carry the positive statement of absence.
      for (const category of ACTIVITY_CATEGORIES) {
        const name = bundle[`methodology.categories.${category}`];
        const expected =
          category === "mobile_combustion"
            ? ctx.t("methodology.categoryAssessed", {
                category: name,
                rows: ctx.count(7),
                calculated: ctx.count(7),
              })
            : ctx.t("methodology.categoryNotPresent", { category: name });
        expect(text, `${locale}/${category}`).toContain(expected);
      }
    },
  );

  it("keeps the five in step with the schema's own discriminator", () => {
    // If a sixth category is ever added to `ACTIVITY_CATEGORIES` (and to the
    // CHECK constraint it pairs with), this fails until it is given a name.
    const bundle = renderMessages("en");
    expect(ACTIVITY_CATEGORIES).toHaveLength(5);
    for (const category of ACTIVITY_CATEGORIES) {
      expect(bundle[`methodology.categories.${category}`]).toBeTypeOf("string");
    }
  });
});

// =============================================================================
// 3. REN-4 — THE FULL-CONFORMITY PROHIBITION, IN THREE LAYERS
// =============================================================================

describe("REN-4 — a partial report may not claim full VSME conformity", () => {
  /** The declared DENIAL, removed before the vocabulary sweep (see the header). */
  const withoutDenial = (text: string, locale: ReportLanguage): string =>
    text.split(renderMessages(locale)[CONFORMITY_KEYS.denial]).join(" ");

  it.each(REPORT_LANGUAGES)(
    "layer 1 — %s: the claim's own message value is absent at `partial`",
    (locale) => {
      const claim = renderMessages(locale)[CONFORMITY_KEYS.claim];
      expect(claim).toBeTypeOf("string");
      const text = textOf(sampleInput({ language: locale, coverage: PARTIAL }));
      expect(text).not.toContain(claim);
    },
  );

  it.each(REPORT_LANGUAGES)(
    "layer 2 — %s: no sentence anywhere matches the conformity vocabulary",
    (locale) => {
      const text = withoutDenial(
        textOf(sampleInput({ language: locale, coverage: PARTIAL })),
        locale,
      );
      expect(claimsFullConformity(text)).toBe(false);
    },
  );

  it.each(REPORT_LANGUAGES)(
    "layer 3 — %s: only the declared keys carry conformity vocabulary",
    (locale) => {
      const matching = Object.entries(renderMessages(locale))
        .filter(([, value]) => claimsFullConformity(value))
        .map(([key]) => key)
        .sort();
      expect(matching).toEqual(
        [CONFORMITY_KEYS.claim, CONFORMITY_KEYS.denial].sort(),
      );
    },
  );

  it.each(REPORT_LANGUAGES)(
    "prints the completeness note at `partial` in %s",
    (locale) => {
      const text = textOf(sampleInput({ language: locale, coverage: PARTIAL }));
      expect(PARTIAL.completenessNote).not.toBeNull();
      expect(text).toContain(PARTIAL.completenessNote as string);
      // And the plan's own exclusions, by name (D14).
      for (const excluded of PARTIAL.excludedByPlan) {
        expect(text).toContain(excluded.name);
      }
    },
  );

  it.each(REPORT_LANGUAGES)(
    "DOES make the claim when coverage is full, in %s",
    (locale) => {
      const text = textOf(sampleInput({ language: locale, coverage: FULL }));
      expect(text).toContain(renderMessages(locale)[CONFORMITY_KEYS.claim]);
    },
  );

  it("says nothing about a completeness note when coverage is full", () => {
    const text = textOf(sampleInput({ coverage: FULL }));
    expect(text).toContain(renderMessages("en")["completeness.noneByPlan"]);
  });
});

// =============================================================================
// 4. REN-2a — THE FOUR DISCLAIMER POINTS
// =============================================================================

describe("REN-2a — the disclaimer", () => {
  it.each(REPORT_LANGUAGES)(
    "has all four points in %s, in both coverage claims",
    (locale) => {
      const ctx = renderContext(locale);
      for (const coverage of [PARTIAL, FULL]) {
        const points = buildDisclaimer(ctx, coverage);
        expect(points).toHaveLength(DISCLAIMER_POINTS.length);
        expect(points.filter((point) => point.trim() === "")).toEqual([]);
        const text = textOf(sampleInput({ language: locale, coverage }));
        for (const point of points) expect(text).toContain(point);
      }
    },
  );

  it("stores the four points as one numbered string for `disclaimer_text`", async () => {
    const render = await renderVsmeBasicPdf(sampleInput());
    for (const index of [1, 2, 3, 4]) {
      expect(render.disclaimerText).toContain(`${index}. `);
    }
    // Point 3 carries the completeness note at `partial` — REN-2a's own clause.
    expect(render.disclaimerText).toContain(PARTIAL.completenessNote as string);
  });
});

// =============================================================================
// 5. §0.7 / AC-6 — A FAILED OR ABSENT RUN PRINTS NO ZEROS
// =============================================================================

describe("a run that did not complete publishes no totals", () => {
  /**
   * A zero WITH A UNIT is the defect: `0 t CO2e` is a figure, `0` next to a
   * count of records is a count. The pattern therefore requires the unit.
   */
  const zeroFigure = (locale: ReportLanguage) => {
    const units = renderMessages(locale);
    const alternatives = [
      units["units.tco2e"],
      units["units.mwh"],
      units["units.eur"],
    ]
      .map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    return new RegExp(`\\b0([.,]0+)?\\s*(${alternatives})\\b`);
  };

  /** No Scope-3 estimate either, so a genuine `0 t CO2e` cannot muddy the scan. */
  const noFigures = { scope3: [], aggregates: null } as const;

  it.each(REPORT_LANGUAGES)(
    "prints no zero-valued figure for a FAILED run in %s",
    (locale) => {
      const input = sampleInput({
        language: locale,
        scope3: [],
        // The realistic shape: a full aggregate object whose every figure is null.
        aggregates: FAILED_AGGREGATES,
        run: {
          runId: "run-2",
          calculatedAt: "2025-03-01T09:00:00.000Z",
          status: "failed",
          lineCount: 12,
          failedCount: 3,
          formulaVersion: "1.0.0",
          roundingRule: "half_up_6",
        },
      });
      const text = textOf(input);
      expect(text).not.toMatch(zeroFigure(locale));
      expect(text).toContain(renderMessages(locale)["common.notCalculated"]);
      // And the reader is told why, before the table of withheld figures.
      expect(text).toContain(
        renderContext(locale).t("executive.failedRun", {
          failed: renderContext(locale).count(3),
          lines: renderContext(locale).count(12),
        }),
      );
    },
  );

  it.each(REPORT_LANGUAGES)(
    "prints no zero-valued figure when there is NO run in %s",
    (locale) => {
      const text = textOf(
        sampleInput({ language: locale, ...noFigures, run: null }),
      );
      expect(text).not.toMatch(zeroFigure(locale));
      expect(text).toContain(renderMessages(locale)["executive.noRun"]);
    },
  );

  it("still produces a valid PDF for a failed run", async () => {
    const render = await renderVsmeBasicPdf(
      sampleInput({ ...noFigures, run: null }),
    );
    expect(render.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("keeps a GENUINE zero as a zero", () => {
    // The counterpart of the rule above, and the reason it is about `null` and
    // not about the digit: a company that burns no fuel reports 0, and that is
    // a figure, not a hole (VAL-033).
    const text = textOf(
      sampleInput({
        aggregates: {
          ...GREEN_AGGREGATES,
          totals: { ...GREEN_AGGREGATES.totals, scope1Co2e: "0.000000" },
        },
      }),
    );
    expect(text).toMatch(zeroFigure("en"));
  });
});

// =============================================================================
// 5b. THE AGGREGATE'S WARNINGS REACH THE DOCUMENT — IN BOTH FORMATS
// =============================================================================

describe("a withheld figure states its reason in the report", () => {
  /**
   * The four warnings a real run raises, with a second `renewable_share_missing`
   * so the COUNT in the sentence is a count and not the constant 1.
   */
  const WARNED_AGGREGATES: CalcAggregates = {
    ...GREEN_AGGREGATES,
    energy: {
      totalMwh: "412.500000",
      renewableMwh: null,
      nonRenewableMwh: null,
    },
    intensity: {
      ...GREEN_AGGREGATES.intensity,
      turnoverEur: null,
      locationBasedIntensity: null,
      marketBasedIntensity: null,
    },
    warnings: [
      { code: "renewable_share_missing", detail: { energy_row_id: "e1" } },
      { code: "renewable_share_missing", detail: { energy_row_id: "e2" } },
      {
        code: "fx_rate_missing",
        detail: {
          legal_entity_id: "11111111-1111-1111-1111-111111111111",
          currency: "RSD",
          year: "2024",
        },
      },
    ],
  };

  /** The sentence the report must print for one warning code, in one locale. */
  const reason = (
    locale: ReportLanguage,
    code: AggregateWarningCode,
    count: number,
  ) =>
    renderContext(locale).t(`qualifications.reason.${code}`, {
      count: renderContext(locale).count(count),
      year: "2024",
    });

  const warnedInput = (locale: ReportLanguage) =>
    sampleInput({ language: locale, aggregates: WARNED_AGGREGATES });

  it.each(REPORT_LANGUAGES)(
    "names every warning of the run, with its count, in %s",
    (locale) => {
      const text = textOf(warnedInput(locale));
      expect(text).toContain(renderMessages(locale)["qualifications.heading"]);
      expect(text).toContain(reason(locale, "renewable_share_missing", 2));
      expect(text).toContain(reason(locale, "fx_rate_missing", 1));
      // The FX sentence carries the year the rate was looked up for, so the
      // reader can tell "no rate for 2024" from "no such currency".
      expect(text).toContain("2024");
    },
  );

  it.each(REPORT_LANGUAGES)(
    "prints the caveat beside the figure it withheld, not only at the end, in %s",
    (locale) => {
      // The energy split and the intensity are printed in B3; so are their
      // reasons. A reader who never turns to the last section still learns why
      // the two halves of the split are blank.
      const b3 = buildSections(warnedInput(locale)).find(
        (section) => section.id === "energyEmissions",
      );
      if (!b3) throw new Error("no energyEmissions section");
      const text = sectionsToText([b3]);
      expect(text).toContain(reason(locale, "renewable_share_missing", 2));
      expect(text).toContain(reason(locale, "fx_rate_missing", 1));
      // …and the figures themselves really are the withheld ones.
      expect(text).toContain(renderMessages(locale)["common.notCalculated"]);
    },
  );

  it.each(REPORT_LANGUAGES)(
    "says so in the executive summary, where the first blank appears, in %s",
    (locale) => {
      const summary = buildSections(warnedInput(locale)).find(
        (section) => section.id === "executiveSummary",
      );
      if (!summary) throw new Error("no executiveSummary section");
      expect(sectionsToText([summary])).toContain(
        renderContext(locale).t("executive.qualified", {
          section: renderContext(locale).t("sections.completeness"),
        }),
      );
    },
  );

  it("says nothing was withheld when nothing was", () => {
    const text = textOf(sampleInput({ aggregates: GREEN_AGGREGATES }));
    expect(text).toContain(renderMessages("en")["qualifications.none"]);
    expect(text).not.toContain(
      renderMessages("en")["qualifications.reason.fx_rate_missing"].slice(
        0,
        40,
      ),
    );
  });

  it("qualifies nothing at all when there is no calculation to qualify", () => {
    // A revision that was never calculated has no warnings AND no figures. "No
    // figure was withheld" would be a false reassurance about a report that
    // published none, so the block is absent entirely.
    const text = textOf(sampleInput({ aggregates: null, run: null }));
    expect(text).not.toContain(renderMessages("en")["qualifications.none"]);
    expect(text).not.toContain(renderMessages("en")["qualifications.heading"]);
  });

  it("carries the same caveats into the WORKBOOK's cells, not only the PDF", async () => {
    // Both formats are built from `buildSections`, but "both formats" is the
    // claim, so it is checked against the bytes: an `.xlsx` is a zip, and the
    // strings live deflated inside `xl/sharedStrings.xml`.
    const render = await renderVsmeBasicXlsx(warnedInput("en"));
    const members = unzipSync(new Uint8Array(render.xlsx));
    const xml = Object.values(members)
      .map((bytes) => strFromU8(bytes))
      .join("\n");

    // XML-escaped: the sentences carry no markup, but the workbook writes
    // `&amp;`/`&#34;` for anything that would be, so compare on a stable slice.
    const sentence = reason("en", "renewable_share_missing", 2);
    expect(xml).toContain(sentence.slice(0, 60));
    expect(xml).toContain(renderMessages("en")["qualifications.heading"]);
  });

  it("still produces a valid PDF with the caveats in it", async () => {
    const render = await renderVsmeBasicPdf(warnedInput("en"));
    expect(render.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(render.text).toContain(reason("en", "fx_rate_missing", 1));
  });
});

// =============================================================================
// 5c. WHY THIS FACTOR — THE BASIS, AND WHAT WAS PASSED OVER
//
// The methodology section already named the pinned SET. That says which
// catalogue was consulted and nothing about what came out of it: "`si-2025` was
// pinned" is equally true of a report priced entirely from ARSO's national table
// and of one priced entirely from a 2006 IPCC global default, and those are not
// the same report. So the basis is printed, grouped, with a line count — and
// where the run recorded that a BETTER factor of the same set could not be
// reached, the substitution is named rather than left for a reader to infer.
// =============================================================================

describe("factor provenance in the document", () => {
  /** A run in which a Slovenian diesel row, entered in kWh, fell to IPCC. */
  const SUBSTITUTED: RenderInput["factorSet"] = {
    code: "si-2025",
    name: "Slovenia 2025",
    status: "active",
    sources: ["ARSO 2025", "IPCC 2006"],
    gwpBases: ["AR5"],
    bases: [
      {
        tier: "site_country",
        geography: "SI",
        applicableYear: 2025,
        source: "ARSO 2025",
        lineCount: 6,
      },
      {
        tier: "global",
        geography: "GLOBAL",
        applicableYear: null,
        source: "IPCC 2006",
        lineCount: 3,
      },
    ],
    substitutions: [
      {
        reason: "unit_unreachable",
        activityType: "gas_oil",
        chosenGeography: "GLOBAL",
        chosenSource: "IPCC 2006",
        enteredUnit: "kWh",
        requestedYear: 2025,
        betterGeography: "SI",
        betterSource: "ARSO 2025",
        betterYear: 2025,
        betterUnits: ["L"],
        lineCount: 3,
      },
    ],
  };

  const substitutedInput = (locale: ReportLanguage) =>
    sampleInput({
      language: locale,
      aggregates: GREEN_AGGREGATES,
      factorSet: SUBSTITUTED,
    });

  it.each(REPORT_LANGUAGES)(
    "states the basis every figure rests on, in %s",
    (locale) => {
      const text = textOf(substitutedInput(locale));
      const bundle = renderMessages(locale);
      expect(text).toContain(bundle["methodology.factorBasis"]);
      // The rung is named in words, the country and the year verbatim — a reader
      // must be able to see "3 of these lines are a global default" without
      // knowing what CALC-2's ladder is called.
      expect(text).toContain(bundle["methodology.tier.site_country"]);
      expect(text).toContain(bundle["methodology.tier.global"]);
      expect(text).toContain("GLOBAL");
      expect(text).toContain("2025");
    },
  );

  it.each(REPORT_LANGUAGES)(
    "names the factor it passed over, and why it could not reach it, in %s",
    (locale) => {
      const text = textOf(substitutedInput(locale));
      const bundle = renderMessages(locale);
      expect(text).toContain(bundle["methodology.substitutionHeading"]);
      // The whole sentence, exactly as the reader sees it — activity, the unit
      // entered, the factor that was passed over and the source that publishes
      // it. Built through the same translator the renderer uses, so a message
      // whose placeholders drift fails here rather than printing `{activity}`.
      expect(text).toContain(
        renderContext(locale).t("methodology.substitution.unit_unreachable", {
          lines: renderContext(locale).count(3),
          activity: "gas_oil",
          chosenGeography: "GLOBAL",
          chosenSource: "IPCC 2006",
          enteredUnit: "kWh",
          year: "2025",
          betterGeography: "SI",
          betterSource: "ARSO 2025",
          betterYear: "2025",
          betterUnits: "L",
        }),
      );
    },
  );

  it.each(REPORT_LANGUAGES)(
    "qualifies the report in the completeness block, in %s",
    (locale) => {
      // T5.6 built `qualifications` for figures that were WITHHELD. A downgraded
      // basis is the opposite shape — the figure was published — and it belongs
      // in the same list because the reader who goes to "what is not in this
      // report" is the reader who needs it.
      const text = textOf(substitutedInput(locale));
      expect(text).toContain(
        renderContext(locale).t(
          "qualifications.reason.factor_basis_downgraded",
          { count: renderContext(locale).count(3), year: "" },
        ),
      );
      // …and the executive summary flags it at the first page — with its OWN
      // sentence, not the one about withheld figures. Nothing here was withheld,
      // and the first paragraph a reader meets must not say otherwise.
      const ctx = renderContext(locale);
      expect(text).toContain(
        ctx.t("executive.basisQualified", {
          section: ctx.t("sections.methodology"),
        }),
      );
      expect(text).not.toContain(
        ctx.t("executive.qualified", {
          section: ctx.t("sections.completeness"),
        }),
      );
    },
  );

  it("says NOTHING when there is nothing to disclose", () => {
    // THE NOISE FLOOR. The default sample's run took the best factor the set
    // holds for every line, so there is no substitution heading, no sentence
    // and no qualification — and the completeness block says the ordinary "no
    // figure was withheld". A marker that appeared on every report would tell a
    // reader nothing at all.
    const text = textOf(sampleInput({ aggregates: GREEN_AGGREGATES }));
    const bundle = renderMessages("en");
    expect(text).not.toContain(bundle["methodology.substitutionHeading"]);
    expect(text).not.toContain(
      bundle["qualifications.reason.factor_basis_downgraded"].slice(0, 40),
    );
    expect(text).toContain(bundle["qualifications.none"]);
    // The BASIS row is still there: it is a fact about every report, not a
    // warning, and a reader is owed it whether or not anything was substituted.
    expect(text).toContain(bundle["methodology.factorBasis"]);
  });

  it("carries the substitution into the WORKBOOK's cells too", async () => {
    const render = await renderVsmeBasicXlsx(substitutedInput("en"));
    const members = unzipSync(new Uint8Array(render.xlsx));
    const xml = Object.values(members)
      .map((bytes) => strFromU8(bytes))
      .join("\n");
    expect(xml).toContain(
      renderMessages("en")["methodology.substitutionHeading"],
    );
  });
});

// =============================================================================
// 6. О-14 — BOTH LOCALES
// =============================================================================

describe("О-14 — the render language is an input", () => {
  it.each(REPORT_LANGUAGES)(
    "renders a complete report in %s",
    async (locale) => {
      const render = await renderVsmeBasicPdf(
        sampleInput({ language: locale }),
      );
      expect(render.language).toBe(locale);
      expect(render.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      const missing = sectionHeadings(locale).filter(
        (heading) => !render.text.includes(heading),
      );
      expect(missing).toEqual([]);
    },
  );

  it("renders the same run differently in the two REPORT_LANGUAGES", async () => {
    const [english, slovenian] = await Promise.all(
      REPORT_LANGUAGES.map((locale) =>
        renderVsmeBasicPdf(sampleInput({ language: locale })),
      ),
    );
    expect(english.text).not.toBe(slovenian.text);
    expect(english.disclaimerText).not.toBe(slovenian.disclaimerText);
    // Numbers follow the locale too — the fixture's €5 000 000 of turnover is
    // grouped by commas in English and by full stops in Slovenian.
    expect(english.text).toContain("5,000,000");
    expect(slovenian.text).toContain("5.000.000");
  });

  it("has identical `render.*` key sets in the two message files", () => {
    const [en, sl] = REPORT_LANGUAGES.map((locale) =>
      Object.keys(renderMessages(locale)).sort(),
    );
    expect(en).toEqual(sl);
    expect(en.length).toBeGreaterThan(80);
  });

  it("has no Slovenian render message copied verbatim from the English one", () => {
    const en = renderMessages("en");
    const sl = renderMessages("sl");
    // Units and the name of a hash algorithm are legitimately the same word in
    // both REPORT_LANGUAGES; everything else being identical means "not translated yet",
    // which is the failure this assertion exists to make loud (R-13).
    const SAME_IN_BOTH = ["units.", "evidence.columns.hash"];
    const identical = Object.keys(en).filter(
      (key) =>
        en[key] === sl[key] &&
        !SAME_IN_BOTH.some((allowed) => key.startsWith(allowed)),
    );
    expect(identical).toEqual([]);
  });

  it("never renders in a language the caller did not choose", () => {
    expect(renderLanguage("sl")).toBe("sl");
    expect(renderLanguage("en")).toBe("en");
    // Anything else falls back to the default rather than throwing a raw key
    // onto a signed page — and `report_render.language`'s CHECK stops the value
    // from being stored at all (О-14).
    expect(renderLanguage("de")).toBe("en");
    expect(renderLanguage(null)).toBe("en");
  });
});

// =============================================================================
// 7. THE DISCLOSURES — "not collected", never a silent skip
// =============================================================================

describe("REN-2 — a disclosure nobody answered is printed as `not collected`", () => {
  it.each(REPORT_LANGUAGES)(
    "marks the unanswered Basic metrics in %s",
    (locale) => {
      const text = textOf(sampleInput({ language: locale }));
      const notCollected = renderMessages(locale)["common.notCollected"];
      // The two unanswered metrics of the fixture are B8 (social) and B11
      // (governance) — К-26's reminder that a Basic report is not only climate.
      expect(text).toContain("Number of employees in head count");
      expect(text).toContain("Number of convictions");
      expect(text).toContain(notCollected);
    },
  );

  it("carries the social and governance disclosure codes into their own blocks", () => {
    const text = textOf(sampleInput());
    expect(text).toContain("B8 — Workforce — general characteristics");
    expect(text).toContain(
      "B11 — Convictions and fines for corruption and bribery",
    );
  });

  it("states the Scope 3 estimates are OUTSIDE the gross totals", () => {
    const text = textOf(sampleInput());
    const bundle = renderMessages("en");
    expect(text).toContain(bundle["scope3.method"]);
    expect(text).toContain(bundle["scope3.excludedFromTotals"]);
    expect(text).toContain("Categories covered by the estimate: 1.");
  });
});

// =============================================================================
// 8. AC-3 — THE BOUNDARY, WITH ITS REASONS
// =============================================================================

describe("AC-3 — an excluded legal entity appears in B1 with its reason", () => {
  it.each(REPORT_LANGUAGES)(
    "names the entity and prints the reason in %s",
    (locale) => {
      const input = sampleInput({ language: locale });
      const basis = buildSections(input).find(
        (section) => section.id === "basis",
      );
      if (!basis) throw new Error("no basis section");
      const text = sectionsToText([basis]);
      const excluded = input.scope[1];
      expect(text).toContain(excluded.name);
      expect(text).toContain(excluded.registeredAddress as string);
      expect(text).toContain(excluded.exclusionReason as string);
      expect(text).toContain(renderMessages(locale)["basis.status.excluded"]);
    },
  );
});

// =============================================================================
// 9. [LOCAL-DB] — `loadRenderInput` against real tables and a real run
// =============================================================================

describeIntegration("the renderer against a live revision", () => {
  setupDocumentsDir();

  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  /**
   * A company with two legal entities — one inside the boundary, one excluded
   * with a stated reason (AC-3) — a 2024 period, an approved gas row, an
   * approved electricity row, one answered disclosure, one evidence document
   * and one DQ assessment. Everything the report has a section for.
   */
  async function fixture() {
    const company = await insertCompany({ plan: "starter" });
    const inside = await insertLegalEntity(company.id, {
      name: "Alpsko Podjetje d.o.o.",
      country: "SI",
      reportingCurrency: "EUR",
      turnover: "5000000",
      registeredAddress: "Dunajska cesta 1, 1000 Ljubljana",
    });
    const outside = await insertLegalEntity(company.id, {
      name: "Jadran Logistika d.o.o.",
      country: "HR",
      registeredAddress: "Ilica 200, 10000 Zagreb",
      parentLegalEntityId: inside.id,
      groupStructureType: "subsidiary",
      ownershipPercentage: "35",
      consolidationMethod: "equity_share",
    });
    const site = await insertFacility(company.id, {
      legalEntityId: inside.id,
      country: "SI",
    });
    const { period } = await insertPeriod(company.id, {
      legalEntityId: inside.id,
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      reportingYear: 2024,
      reportingBasis: "consolidated",
    });
    const EXCLUSION_REASON =
      "Minority holding of 35% with no operational control; excluded from the consolidated boundary for FY2024.";
    await insertPeriodScope(company.id, {
      periodId: period.id,
      legalEntityId: outside.id,
      status: "excluded",
      exclusionReason: EXCLUSION_REASON,
    });
    const revision = await insertRevision(company.id, { periodId: period.id });

    const gas = await insertEmissionActivity(company.id, {
      revisionId: revision.id,
      legalEntityId: inside.id,
      facilityId: site.id,
      activityCategory: "stationary_combustion",
      activityType: "natural_gas",
      activityValue: "1000",
      unit: "kWh_gross",
      yearMonth: "2024-03",
      state: "approved",
    });
    await insertEnergyActivity(company.id, {
      revisionId: revision.id,
      legalEntityId: inside.id,
      facilityId: site.id,
      energyType: "electricity",
      consumption: "1000",
      unit: "kWh",
      renewableShare: "40",
      yearMonth: "2024-03",
      state: "approved",
      supplier: null,
    });
    const disclosure = await insertDisclosure(company.id, {
      revisionId: revision.id,
      legalEntityId: inside.id,
      valueText: "OPTION A: Basic module only",
      state: "approved",
    });
    const doc = await insertDocument(company.id, {
      fileName: "gas-invoice-2024.pdf",
    });
    await insertEvidenceLink(company.id, {
      documentId: doc.id,
      linkedObjectType: "emission_activity",
      linkedObjectId: gas.id,
    });
    await insertDq(company.id, {
      objectType: "emission_activity",
      objectId: gas.id,
      qualityTier: "high_primary",
    });

    return {
      company,
      inside,
      outside,
      period,
      revision,
      disclosure,
      doc,
      EXCLUSION_REASON,
    };
  }

  /** The revision row as Drizzle sees it — `loadRenderInput` takes that shape. */
  async function revisionRow(companyId: string, revisionId: string) {
    const [row] = await getTestDb()
      .select()
      .from(reportRevision)
      .where(
        and(
          eq(reportRevision.companyId, companyId),
          eq(reportRevision.id, revisionId),
        ),
      );
    if (!row) throw new Error("no revision");
    return row;
  }

  it("renders a real revision in both REPORT_LANGUAGES, with every section present", async () => {
    const f = await fixture();
    const db = getTestDb();
    const row = await revisionRow(f.company.id, f.revision.id);
    const run = await calculateRevision(db, f.company.id, row);
    expect(run.ok).toBe(true);

    for (const locale of REPORT_LANGUAGES) {
      const input = await loadRenderInput(db, f.company.id, row, {
        language: locale,
        coverage: FULL,
      });
      expect(input).not.toBeNull();
      if (!input) throw new Error("no input");
      expect(input.language).toBe(locale);

      const render = await renderVsmeBasicPdf(input);
      expect(render.language).toBe(locale);
      expect(render.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(render.pdf.byteLength).toBeGreaterThan(1000);
      const missing = sectionHeadings(locale).filter(
        (heading) => !render.text.includes(heading),
      );
      expect(missing).toEqual([]);
    }
  });

  it("puts the excluded legal entity in B1 with its reason (AC-3)", async () => {
    const f = await fixture();
    const db = getTestDb();
    const row = await revisionRow(f.company.id, f.revision.id);
    await calculateRevision(db, f.company.id, row);

    const input = await loadRenderInput(db, f.company.id, row, {
      language: "en",
      coverage: FULL,
    });
    if (!input) throw new Error("no input");

    const excluded = input.scope.find(
      (entry) => entry.legalEntityId === f.outside.id,
    );
    expect(excluded?.status).toBe("excluded");
    expect(excluded?.exclusionReason).toBe(f.EXCLUSION_REASON);
    expect(excluded?.isSubsidiary).toBe(true);

    const basis = buildSections(input).find(
      (section) => section.id === "basis",
    );
    if (!basis) throw new Error("no basis section");
    const text = sectionsToText([basis]);
    expect(text).toContain(f.outside.name);
    expect(text).toContain(f.EXCLUSION_REASON);
    expect(text).toContain("Ilica 200, 10000 Zagreb");
  });

  it("reads the catalogue, not the answers — an unanswered metric says `not collected`", async () => {
    const f = await fixture();
    const db = getTestDb();
    const row = await revisionRow(f.company.id, f.revision.id);
    const input = await loadRenderInput(db, f.company.id, row, {
      language: "en",
      coverage: FULL,
    });
    if (!input) throw new Error("no input");

    // The seeded Basic catalogue is 70 metrics across B1…B11; exactly one of
    // them is answered by the fixture.
    expect(input.disclosures.length).toBeGreaterThan(40);
    const answered = input.disclosures.filter((row) => row.value !== null);
    expect(answered).toHaveLength(1);

    const codes = new Set(input.disclosures.map((row) => row.disclosureCode));
    for (const code of ["B1", "B2", "B8", "B9", "B10", "B11"]) {
      expect(codes.has(code), code).toBe(true);
    }

    const text = sectionsToText(buildSections(input));
    expect(text).toContain(renderMessages("en")["common.notCollected"]);
    // Every unanswered metric's TITLE is on the page — nothing is skipped.
    const unanswered = input.disclosures.filter((row) => row.value === null);
    const absent = unanswered.filter((row) => !text.includes(row.title));
    expect(absent.map((row) => row.metricKey)).toEqual([]);
  });

  it("carries the run's figures, evidence and data quality into the report", async () => {
    const f = await fixture();
    const db = getTestDb();
    const row = await revisionRow(f.company.id, f.revision.id);
    await calculateRevision(db, f.company.id, row);

    const input = await loadRenderInput(db, f.company.id, row, {
      language: "en",
      coverage: FULL,
    });
    if (!input) throw new Error("no input");

    expect(input.run?.status).toBe("ok");
    expect(input.aggregates?.totals.scope1Co2e).not.toBeNull();
    expect(input.factorSet?.sources.length).toBeGreaterThan(0);
    expect(input.evidence).toHaveLength(1);
    expect(input.evidence[0]?.fileName).toBe("gas-invoice-2024.pdf");
    expect(input.dataQuality.assessedCount).toBe(1);
    expect(input.dataQuality.byTier.high_primary).toBe(1);

    // AC-4 against the live data: one category has rows, four do not.
    const withRows = input.scope1Categories.filter((c) => c.rowCount > 0);
    expect(withRows.map((c) => c.category)).toEqual(["stationary_combustion"]);
    expect(input.scope1Categories).toHaveLength(5);

    const text = sectionsToText(buildSections(input));
    expect(text).toContain("gas-invoice-2024.pdf");
    expect(text).not.toContain(renderMessages("en")["common.notCalculated"]);
  });

  it("renders a revision that was never calculated without inventing zeros", async () => {
    const f = await fixture();
    const db = getTestDb();
    const row = await revisionRow(f.company.id, f.revision.id);

    const input = await loadRenderInput(db, f.company.id, row, {
      language: "en",
      coverage: FULL,
    });
    if (!input) throw new Error("no input");
    expect(input.run).toBeNull();
    expect(input.aggregates).toBeNull();

    const render = await renderVsmeBasicPdf(input);
    expect(render.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(render.text).toContain(renderMessages("en")["executive.noRun"]);
    expect(render.text).not.toMatch(/\b0([.,]0+)?\s*(t CO2e|MWh)\b/);
  });
});
