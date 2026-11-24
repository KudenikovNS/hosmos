import { describe, it, expect } from "vitest";
import {
  parseCheckoutTarget,
  buildBillingAddress,
  PAID_PLAN_IDS,
} from "../checkout-params";

// T-B3: the `/billing` page reads its target `{plan, period}` from the URL
// (`?plan=pro&period=monthly`). `parseCheckoutTarget` is the pure gate between
// untrusted query strings and the checkout call — only a paid plan + a valid
// period yields a target; anything else is `null` so the page falls back to the
// picker. `buildBillingAddress` fills sandbox-safe defaults so an incomplete
// address never blocks submit.
describe("parseCheckoutTarget", () => {
  it("rejects the monthly period — annual only since партия 16", () => {
    expect(parseCheckoutTarget("pro", "monthly")).toBeNull();
  });

  it("accepts each paid plan with a valid period", () => {
    for (const plan of PAID_PLAN_IDS) {
      expect(parseCheckoutTarget(plan, "annual")).toEqual({
        plan,
        period: "annual",
      });
    }
  });

  it("rejects the free trial plan (nothing to pay for)", () => {
    expect(parseCheckoutTarget("trial", "annual")).toBeNull();
  });

  it("rejects unknown plans and periods", () => {
    expect(parseCheckoutTarget("pro", "weekly")).toBeNull();
    expect(parseCheckoutTarget("gold", "annual")).toBeNull();
    expect(parseCheckoutTarget("", "")).toBeNull();
  });

  it("rejects missing params", () => {
    expect(parseCheckoutTarget(null, null)).toBeNull();
    expect(parseCheckoutTarget("pro", null)).toBeNull();
    expect(parseCheckoutTarget(null, "annual")).toBeNull();
  });
});

describe("buildBillingAddress", () => {
  it("uses the provided fields, upper-casing a 2-letter country", () => {
    expect(
      buildBillingAddress({
        countryCode: "si",
        city: "Ljubljana",
        postcode: "1000",
        streetLine1: "Trg 1",
      }),
    ).toEqual({
      countryCode: "SI",
      city: "Ljubljana",
      postcode: "1000",
      streetLine1: "Trg 1",
    });
  });

  it("falls back to sandbox-safe defaults when fields are missing", () => {
    expect(buildBillingAddress({})).toEqual({
      countryCode: "GB",
      city: "London",
      postcode: "SW1A 1AA",
      streetLine1: "1 Test Street",
    });
  });

  it("trims blank strings and treats them as missing", () => {
    expect(
      buildBillingAddress({
        countryCode: null,
        city: "   ",
        postcode: "",
        streetLine1: undefined,
      }),
    ).toEqual({
      countryCode: "GB",
      city: "London",
      postcode: "SW1A 1AA",
      streetLine1: "1 Test Street",
    });
  });

  it("keeps a valid alpha-2 country but rejects a 3-letter code (no wrong-country truncation)", () => {
    expect(buildBillingAddress({ countryCode: "si" }).countryCode).toBe("SI");
    // "SVN" must NOT become "SV" — an invalid length falls back to the default.
    expect(buildBillingAddress({ countryCode: "SVN" }).countryCode).toBe("GB");
  });
});
