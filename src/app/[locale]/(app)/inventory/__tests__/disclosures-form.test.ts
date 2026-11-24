// =============================================================================
// THE DISCLOSURE FORM, PINNED AGAINST THE REAL 141-METRIC CATALOGUE (T3.5b).
//
// ─── WHY THIS IS A `.test.ts` AND NOT THE `.test.tsx` THE PLAN NAMED ─────────
//
// The suite is `environment: "node"` and `include: ["src/**/__tests__/**/
// *.test.ts"]`: there is no jsdom, no React testing library, and adding one is
// not this task's business. So the same move `../_lib/__tests__/actions.test.ts`
// made for the approve button is made again, one level up: every decision this
// screen could get WRONG is a pure function of catalogue data
// (`../disclosures/_lib/catalog`), the components hold exactly one reference to
// each, and the functions are pinned here against the catalogue the product
// actually ships — read FROM POSTGRES, not from a three-metric fixture.
//
// WHAT THIS PROVES:
//   • every `value_type` the catalogue uses has a control, and every one of the
//     12 `DataType`s has one — failing BY NAME on a type without a renderer;
//   • the client's DM-19 placement map is IDENTICAL to the server's, and a
//     metric with `breakdown_dimensions` is placed in `value_json` whatever its
//     scalar type says;
//   • every `disclosure_code` of the catalogue lands in a section — B1…B11 and
//     C1…C9 alike, so no disclosure is left without a screen;
//   • a breakdown metric composes ONE `value_json` of `{total, breakdown}` and
//     never a number (the write the server refuses 422, T3.3);
//   • an unanswered mandatory metric is `not_collected`, not absent; a
//     Comprehensive metric without the entitlement is `not_applicable` and
//     locked; `false` and `0` read as answers, not as blanks;
//   • `disclosures.*` says the same things in both locales.
//
// WHAT IT CANNOT PROVE, and this is the honest limit of a DOM-less suite:
//   • that the control chosen is actually RENDERED — `ValueControl`'s `switch`
//     is exhaustive over `ControlKind` (the compiler checks that), but nothing
//     here mounts it, so a control that renders blank, an `<input>` with the
//     wrong `type`, or a disabled `fieldset` that is not in fact disabled would
//     pass;
//   • that the Save button is hidden without `data.write` — `rowActionGates` is
//     pinned by `../_lib/__tests__/actions.test.ts` over the whole capability
//     matrix, but the fact that the CARD asks it exactly once is review, not a
//     test;
//   • that the upgrade CTA is on screen for a locked metric — only that the
//     state derivation says `not_applicable` and that `moduleAvailable` is false;
//   • the end-to-end refusals themselves (422 for a breakdown sent as a number,
//     422 for a Comprehensive metric on `starter`). Those belong to the API and
//     are proven where they can be proven, against a live database, in
//     `src/app/api/disclosures/__tests__/disclosures.integration.test.ts`.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `@/server/inventory/disclosures` is imported for ONE reason — to compare the
// client's DM-19 placement map with the server's own — and its transitive
// imports reach the `server-only` marker and the db singleton. Both are neutered
// the way every other suite that loads server code does it: the marker becomes
// an empty module, and `@/server/db` becomes the harness's test connection. No
// query is issued through it here.
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return harness.testDbModule();
});

import { metricCatalog } from "@/server/db/schema";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { VALUE_FIELD_BY_TYPE as SERVER_VALUE_FIELD_BY_TYPE } from "@/server/inventory/disclosures";
import type { MetricDto } from "@/server/factors/reference";
import ESRS_METRICS from "@/server/db/seed-data/esrs-metrics.json";
import { VSME_METRICS } from "@/server/db/seed-data/vsme-metrics";
import { DATA_TYPES, type DataType } from "@/shared/enums";

