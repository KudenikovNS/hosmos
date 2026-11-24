// =============================================================================
// WIRE → COLUMN primitives, shared by every registry service (T2.2 → T2.3 → …).
//
// WHERE THE LINE IS, and it is the same line in every service that uses these:
//   • THESE HELPERS refuse only what would reach Postgres as a MALFORMED LITERAL
//     or a value the column physically cannot hold — a word where a NUMERIC
//     goes, `"yesterday"` for a `date`, a 5-letter country for a `char(2)`, a
//     non-uuid for an FK, an enum value outside its list (§0.8 puts those in the
//     app layer). Such a body is a bare `VALIDATION` naming the FIELD.
//   • THE VAL-* RULES judge everything semantic: is the value in the reference
//     list, is the range legal, is the hierarchy acyclic, is the link to an
//     entity that is in force. Such a body is a `VALIDATION` carrying rule CODES.
//
// The split has a consequence worth stating, because getting it wrong quietly
// changes the API: a range that a RULE owns must NOT be narrowed here. Latitude
// is the live example — VAL-006 owns −90…90, so `parseNewFacility` passes `91`
// straight through to be refused by the rule, with the code the UI renders
// against the field. `decimalOrNull`'s bounds are therefore for what the COLUMN
// cannot hold, not for what the DOMAIN disallows.
//
// EVERY HELPER RETURNS THE SAME THREE-WAY ANSWER: a value, `null` (the caller
// sent `""` or `null`, i.e. "clear this field"), or `undefined` — REJECT. A
// caller turns `undefined` into `{ok: false, field}` and nothing else does.
// =============================================================================

/** Parse outcome: the column values, or the API field that was rejected. */
export type ParseResult<V> =
  { ok: true; values: V } | { ok: false; field: string };

/** ISO-8601 calendar date — the only shape a `date` column accepts from the wire. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The canonical uuid shape (mirrors `isUuid` in `./handler`, kept local to avoid a cycle). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Blank-as-null: a form clears a field by sending `""`, which means NULL. */
export function textOrNull(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A finite number in `[min, max]`, as the string a NUMERIC column stores.
 *
 * The default bounds are the safe-integer range, i.e. "any number JavaScript can
 * carry losslessly" — see the header: a bound here is about the COLUMN, and a
 * caller passes a narrower one only when the narrowing is not some rule's job.
 */
export function decimalOrNull(
  raw: unknown,
  min = -Number.MAX_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): string | null | undefined {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "number" && typeof raw !== "string") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return String(n);
}

/**
 * A whole number in `[min, max]`, for an `integer` column (`reporting_year`,
 * `base_year`, `employee_count`…), or NULL.
 *
 * Unlike {@link decimalOrNull} this returns a NUMBER: `integer` columns map to
 * `number` in Drizzle, not to the string a NUMERIC carries. A fractional value
 * is a rejection rather than a silent truncation — `2024.5` is not a year, and
 * rounding it here would store something the caller never sent. Bounds are
 * MANDATORY for the same reason the header gives: int4 overflows as a driver
 * error, so a caller states the range its column can hold.
 */
export function integerOrNull(
  raw: unknown,
  min: number,
  max: number,
): number | null | undefined {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "number" && typeof raw !== "string") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}

/** An `YYYY-MM-DD` string, or NULL. Anything else is a rejection. */
export function isoDateOrNull(raw: unknown): string | null | undefined {
  const parsed = textOrNull(raw);
  if (parsed === undefined) return undefined;
  if (parsed !== null && !ISO_DATE.test(parsed)) return undefined;
  return parsed;
}

/** A uuid (an FK target), or NULL. A non-uuid would be a malformed literal → 500. */
export function uuidOrNull(raw: unknown): string | null | undefined {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || !UUID.test(raw)) return undefined;
  return raw;
}

/**
 * A fixed-length alphabetic code, UPPERCASED — `char(2)` countries, `char(3)`
 * currencies. Length is checked HERE because a longer string is a driver error;
 * MEMBERSHIP of the ISO list is VAL-002's, not this function's.
 */
export function alphaCodeOrNull(
  raw: unknown,
  length: number,
): string | null | undefined {
  const parsed = textOrNull(raw);
  if (parsed === undefined) return undefined;
  if (parsed === null) return null;
  return new RegExp(`^[A-Za-z]{${length}}$`).test(parsed)
    ? parsed.toUpperCase()
    : undefined;
}

/** A member of a domain list (§0.8 — the guard IS the constraint), or NULL. */
export function oneOfOrNull<T extends string>(
  raw: unknown,
  guard: (value: string) => value is T,
): T | null | undefined {
  const parsed = textOrNull(raw);
  if (parsed === undefined) return undefined;
  if (parsed === null) return null;
  return guard(parsed) ? parsed : undefined;
}

/**
 * A boolean, accepting the two string spellings a form sends. There is no NULL
 * branch — `undefined` here always means reject — so this is the helper for a
 * NOT NULL boolean (`facility.included_in_boundary`,
 * `emission_factor.wtt_included`). {@link booleanOrNull} is the nullable one.
 */
export function booleanValue(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

/**
 * A boolean, or NULL — for a boolean column on which "unknown" is a third,
 * MEANINGFUL state rather than a missing answer.
 *
 * `emission_factor.rf_included` (T2.8) is the first: `false` says the factor
 * deliberately excludes the radiative-forcing uplift, NULL says the source is
 * silent on the question, and collapsing the two would make a flight factor
 * claim a methodological position nobody took.
 */
export function booleanOrNull(raw: unknown): boolean | null | undefined {
  if (raw === null || raw === "") return null;
  return booleanValue(raw);
}

/** NUMERIC (`string | null`) → `number | null`, null-preserving — the serialiser half. */
export function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}
