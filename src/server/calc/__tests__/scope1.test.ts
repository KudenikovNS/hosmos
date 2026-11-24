// =============================================================================
// SCOPE 1 — GOLDEN TESTS (T5.2, TEST-3, О-11). NO DATABASE.
//
// The expectations live in `./golden/scope1-basic.json`, each with the hand
// arithmetic that produced it. They were NOT produced by running this engine
// and recording the output — that would only prove the code agrees with itself
// — and NOT by comparing against the deleted legacy calculator (О-11). The
// arithmetic string next to every number is the proof, and it is checkable with
// a pencil by someone who trusts neither the author nor the implementation.
//
// This file's job is therefore narrow and mechanical: feed the fixture in,
// compare every field, and add the assertions the fixture cannot make about
// itself — that the version is pinned, that the biogenic figures really are
// absent from the fossil total, that the missing-factor row is not a zero, and
// that a float implementation would get the last row wrong.
// =============================================================================
import { describe, expect, it } from "vitest";

import {
  add,
  formatDecimal,
  multiply,
  parseDecimal,
  significantDigits,
  ZERO,
  type Decimal,
} from "../decimal";
import { FactorsAmbiguousError } from "../factors";
import {
  FORMULA_VERSION,
  ROUNDING_DECIMALS,
  ROUNDING_RULE,
} from "../formula-version";
import {
  computeScope1,
  SCOPE1_INPUT_BASES,
  type Scope1ExclusionReason,
  type Scope1Factor,
  type Scope1InputBasis,
  type Scope1Period,
  type Scope1Row,
} from "../scope1";
import type { ConversionCandidate } from "../units";

import goldenJson from "./golden/scope1-basic.json";

/** The fixture's shape. Declared here so the JSON is checked, not trusted. */
interface GoldenFixture {
  readonly formulaVersion: string;
  readonly roundingRule: string;
  readonly roundingDecimals: number;
  readonly period: Scope1Period;
  readonly conversions: readonly ConversionCandidate[];
  readonly factors: readonly Scope1Factor[];
  readonly rows: readonly Scope1Row[];
  readonly expectedLines: readonly {
    readonly activityRowId: string;
    readonly category: string;
    readonly calculationStatus: string;
    readonly inputBasis: Scope1InputBasis;
    readonly inputValue: string;
    readonly inputUnit: string;
    readonly conversionFactor: string;
    readonly factorId: string | null;
    readonly biogenic: boolean;
    readonly co2eResult: string | null;
    readonly biogenicCo2Result: string | null;
  }[];
  readonly expectedExcluded: readonly {
    readonly activityRowId: string;
    readonly reason: Scope1ExclusionReason;
  }[];
  readonly expectedTotals: {
    readonly fossilCo2e: string;
    readonly biogenicCo2: string;
    readonly lineCount: number;
    readonly okCount: number;
    readonly failedCount: number;
    readonly runStatus: "ok" | "failed";
  };
}

const golden = goldenJson as unknown as GoldenFixture;

/** The five `activity_category` values Scope 1 has (§4.9). */
const SCOPE1_CATEGORIES = [
  "stationary_combustion",
  "mobile_combustion",
  "fugitive_emissions",
  "process_emissions",
  "onsite_generation",
] as const;

/** The row the whole precision argument rests on. */
const PROBE_ROW_ID = "00000000-0000-4000-8000-0000000000aa";

const result = computeScope1(
  golden.rows,
  golden.factors,
  golden.conversions,
  golden.period,
);

const lineFor = (activityRowId: string) => {
  const line = result.lines.find((l) => l.activityRowId === activityRowId);
  if (!line) throw new Error(`no line for ${activityRowId}`);
  return line;
};

const rowFor = (id: string) => {
  const row = golden.rows.find((r) => r.id === id);
  if (!row) throw new Error(`no fixture row ${id}`);
  return row;
};

