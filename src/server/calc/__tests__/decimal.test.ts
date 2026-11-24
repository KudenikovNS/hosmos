// Exact decimal arithmetic — the layer CALC-4 stands on. NO DATABASE.
//
// The cases below are the ones a float gets wrong, plus the two the engine
// depends on being exact: a scale that survives a multiplication, and a
// half-way tail that rounds away from zero in both directions.
import { describe, expect, it } from "vitest";

import {
  add,
  compare,
  DecimalParseError,
  formatDecimal,
  isNegative,
  isZero,
  multiply,
  parseDecimal,
  parseDecimalOrZero,
  roundHalfUp,
  significantDigits,
  subtract,
  ZERO,
} from "../decimal";

describe("parsing a `numeric`-as-string", () => {
  it("keeps the scale a source published", () => {
    // '0.18290' and '0.1829' are the same quantity; only the first says the
    // factor was published to five places.
    expect(parseDecimal("0.18290")).toEqual({ units: BigInt(18290), scale: 5 });
    expect(parseDecimal("0.1829")).toEqual({ units: BigInt(1829), scale: 4 });
    expect(compare(parseDecimal("0.18290"), parseDecimal("0.1829"))).toBe(0);
  });

  it("reads signs, bare integers and bare fractions", () => {
    expect(parseDecimal("-12.5")).toEqual({ units: BigInt(-125), scale: 1 });
    expect(parseDecimal("1500")).toEqual({ units: BigInt(1500), scale: 0 });
    expect(parseDecimal(".5")).toEqual({ units: BigInt(5), scale: 1 });
    expect(parseDecimal("5.")).toEqual({ units: BigInt(5), scale: 0 });
  });

  it("survives more digits than a double has", () => {
    const wide = "123456789012345678901234567890.123456789012345";
    expect(formatDecimal(parseDecimal(wide), 15)).toBe(wide);
    // The same string through a `number` loses everything past the 17th digit.
    expect(Number(wide).toString()).not.toBe(wide);
  });

  it("throws rather than substituting a zero (§0.7)", () => {
    expect(() => parseDecimal("")).toThrow(DecimalParseError);
    expect(() => parseDecimal("abc")).toThrow(DecimalParseError);
    expect(() => parseDecimal("1,5")).toThrow(DecimalParseError);
    // Exponent notation means the value has already been through a double.
    expect(() => parseDecimal("1.5e3")).toThrow(DecimalParseError);
  });

  it("reads a NULL column as zero", () => {
    expect(parseDecimalOrZero(null)).toEqual(ZERO);
    expect(parseDecimalOrZero(undefined)).toEqual(ZERO);
    expect(isZero(parseDecimalOrZero(null))).toBe(true);
  });
});

describe("arithmetic a float gets wrong", () => {
  it("adds tenths exactly", () => {
    expect(
      formatDecimal(add(parseDecimal("0.1"), parseDecimal("0.2")), 1),
    ).toBe("0.3");
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("multiplies without losing a digit", () => {
    const product = multiply(parseDecimal("1.1"), parseDecimal("1.1"));
    expect(product).toEqual({ units: BigInt(121), scale: 2 });
    expect(formatDecimal(product, 2)).toBe("1.21");
    expect(1.1 * 1.1).not.toBe(1.21);
  });

  it("chains three factors the way CALC-4 does", () => {
    // 1500 m³ × 11.0342 × 0.18290 — the golden fixture's first row.
    const exact = multiply(
      multiply(parseDecimal("1500"), parseDecimal("11.0342")),
      parseDecimal("0.18290"),
    );
    expect(formatDecimal(exact, 9)).toBe("3027.232770000");
  });

  it("subtracts a mass balance exactly", () => {
    const charge = subtract(
      add(parseDecimal("120"), parseDecimal("45.5")),
      add(parseDecimal("12.25"), parseDecimal("133.75")),
    );
    expect(formatDecimal(charge, 2)).toBe("19.50");
    expect(isNegative(charge)).toBe(false);
  });
});

describe("ROUNDING_RULE — half up, away from zero", () => {
  it("rounds an exact half up", () => {
    expect(formatDecimal(roundHalfUp(parseDecimal("0.5"), 0), 0)).toBe("1");
    expect(formatDecimal(roundHalfUp(parseDecimal("1.5"), 0), 0)).toBe("2");
    // Banker's rounding would give 2 here; half-up gives 3.
    expect(formatDecimal(roundHalfUp(parseDecimal("2.5"), 0), 0)).toBe("3");
  });

  it("is symmetric about zero", () => {
    expect(formatDecimal(roundHalfUp(parseDecimal("-0.5"), 0), 0)).toBe("-1");
    expect(formatDecimal(roundHalfUp(parseDecimal("-2.5"), 0), 0)).toBe("-3");
  });

  it("rounds just below a half down", () => {
    expect(formatDecimal(roundHalfUp(parseDecimal("0.4999999"), 0), 0)).toBe(
      "0",
    );
    expect(
      formatDecimal(roundHalfUp(parseDecimal("2469135.78024649"), 6), 6),
    ).toBe("2469135.780246");
  });

  it("widens without rounding", () => {
    expect(formatDecimal(roundHalfUp(parseDecimal("2116.5"), 6), 6)).toBe(
      "2116.500000",
    );
  });
});

describe("formatting a stored result", () => {
  it("always prints the full width, so AC-8 can compare bytes", () => {
    expect(formatDecimal(parseDecimal("2116.5"), 6)).toBe("2116.500000");
    expect(formatDecimal(ZERO, 6)).toBe("0.000000");
    expect(formatDecimal(parseDecimal("0.0000004"), 6)).toBe("0.000000");
  });

  it("never emits a negative zero", () => {
    expect(formatDecimal(parseDecimal("-0.0000001"), 6)).toBe("0.000000");
    expect(formatDecimal(parseDecimal("-0"), 6)).toBe("0.000000");
  });

  it("keeps the sign on a real negative (VAL-018's case)", () => {
    expect(formatDecimal(parseDecimal("-30"), 6)).toBe("-30.000000");
  });
});

describe("significantDigits", () => {
  it("counts digits, ignoring the sign, the point and leading zeros", () => {
    expect(significantDigits("12345678.9012325")).toBe(15);
    expect(significantDigits("-0.00123")).toBe(3);
    expect(significantDigits("1500")).toBe(4);
  });
});
