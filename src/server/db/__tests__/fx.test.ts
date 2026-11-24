// Unit tests for the currency + annual FX resolver (DATA-INTEGRITY §Q3-FX / D8,
// T1.5c). Pure functions only — no DB — so they run under vitest (node env)
// alongside the golden/factor-resolver suites. `getFxRates(db, …)` (the thin DB
// loader) is exercised by the [LOCAL-DB] throwaway check, not here.
import { describe, expect, it } from "vitest";

import {
  convertToEur,
  resolveDefaultCurrency,
  resolveFxRateMap,
  type FxRateRow,
} from "@/server/db/fx";

// Minimal §5 fixture: EUR (=1.0 every year) + RSD across the three seeded years.
const ROWS: FxRateRow[] = [
  { currency_code: "EUR", year: "2023", rate_to_eur: 1.0 },
  { currency_code: "EUR", year: "2024", rate_to_eur: 1.0 },
  { currency_code: "EUR", year: "2025", rate_to_eur: 1.0 },
  { currency_code: "RSD", year: "2023", rate_to_eur: 0.008528 },
  { currency_code: "RSD", year: "2024", rate_to_eur: 0.008541 },
  { currency_code: "RSD", year: "2025", rate_to_eur: 0.00854 },
];

describe("resolveFxRateMap", () => {
  it("resolves the exact-year rate for EUR (1.0) and a non-EUR currency", () => {
    const map = resolveFxRateMap(ROWS, "2024");
    expect(map.get("EUR")).toBe(1.0);
    expect(map.get("RSD")).toBe(0.008541);
  });

  it("falls back to the nearest past year when the exact year is absent", () => {
    // 2099 → max(year < 2099) = 2025.
    const map = resolveFxRateMap(ROWS, "2099");
    expect(map.get("RSD")).toBe(0.00854);
  });

  it("falls back to the nearest future year when no past year exists", () => {
    // 2000 → min(year > 2000) = 2023.
    const map = resolveFxRateMap(ROWS, "2000");
    expect(map.get("RSD")).toBe(0.008528);
  });

  it("omits a currency with no rate at all (missing → caller warns, D4)", () => {
    const map = resolveFxRateMap(ROWS, "2024");
    expect(map.has("USD")).toBe(false);
    expect(map.get("USD")).toBeUndefined();
  });
});

describe("convertToEur", () => {
  it("multiplies amount by rate_to_eur (RSD 2024)", () => {
    const map = resolveFxRateMap(ROWS, "2024");
    // 5_000_000 RSD × 0.008541 = 42_705 EUR.
    expect(convertToEur(5_000_000, "RSD", map)).toBeCloseTo(42_705, 6);
  });

  it("is a pass-through for EUR (rate 1.0)", () => {
    const map = resolveFxRateMap(ROWS, "2024");
    expect(convertToEur(1234.56, "EUR", map)).toBe(1234.56);
  });

  it("returns null on a missing (currency, year) rate — never a silent 1.0 or 0", () => {
    const map = resolveFxRateMap(ROWS, "2024");
    expect(convertToEur(5_000_000, "USD", map)).toBeNull();
  });
});

describe("resolveDefaultCurrency", () => {
  it("prefers subsidiary over company over the EUR fallback", () => {
    expect(
      resolveDefaultCurrency({
        subsidiary: { currency: "RSD" },
        company: { currency: "USD" },
      }),
    ).toBe("RSD");
  });

  it("uses the company currency when no subsidiary is present", () => {
    expect(resolveDefaultCurrency({ company: { currency: "GBP" } })).toBe(
      "GBP",
    );
  });

  it("falls back to EUR when nothing is set", () => {
    expect(resolveDefaultCurrency({})).toBe("EUR");
    expect(
      resolveDefaultCurrency({ subsidiary: null, company: { currency: null } }),
    ).toBe("EUR");
  });
});