import {
  CONTROL_BY_TYPE,
  DISCLOSURE_STATES,
  VALUE_FIELD_BY_TYPE,
  breakdownSpec,
  comprehensiveWritable,
  controlFor,
  draftOf,
  filledField,
  metricState,
  moduleAvailable,
  recordsByMetric,
  sectionSummary,
  simplifiedEsrsWritable,
  sectionsOf,
  valueBody,
  visibleMetrics,
  type MetricControl,
  type ValueDraft,
} from "../disclosures/_lib/catalog";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");

/** Basic B1…B11 — the disclosures `T5.6` prints for every VSME report. */
const BASIC_CODES = [
  "B1",
  "B2",
  "B3",
  "B4",
  "B5",
  "B6",
  "B7",
  "B8",
  "B9",
  "B10",
  "B11",
] as const;

/** A `disclosure_record` DTO's value half, with everything empty. */
const NO_VALUE = {
  value_numeric: null,
  value_text: null,
  value_boolean: null,
  value_date: null,
  value_json: null,
};

/** The seed JSON as `MetricDto`s — the DB-less half of every property below. */
const SEEDED: MetricDto[] = VSME_METRICS.map((metric) => ({
  ...metric,
  breakdown_dimensions: metric.breakdown_dimensions,
  // 0017–0019 columns; the seed JSON predates them and the form ignores them.
  title_sl: null,
  disclosure_title_sl: null,
  esrs_reference: null,
  esrs_applicability: null,
  client_data_source: null,
  official_source: null,
}));

/** A draft filled the way each control fills it — the composer's input. */
function filledDraft(control: MetricControl): ValueDraft {
  if (control.kind === "breakdown") {
    return {
      text: "12",
      lines: "",
      rows: [
        {
          dimension: control.breakdown?.dimensions[0] ?? "",
          label: "grid",
          amount: "5",
        },
      ],
    };
  }
  if (control.kind === "codeList") return { text: "", lines: "A\nB", rows: [] };
  if (control.kind === "boolean") return { text: "true", lines: "", rows: [] };
  if (control.kind === "date") {
    return { text: "2024-01-31", lines: "", rows: [] };
  }
  if (
    control.kind === "decimal" ||
    control.kind === "integer" ||
    control.kind === "percentage"
  ) {
    return { text: "12", lines: "", rows: [] };
  }
  return { text: "an answer", lines: "", rows: [] };
}

// ─── The properties, stated once and run over two derivations ────────────────

/**
 * Everything the acceptance of T3.5b asks about the catalogue, as one function.
 *
 * It runs TWICE: over the committed seed (`vsme-metrics.json`, so the properties
 * hold on every commit, DB or no DB) and over the rows Postgres actually holds
 * after `db:migrate` + `db:seed` — which is the [LOCAL-DB] half and the one that
 * catches a migration that seeded the catalogue differently from the file.
 */