describe("golden fixture — the version is part of the expectations", () => {
  // The acceptance in the plan: "changing FORMULA_VERSION without updating the
  // golden file fails the test". FORMULA_VERSION covers the formula, the factor
  // priority ladder, the year rule, the tie-break, the conversion preference,
  // the rounding rule and the VAL-034 tolerance (see `formula-version.ts`) —
  // every one of which can move a number below without any input changing. So
  // a bump has to be accompanied by a fresh look at these figures, and this
  // assertion is what forces the look.
  it("pins FORMULA_VERSION, the rounding rule and its precision", () => {
    expect(FORMULA_VERSION).toBe(golden.formulaVersion);
    expect(ROUNDING_RULE).toBe(golden.roundingRule);
    expect(ROUNDING_DECIMALS).toBe(golden.roundingDecimals);
    expect(result.formulaVersion).toBe(golden.formulaVersion);
    expect(result.roundingRule).toBe(golden.roundingRule);
  });

  it("stamps every line with the version and the rounding rule (VAL-035)", () => {
    for (const line of result.lines) {
      expect(line.formulaVersion).toBe(golden.formulaVersion);
      expect(line.roundingRule).toBe(golden.roundingRule);
    }
  });
});

describe("golden fixture — coverage the acceptance asks for", () => {
  it("covers all five Scope-1 categories", () => {
    const covered = new Set(golden.expectedLines.map((e) => e.category));
    expect([...covered].sort()).toEqual([...SCOPE1_CATEGORIES].sort());
  });

  it("covers both mass-balance branches and the plain input", () => {
    const bases = new Set(result.lines.map((l) => l.inputBasis));
    expect([...bases].sort()).toEqual([...SCOPE1_INPUT_BASES].sort());
  });

  it("covers a row that needs a unit conversion", () => {
    const converted = result.lines.filter(
      (l) => l.conversionFactor !== "1" && l.calculationStatus === "ok",
    );
    expect(converted.length).toBeGreaterThan(0);
    // Contextual, not universal: a cubic metre of gas reaches kWh only through
    // that gas's calorific value (CALC-3).
    expect(converted[0].inputUnit).toBe("m3");
    expect(converted[0].conversionFactor).toBe("11.0342");
    expect(converted[0].conversionId).not.toBeNull();
  });

  it("covers a biogenic row from each side of the OR", () => {
    const biogenic = result.lines.filter((l) => l.biogenic);
    expect(biogenic).toHaveLength(2);
    // a7: the ROW says nothing, the FACTOR says biogenic.
    expect(rowFor(biogenic[0].activityRowId).biogenicFlag).toBeNull();
    expect(biogenic[0].factor?.biogenicTreatment).toBe("biogenic");
    // a8: the ROW says biogenic, the FACTOR says fossil — they disagree, and
    // §9 CALC-4's OR means the row wins.
    expect(rowFor(biogenic[1].activityRowId).biogenicFlag).toBe(true);
    expect(biogenic[1].factor?.biogenicTreatment).toBe("fossil");
  });
});

describe("golden fixture — every line, against the hand arithmetic", () => {
  it("produces exactly the expected lines, in row order", () => {
    expect(result.lines.map((l) => l.activityRowId)).toEqual(
      golden.expectedLines.map((e) => e.activityRowId),
    );
  });

  it.each(golden.expectedLines)(
    "$activityRowId ($category) → $co2eResult kgCO2e",
    (expected) => {
      const line = lineFor(expected.activityRowId);

      expect(line.calculationStatus).toBe(expected.calculationStatus);
      expect(line.inputBasis).toBe(expected.inputBasis);
      expect(line.inputValue).toBe(expected.inputValue);
      expect(line.inputUnit).toBe(expected.inputUnit);
      expect(line.conversionFactor).toBe(expected.conversionFactor);
      expect(line.factorId).toBe(expected.factorId);
      expect(line.biogenic).toBe(expected.biogenic);
      expect(line.co2eResult).toBe(expected.co2eResult);
      expect(line.biogenicCo2Result).toBe(expected.biogenicCo2Result);
      expect(line.scope).toBe("scope1");
      // К-20: `reporting_basis` is Scope 2's discriminator and must stay NULL.
      expect(line.reportingBasis).toBeNull();
    },
  );

  it("applies CALC-1's four rejections, one reason each", () => {
    expect(result.excluded).toEqual(
      golden.expectedExcluded.map((e) => ({
        activityRowId: e.activityRowId,
        reason: e.reason,
      })),
    );
  });

  it("matches the expected totals and run status", () => {
    expect(result.totals.fossilCo2e).toBe(golden.expectedTotals.fossilCo2e);
    expect(result.totals.biogenicCo2).toBe(golden.expectedTotals.biogenicCo2);
    expect(result.totals.lineCount).toBe(golden.expectedTotals.lineCount);
    expect(result.totals.okCount).toBe(golden.expectedTotals.okCount);
    expect(result.totals.failedCount).toBe(golden.expectedTotals.failedCount);
    expect(result.runStatus).toBe(golden.expectedTotals.runStatus);
  });
});

