// Unit tests for the PURE period-math helpers of subscription activation (T-C1).
// No database is touched, so these run everywhere (not gated on DATABASE_URL).
// `server-only` is stubbed because subscription.ts imports it at module load.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  addMonths,
  addYears,
  computePeriodEnd,
  computeProration,
} from "@/server/billing/subscription";

const utc = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("addMonths", () => {
  it("adds a whole month mid-month", () => {
    expect(iso(addMonths(utc(2026, 1, 15), 1))).toBe("2026-02-15");
  });

  it("rolls over the year boundary", () => {
    expect(iso(addMonths(utc(2026, 12, 15), 1))).toBe("2027-01-15");
  });

  it("clamps Jan 31 + 1 month to the last day of February (non-leap)", () => {
    expect(iso(addMonths(utc(2026, 1, 31), 1))).toBe("2026-02-28");
  });

  it("clamps Jan 31 + 1 month to Feb 29 in a leap year", () => {
    expect(iso(addMonths(utc(2024, 1, 31), 1))).toBe("2024-02-29");
  });
});

describe("addYears", () => {
  it("adds a year mid-month", () => {
    expect(iso(addYears(utc(2026, 1, 15), 1))).toBe("2027-01-15");
  });

  it("clamps Feb 29 + 1 year to Feb 28", () => {
    expect(iso(addYears(utc(2024, 2, 29), 1))).toBe("2025-02-28");
  });
});

describe("computePeriodEnd", () => {
  it("monthly adds ~1 month", () => {
    expect(iso(computePeriodEnd(utc(2026, 3, 10), "monthly"))).toBe(
      "2026-04-10",
    );
  });

  it("annual adds 1 year", () => {
    expect(iso(computePeriodEnd(utc(2026, 3, 10), "annual"))).toBe(
      "2027-03-10",
    );
  });

  it("preserves the time-of-day of the start instant", () => {
    const start = new Date("2026-03-10T08:30:00.000Z");
    expect(computePeriodEnd(start, "monthly").toISOString()).toBe(
      "2026-04-10T08:30:00.000Z",
    );
  });
});

describe("computeProration", () => {
  // A 10-day period; starter (2000) → pro (10000). Diff = 8000 minor units.
  const periodStart = new Date("2026-03-01T00:00:00.000Z");
  const periodEnd = new Date("2026-03-11T00:00:00.000Z");

  it("full period remaining ≈ the full price difference", () => {
    // now == periodStart → frac 1 → charge = newMinor - oldMinor.
    expect(
      computeProration({
        oldMinor: 2000,
        newMinor: 10000,
        now: periodStart,
        periodStart,
        periodEnd,
      }),
    ).toBe(8000);
  });

  it("half the period remaining ≈ half the difference", () => {
    const mid = new Date("2026-03-06T00:00:00.000Z"); // 5 of 10 days left
    expect(
      computeProration({
        oldMinor: 2000,
        newMinor: 10000,
        now: mid,
        periodStart,
        periodEnd,
      }),
    ).toBe(4000); // round(10000*0.5) - round(2000*0.5) = 5000 - 1000
  });

  it("zero time remaining → 0 (never charge for a period already ended)", () => {
    expect(
      computeProration({
        oldMinor: 2000,
        newMinor: 10000,
        now: periodEnd,
        periodStart,
        periodEnd,
      }),
    ).toBe(0);
    // Past the end clamps to 0, not negative.
    expect(
      computeProration({
        oldMinor: 2000,
        newMinor: 10000,
        now: new Date("2026-03-20T00:00:00.000Z"),
        periodStart,
        periodEnd,
      }),
    ).toBe(0);
  });

  it("a downgrade (newMinor < oldMinor) never yields a positive charge", () => {
    // Not used by the route for downgrades, but the formula must clamp to 0.
    const mid = new Date("2026-03-06T00:00:00.000Z");
    expect(
      computeProration({
        oldMinor: 10000,
        newMinor: 2000,
        now: mid,
        periodStart,
        periodEnd,
      }),
    ).toBe(0);
  });

  it("a zero-length span yields frac 0 → charge 0 (no divide-by-zero)", () => {
    expect(
      computeProration({
        oldMinor: 2000,
        newMinor: 10000,
        now: periodStart,
        periodStart,
        periodEnd: periodStart,
      }),
    ).toBe(0);
  });
});
