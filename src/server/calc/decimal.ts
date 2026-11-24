// EXACT DECIMAL ARITHMETIC FOR THE CALCULATION LAYER (CALC-4, CALC-7, AC-8).
//
// See docs/decisions/server-calc-decimal.md for the full account.

/**
 * An exact decimal: `units / 10 ** scale`.
 *
 * `scale` is a non-negative integer. There is no normalised form — `1.50` and
 * `1.5` are distinct {@link Decimal}s that {@link compare} equal — because
 * trailing zeros carry the precision a source published and dropping them would
 * quietly rewrite `factor_value` `'0.18290'` as `'0.1829'`.
 */
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

/** Everything `parseDecimal` accepts: optional sign, digits, optional fraction. */
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

// The `0n` literal syntax needs `target: es2020` and the project compiles at
// es2017, so the constants are built with `BigInt()` instead. Naming them once
// keeps the arithmetic below readable and the conversion off the hot path.
const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const BIG_TWO = BigInt(2);
const BIG_TEN = BigInt(10);

/** The zero of scale 0. */
export const ZERO: Decimal = { units: BIG_ZERO, scale: 0 };

/**
 * Thrown when a string that was supposed to be a `numeric` is not one.
 *
 * It THROWS rather than returning a fallback on purpose: a silent `0` for an
 * unparseable factor value is precisely the substitution §0.7 forbids, and a
 * silent `NaN` would propagate into a stored result. Postgres hands `numeric`
 * back as a well-formed string, so reaching this means the value never came
 * from the column it claims to.
 */
export class DecimalParseError extends Error {
  constructor(value: string) {
    super(`not a decimal literal: ${JSON.stringify(value)}`);
    this.name = "DecimalParseError";
  }
}

/**
 * A `numeric`-as-string → {@link Decimal}, exactly and with its scale intact.
 *
 * Exponent notation is deliberately NOT accepted. Postgres never emits it for
 * `numeric` (only for `float8`), so a string carrying an `e` reached here from
 * a `Number.prototype.toString()` somewhere — i.e. it has already been through
 * a double, which is the failure this module exists to prevent. Better to throw
 * at the boundary than to launder the loss.
 */
export function parseDecimal(value: string): Decimal {
  if (!DECIMAL_PATTERN.test(value)) throw new DecimalParseError(value);

  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[+-]/, "");
  const dot = unsigned.indexOf(".");
  const integerPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fractionPart = dot === -1 ? "" : unsigned.slice(dot + 1);
  const digits = BigInt(`${integerPart || "0"}${fractionPart}`);

  return { units: negative ? -digits : digits, scale: fractionPart.length };
}

/** `parseDecimal`, but a `null`/`undefined` column reads as {@link ZERO}. */
export function parseDecimalOrZero(value: string | null | undefined): Decimal {
  return value === null || value === undefined ? ZERO : parseDecimal(value);
}

/** `a` restated at `scale` (never smaller than its own — this cannot round). */
function rescale(a: Decimal, scale: number): Decimal {
  if (scale === a.scale) return a;
  return { units: a.units * BIG_TEN ** BigInt(scale - a.scale), scale };
}

/** `a × b`, exact: the scales add and nothing is dropped. */
export function multiply(a: Decimal, b: Decimal): Decimal {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/** `a + b`, exact at the finer of the two scales. */
export function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return {
    units: rescale(a, scale).units + rescale(b, scale).units,
    scale,
  };
}

/** `a − b`, exact at the finer of the two scales. */
export function subtract(a: Decimal, b: Decimal): Decimal {
  return add(a, { units: -b.units, scale: b.scale });
}