function catalogueProperties(name: string, load: () => MetricDto[]) {
  describe(`${name}: the form against the catalogue`, () => {
    it("has a control for every value_type the catalogue uses", () => {
      const metrics = load();
      expect(metrics.length).toBeGreaterThan(0);

      // The failure NAMES the type and a metric that carries it — the guard
      // against "we did Decimal and Text, the rest later".
      const unsupported = metrics
        .filter((metric) => controlFor(metric) === null)
        .map((metric) => `${metric.metric_key}:${metric.value_type}`);
      expect(unsupported).toEqual([]);

      const used = [...new Set(metrics.map((m) => m.value_type))].sort();
      const withoutControl = used.filter((type) => !(type in CONTROL_BY_TYPE));
      expect(withoutControl).toEqual([]);
    });

    it("places every value where the SERVER's DM-19 map places it", () => {
      for (const metric of load()) {
        const control = controlFor(metric);
        expect(control).not.toBeNull();
        const spec = breakdownSpec(metric.breakdown_dimensions);
        // S1/DM-19 — a breakdown metric overrides the type→column map.
        const expected = spec
          ? "value_json"
          : SERVER_VALUE_FIELD_BY_TYPE[control!.valueType];
        expect({ key: metric.metric_key, field: control!.field }).toEqual({
          key: metric.metric_key,
          field: expected,
        });
      }
    });

    it("gives every disclosure_code a section, B1…B11 included", () => {
      const metrics = load();
      const sections = sectionsOf(metrics);
      const covered = new Set(sections.map((section) => section.code));

      const codes = [...new Set(metrics.map((m) => m.disclosure_code))];
      const uncovered = codes.filter((code) => !covered.has(code));
      expect(uncovered).toEqual([]);
      for (const code of BASIC_CODES) expect(covered.has(code)).toBe(true);

      // Every metric reaches exactly one section, and the sections are in the
      // workbook's own order (`sort_order`).
      const placed = sections.flatMap((section) =>
        section.metrics.map((m) => m.metric_key),
      );
      expect(placed.length).toBe(metrics.length);
      expect(new Set(placed).size).toBe(metrics.length);
      const orders = sections.map((section) => section.sortOrder);
      expect([...orders].sort((a, b) => a - b)).toEqual(orders);
      for (const section of sections) {
        const inner = section.metrics.map((m) => m.sort_order);
        expect([...inner].sort((a, b) => a - b)).toEqual(inner);
      }
    });

    it("composes exactly one value field for every metric", () => {
      for (const metric of load()) {
        const control = controlFor(metric)!;
        const composed = valueBody(control, filledDraft(control));
        expect(composed.ok).toBe(true);
        if (!composed.ok) continue;
        expect(Object.keys(composed.body)).toEqual([control.field]);
      }
    });

    it("sends a metric with breakdown_dimensions as one value_json", () => {
      const metrics = load();
      const withBreakdown = metrics.filter((metric) =>
        breakdownSpec(metric.breakdown_dimensions),
      );
      // The seeded catalogue carries seven of them (B3 §29, energy source).
      expect(withBreakdown.length).toBeGreaterThan(0);

      for (const metric of withBreakdown) {
        const control = controlFor(metric)!;
        expect(control.kind).toBe("breakdown");
        const composed = valueBody(control, {
          text: "120.5",
          lines: "",
          rows: [
            {
              dimension: control.breakdown!.dimensions[0],
              label: "solar",
              amount: "20",
            },
            {
              dimension: control.breakdown!.dimensions[0],
              label: "wind",
              amount: "100.5",
            },
          ],
        });
        expect(composed.ok).toBe(true);
        if (!composed.ok) continue;
        // ONE field, and the total is a JSON NUMBER beside its split — never a
        // number in `value_numeric` with the split somewhere else (DM-19).
        expect(Object.keys(composed.body)).toEqual(["value_json"]);
        expect(composed.body.value_json).toEqual({
          total: 120.5,
          breakdown: {
            [control.breakdown!.dimensions[0]]: { solar: 20, wind: 100.5 },
          },
        });
        expect(typeof composed.body.value_numeric).toBe("undefined");

        // …and it survives a round trip through a stored record, which is what
        // makes an EDIT an edit rather than an overwrite.
        const draft = draftOf(control, {
          ...NO_VALUE,
          value_json: composed.body.value_json,
        });
        expect(valueBody(control, draft)).toEqual(composed);
      }
    });

    it("shows an unanswered mandatory metric as not collected", () => {
      const metrics = load();
      const mandatory = metrics.filter(
        (metric) => metric.requirement_type === "mandatory",
      );
      expect(mandatory.length).toBeGreaterThan(0);
      for (const metric of mandatory) {
        expect(metricState({ metric, record: null, comprehensive: true })).toBe(
          "not_collected",
        );
      }

      // And it is still on the screen: the section it belongs to counts it.
      const sections = sectionsOf(metrics);
      const totals = sections.reduce(
        (sum, section) =>
          sum + sectionSummary(section, () => null, true).not_collected,
        0,
      );
      expect(totals).toBe(metrics.length);
    });

    it("locks Comprehensive metrics without the entitlement (PG-6)", () => {
      const metrics = load();
      const comprehensive = metrics.filter((m) => m.module === "comprehensive");
      const basic = metrics.filter((m) => m.module === "basic");
      expect(comprehensive.length).toBeGreaterThan(0);
      expect(basic.length).toBeGreaterThan(0);

      for (const metric of comprehensive) {
        expect(moduleAvailable(metric.module, false)).toBe(false);
        expect(
          metricState({ metric, record: null, comprehensive: false }),
        ).toBe("not_applicable");
        // Entitled, the very same metric is an ordinary unanswered datapoint.
        expect(metricState({ metric, record: null, comprehensive: true })).toBe(
          "not_collected",
        );
      }
      for (const metric of basic) {
        expect(moduleAvailable(metric.module, false)).toBe(true);
        expect(
          metricState({ metric, record: null, comprehensive: false }),
        ).toBe("not_collected");
      }
    });
  });
}

