// =============================================================================
// T1.1 acceptance — the Phase-1 domain enums.
//
// Two kinds of assertion live here and they are not the same kind of thing:
//
//   1. STRUCTURAL invariants, asserted over `PHASE1_ENUMS` so they hold for
//      every list including ones added later — non-empty, duplicate-free,
//      frozen readonly tuples rather than mutable `string[]`.
//   2. PINNED COUNTS AND VALUES for the four lists whose exact content the spec
//      makes load-bearing (DataType 12, ApplicabilityStatus 4 per D15,
//      WorkflowStatus 6, CalculationMethod 9). These are here to FAIL when
//      someone "tidies up" a list that downstream code counts on — DM-19 fans
//      the 12 DataTypes onto six value columns, LC-2 maps the 6 workflow
//      statuses onto 6 period statuses. A count changing silently is the bug.
// =============================================================================

import { describe, expect, it } from "vitest";

import * as enumModule from "@/shared/enums";
import {
  APPLICABILITY_STATUSES,
  CALCULATION_METHODS,
  DATA_TYPES,
  ENERGY_UNITS,
  isApplicabilityStatus,
  isDataType,
  isPeriodStatus,
  isWorkflowStatus,
  PERIOD_STATUSES,
  PHASE1_ENUMS,
  UNIT_CODES,
  WORKFLOW_STATUSES,
  type Phase1EnumName,
} from "@/shared/enums";

const ENUM_NAMES = Object.keys(PHASE1_ENUMS) as Phase1EnumName[];

/**
 * `never` when `T` has been widened to `string[]`, `T` itself for a tuple.
 *
 * SCOPE OF THE CHECK, so it is not trusted for more than it does: it rejects
 * the two WIDENINGS that lose the value information — `string[]` and
 * `readonly string[]` — because neither is assignable back to a tuple type. It
 * does NOT reject a mutable array whose type is still narrow, e.g.
 * `const X: ("a" | "b")[] = ["a", "b"]`: that keeps its literal members, so
 * `ReadonlyTuple` passes it through. Dropping `as const` in practice produces
 * `string[]` and is caught; hand-writing a narrow mutable type is not. The
 * convention (`as const` on every list) is what closes that gap.
 */
type ReadonlyTuple<T extends readonly string[]> = string[] extends T
  ? never
  : T;

describe("PHASE1_ENUMS — structural invariants (all lists)", () => {
  // GROWTH-PROOF, and deliberately so. This started as `toHaveLength(29)`, which
  // T2.3 would have had to edit merely for adding `AssetType` with the asset
  // registry — and every later list after it. What the assertion is FOR is that
  // a list is never quietly dropped from the index (the reverse direction, "a
  // list exists but is not indexed", is the next test's job and is exact), so a
  // FLOOR states it without turning every addition into a diff here.
  it("indexes at least the 29 Phase-1 lists S1 pinned", () => {
    expect(ENUM_NAMES.length).toBeGreaterThanOrEqual(29);
  });

  // The invariants below are asserted over `PHASE1_ENUMS`, so a list that is
  // exported from one of the files but never added to the index would escape
  // ALL of them silently. This closes that door from the other side: every
  // string tuple the module exports must BE one of the indexed lists (compared
  // by identity, so a copy with the same values does not count).
  it("indexes every readonly string tuple the module exports", () => {
    const indexed = new Set<readonly string[]>(Object.values(PHASE1_ENUMS));
    const exported = Object.entries<unknown>(enumModule).filter(
      (entry): entry is [string, readonly string[]] =>
        Array.isArray(entry[1]) &&
        entry[1].every((value: unknown) => typeof value === "string"),
    );

    expect(exported).toHaveLength(ENUM_NAMES.length);
    const orphans = exported
      .filter(([, values]) => !indexed.has(values))
      .map(([name]) => name);
    expect(orphans).toEqual([]);
  });

  it.each(ENUM_NAMES)("%s is non-empty", (name) => {
    expect(PHASE1_ENUMS[name].length).toBeGreaterThan(0);
  });

  it.each(ENUM_NAMES)("%s has no duplicate values", (name) => {
    const values = PHASE1_ENUMS[name];
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(ENUM_NAMES)("%s holds only non-empty strings", (name) => {
    for (const value of PHASE1_ENUMS[name]) {
      expect(typeof value).toBe("string");
      expect(value.trim()).not.toBe("");
    }
  });

  // "No list is exported as `string[]` — readonly tuples only." That is a
  // compile-time property, so it is asserted at compile time: `ReadonlyTuple<T>`
  // collapses to `never` for a widened `string[]`, and the assignment below then
  // fails `tsc --noEmit`. Dropping an `as const` breaks the build, not just this
  // test — which is the point, since a mutable export would let a caller push a
  // value the union type has never heard of.
  it("exports every list as a readonly tuple, never as string[]", () => {
    const tuples: {
      [K in Phase1EnumName]: ReadonlyTuple<(typeof PHASE1_ENUMS)[K]>;
    } = PHASE1_ENUMS;
    expect(Object.keys(tuples)).toHaveLength(ENUM_NAMES.length);
  });
});

describe("pinned lists the spec makes load-bearing", () => {
  it("DataType has exactly 12 values (DM-18, DM-20, S1)", () => {
    expect(DATA_TYPES).toHaveLength(12);
  });

  it("ApplicabilityStatus has exactly the 4 values of D15 / spec §4.6", () => {
    // The workbook sheet lists five (it adds `Applicable`); the spec's CHECK
    // wins with four, lowercase snake_case.
    expect(APPLICABILITY_STATUSES).toEqual([
      "included",
      "excluded",
      "not_applicable",
      "not_assessed",
    ]);
  });

  it("WorkflowStatus has exactly 6 values (DM-10, D22)", () => {
    expect(WORKFLOW_STATUSES).toHaveLength(6);
    expect(WORKFLOW_STATUSES).toEqual([
      "draft",
      "submitted",
      "in_review",
      "approved",
      "rejected",
      "locked",
    ]);
  });

  it("CalculationMethod has exactly 9 values (Enums sheet)", () => {
    expect(CALCULATION_METHODS).toHaveLength(9);
  });

  it("PeriodStatus keeps the workbook's verbatim labels (К-4, LC-2)", () => {
    // Casing here is the API contract, not a style slip: К-4 commits to the
    // workbook's exact values, so `In review` must not become `in_review`.
    expect(PERIOD_STATUSES).toEqual([
      "Draft",
      "Submitted",
      "In review",
      "Approved",
      "Locked",
      "Reopened",
    ]);
    expect(isPeriodStatus("in_review")).toBe(false);
  });

  it("EnergyUnit is a subset of UnitCode (spec §4.10 vs the mixin unit)", () => {
    for (const unit of ENERGY_UNITS) {
      expect(UNIT_CODES).toContain(unit);
    }
  });
});

describe("type guards", () => {
  it("accept every value of their own list", () => {
    for (const value of DATA_TYPES) expect(isDataType(value)).toBe(true);
    for (const value of WORKFLOW_STATUSES)
      expect(isWorkflowStatus(value)).toBe(true);
  });

  it("reject values from a neighbouring list", () => {
    expect(isDataType("multi-enum")).toBe(false); // workbook label, not the wire value
    expect(isApplicabilityStatus("applicable")).toBe(false); // dropped per D15
    expect(isWorkflowStatus("reopened")).toBe(false); // PeriodStatus only
  });

  it("reject non-strings without throwing", () => {
    for (const value of [undefined, null, 0, {}, [], true]) {
      expect(isDataType(value)).toBe(false);
    }
  });
});