describe("VAL-017 — biogenic carbon is not in the fossil total", () => {
  it("sums the fossil total out of the non-biogenic lines only", () => {
    const sum = result.lines
      .filter((l) => !l.biogenic && l.co2eResult !== null)
      .reduce<Decimal>(
        (acc, line) => add(acc, parseDecimal(line.co2eResult as string)),
        ZERO,
      );
    expect(formatDecimal(sum, ROUNDING_DECIMALS)).toBe(
      result.totals.fossilCo2e,
    );
  });

  it("would produce a DIFFERENT total if the biogenic figures were folded in", () => {
    // The assertion that actually bites: it is not enough for the biogenic rows
    // to be labelled, their kilograms must be missing from the headline figure.
    const fossil = parseDecimal(result.totals.fossilCo2e);
    const biogenic = parseDecimal(result.totals.biogenicCo2);
    expect(biogenic.units).toBeGreaterThan(BigInt(0));
    expect(fossil.units + biogenic.units).not.toBe(fossil.units);
    expect(formatDecimal(fossil, ROUNDING_DECIMALS)).not.toBe(
      formatDecimal(
        { units: fossil.units + biogenic.units, scale: fossil.scale },
        ROUNDING_DECIMALS,
      ),
    );
  });

  it("gives a biogenic line a genuine zero on the fossil column", () => {
    for (const line of result.lines.filter((l) => l.biogenic)) {
      expect(line.co2eResult).toBe("0.000000");
      expect(line.biogenicCo2Result).not.toBeNull();
      expect(line.calculationStatus).toBe("ok");
    }
  });
});

describe("§0.7 / AC-6 — a missing factor is never a zero", () => {
  const failed = () => result.lines.filter((l) => l.calculationStatus !== "ok");

  it("marks the unpriced row `failed_missing_factor`", () => {
    expect(failed()).toHaveLength(1);
    expect(failed()[0].calculationStatus).toBe("failed_missing_factor");
    expect(failed()[0].factorId).toBeNull();
    expect(failed()[0].factor).toBeNull();
  });

  it("writes NO number at all — not 0, not '0', not '0.000000'", () => {
    const line = failed()[0];
    expect(line.co2eResult).toBeNull();
    expect(line.co2eResult).not.toBe(0);
    expect(line.co2eResult).not.toBe("0");
    expect(line.co2eResult).not.toBe("0.000000");
    expect(line.biogenicCo2Result).toBeNull();
  });

  it("fails the whole run, which is what blocks approve/render/lock", () => {
    expect(result.runStatus).toBe("failed");
  });

  it("fails the row with `failed_unit` when the factor exists but no path does", () => {
    // A factor priced in `kg`, a row entered in `parcel`, and no conversion
    // between them: a DIFFERENT fix (seed a conversion, not a factor), hence a
    // different status — and still no number.
    const row: Scope1Row = {
      ...rowFor("00000000-0000-4000-8000-0000000000a3"),
      unit: "parcel",
      method: "activity_based",
      activityValue: "5",
    };
    const only = computeScope1(
      [row],
      golden.factors,
      golden.conversions,
      golden.period,
    );
    expect(only.lines[0].calculationStatus).toBe("failed_unit");
    expect(only.lines[0].co2eResult).toBeNull();
    expect(only.lines[0].wantedUnits).toEqual(["kg"]);
    expect(only.runStatus).toBe("failed");
  });
});