catalogueProperties("the seeded catalogue", () => SEEDED);

// ─── [LOCAL-DB]: the same properties over the rows Postgres holds ────────────

describeIntegration("[LOCAL-DB] the catalogue as the database holds it", () => {
  let rows: MetricDto[] = [];

  beforeAll(async () => {
    await setupSchema();
    const db = getTestDb();
    const stored = await db
      .select()
      .from(metricCatalog)
      .where(eq(metricCatalog.standard, "vsme")) // 0019 adds ESRS rows beside these
      .orderBy(asc(metricCatalog.sortOrder), asc(metricCatalog.metricKey));
    rows = stored.map((row) => ({
      metric_key: row.metricKey,
      standard: row.standard,
      pillar: row.pillar,
      module: row.module,
      disclosure_code: row.disclosureCode,
      disclosure_title: row.disclosureTitle,
      disclosure_title_en: row.disclosureTitleEn,
      paragraph: row.paragraph,
      requirement_type: row.requirementType,
      title: row.title,
      title_en: row.titleEn,
      description: row.description,
      unit: row.unit,
      applicability_condition: row.applicabilityCondition,
      value_type: row.valueType,
      breakdown_dimensions: row.breakdownDimensions,
      guidance: row.guidance,
      sort_order: row.sortOrder,
      is_active: row.isActive,
      title_sl: row.titleSl,
      disclosure_title_sl: row.disclosureTitleSl,
      esrs_reference: row.esrsReference,
      esrs_applicability: row.esrsApplicability,
      client_data_source: row.clientDataSource,
      official_source: row.officialSource,
    }));
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("holds the catalogue this screen is generated from", () => {
    // The seed is what production gets by migration (О-13); if the table were
    // empty every property below would pass vacuously.
    expect(rows.length).toBe(VSME_METRICS.length);
  });

  catalogueProperties("the stored catalogue", () => rows);
});

// ─── The decisions that do not need a catalogue ──────────────────────────────

describe("the renderer map covers all 12 DataTypes", () => {
  it("names a control for each of them", () => {
    const missing = DATA_TYPES.filter((type) => !CONTROL_BY_TYPE[type]);
    expect(missing).toEqual([]);
    expect(Object.keys(CONTROL_BY_TYPE).sort()).toEqual([...DATA_TYPES].sort());
  });

  it("agrees with the SERVER about which column each type writes", () => {
    // The client copy exists because importing the server module would drag
    // drizzle into the browser bundle. This is what keeps the copy honest.
    expect(VALUE_FIELD_BY_TYPE).toEqual(SERVER_VALUE_FIELD_BY_TYPE);
  });

  it("draws string and text differently, and reads datetime as a date", () => {
    // The three pairs the header of `catalog.ts` explains: same column, and in
    // one case the same control.
    expect(CONTROL_BY_TYPE.string).not.toBe(CONTROL_BY_TYPE.text);
    expect(CONTROL_BY_TYPE.datetime).toBe(CONTROL_BY_TYPE.date);
    expect(CONTROL_BY_TYPE.enum).toBe(CONTROL_BY_TYPE.reference);
    expect(CONTROL_BY_TYPE.multi_enum).toBe(CONTROL_BY_TYPE.multi_reference);
  });

  it("composes each of the 12 into the column DM-19 assigns it", () => {
    for (const valueType of DATA_TYPES) {
      const control = controlFor({
        metric_key: `synthetic-${valueType}`,
        value_type: valueType,
        breakdown_dimensions: null,
      });
      expect(control).not.toBeNull();
      const composed = valueBody(control!, filledDraft(control!));
      expect(composed.ok).toBe(true);
      if (!composed.ok) continue;
      expect(Object.keys(composed.body)).toEqual([
        SERVER_VALUE_FIELD_BY_TYPE[valueType as DataType],
      ]);
    }
  });

  it("refuses to guess a control for a value_type outside the 12", () => {
    expect(
      controlFor({
        metric_key: "corrupt",
        value_type: "colour",
        breakdown_dimensions: null,
      }),
    ).toBeNull();
  });
});

describe("the three states", () => {
  const metric = { module: "basic" };

  it("is exactly the set T5.6 prints", () => {
    expect([...DISCLOSURE_STATES]).toEqual([
      "filled",
      "not_collected",
      "not_applicable",
    ]);
  });

  it("counts false and 0 as answers, and NULL as the only emptiness", () => {
    expect(
      metricState({
        metric,
        record: { ...NO_VALUE, value_boolean: false },
        comprehensive: true,
      }),
    ).toBe("filled");
    expect(
      metricState({
        metric,
        record: { ...NO_VALUE, value_numeric: 0 },
        comprehensive: true,
      }),
    ).toBe("filled");
    expect(metricState({ metric, record: NO_VALUE, comprehensive: true })).toBe(
      "not_collected",
    );
    expect(filledField({ ...NO_VALUE, value_boolean: false })).toBe(
      "value_boolean",
    );
    expect(filledField(null)).toBeNull();
    // Two non-empty fields cannot be written through the API (DM-19); read back,
    // they are "no single answer" rather than one picked arbitrarily.
    expect(
      filledField({ ...NO_VALUE, value_numeric: 1, value_text: "x" }),
    ).toBeNull();
  });

  it("mirrors the server's writeFeatures, not the plan name (PG-6)", () => {
    const features = { vsmeComprehensive: true };
    expect(comprehensiveWritable({ features, mode: "active" })).toBe(true);
    // A lapsed subscription writes at trial level (§9) — the same rule
    // `getEntitlements` applies, so the screen cannot offer a write the server
    // would refuse.
    expect(comprehensiveWritable({ features, mode: "readonly" })).toBe(false);
    expect(comprehensiveWritable({ features, mode: "locked" })).toBe(false);
    expect(
      comprehensiveWritable({
        features: { vsmeComprehensive: false },
        mode: "active",
      }),
    ).toBe(false);
  });
});

describe("a record answers one metric of one entity", () => {
  const record = (over: Record<string, unknown>) =>
    ({
      id: "r1",
      legal_entity_id: "entity-a",
      metric_key: "VSME-001",
      ...NO_VALUE,
      ...over,
    }) as never;

  it("indexes by metric within the entity being edited", () => {
    const records = [
      record({ id: "r1" }),
      record({ id: "r2", legal_entity_id: "entity-b" }),
      record({ id: "r3", metric_key: "VSME-002" }),
    ];
    const mine = recordsByMetric(records, "entity-a");
    expect([...mine.keys()].sort()).toEqual(["VSME-001", "VSME-002"]);
    expect(mine.get("VSME-001")!.map((r) => r.id)).toEqual(["r1"]);
    expect(recordsByMetric(records, "entity-b").get("VSME-001")![0].id).toBe(
      "r2",
    );
  });

  it("keeps a retired metric on screen while an answer exists for it", () => {
    const retired = SEEDED[0];
    const metrics = [{ ...retired, is_active: false }];
    expect(visibleMetrics(metrics, new Set())).toEqual([]);
    expect(visibleMetrics(metrics, new Set([retired.metric_key]))).toHaveLength(
      1,
    );
  });
});

describe("the composer never refuses a value the server would accept", () => {
  const decimal = controlFor({
    metric_key: "d",
    value_type: "decimal",
    breakdown_dimensions: null,
  })!;
  const breakdown = controlFor({
    metric_key: "b",
    value_type: "decimal",
    breakdown_dimensions: {
      if_obtainable: true,
      dimensions: ["energy_source"],
    },
  })!;

  it("passes a numeric answer through untouched — the server types it", () => {
    // `12,5` is not a decimal; the SERVER says so (`decimalOrNull` → 422 on the
    // field). The client does not pre-empt that judgement (VR-2).
    expect(valueBody(decimal, { text: "12,5", lines: "", rows: [] })).toEqual({
      ok: true,
      body: { value_numeric: "12,5" },
    });
  });

  it("reports an empty draft as nothing to send, not as a bad value", () => {
    expect(valueBody(decimal, { text: "  ", lines: "", rows: [] })).toEqual({
      ok: false,
      fault: "empty",
    });
    expect(valueBody(breakdown, { text: "", lines: "", rows: [] })).toEqual({
      ok: false,
      fault: "empty",
    });
  });

  it("omits an empty breakdown — 'if obtainable' makes a total a full answer", () => {
    expect(valueBody(breakdown, { text: "7", lines: "", rows: [] })).toEqual({
      ok: true,
      body: { value_json: { total: 7 } },
    });
    // A row still being typed is not a part.
    expect(
      valueBody(breakdown, {
        text: "7",
        lines: "",
        rows: [{ dimension: "energy_source", label: "", amount: "" }],
      }),
    ).toEqual({ ok: true, body: { value_json: { total: 7 } } });
  });

  it("insists on the total, because that is the figure the report prints", () => {
    expect(
      valueBody(breakdown, {
        text: "",
        lines: "",
        rows: [{ dimension: "energy_source", label: "solar", amount: "3" }],
      }),
    ).toEqual({ ok: false, fault: "total_required" });
  });

  it("cannot compose a JSON number out of prose", () => {
    expect(
      valueBody(breakdown, { text: "about ten", lines: "", rows: [] }),
    ).toEqual({ ok: false, fault: "not_a_number" });
  });
});

// ─── i18n (§0.5 — [+i18n] means BOTH locales) ────────────────────────────────

describe("disclosures.* i18n", () => {
  const load = (locale: string) =>
    JSON.parse(
      readFileSync(path.join(REPO_ROOT, "messages", `${locale}.json`), "utf8"),
    ) as Record<string, Record<string, unknown>>;

  const flatten = (node: unknown, prefix = ""): string[] => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return prefix ? [prefix] : [];
    }
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      flatten(v, prefix ? `${prefix}.${k}` : k),
    );
  };

  const en = load("en");
  const sl = load("sl");

  it("says the same things in both locales", () => {
    expect(flatten(en.disclosures).sort()).toEqual(
      flatten(sl.disclosures).sort(),
    );
    expect(flatten(en.disclosures).length).toBeGreaterThan(0);
    expect(typeof en.nav.disclosures).toBe("string");
    expect(typeof sl.nav.disclosures).toBe("string");
  });

  it("localises the three states and the section chrome", () => {
    const state = en.disclosures.state as Record<string, string>;
    for (const key of DISCLOSURE_STATES) {
      expect(typeof state[key]).toBe("string");
      expect((sl.disclosures.state as Record<string, string>)[key]).toBeTypeOf(
        "string",
      );
      // An untranslated stub passes a key-set check while being, to a Slovenian
      // user, exactly the English string the check was meant to catch.
      expect((sl.disclosures.state as Record<string, string>)[key]).not.toBe(
        state[key],
      );
    }
  });

  it("leaves the metric texts to the catalogue", () => {
    // О-20: the metric's own words are the standard's (`title_en`) and the
    // workbook's (`title`); the app does not keep a second copy of 141 labels.
    const keys = flatten(en.disclosures);
    const metricKeys = keys.filter((key) => /VSME-\d/.test(key));
    expect(metricKeys).toEqual([]);
    // Партия 18 added a dozen SCREEN strings (how-to steps, «Use this», «Other…»);
    // the metric texts still live in `server/catalog/texts`, never here.
    expect(keys.length).toBeLessThan(100);
  });
});

