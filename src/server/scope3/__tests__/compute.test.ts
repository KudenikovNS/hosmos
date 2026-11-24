// =============================================================================
// THE SPEND COMPUTE'S OWN TESTS (T3.6) — moved VERBATIM from the legacy
// wide-table engine's `calculate.test.ts` when `computeScope3Spend` moved out of
// it (О-8/MIG-10); that suite and its module were deleted in T3.8. Not one
// expectation changed here: they are the record that the arithmetic did not.
// =============================================================================
import { describe, expect, it } from "vitest";

import { computeScope3Spend, type FactorRow } from "@/server/scope3/compute";

/** The same 2-decimal rounding the annual aggregation applies to cat1 + cat2. */
const round2 = (v: number): number => Math.round(v * 100) / 100;

// §Q3(b)/§Q3-FX (T1.5b) — spend-based Scope-3 cats 1 & 2, currency-aware. Pure:
// FX map + resolved EXIOBASE rows are passed in (server-resolved; client sends
// neither). line_tCO2e = spend × fx(currency) × factor ÷ 1e6.
describe("computeScope3Spend: spend-based Scope-3 cats 1/2 (FX-aware)", () => {
  // EXIOBASE per-€1000 rows (seed.ts): electronics 350, furniture 310, machinery 450.
  const SPEND_ROWS: FactorRow[] = [
    {
      id: "e",
      factor_id: "s3_c1_electronics",
      country_code: null,
      year: "2024",
      value: 350,
      unit: "EUR 1000 spent",
      source: "EXIOBASE",
    },
    {
      id: "f",
      factor_id: "s3_c1_furniture",
      country_code: null,
      year: "2024",
      value: 310,
      unit: "EUR 1000 spent",
      source: "EXIOBASE",
    },
    {
      id: "m",
      factor_id: "s3_c2_machinery",
      country_code: null,
      year: "2024",
      value: 450,
      unit: "EUR 1000 spent",
      source: "EXIOBASE",
    },
    // A non-spend commodity (per-tonne) — NOT eligible for a spend line.
    {
      id: "p",
      factor_id: "s3_c1_paper",
      country_code: null,
      year: "2024",
      value: 919,
      unit: "tonne",
      source: "DEFRA",
    },
  ];
  // rate_to_eur (EUR per 1 unit); EUR → 1.0, RSD 2024 = 0.008541 (seed).
  const FX = new Map<string, number>([
    ["EUR", 1],
    ["RSD", 0.008541],
  ]);

  it("EUR cat-1 line: electronics €10 000 × 350 ÷ 1e6 = 3.5 t", () => {
    const r = computeScope3Spend(
      [
        {
          category: 1,
          commodityKey: "s3_c1_electronics",
          spendAmount: 10_000,
          currency: "EUR",
        },
      ],
      SPEND_ROWS,
      FX,
      "2024",
    );
    expect(r.cat1).toBeCloseTo(3.5, 9);
    expect(r.cat2).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it("non-EUR cat-2 line: machinery RSD 5 000 000 × 0.008541 = €42 705 × 450 ÷ 1e6 = 19.21725 t", () => {
    const r = computeScope3Spend(
      [
        {
          category: 2,
          commodityKey: "s3_c2_machinery",
          spendAmount: 5_000_000,
          currency: "RSD",
        },
      ],
      SPEND_ROWS,
      FX,
      "2024",
    );
    expect(r.cat2).toBeCloseTo(19.21725, 9); // 42705 × 450 / 1e6
    expect(r.cat1).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it("mixes EUR cat-1 + RSD cat-2 into their own subtotals", () => {
    const r = computeScope3Spend(
      [
        {
          category: 1,
          commodityKey: "s3_c1_electronics",
          spendAmount: 10_000,
          currency: "EUR",
        },
        {
          category: 2,
          commodityKey: "s3_c2_machinery",
          spendAmount: 5_000_000,
          currency: "RSD",
        },
      ],
      SPEND_ROWS,
      FX,
      "2024",
    );
    expect(r.cat1).toBeCloseTo(3.5, 9);
    expect(r.cat2).toBeCloseTo(19.21725, 9);
    expect(round2(r.cat1 + r.cat2)).toBe(22.72); // annual extraScope3
    expect(r.warnings).toEqual([]);
  });

  it("missing FX rate → line contributes 0 + a warning (never a silent 1.0)", () => {
    const r = computeScope3Spend(
      [
        {
          category: 1,
          commodityKey: "s3_c1_electronics",
          spendAmount: 10_000,
          currency: "USD", // not in the FX map
        },
      ],
      SPEND_ROWS,
      FX,
      "2024",
    );
    expect(r.cat1).toBe(0);
    expect(r.cat2).toBe(0);
    expect(r.warnings).toEqual(["no FX rate for USD 2024"]);
  });

  it("missing / non-€1000 factor → line contributes 0 + a warning", () => {
    const r = computeScope3Spend(
      [
        {
          category: 1,
          commodityKey: "s3_c1_unknown", // no such factor row
          spendAmount: 10_000,
          currency: "EUR",
        },
        {
          category: 1,
          commodityKey: "s3_c1_paper", // exists but unit is per-tonne, not spend
          spendAmount: 10_000,
          currency: "EUR",
        },
      ],
      SPEND_ROWS,
      FX,
      "2024",
    );
    expect(r.cat1).toBe(0);
    expect(r.warnings).toEqual([
      "no spend factor for s3_c1_unknown 2024",
      "no spend factor for s3_c1_paper 2024",
    ]);
  });

  it("no spend lines → zero subtotals, no warnings (regression-safe)", () => {
    const r = computeScope3Spend([], SPEND_ROWS, FX, "2024");
    expect(r.cat1).toBe(0);
    expect(r.cat2).toBe(0);
    expect(r.warnings).toEqual([]);
  });
});
