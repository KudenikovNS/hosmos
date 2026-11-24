/**
 * Server-side validation for the two landing-page lead forms (ТЗ §11).
 *
 * Pure and dependency-free on purpose: the route handler needs it, and so does
 * the unit test, and neither should need a database or a request object to ask
 * "is this a valid Demo lead?". The client re-implements the SAME rules for
 * inline validation, and that duplication is intentional — §11 requires inline
 * validation after blur AND server-side validation, because the first is a
 * courtesy and only the second is a control.
 *
 * The function returns FIELD-KEYED errors rather than a single message. §13
 * requires the form to move focus to the first invalid field and announce the
 * error through `aria-describedby`; a flat "invalid input" string cannot drive
 * either behaviour.
 */

/** Which form a submission came from. Decides which block of fields is required. */
export type LeadFormType = "demo" | "vesg";

/** Error codes, not messages — the copy lives in `messages/landing.<locale>.json`. */
export type LeadErrorCode = "required" | "email" | "consent" | "tooLong";

/** `{ fieldName: errorCode }`. Empty object = valid. */
export type LeadErrors = Partial<Record<string, LeadErrorCode>>;

/** A lead as it arrives on the wire: every value is `unknown` until checked. */
export type RawLead = Record<string, unknown>;

/**
 * Field length caps. These are not cosmetic: `comment` is a free-text field on a
 * public, unauthenticated endpoint, and an uncapped one is a way to write
 * megabytes into the database for the price of one HTTP request.
 */
const MAX_LENGTH: Record<string, number> = {
  fullName: 120,
  email: 254, // RFC 5321 maximum for a forward path
  company: 160,
  country: 80,
  siteCount: 40,
  reportingPeriod: 160,
  comment: 2000,
};
const DEFAULT_MAX_LENGTH = 120;

/**
 * Allowed values for the enumerated fields, mirroring the CHECK constraints of
 * `0013_marketing_leads`. A value outside the set is treated as ABSENT rather
 * than as its own error code: the only way to send one is to bypass the form, so
 * there is no user-facing mistake to explain — and letting it through would
 * surface as a database constraint violation (a 500) instead of a 422.
 */
const ENUMS = {
  entityCount: ["1", "2-3", "4-10", "10+"],
  interest: ["starter", "pro", "enterprise", "white_label"],
  inSlovenia: ["yes", "no"],
  companySize: ["micro", "small", "medium", "other"],
  hasEmployee: ["yes", "no", "unknown"],
} as const satisfies Record<string, readonly string[]>;

export type EnumField = keyof typeof ENUMS;

/** Fields both forms require (§11). */
const SHARED_REQUIRED = ["fullName", "email", "company"] as const;
/** Demo-only required fields. `siteCount` and `comment` are optional by design. */
const DEMO_REQUIRED = ["entityCount", "interest"] as const;
/** VESG-only required fields. §11 marks "Slovenia: yes/no" and size as required. */
const VESG_REQUIRED = ["inSlovenia", "companySize"] as const;

/** Trim a value to a string, or `undefined` when it is absent/blank/not a string. */
export function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The value of an enumerated field, or `undefined` when it is not in the set. */
export function enumValue(
  field: EnumField,
  value: unknown,
): string | undefined {
  const candidate = str(value);
  if (!candidate) return undefined;
  return (ENUMS[field] as readonly string[]).includes(candidate)
    ? candidate
    : undefined;
}

/**
 * Email shape check.
 *
 * Deliberately permissive — one `@`, something either side, a dot in the domain,
 * no whitespace. A stricter regex is a well-known way to reject valid addresses
 * (plus-tags, new TLDs, IDN domains) and this endpoint has no business deciding
 * that a real customer's address does not exist. Deliverability is proven by
 * replying to the address, not by a pattern.
 */
export function isEmailShaped(value: string): boolean {
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  return (
    domain.length >= 3 &&
    domain.includes(".") &&
    !domain.startsWith(".") &&
    !domain.endsWith(".")
  );
}

/**
 * Validate a submission. Returns every failing field at once — a form that
 * reveals its problems one at a time makes the visitor pay a round trip per
 * mistake.
 *
 * `consent` is the privacy-policy checkbox: §11 requires it to be a separate,
 * NOT pre-ticked box, so its absence is a real validation error and never a
 * default. The marketing opt-in is independent and never required.
 */
export function validateLead(form: LeadFormType, raw: RawLead): LeadErrors {
  const errors: LeadErrors = {};

  const required = [
    ...SHARED_REQUIRED,
    ...(form === "demo" ? DEMO_REQUIRED : VESG_REQUIRED),
  ];

  for (const field of required) {
    const value =
      field in ENUMS
        ? enumValue(field as EnumField, raw[field])
        : str(raw[field]);
    if (!value) errors[field] = "required";
  }

  // Length caps apply to every free-text field that was actually sent, whether
  // or not it is required — an over-long optional comment is still a problem.
  for (const [field, max] of Object.entries(MAX_LENGTH)) {
    const value = str(raw[field]);
    if (value && value.length > max) errors[field] = "tooLong";
  }
  for (const [field, value] of Object.entries(raw)) {
    if (field in MAX_LENGTH || field in ENUMS) continue;
    const text = str(value);
    if (text && text.length > DEFAULT_MAX_LENGTH) errors[field] = "tooLong";
  }

  // Shape check only once the field is present, so a blank email reads
  // "required" rather than the more confusing "that is not a valid address".
  const email = str(raw.email);
  if (email && !errors.email && !isEmailShaped(email)) errors.email = "email";

  if (raw.consentPrivacy !== true) errors.consentPrivacy = "consent";

  return errors;
}

/** Convenience predicate — `validateLead` returns `{}` for a valid submission. */
export function isValid(errors: LeadErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * Honeypot check (§11 "Защита: … honeypot/turnstile при необходимости").
 *
 * The field is rendered, visually hidden and left empty by every human; a bot
 * that fills every input it finds fills this one too. The caller must answer a
 * tripped honeypot with the SAME success response a real submission gets — a
 * distinguishable rejection simply teaches the next bot which field to skip.
 */
export function honeypotTripped(raw: RawLead): boolean {
  return Boolean(str(raw.website));
}