// ─── Партия 9 — the simplified-ESRS module (0019 rows, 0021 flag) ────────────

describe("партия 9 — the simplified-ESRS layer is a second module gate", () => {
  /** The 50 ESRS-only rows as `MetricDto`s — the same shape `SEEDED` takes. */
  const ESRS: MetricDto[] = ESRS_METRICS.map((metric) => ({
    ...metric,
    breakdown_dimensions: metric.breakdown_dimensions,
    title_sl: null,
    disclosure_title_sl: null,
  }));

  it("every ESRS row has a control, so the form can draw all fifty", () => {
    expect(ESRS).toHaveLength(50);
    for (const metric of ESRS) {
      expect(metric.standard).toBe("esrs");
      expect(metric.module).toBe("simplified_esrs");
      expect(controlFor(metric), metric.metric_key).not.toBeNull();
    }
  });

  it("ESRS sections come after every VSME section, tagged with their standard", () => {
    const sections = sectionsOf([...SEEDED, ...ESRS]);
    const standards = sections.map((s) => s.standard);
    const firstEsrs = standards.indexOf("esrs");
    expect(firstEsrs).toBeGreaterThan(0);
    expect(standards.slice(0, firstEsrs).every((s) => s === "vsme")).toBe(true);
    expect(standards.slice(firstEsrs).every((s) => s === "esrs")).toBe(true);
    expect(sections.filter((s) => s.standard === "esrs")).toHaveLength(
      new Set(ESRS.map((m) => m.disclosure_code)).size,
    );
  });

  it("is locked unless the plan has the layer — independent of Comprehensive", () => {
    const metric = { module: "simplified_esrs" };
    // The third argument defaults to false: an old call site that never heard
    // of the layer locks it, which is the safe direction.
    expect(moduleAvailable("simplified_esrs", true)).toBe(false);
    expect(moduleAvailable("simplified_esrs", false, true)).toBe(true);
    expect(moduleAvailable("comprehensive", false, true)).toBe(false);
    expect(moduleAvailable("basic", false, false)).toBe(true);
    expect(metricState({ metric, record: null, comprehensive: true })).toBe(
      "not_applicable",
    );
    expect(
      metricState({
        metric,
        record: null,
        comprehensive: false,
        simplifiedEsrs: true,
      }),
    ).toBe("not_collected");
  });

  it("sectionSummary counts locked ESRS metrics as not applicable", () => {
    const [section] = sectionsOf(ESRS);
    const total = section.metrics.length;
    expect(sectionSummary(section, () => null, true).not_applicable).toBe(
      total,
    );
    expect(sectionSummary(section, () => null, false, true).not_collected).toBe(
      total,
    );
  });

  it("simplifiedEsrsWritable needs the feature AND an active subscription", () => {
    const features = { simplifiedEsrs: true };
    expect(simplifiedEsrsWritable({ features, mode: "active" })).toBe(true);
    expect(simplifiedEsrsWritable({ features, mode: "readonly" })).toBe(false);
    expect(simplifiedEsrsWritable({ features, mode: "locked" })).toBe(false);
    expect(
      simplifiedEsrsWritable({
        features: { simplifiedEsrs: false },
        mode: "active",
      }),
    ).toBe(false);
  });
});
