// =============================================================================
// `dashboard.*` PARITY AND COMPLETENESS (T5.9 acceptance).
//
// WHY A SUITE OF ITS OWN WHEN `shared/__tests__/i18n-parity.test.ts` ALREADY
// COMPARES THE WHOLE FILE. That test proves the two files carry the same KEYS,
// which is necessary and not sufficient here. The KPI block renders three closed
// vocabularies straight off the wire — the five tiles, the two statuses a
// published revision can be in, and CALC-6's three staleness sources — and the
// staleness one is looked up with a `t.has()` fallback to the raw token, so a
// missing key does not fail: it prints `period_scope` at a user, identically in
// both locales, and whole-file parity stays green. The vocabularies are
// therefore checked against their SOURCE lists, which are code constants.
//
// AND TWO VALUE CHECKS, because this screen's words carry the acceptance
// criterion. "A company with no approved run sees a state that is NOT zeros" is
// a claim about a SENTENCE, and a sentence that has been keyed but not written
// would pass every structural test in this repository.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// The vocabularies below are SERVER constants, and importing them is the whole
// point: a list re-typed on this side would drift from the one the API answers
// with, which is exactly the failure this file exists to catch. They are plain
// `const` arrays, but their modules carry `server-only`, so the guard is stubbed
// the same way every integration suite in this repository stubs it.
vi.mock("server-only", () => ({}));

import { RUN_STALENESS_SOURCES } from "@/server/calc/run";
import {
  DASHBOARD_EMISSION_STATES,
  PUBLISHED_STATUSES,
} from "@/server/dashboard/dashboard";

import { KPI_KEYS, KPI_UNITS } from "../kpi";

const REPO_ROOT = path.resolve(__dirname, "../../../../../../..");

/**
 * Keys whose Slovenian value is legitimately the English one: the unit labels.
 * `t CO₂e`, `MWh` and `t CO₂e / EUR` are SI and IPCC notation, identical in both
 * locales, and an exact list of keys keeps adding to it a deliberate act.
 */
const IDENTICAL_BY_DESIGN = KPI_UNITS.map(
  (unit) => `dashboard.emissions.units.${unit}`,
);

type Messages = Record<string, unknown>;

function load(locale: string): Messages {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, "messages", `${locale}.json`), "utf8"),
  ) as Messages;
}

/** Every leaf VALUE of a message tree, by dotted key (strings only). */
function flattenValues(node: unknown, prefix = ""): Record<string, string> {
  if (typeof node === "string") return prefix ? { [prefix]: node } : {};
  if (!node || typeof node !== "object" || Array.isArray(node)) return {};
  return Object.entries(node as Messages).reduce<Record<string, string>>(
    (acc, [key, value]) =>
      Object.assign(
        acc,
        flattenValues(value, prefix ? `${prefix}.${key}` : key),
      ),
    {},
  );
}

const en = flattenValues(load("en"));
const sl = flattenValues(load("sl"));
const keys = Object.keys(en).filter((key) => key.startsWith("dashboard."));

describe("dashboard.* parity", () => {
  it("exists at all", () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it("has no key that exists only in English", () => {
    expect(keys.filter((key) => !(key in sl))).toEqual([]);
  });

  it("has no key that exists only in Slovenian", () => {
    const slKeys = Object.keys(sl).filter((key) =>
      key.startsWith("dashboard."),
    );
    expect(slKeys.filter((key) => !(key in en))).toEqual([]);
  });

  it("has no empty message in either locale", () => {
    expect(keys.filter((key) => en[key].trim() === "")).toEqual([]);
    expect(keys.filter((key) => (sl[key] ?? "").trim() === "")).toEqual([]);
  });

  it("has no Slovenian value copied verbatim from the English one", () => {
    expect(
      keys.filter(
        (key) => en[key] === sl[key] && !IDENTICAL_BY_DESIGN.includes(key),
      ),
    ).toEqual([]);
  });
});

describe("dashboard.emissions.* — no wire token can reach a user", () => {
  const bothHave = (list: readonly string[]) =>
    list.filter((key) => !(key in en) || !(key in sl));

  it("labels every KPI tile the block renders", () => {
    expect(
      bothHave([
        ...KPI_KEYS.map((key) => `dashboard.emissions.kpi.${key}`),
        "dashboard.emissions.kpi.coverage",
      ]),
    ).toEqual([]);
  });

  it("names every unit a tile can print", () => {
    expect(
      bothHave(KPI_UNITS.map((unit) => `dashboard.emissions.units.${unit}`)),
    ).toEqual([]);
  });

  it("names both statuses a published revision can be in (UI-6)", () => {
    expect(
      bothHave(
        PUBLISHED_STATUSES.map(
          (status) => `dashboard.emissions.revisionStatus.${status}`,
        ),
      ),
    ).toEqual([]);
  });

  it("explains every CALC-6 staleness source", () => {
    // The one vocabulary rendered with a `t.has()` fallback — without this
    // check, a missing key prints `period_scope` at a user in both locales.
    expect(
      bothHave(
        RUN_STALENESS_SOURCES.map(
          (source) => `dashboard.emissions.staleSource.${source}`,
        ),
      ),
    ).toEqual([]);
  });

  it("has a sentence for every state the block can be in", () => {
    // `ok` is the state that shows figures and needs no sentence; the other
    // three each have one, and a fifth state added to the union without copy
    // would fail here rather than render a blank card.
    const copyFor: Record<string, string | null> = {
      ok: null,
      stale: "dashboard.emissions.stale",
      failed: "dashboard.emissions.failed",
      no_run: "dashboard.emissions.noRun",
    };
    const named = DASHBOARD_EMISSION_STATES.map((state) => copyFor[state]);
    expect(named.filter((key) => key === undefined)).toEqual([]);
    expect(
      bothHave(named.filter((key): key is string => typeof key === "string")),
    ).toEqual([]);
  });
});

describe("dashboard.emissions.* says the things T5.9 is about", () => {
  it("tells a company with nothing approved that there is NO FIGURE, not a zero", () => {
    for (const messages of [en, sl]) {
      // The acceptance criterion in words. It is not enough for the key to
      // exist: the sentence has to be the one that stops a reader concluding
      // their emissions are nil, so it is required to be a real explanation
      // rather than a two-word placeholder.
      expect(
        messages["dashboard.emissions.noApprovedBody"].length,
      ).toBeGreaterThan(80);
      expect(messages["dashboard.emissions.noFigure"].length).toBeGreaterThan(
        5,
      );
      expect(messages["dashboard.emissions.noFigure"]).not.toMatch(/[0-9]/);
    }
  });

  it("words the failed-run sentence with the number of lines to fix", () => {
    for (const messages of [en, sl]) {
      expect(messages["dashboard.emissions.failed"]).toContain("plural");
      expect(messages["dashboard.emissions.failed"]).toContain("{count");
    }
  });

  it("names what moved in the stale sentence", () => {
    for (const messages of [en, sl]) {
      expect(messages["dashboard.emissions.stale"]).toContain("{sources}");
    }
  });

  it("words coverage as a fraction of the registry, in both locales", () => {
    for (const messages of [en, sl]) {
      for (const key of [
        "dashboard.emissions.coverage.legalEntities",
        "dashboard.emissions.coverage.facilities",
      ]) {
        expect(messages[key]).toContain("{included}");
        expect(messages[key]).toContain("{total}");
      }
    }
  });
});
