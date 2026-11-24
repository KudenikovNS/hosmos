/**
 * Партия 21 — an entity's validity window against the reporting period.
 *
 * The owner set «velja od 02.02.2030» on the only legal entity and nothing
 * said that the 2024 report had just lost it. The window is not wrong — an
 * entity may join later — so the screen warns instead of refusing, and this is
 * the predicate behind the warning.
 */
import { describe, expect, it } from "vitest";

import { overlapsPeriod } from "../dates";

const PERIOD = ["2024-01-01", "2024-12-31"] as const;

describe("overlapsPeriod", () => {
  it("accepts a window that covers the period", () => {
    expect(overlapsPeriod("2020-01-01", null, ...PERIOD)).toBe(true);
    expect(overlapsPeriod(null, null, ...PERIOD)).toBe(true);
    expect(overlapsPeriod("2024-06-01", "2024-06-30", ...PERIOD)).toBe(true);
  });

  it("accepts a window that touches either edge", () => {
    expect(overlapsPeriod("2024-12-31", null, ...PERIOD)).toBe(true);
    expect(overlapsPeriod(null, "2024-01-01", ...PERIOD)).toBe(true);
  });

  it("rejects a window that starts after the period ends", () => {
    // The case that prompted this: a date typed three years out.
    expect(overlapsPeriod("2030-02-02", "2030-02-20", ...PERIOD)).toBe(false);
    expect(overlapsPeriod("2025-01-01", null, ...PERIOD)).toBe(false);
  });

  it("rejects a window that ended before the period began", () => {
    expect(overlapsPeriod(null, "2023-12-31", ...PERIOD)).toBe(false);
    expect(overlapsPeriod("2019-01-01", "2023-12-31", ...PERIOD)).toBe(false);
  });

  it("says nothing when there is no period to judge against", () => {
    expect(overlapsPeriod("2030-01-01", null, null, null)).toBe(true);
  });
});
