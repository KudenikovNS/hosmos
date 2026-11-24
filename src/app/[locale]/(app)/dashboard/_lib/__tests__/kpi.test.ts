// =============================================================================
// THE KPI BLOCK'S DECISIONS (T5.9) — DB-less, and about ONE property above all.
//
// A DASHBOARD MAY NOT SHOW A ZERO IT WAS NOT GIVEN. `calc/aggregate.ts` nulls
// every figure of a failed run so that the sum of the lines that happened to
// work cannot be published; a `?? 0` on the presentation side would undo that
// decision in the one place where a person actually reads it. So the failed and
// never-calculated cases are walked here field by field, and the assertion is
// not "the tiles look right" but "no tile carries a value at all".
//
// The arithmetic itself is NOT re-checked here — there is none. `kpiFigures`
// changes kilograms into tonnes with the shared shift and passes everything else
// through; `aggregate.test`/`calc.integration.test` own the sums.
// =============================================================================
import { describe, expect, it } from "vitest";

import type { DashboardEmissions } from "@/server/dashboard/dashboard";
import { kilogramsToTonnes } from "@/shared/units";

import {
  coverageFractions,
  KPI_KEYS,
  kpiFigures,
  showsFigures,
  type KpiFigure,
} from "../kpi";

/** A green run's payload, as `/api/dashboard` hands it over. */
function greenEmissions(
  overrides: Partial<DashboardEmissions> = {},
): DashboardEmissions {
  return {
    revision_id: "11111111-1111-4111-8111-111111111111",
    revision_no: 2,
    status: "approved",
    period_id: "22222222-2222-4222-8222-222222222222",
    period_name: "FY2024",
    period_start: "2024-01-01",
    period_end: "2024-12-31",
    state: "ok",
    run: {
      run_id: "33333333-3333-4333-8333-333333333333",
      calculated_at: "2025-02-01T10:00:00.000Z",
      line_count: 3,
      failed_count: 0,
    },
    stale_sources: [],
    totals: {
      scope1Co2e: "182.900000",
      scope1BiogenicCo2: "0.000000",
      scope2LocationBasedCo2e: "212.000000",
      scope2MarketBasedCo2e: "212.000000",
    },
    energy: {
      totalMwh: "1.000000",
      renewableMwh: "0.400000",
      nonRenewableMwh: "0.600000",
    },
    intensity: {
      turnoverEur: "1000000.00",
      locationBasedTco2e: "0.394900000",
      marketBasedTco2e: "0.394900000",
      locationBasedIntensity: "0.000000394900",
      marketBasedIntensity: "0.000000394900",
      fxYear: "2024",
    },
    coverage: {
      legal_entities_included: 2,
      legal_entities_total: 3,
      facilities_included: 1,
      facilities_total: 4,
    },
    ...overrides,
  };
}

/** THE probe of this file: does any tile carry a digit? */
const values = (figures: readonly KpiFigure[]) =>
  figures.map((figure) => figure.value);

describe("kpiFigures — the five figures UI-6 names", () => {
  it("returns exactly the five tiles, in order, and no others", () => {
    expect(kpiFigures(greenEmissions()).map((figure) => figure.key)).toEqual([
      ...KPI_KEYS,
    ]);
  });

  it("prints the emission totals in TONNES, through the shared shift", () => {
    const figures = kpiFigures(greenEmissions());
    const byKey = new Map(figures.map((figure) => [figure.key, figure]));
    // The aggregate publishes kilograms; VSME B3 and the PDF report tonnes, and
    // the shift is the renderer's own so a headline and a report cannot round
    // the same figure two ways.
    expect(byKey.get("scope1")?.value).toBe(kilogramsToTonnes("182.900000"));
    expect(byKey.get("scope1")?.value).toBe("0.182900000");
    expect(byKey.get("scope2Lb")?.value).toBe("0.212000000");
    expect(byKey.get("scope2Mb")?.value).toBe("0.212000000");
    expect(byKey.get("scope1")?.unit).toBe("tCO2e");
  });

  it("passes MWh and the intensity through UNCHANGED", () => {
    const emissions = greenEmissions();
    const byKey = new Map(
      kpiFigures(emissions).map((figure) => [figure.key, figure]),
    );
    // CALC-3 denominated the energy and CALC-8 divided the intensity; a second
    // opinion about either on this side would be a figure nobody calculated.
    expect(byKey.get("energy")?.value).toBe(emissions.energy?.totalMwh);
    expect(byKey.get("energy")?.unit).toBe("MWh");
    expect(byKey.get("intensity")?.value).toBe(
      emissions.intensity?.locationBasedIntensity,
    );
    expect(byKey.get("intensity")?.unit).toBe("intensityEur");
  });

  it("keeps enough decimals for an intensity to survive rounding", () => {
    const byKey = new Map(
      kpiFigures(greenEmissions()).map((figure) => [figure.key, figure]),
    );
    // 0.0000003949 tCO₂e/EUR at three decimals would print `0.000` — the one
    // thing this screen may never show.
    expect(byKey.get("intensity")?.decimals).toBeGreaterThanOrEqual(9);
  });
});