describe("the arithmetic is decimal, not float", () => {
  const probe = rowFor(PROBE_ROW_ID);
  const line = lineFor(PROBE_ROW_ID);
  const factor = golden.factors.find((f) => f.id === line.factorId);

  it("carries 15 significant digits into the formula", () => {
    expect(significantDigits(probe.activityValue)).toBe(15);
    expect(line.inputValue).toBe(probe.activityValue);
  });

  it("rounds the exact half up, per ROUNDING_RULE", () => {
    // 12 345 678.9012325 × 1 × 0.2 = 2 469 135.7802465 exactly — a bare …5 at
    // the seventh decimal, i.e. the boundary itself. Half away from zero → up.
    const exact = multiply(
      multiply(parseDecimal(probe.activityValue), parseDecimal("1")),
      parseDecimal("0.2"),
    );
    expect(formatDecimal(exact, 7)).toBe("2469135.7802465");
    expect(line.co2eResult).toBe("2469135.780247");
  });

  it("gets an answer a DOUBLE cannot reach", () => {
    // The same three numbers through `number`. Neither 12345678.9012325 nor 0.2
    // is representable in binary, and the nearest double product falls just
    // BELOW the boundary, so a float implementation rounds down and is wrong in
    // the last place — silently, in a figure that reaches a signed report.
    const asFloat =
      Number(probe.activityValue) *
      Number(line.conversionFactor) *
      Number(factor?.factorValue);

    expect(asFloat.toFixed(20)).toBe("2469135.78024649992585182190");
    expect(asFloat.toFixed(ROUNDING_DECIMALS)).toBe("2469135.780246");
    expect(asFloat.toFixed(ROUNDING_DECIMALS)).not.toBe(line.co2eResult);
    expect(line.co2eResult).toBe("2469135.780247");
  });
});

// =============================================================================
// Branches the golden fixture cannot express without becoming unreadable.
// =============================================================================

/** The fixture's a3 (R-410A, mass balance) as a starting point. */
const fugitive = (overrides: Partial<Scope1Row> = {}): Scope1Row => ({
  ...golden.rows[2],
  ...overrides,
});

const compute = (rows: readonly Scope1Row[]) =>
  computeScope1(rows, golden.factors, golden.conversions, golden.period);

describe("CALC-4 — which mass-balance branch runs", () => {
  it("chooses the branch by `method`, never by which columns are filled", () => {
    // Every refrigerant column populated exactly as in a3, but the declared
    // method is neither of the two. `activity_value` is used verbatim: guessing
    // at the intent would make the stored figure depend on data-entry
    // leftovers rather than on the method the preparer declared.
    const line = compute([
      fugitive({ method: "average_data", activityValue: "3" }),
    ]).lines[0];
    expect(line.inputBasis).toBe("activity_value");
    expect(line.inputValue).toBe("3");
    expect(line.co2eResult).toBe("6264.000000"); // 3 × 2088
  });

  it("treats an unrecognised method the same way — no mass balance", () => {
    const line = compute([
      // `method` is NOT NULL in the schema, so "absent" reaches the engine as
      // an empty or unknown string; neither selects a derivation.
      fugitive({ method: "", activityValue: "2" }),
    ]).lines[0];
    expect(line.inputBasis).toBe("activity_value");
    expect(line.co2eResult).toBe("4176.000000"); // 2 × 2088
  });

  it("leaves a NON-fugitive row alone even when its method says mass_balance", () => {
    const line = compute([
      {
        ...golden.rows[1], // mobile combustion, 12 500 km
        method: "mass_balance",
      },
    ]).lines[0];
    expect(line.inputBasis).toBe("activity_value");
    expect(line.co2eResult).toBe("2116.500000");
  });

  it("reads a NULL component of the balance as zero", () => {
    // 0 + 45.5 − 12.25 − 0 = 33.25 kg → × 2088 = 69 426
    const line = compute([fugitive({ openingStock: null, closingStock: null })])
      .lines[0];
    expect(line.inputValue).toBe("33.25");
    expect(line.co2eResult).toBe("69426.000000");
  });

  it("returns a negative balance as it falls (VAL-018 is a warning)", () => {
    // 10 + 0 − 0 − 40 = −30 kg. Clamping to zero here would hide exactly the
    // inconsistency §6.2 asks VAL-018 to report.
    const line = compute([
      fugitive({
        openingStock: "10",
        refrigerantAdded: null,
        refrigerantRecovered: null,
        closingStock: "40",
      }),
    ]).lines[0];
    expect(line.inputValue).toBe("-30");
    expect(line.co2eResult).toBe("-62640.000000");
  });

  it("denominates a derived charge in kg whatever the row's own unit says", () => {
    // The refrigerant columns are kg by §4.9, so a row that (wrongly) carries
    // `unit = 't'` must not have its charge resolved against a tonne factor.
    const line = compute([fugitive({ unit: "t" })]).lines[0];
    expect(line.inputUnit).toBe("kg");
    expect(line.conversionFactor).toBe("1");
    expect(line.co2eResult).toBe("40716.000000");
  });

  it("applies leakage_rate as a percent", () => {
    // 350 × 100 / 100 = 350 kg — a full-charge loss, the rate's upper edge.
    const line = compute([
      fugitive({
        activityType: "r134a",
        method: "engineering_estimate",
        equipmentCapacity: "350",
        leakageRate: "100",
      }),
    ]).lines[0];
    // Scale follows the inputs: 350 (0 dp) × 100 (0 dp) × 0.01 (2 dp) = 2 dp.
    expect(line.inputValue).toBe("350.00");
    expect(line.co2eResult).toBe("500500.000000"); // 350 × 1430
  });
});

