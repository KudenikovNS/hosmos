import { describe, expect, it } from "vitest";

import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_DAYS,
  parseConsent,
  serializeConsent,
} from "../consent";

describe("cookie consent", () => {
  it("reads a stored choice out of a cookie header", () => {
    expect(parseConsent(`a=1; ${CONSENT_COOKIE}=all; b=2`)).toBe("all");
    expect(parseConsent(`${CONSENT_COOKIE}=necessary`)).toBe("necessary");
  });

  it("treats a missing or tampered value as not answered", () => {
    expect(parseConsent("")).toBeNull();
    expect(parseConsent("NEXT_LOCALE=sl")).toBeNull();
    expect(parseConsent(`${CONSENT_COOKIE}=granted`)).toBeNull();
  });

  it("stores the choice for six months, first-party, Lax", () => {
    const cookie = serializeConsent("all");
    expect(cookie.startsWith(`${CONSENT_COOKIE}=all; Path=/;`)).toBe(true);
    expect(cookie).toContain(`Max-Age=${CONSENT_MAX_AGE_DAYS * 86400}`);
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(serializeConsent("necessary", false)).not.toContain("Secure");
  });
});