/** `−1 | 0 | 1` — `1.50` and `1.5` compare equal (see {@link Decimal}). */
export function compare(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = rescale(a, scale).units;
  const right = rescale(b, scale).units;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** True when the value is exactly zero, at any scale. */
export function isZero(a: Decimal): boolean {
  return a.units === BIG_ZERO;
}

/** True when the value is strictly below zero (VAL-018's mass-balance check). */
export function isNegative(a: Decimal): boolean {
  return a.units < BIG_ZERO;
}

/**
 * `ROUNDING_RULE` — half-up to `decimals` places, ties AWAY FROM ZERO.
 *
 * "Half up" is the accounting convention, not banker's rounding: `0.5 → 1` and
 * `−0.5 → −1`. Symmetry matters here because the only negative figure the
 * engine can produce is a negative refrigerant charge (VAL-018 warns about it,
 * §6.2 does not block it), and rounding it toward zero would make `|x|` and
 * `|−x|` disagree in the last place.
 *
 * Widening (a `decimals` above the value's own scale) is exact.
 */
export function roundHalfUp(a: Decimal, decimals: number): Decimal {
  if (decimals >= a.scale) return rescale(a, decimals);

  const divisor = BIG_TEN ** BigInt(a.scale - decimals);
  const negative = a.units < BIG_ZERO;
  const magnitude = negative ? -a.units : a.units;
  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  // `remainder * 2 >= divisor` is "the dropped tail is at least a half" without
  // ever forming the half — divisor may be odd only when it is 1, which this
  // branch has already excluded.
  const rounded =
    remainder * BIG_TWO >= divisor ? quotient + BIG_ONE : quotient;

  return { units: negative ? -rounded : rounded, scale: decimals };
}

/**
 * Thrown by {@link divideHalfUp} on a zero divisor.
 *
 * A THROW, like {@link DecimalParseError}, and for the same §0.7 reason: the
 * alternatives are a `0` (a value nobody computed, indistinguishable from a
 * genuine one) and an `Infinity` (which formats as garbage and reaches a report
 * as one). CALC-5's only divisor is the LENGTH IN DAYS of an instrument's
 * vintage window, which the caller has already established is positive, so
 * reaching this means the guard above it was removed.
 */
class DecimalDivisionByZeroError extends Error {
  constructor() {
    super("division by zero");
    this.name = "DecimalDivisionByZeroError";
  }
}

/**
 * `a ÷ b`, rounded half-up (away from zero) to `decimals` places — THE ONLY
 * quotient in the engine, see the module header.
 *
 * The quotient is formed ONCE, at full precision, in integers: `a` and `b` are
 * scaled `BigInt`s, so `a/b = (ua · 10^sb) / (ub · 10^sa)`, and asking for
 * `decimals` places just multiplies the numerator by `10^decimals` before the
 * single integer division. There is no intermediate decimal to round twice and
 * no float anywhere — `181/362` comes out as exactly `0.5`, not as
 * `0.4999999999999999`.
 *
 * Ties go AWAY FROM ZERO, matching {@link roundHalfUp}: the two are the same
 * rule (`ROUNDING_RULE`) applied at different moments, and a proration that
 * rounded to even while a result rounded half-up would be one methodology
 * described by two.
 */
export function divideHalfUp(
  a: Decimal,
  b: Decimal,
  decimals: number,
): Decimal {
  if (b.units === BIG_ZERO) throw new DecimalDivisionByZeroError();

  // (ua · 10^(sb + decimals)) / (ub · 10^sa), as one exact integer division.
  const numerator = a.units * BIG_TEN ** BigInt(b.scale + decimals);
  const denominator = b.units * BIG_TEN ** BigInt(a.scale);
  const negative = numerator < BIG_ZERO !== denominator < BIG_ZERO;
  const absNumerator = numerator < BIG_ZERO ? -numerator : numerator;
  const absDenominator = denominator < BIG_ZERO ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  // "The dropped tail is at least a half", without ever forming the half.
  const rounded =
    remainder * BIG_TWO >= absDenominator ? quotient + BIG_ONE : quotient;

  return { units: negative ? -rounded : rounded, scale: decimals };
}

/**
 * The canonical `numeric` literal: a fixed `decimals` places, always.
 *
 * FIXED rather than trimmed, because this string IS the stored result and AC-8
 * compares stored results byte for byte. `'2116.5'` and `'2116.500000'` are the
 * same quantity and different bytes; pinning the width means the comparison
 * never has to know that. A value at zero prints without a sign, so a rounded
 * `−0.0000001` cannot surface as `'-0.000000'`.
 *
 * @param decimals places to print; the value must already be rounded to at most
 *                 this many (widening is exact, narrowing would round twice)
 */
export function formatDecimal(a: Decimal, decimals: number): string {
  const fixed = roundHalfUp(a, decimals);
  const negative = fixed.units < BIG_ZERO;
  const magnitude = (negative ? -fixed.units : fixed.units)
    .toString()
    .padStart(decimals + 1, "0");
  const cut = magnitude.length - decimals;
  const integerPart = magnitude.slice(0, cut);
  const fractionPart = decimals > 0 ? `.${magnitude.slice(cut)}` : "";
  const sign = negative && fixed.units !== BIG_ZERO ? "-" : "";

  return `${sign}${integerPart}${fractionPart}`;
}

/**
 * The number of SIGNIFICANT decimal digits in a literal — leading zeros do not
 * count, trailing zeros after a decimal point do.
 *
 * Exported for the tests: the T5.2 acceptance asks for a row carrying 15
 * significant digits, and "15" has to be asserted rather than eyeballed, or the
 * probe silently stops probing the day someone tidies the fixture.
 */
export function significantDigits(value: string): number {
  const digits = value.replace(/^[+-]/, "").replace(".", "");
  const trimmed = digits.replace(/^0+/, "");
  return trimmed.length;
}