describe("CALC-1 — the period window", () => {
  /** The fixture's a2 (12 500 km) run against an arbitrary window. */
  const run = (startDate: string, endDate: string, yearMonth: string | null) =>
    computeScope1(
      [{ ...golden.rows[1], yearMonth }],
      golden.factors,
      golden.conversions,
      { ...golden.period, startDate, endDate },
    );

  it("includes a month that lies wholly inside the period", () => {
    const included = run("2025-02-01", "2025-11-30", "2025-04");
    expect(included.excluded).toEqual([]);
    expect(included.lines).toHaveLength(1);
  });

  it("excludes a month that only straddles the edge (D3/D12 deferred)", () => {
    // The period starts mid-February, so February is not wholly inside. §9
    // defers the partial-month rule; the two honest readings (count it,
    // prorate it) differ by an amount nobody has decided, so the month is left
    // out rather than silently picked.
    const leading = run("2025-02-15", "2025-11-15", "2025-02");
    expect(leading.lines).toHaveLength(0);
    expect(leading.excluded[0].reason).toBe("outside_period");

    const trailing = run("2025-02-15", "2025-11-15", "2025-11");
    expect(trailing.lines).toHaveLength(0);
    expect(trailing.excluded[0].reason).toBe("outside_period");
  });

  it("handles February's length rather than assuming 31 days", () => {
    // 2024 is a leap year: a period ending 2024-02-29 wholly contains 2024-02,
    // and one ending 2024-02-28 does not.
    const leap = run("2024-02-01", "2024-02-29", "2024-02");
    expect(leap.excluded).toEqual([]);
    expect(leap.lines).toHaveLength(1);

    const short = run("2024-02-01", "2024-02-28", "2024-02");
    expect(short.excluded[0].reason).toBe("outside_period");
  });

  it("keeps a whole-period row (`year_month IS NULL`) in every window", () => {
    const anywhere = computeScope1(
      [golden.rows[4]],
      golden.factors,
      golden.conversions,
      { ...golden.period, startDate: "2025-06-10", endDate: "2025-06-20" },
    );
    expect(anywhere.excluded).toEqual([]);
    expect(anywhere.lines[0].co2eResult).toBe("131350.000000");
  });
});

describe("CALC-2 — the pinned set and its refusals", () => {
  it("ignores a factor from another set even when it is the only match", () => {
    const foreign = golden.factors.map((f) => ({
      ...f,
      factorSetId: "99999999-9999-4999-8999-999999999999",
    }));
    const run = computeScope1(
      [golden.rows[1]],
      foreign,
      golden.conversions,
      golden.period,
    );
    expect(run.lines[0].calculationStatus).toBe("failed_missing_factor");
    expect(run.lines[0].co2eResult).toBeNull();
  });

  it("aborts the run on an ambiguous set rather than picking one (§12.1)", () => {
    const twin = {
      ...golden.factors[1],
      id: "00000000-0000-4000-8000-00000000f2b0",
      factorValue: "0.99999",
    };
    expect(() =>
      computeScope1(
        [golden.rows[1]],
        [...golden.factors, twin],
        golden.conversions,
        golden.period,
      ),
    ).toThrow(FactorsAmbiguousError);
  });
});
