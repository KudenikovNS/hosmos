// =============================================================================
// VR-2 — THE INLINE CHECKS ARE PINNED AGAINST THE RULE REGISTRY.
//
// `_lib/checks` mirrors a handful of `record`-scope rules so the form can speak
// before the round trip. The danger of any such mirror is that it drifts: a hint
// shown on a table the rule does not apply to, or shown in the wrong register
// (a warning that is really a blocking error), teaches the user something the
// server then contradicts.
//
// `VALIDATION_RULES` (`@/server/validation/rules`) is the source of truth for
// both facts and is a plain constant with no imports at all — so this test can
// hold it beside the mirror and compare. It asserts three things:
//
//   1. every code the mirror can emit EXISTS, is `record`-scoped and is
//      `blocking` — because the hint is rendered as a problem, not as a remark;
//   2. every code is declared against the TABLE the mirror emits it for
//      (`appliesTo`), so a VAL-015 hint can never appear on the energy form;
//   3. the two factor-set rules are NOT mirrored (`FACTOR_SET_CHECKS`) — the
//      abstention `checks.ts` argues for, held in place by name.
//
// It also pins the property the whole design rests on: the mirror produces
// ANNOTATIONS, never a verdict. There is no "blocked" in its output type, so
// there is nothing a caller could read to disable a Save — the reason the client
// cannot refuse what the server would accept.
// =============================================================================
import { describe, expect, it } from "vitest";

import type { InputTableName } from "@/server/inventory/tables";
import { VALIDATION_RULES } from "@/server/validation/rules";

import { FACTOR_SET_CHECKS, inlineChecks, type InlineCheck } from "../checks";

/** The three tables this screen edits (`disclosure_record` is T3.5b's). */
const TABLES: InputTableName[] = [
  "emission_activity",
  "purchased_energy_activity",
  "contractual_instrument",
];

/**
 * Form states chosen so that every branch of the mirror fires at least once.
 * The point is not to test the branches (they are three lines each) but to
 * COLLECT every `(code, table)` pair the mirror can produce, so the registry
 * assertions below run over the real output rather than over a hand-written list
 * that could fall behind the module.
 */
const STATES: Record<InputTableName, Record<string, string>[]> = {
  emission_activity: [
    { activity_value: "-1", method: "fuel_based", unit: "km", facility_id: "" },
    { method: "mass_balance", facility_id: "site" },
    { method: "distance_based", unit: "L", facility_id: "site" },
    { method: "activity_based", unit: "", facility_id: "site" },
    { activity_value: "0", method: "fuel_based", unit: "L", notes: "why" },
  ],
  purchased_energy_activity: [
    { consumption: "-5", facility_id: "" },
    { consumption: "10", facility_id: "site" },
  ],
  contractual_instrument: [{ covered_volume: "-1", facility_id: "" }],
  disclosure_record: [{}],
};

/** Every `(code, table)` pair the mirror can emit, over {@link STATES}. */
function emitted(): { code: string; table: InputTableName }[] {
  const pairs: { code: string; table: InputTableName }[] = [];
  for (const table of TABLES) {
    for (const values of STATES[table]) {
      for (const check of inlineChecks(table, values)) {
        if (!pairs.some((p) => p.code === check.code && p.table === table)) {
          pairs.push({ code: check.code, table });
        }
      }
    }
  }
  return pairs;
}

const rule = (code: string) =>
  VALIDATION_RULES.find((entry) => entry.code === code);

/** `appliesTo` widened to plain strings — it is a list of TABLE NAMES (К-8). */
const appliesTo = (code: string): readonly string[] =>
  rule(code)?.appliesTo ?? [];

describe("the inline checks mirror rules that exist", () => {
  const pairs = emitted();

  it("emits something at all — otherwise every assertion below is vacuous", () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  it("emits only codes the registry knows, in the register the hint uses", () => {
    const wrong = pairs
      .filter(({ code }) => {
        const entry = rule(code);
        return (
          !entry ||
          entry.scope !== "record" ||
          entry.severity !== "error" ||
          !entry.blocking
        );
      })
      .map(({ code }) => code);
    expect(wrong).toEqual([]);
  });

  it("emits each code only for a table the rule is declared against", () => {
    const misplaced = pairs
      .filter(({ code, table }) => !appliesTo(code).includes(table))
      .map(({ code, table }) => `${code} on ${table}`);
    expect(misplaced).toEqual([]);
  });
});

describe("the factor-set rules are deliberately NOT mirrored", () => {
  it("names two rules that this screen defers to the server", () => {
    // If either ever stopped being a rule, the drawer would be promising a check
    // that no longer exists.
    for (const code of FACTOR_SET_CHECKS) {
      expect(rule(code), code).toBeDefined();
    }
  });

  it("never emits one of them as an inline hint", () => {
    const leaked = emitted()
      .map(({ code }) => code)
      .filter((code) =>
        (FACTOR_SET_CHECKS as readonly string[]).includes(code),
      );
    expect(leaked).toEqual([]);
  });
});

describe("the mirror is advisory", () => {
  it("returns annotations that name a field, and nothing that could gate a write", () => {
    const checks = inlineChecks("emission_activity", {
      activity_value: "-1",
      method: "distance_based",
      unit: "L",
      facility_id: "",
    });
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      // Two keys, both descriptive. No `blocking`, no `valid`, no `canSave`:
      // there is nothing here for a caller to disable a button with.
      expect(Object.keys(check).sort()).toEqual(["code", "field"]);
      expect((check as InlineCheck).field).not.toBe("");
    }
  });

  it("says nothing at all about a contractual instrument", () => {
    // VAL-023 needs the reporting period and VAL-022/VAL-024 need the matched
    // consumption — none of which a form holds. Silence beats a guess.
    expect(
      inlineChecks("contractual_instrument", {
        covered_volume: "-1",
        facility_id: "",
      }),
    ).toEqual([]);
  });

  it("stays quiet on a row that has nothing wrong with it", () => {
    expect(
      inlineChecks("emission_activity", {
        activity_value: "12",
        method: "fuel_based",
        unit: "L",
        facility_id: "site-1",
      }),
    ).toEqual([]);
  });

  it("asks for the documented exception when a row names no site (AC-2)", () => {
    expect(
      inlineChecks("purchased_energy_activity", {
        consumption: "12",
        facility_id: "",
        notes: "",
      }),
    ).toEqual([{ code: "VAL-104", field: "notes" }]);
    expect(
      inlineChecks("purchased_energy_activity", {
        consumption: "12",
        facility_id: "",
        notes: "metered at group level",
      }),
    ).toEqual([]);
  });
});
