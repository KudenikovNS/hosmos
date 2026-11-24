// Unit tests for the VAL-* inventory, the evaluator registry and the locale
// coverage of the rule messages (T2.1 acceptance, §6.2, О-12, R-12, R-13).
//
// NO DATABASE IS TOUCHED HERE. Everything asserted is a property of constants:
// which codes exist, that each is either implemented or scheduled, and that both
// locales can render every one of them. That is deliberate — these are exactly
// the invariants that a DB-less CI must be able to break the build on.
import { readFileSync } from "node:fs";
import path from "node:path";

import { getTableName, is, Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";

import {
  assertEvaluatorCoverage,
  coverageProblems,
  EVALUATORS,
  PENDING_EVALUATORS,
} from "../registry";
import {
  findRule,
  rulesForScope,
  VALIDATION_RULES,
  VALIDATION_SCOPES,
  VALIDATION_SEVERITIES,
  type ValidationRule,
} from "../rules";

/**
 * The inventory seen through the §6.1 INTERFACE rather than through its literal
 * `as const` type. Structural assertions ("is this scope one of the four?",
 * "is `appliesTo` non-empty?") must be written against the widened type: on the
 * literal type TypeScript already knows the answer and helpfully turns the
 * check into a comparison it can prove is always false — a test that cannot
 * fail. Widening keeps the assertion about the DATA, which is the thing that
 * can drift.
 */
const RULES: readonly ValidationRule[] = VALIDATION_RULES;

/**
 * The Phase-1 inventory, transcribed BY HAND from spec §6.2 — 35 domain rules
 * (VAL-001…024, 031…041) plus 7 platform rules (VAL-101…107) = 42.
 *
 * VAL-107 is not a §6.2 cell: it is the factor-basis warning this engine added
 * with factor provenance, and it sits in К-11's platform range for the reason
 * `rules.ts` gives — VAL-042/043 are RESERVED for Phase 5's Targets and appear
 * in {@link EXCLUDED_CODES} below, so an engine rule that took one of them would
 * silently claim a code a later phase is owed.
 *
 * Written out literally rather than generated from a range: a generated list
 * would happily "confirm" whatever the array happens to contain, and the whole
 * point is to catch a code that was dropped, renamed or quietly added. The
 * excluded ranges (VAL-025…030 Scope 3, VAL-042/043 Targets — §6.3) are absent
 * from this list precisely because they must be absent from the array.
 */
const EXPECTED_CODES = [
  "VAL-001",
  "VAL-002",
  "VAL-003",
  "VAL-004",
  "VAL-005",
  "VAL-006",
  "VAL-007",
  "VAL-008",
  "VAL-009",
  "VAL-010",
  "VAL-011",
  "VAL-012",
  "VAL-013",
  "VAL-014",
  "VAL-015",
  "VAL-016",
  "VAL-017",
  "VAL-018",
  "VAL-019",
  "VAL-020",
  "VAL-021",
  "VAL-022",
  "VAL-023",
  "VAL-024",
  "VAL-031",
  "VAL-032",
  "VAL-033",
  "VAL-034",
  "VAL-035",
  "VAL-036",
  "VAL-037",
  "VAL-038",
  "VAL-039",
  "VAL-040",
  "VAL-041",
  "VAL-101",
  "VAL-102",
  "VAL-103",
  "VAL-104",
  "VAL-105",
  "VAL-106",
  "VAL-107",
] as const;

/** The codes §6.3 defers out of Phase 1 — none may appear in the array. */
const EXCLUDED_CODES = [
  "VAL-025",
  "VAL-026",
  "VAL-027",
  "VAL-028",
  "VAL-029",
  "VAL-030",
  "VAL-042",
  "VAL-043",
] as const;

const CODES = VALIDATION_RULES.map((rule) => rule.code);

/** `{a} \ {b}`, sorted — so a failure names the difference instead of a count. */
const missing = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((value) => !b.includes(value)).sort();

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** The `validation` namespace of one locale file. */
function localeValidation(locale: string): Record<string, string> {
  const file = path.join(REPO_ROOT, "messages", `${locale}.json`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    validation?: Record<string, string>;
  };
  return parsed.validation ?? {};
}

describe("VALIDATION_RULES — the §6.2 inventory", () => {
  it("holds exactly the 42 expected codes", () => {
    expect(missing(EXPECTED_CODES, CODES)).toEqual([]); // absent from the array
    expect(missing(CODES, EXPECTED_CODES)).toEqual([]); // unexpected extras
    expect(CODES).toHaveLength(42);
  });

  it("carries none of the codes §6.3 excludes from Phase 1", () => {
    const excluded: readonly string[] = EXCLUDED_CODES;
    expect(CODES.filter((code) => excluded.includes(code))).toEqual([]);
  });

  it("has no duplicate code", () => {
    const seen = new Set<string>();
    const duplicates = CODES.filter((code) => !seen.add(code));
    expect(duplicates).toEqual([]);
  });

  it("uses one of the four DM-28 scopes on every rule", () => {
    const scopes: readonly string[] = VALIDATION_SCOPES;
    const wrong = RULES.filter((rule) => !scopes.includes(rule.scope)).map(
      (rule) => `${rule.code}: ${rule.scope}`,
    );
    expect(wrong).toEqual([]);
  });

  it("uses one of the two severities on every rule", () => {
    const severities: readonly string[] = VALIDATION_SEVERITIES;
    const wrong = RULES.filter(
      (rule) => !severities.includes(rule.severity),
    ).map((rule) => `${rule.code}: ${rule.severity}`);
    expect(wrong).toEqual([]);
  });

  it("never marks a warning as blocking (blocking ⇒ error)", () => {
    const wrong = RULES.filter(
      (rule) => rule.blocking && rule.severity !== "error",
    ).map((rule) => rule.code);
    expect(wrong).toEqual([]);
  });

  it("carries a non-empty canonical RU message on every rule", () => {
    const empty = RULES.filter((rule) => rule.message.trim() === "").map(
      (rule) => rule.code,
    );
    expect(empty).toEqual([]);
    // The message is the audit text, so two rules sharing one would make a
    // stored result ambiguous without its code.
    expect(new Set(RULES.map((rule) => rule.message)).size).toBe(42);
  });

  it("targets real tables in `appliesTo` (the object_type vocabulary, К-8)", () => {
    const tables = new Set<string>();
    for (const value of Object.values(schema)) {
      if (is(value, Table)) tables.add(getTableName(value));
    }
    const unknown = RULES.flatMap((rule) =>
      rule.appliesTo
        .filter((target) => !tables.has(target))
        .map((target) => `${rule.code} → ${target}`),
    );
    expect(unknown).toEqual([]);
    expect(
      RULES.filter((rule) => rule.appliesTo.length === 0).map((r) => r.code),
    ).toEqual([]);
  });

  it("looks rules up by code and by scope", () => {
    expect(findRule("VAL-001")?.domain).toBe("Organisation");
    expect(findRule("VAL-999")).toBeUndefined();
    expect(rulesForScope("reference_org").map((rule) => rule.code)).toContain(
      "VAL-031",
    );
    // Every rule belongs to exactly one scope bucket.
    expect(
      VALIDATION_SCOPES.reduce(
        (total, scope) => total + rulesForScope(scope).length,
        0,
      ),
    ).toBe(42);
  });
});

describe("evaluator coverage — the R-12 guard", () => {
  it("has an evaluator or a manifest entry for every code, named on failure", () => {
    const implemented = Object.keys(EVALUATORS);
    const scheduled = Object.keys(PENDING_EVALUATORS);
    const uncovered = missing(CODES, [...implemented, ...scheduled]);
    expect(
      uncovered,
      `these VAL-* codes would pass silently — add an evaluator or a ` +
        `PENDING_EVALUATORS entry naming the task that will write one`,
    ).toEqual([]);
  });

  it("names a non-empty owning task on every manifest entry", () => {
    const taskless = Object.entries(PENDING_EVALUATORS)
      .filter(([, entry]) => !entry?.task?.trim())
      .map(([code]) => code);
    expect(taskless).toEqual([]);
    const noteless = Object.entries(PENDING_EVALUATORS)
      .filter(([, entry]) => !entry?.note?.trim())
      .map(([code]) => code);
    expect(noteless).toEqual([]);
  });

  it("keeps the manifest free of implemented and unknown codes", () => {
    const both = Object.keys(PENDING_EVALUATORS).filter(
      (code) => code in EVALUATORS,
    );
    expect(both, "implemented rules must be removed from the manifest").toEqual(
      [],
    );
    expect(missing(Object.keys(PENDING_EVALUATORS), CODES)).toEqual([]);
  });

  it("accepts the real registry", () => {
    expect(() => assertEvaluatorCoverage()).not.toThrow();
  });

  it("rejects a rule with neither an evaluator nor a manifest entry", () => {
    const rules = [...VALIDATION_RULES, { code: "VAL-999" }];
    expect(coverageProblems(rules)).toEqual([
      { code: "VAL-999", reason: "no evaluator and no manifest entry" },
    ]);
    expect(() => assertEvaluatorCoverage(rules)).toThrow(/VAL-999/);
    expect(() => assertEvaluatorCoverage(rules)).toThrow(
      /no evaluator and no manifest entry/,
    );
  });

  it("rejects a manifest entry with an empty task reference", () => {
    const problems = coverageProblems(
      [{ code: "VAL-001" }],
      {},
      { "VAL-001": { task: "  " } },
    );
    expect(problems).toEqual([
      {
        code: "VAL-001",
        reason: "manifest entry with an empty task reference",
      },
    ]);
  });

  it("rejects a code that is both implemented and scheduled", () => {
    const problems = coverageProblems(
      [{ code: "VAL-001" }],
      { "VAL-001": () => Promise.resolve([]) },
      { "VAL-001": { task: "T9.9" } },
    );
    expect(problems).toEqual([
      { code: "VAL-001", reason: "both an evaluator and a manifest entry" },
    ]);
  });

  it("rejects a manifest entry for a code outside the inventory", () => {
    const problems = coverageProblems([], {}, { "VAL-777": { task: "T9.9" } });
    expect(problems).toEqual([
      {
        code: "VAL-777",
        reason: "manifest entry for a code that is not in VALIDATION_RULES",
      },
    ]);
  });
});

describe("i18n — rule messages in both locales (О-12, R-13)", () => {
  const en = localeValidation("en");
  const sl = localeValidation("sl");

  it("covers all 42 codes in en.json", () => {
    expect(missing(CODES, Object.keys(en))).toEqual([]);
    expect(missing(Object.keys(en), CODES)).toEqual([]);
  });

  it("has identical key sets in en.json and sl.json", () => {
    expect(missing(Object.keys(en), Object.keys(sl))).toEqual([]); // en-only
    expect(missing(Object.keys(sl), Object.keys(en))).toEqual([]); // sl-only
    expect(Object.keys(sl)).toHaveLength(42);
  });

  it("has no empty or untranslated (copied) message", () => {
    expect(Object.entries(en).filter(([, text]) => !text.trim())).toEqual([]);
    expect(Object.entries(sl).filter(([, text]) => !text.trim())).toEqual([]);
    // A Slovenian string identical to the English one is an untranslated stub.
    expect(CODES.filter((code) => en[code] === sl[code])).toEqual([]);
  });
});