describe("a figure the calculation withheld stays withheld (§0.7)", () => {
  it("carries NO value for a FAILED run — not one zero anywhere", () => {
    // What `aggregate.ts` actually returns when a line failed: the objects are
    // present, every field inside them is null.
    const failed = greenEmissions({
      state: "failed",
      run: {
        run_id: "33333333-3333-4333-8333-333333333333",
        calculated_at: "2025-02-01T10:00:00.000Z",
        line_count: 3,
        failed_count: 1,
      },
      totals: {
        scope1Co2e: null,
        scope1BiogenicCo2: null,
        scope2LocationBasedCo2e: null,
        scope2MarketBasedCo2e: null,
      },
      energy: { totalMwh: null, renewableMwh: null, nonRenewableMwh: null },
      intensity: {
        turnoverEur: null,
        locationBasedTco2e: null,
        marketBasedTco2e: null,
        locationBasedIntensity: null,
        marketBasedIntensity: null,
        fxYear: "2024",
      },
    });
    expect(values(kpiFigures(failed))).toEqual([null, null, null, null, null]);
    // And the block does not render tiles at all for it — the failure is a
    // sentence naming the lines to fix, not six empty boxes.
    expect(showsFigures(failed)).toBe(false);
  });

  it("carries NO value when the revision has never been calculated", () => {
    const never = greenEmissions({
      state: "no_run",
      run: null,
      totals: null,
      energy: null,
      intensity: null,
    });
    expect(values(kpiFigures(never))).toEqual([null, null, null, null, null]);
    expect(showsFigures(never)).toBe(false);
  });

  it("withholds ONE figure without withholding the others", () => {
    // An energy row whose unit reaches no MWh (VAL-024) stops the SPLIT being
    // publishable while the emission totals are perfectly fine. The tiles have
    // to be able to say that — a card that hid everything or defaulted the
    // missing one to 0 would both be wrong.
    const partial = greenEmissions({
      energy: { totalMwh: null, renewableMwh: null, nonRenewableMwh: null },
    });
    const byKey = new Map(
      kpiFigures(partial).map((figure) => [figure.key, figure]),
    );
    expect(byKey.get("energy")?.value).toBeNull();
    expect(byKey.get("scope1")?.value).toBe("0.182900000");
  });
});

describe("showsFigures — a stale run's figures are still figures", () => {
  it("shows a green run and shows a STALE one", () => {
    expect(showsFigures(greenEmissions())).toBe(true);
    // CALC-6 says an input moved after the run. The figures are what somebody
    // APPROVED, so they are shown, with the notice beside them; hiding them
    // would withhold the only totals the company has.
    expect(
      showsFigures(
        greenEmissions({ state: "stale", stale_sources: ["period_scope"] }),
      ),
    ).toBe(true);
  });
});

describe("coverageFractions — a boundary, not a figure", () => {
  it("reports both fractions as COUNTS, where a zero is a real zero", () => {
    expect(coverageFractions(greenEmissions())).toEqual([
      { key: "legalEntities", included: 2, total: 3 },
      { key: "facilities", included: 1, total: 4 },
    ]);
  });

  it("reports an empty boundary as 0 of N rather than as no figure", () => {
    // The distinction the types carry: "nobody is in the boundary" is a fact the
    // user entered and reads as `0 of 3`, while a withheld TOTAL reads as words.
    const empty = coverageFractions(
      greenEmissions({
        coverage: {
          legal_entities_included: 0,
          legal_entities_total: 3,
          facilities_included: 0,
          facilities_total: 4,
        },
      }),
    );
    expect(empty.map((fraction) => fraction.included)).toEqual([0, 0]);
  });
});

describe("kilogramsToTonnes — the one shift, shared with the renderer", () => {
  it("shifts the decimal point three places without a float", () => {
    expect(kilogramsToTonnes("182.900000")).toBe("0.182900000");
    expect(kilogramsToTonnes("1000")).toBe("1.000");
    expect(kilogramsToTonnes("1")).toBe("0.001");
    expect(kilogramsToTonnes("0.1")).toBe("0.0001");
    expect(kilogramsToTonnes("-2500.5")).toBe("-2.5005");
    // A figure no double could hold exactly, kept exactly.
    expect(kilogramsToTonnes("12345678901234567890.123456")).toBe(
      "12345678901234567.890123456",
    );
  });
});
