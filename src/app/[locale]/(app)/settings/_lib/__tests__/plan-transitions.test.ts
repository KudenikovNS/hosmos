// T-C3: unit tests for the pure settings billing helpers. React/SDK-free so they
// run in the node env — they pin the upgrade/downgrade decision and the annual
// price rule the modal renders (display only; the server re-prices at charge).
import { describe, expect, it } from "vitest";

import {
  ANNUAL_DISCOUNT_LABEL,
  ANNUAL_MONTHS_CHARGED,
  annualPrice,
  transitionKind,
} from "../plan-transitions";

describe("annualPrice", () => {
  it("charges 10 months for a year (2 months free)", () => {
    expect(ANNUAL_MONTHS_CHARGED).toBe(10);
    expect(annualPrice(20)).toBe(200);
    expect(annualPrice(100)).toBe(1000);
    expect(annualPrice(0)).toBe(0);
  });

  it("exposes a ~17% discount label", () => {
    expect(ANNUAL_DISCOUNT_LABEL).toMatch(/17%/);
  });
});

describe("transitionKind", () => {
  it("is 'upgrade' when the target ranks higher than current", () => {
    expect(transitionKind("trial", "starter")).toBe("upgrade");
    expect(transitionKind("starter", "pro")).toBe("upgrade");
    expect(transitionKind("pro", "enterprise")).toBe("upgrade");
  });

  it("is 'downgrade' when the target ranks lower than current", () => {
    expect(transitionKind("enterprise", "pro")).toBe("downgrade");
    expect(transitionKind("pro", "starter")).toBe("downgrade");
    expect(transitionKind("starter", "trial")).toBe("downgrade");
  });

  it("is 'same' when the plans match", () => {
    expect(transitionKind("pro", "pro")).toBe("same");
  });
});
