/**
 * Landing-page lead validation (ТЗ §11).
 *
 * The rules under test are the ones that decide whether a stranger's enquiry is
 * accepted, so the cases here are the refusals rather than the happy path: a
 * consent box that defaults to unchecked, a honeypot that must not be
 * distinguishable from success, and a comment field that cannot be used to
 * write a novel into the database.
 */
import { describe, expect, it } from "vitest";

import {
  enumValue,
  honeypotTripped,
  isEmailShaped,
  isValid,
  str,
  validateLead,
} from "../validate";

/** A Demo submission with every required field satisfied. */
const validDemo = {
  fullName: "Ana Novak",
  email: "ana@primer.si",
  company: "Primer d.o.o.",
  entityCount: "2-3",
  interest: "pro",
  consentPrivacy: true,
};

/** A VESG submission with every required field satisfied. */
const validVesg = {
  fullName: "Ana Novak",
  email: "ana@primer.si",
  company: "Primer d.o.o.",
  inSlovenia: "yes",
  companySize: "micro",
  consentPrivacy: true,
};

describe("validateLead", () => {
  it("accepts a complete Demo submission", () => {
    expect(validateLead("demo", validDemo)).toEqual({});
    expect(isValid(validateLead("demo", validDemo))).toBe(true);
  });

  it("accepts a complete VESG submission", () => {
    expect(validateLead("vesg", validVesg)).toEqual({});
  });

  it("requires each form's OWN fields, not the other form's", () => {
    // A Demo payload sent as VESG is missing the VESG block and vice versa —
    // the check that stops the two forms drifting into one another.
    expect(validateLead("vesg", validDemo)).toMatchObject({
      inSlovenia: "required",
      companySize: "required",
    });
    expect(validateLead("demo", validVesg)).toMatchObject({
      entityCount: "required",
      interest: "required",
    });
  });

  it("reports EVERY failing field at once", () => {
    const errors = validateLead("demo", { consentPrivacy: true });
    expect(Object.keys(errors).sort()).toEqual([
      "company",
      "email",
      "entityCount",
      "fullName",
      "interest",
    ]);
  });

  it("treats a missing consent box as an error, never as a default", () => {
    // §11: the privacy checkbox is separate and NOT pre-ticked, so its absence
    // must fail rather than being inferred from the submission itself.
    expect(
      validateLead("demo", { ...validDemo, consentPrivacy: undefined }),
    ).toMatchObject({ consentPrivacy: "consent" });
    expect(
      validateLead("demo", { ...validDemo, consentPrivacy: "true" }),
    ).toMatchObject({ consentPrivacy: "consent" });
  });

  it("does not require the marketing opt-in", () => {
    expect(
      validateLead("demo", { ...validDemo, consentMarketing: false }),
    ).toEqual({});
  });

  it("reports a blank email as required and a malformed one as email", () => {
    expect(validateLead("demo", { ...validDemo, email: "   " })).toMatchObject({
      email: "required",
    });
    expect(
      validateLead("demo", { ...validDemo, email: "ana(at)primer" }),
    ).toMatchObject({ email: "email" });
  });

  it("rejects an over-long comment", () => {
    const errors = validateLead("demo", {
      ...validDemo,
      comment: "x".repeat(2001),
    });
    expect(errors.comment).toBe("tooLong");
  });

  it("accepts a comment at exactly the cap", () => {
    expect(
      validateLead("demo", { ...validDemo, comment: "x".repeat(2000) }).comment,
    ).toBeUndefined();
  });

  it("treats an out-of-set enum value as absent, not as its own error", () => {
    // Reaching this needs a bypassed form, so there is no user mistake to
    // explain — and letting it through would become a DB constraint 500.
    const errors = validateLead("demo", { ...validDemo, interest: "platinum" });
    expect(errors.interest).toBe("required");
  });
});

describe("honeypotTripped", () => {
  it("is quiet for a human submission", () => {
    expect(honeypotTripped(validDemo)).toBe(false);
    expect(honeypotTripped({ ...validDemo, website: "  " })).toBe(false);
  });

  it("trips when the hidden field was filled", () => {
    expect(honeypotTripped({ ...validDemo, website: "https://spam" })).toBe(
      true,
    );
  });
});

describe("isEmailShaped", () => {
  it("accepts addresses a strict regex would wrongly reject", () => {
    for (const address of [
      "ana+vsme@primer.si",
      "a@b.co",
      "ime.priimek@pod-jetje.co.uk",
      "info@računovodstvo.si",
    ]) {
      expect(isEmailShaped(address), address).toBe(true);
    }
  });

  it("rejects shapes that cannot be an address", () => {
    for (const address of [
      "ana",
      "@primer.si",
      "ana@",
      "ana@primer",
      "ana@@primer.si",
      "ana @primer.si",
      "ana@.si",
      "ana@primer.",
    ]) {
      expect(isEmailShaped(address), address).toBe(false);
    }
  });
});

describe("str / enumValue", () => {
  it("trims, and treats blank or non-string input as absent", () => {
    expect(str("  Ana  ")).toBe("Ana");
    expect(str("   ")).toBeUndefined();
    expect(str(42)).toBeUndefined();
    expect(str(undefined)).toBeUndefined();
  });

  it("passes through only values the DB CHECK constraints allow", () => {
    expect(enumValue("entityCount", "4-10")).toBe("4-10");
    expect(enumValue("entityCount", "4–10")).toBeUndefined(); // en dash, not hyphen
    expect(enumValue("interest", "white_label")).toBe("white_label");
    expect(enumValue("companySize", "MICRO")).toBeUndefined();
  });
});
