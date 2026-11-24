// =============================================================================
// WHAT THE KPI BLOCK SHOWS, AS PURE FUNCTIONS (T5.9 — UI-6).
//
// The screen renders answers; this module decides them, and it is tested without
// a browser or a database. There are two decisions and one conversion:
//
//   1. WHICH FIGURES (`kpiFigures`). The five UI-6 names — Scope 1, Scope 2
//      location-based, Scope 2 market-based, energy in MWh, intensity — each
//      carrying its DISPLAY unit and the decimals that unit is read in. The
//      sixth tile is coverage, which is counts rather than figures and has its
//      own function (`coverageFractions`) for the reason given there.
//   2. WHEN THERE IS A FIGURE AT ALL. Every value is `string | null`, and `null`
//      travels all the way to the tile, which prints the words for "no figure".
//      NOTHING IN THIS FILE MAY WRITE `?? 0`, `?? "0"` OR `Number(x) || 0`, and
//      `kpi.test.ts` walks the output of a failed run to prove none of them
//      appear: `calc/aggregate.ts` nulls every total of a failed run precisely so
//      that the sum of the lines that happened to work cannot be published, and
//      a `?? 0` on this side would undo that decision in the one place where a
//      person actually reads it.
//   3. kg → t (`@/shared/units`'s `kilogramsToTonnes`). The aggregate publishes
//      kilograms; VSME B3 and the PDF report tonnes. The shift is IMPORTED and
//      not re-typed here, so the dashboard headline and the rendered report
//      cannot round the same figure two ways.
//
// THE FIGURES THEMSELVES ARE NOT COMPUTED, RE-SUMMED OR RECONCILED HERE. They
// arrive as `GET /api/revisions/[id]/results`' own aggregate objects, passed
// through `GET /api/dashboard` unchanged (see `@/server/dashboard/dashboard`).
// This module changes their UNIT and nothing else.
// =============================================================================
import type { DashboardEmissions } from "@/server/dashboard/dashboard";
import { kilogramsToTonnes } from "@/shared/units";

/**
 * The five numeric tiles, in the order the block reads them: what the company
 * emitted, what it consumed, and the ratio VSME B3 asks for.
 *
 * A LIST RATHER THAN SIX CALLS, so `i18n.test.ts` can check that both locales
 * name every one of them: a tile whose label is missing would otherwise render
 * its own key (`scope2Mb`) at a user, identically in both languages, and
 * whole-file parity could not see it.
 */
export const KPI_KEYS = [
  "scope1",
  "scope2Lb",
  "scope2Mb",
  "energy",
  "intensity",
] as const;

/** One of {@link KPI_KEYS}. */
type KpiKey = (typeof KPI_KEYS)[number];

/**
 * The units a KPI tile prints in — a closed list, so the label of each is a
 * message key that the i18n suite can require in both locales.
 */
export const KPI_UNITS = ["tCO2e", "MWh", "intensityEur"] as const;

/** One of {@link KPI_UNITS}. */
type KpiUnit = (typeof KPI_UNITS)[number];

/** One tile. `value` is a decimal STRING in {@link KpiFigure.unit}, or nothing. */
export interface KpiFigure {
  readonly key: KpiKey;
  /**
   * The figure as a decimal string, already in `unit` — or `null`, which means
   * "no completed calculation published this" and NEVER "zero".
   */
  readonly value: string | null;
  readonly unit: KpiUnit;
  /** Decimals the tile shows. Presentation only — it moves no stored figure. */
  readonly decimals: number;
}

/** Decimals of a tonne figure on screen — a kilogram of CO₂e. */
const TONNE_DECIMALS = 3;

/** Decimals of an MWh figure on screen — a kilowatt-hour. */
const ENERGY_DECIMALS = 3;

/**
 * Decimals of an intensity on screen.
 *
 * Nine, because the quantity is genuinely tiny: a company with €10M of turnover
 * and 500 tCO₂e reports 0.00005 tCO₂e per EUR, and three places would round the
 * whole figure away to `0.000` — which is the one thing this screen may not
 * print. The renderer uses the same nine for the same reason.
 */
const INTENSITY_DECIMALS = 9;

/** kg → t, or nothing at all. The `null` is carried, never defaulted (§0.7). */
const tonnes = (kilograms: string | null): string | null =>
  kilograms === null ? null : kilogramsToTonnes(kilograms);

/**
 * The five figures of the block, for a revision whose run PUBLISHED something.
 *
 * `emissions.totals`/`energy`/`intensity` are `null` as a whole only when the
 * revision has never been calculated, and every field inside them is `null` when
 * the run failed — both cases come out of here as tiles with no value, which is
 * exactly what the screen needs to say either thing without inventing a number.
 */
export function kpiFigures(emissions: DashboardEmissions): KpiFigure[] {
  const totals = emissions.totals;
  const energy = emissions.energy;
  const intensity = emissions.intensity;
  return [
    {
      key: "scope1",
      value: tonnes(totals?.scope1Co2e ?? null),
      unit: "tCO2e",
      decimals: TONNE_DECIMALS,
    },
    {
      key: "scope2Lb",
      value: tonnes(totals?.scope2LocationBasedCo2e ?? null),
      unit: "tCO2e",
      decimals: TONNE_DECIMALS,
    },
    {
      key: "scope2Mb",
      value: tonnes(totals?.scope2MarketBasedCo2e ?? null),
      unit: "tCO2e",
      decimals: TONNE_DECIMALS,
    },
    {
      key: "energy",
      // Already MWh — CALC-3 denominated it, and re-scaling it here would be a
      // second opinion about a figure the run already settled.
      value: energy?.totalMwh ?? null,
      unit: "MWh",
      decimals: ENERGY_DECIMALS,
    },
    {
      key: "intensity",
      // LOCATION-BASED, the basis every VSME report must publish. The
      // market-based ratio is derivable from the tile beside it, and two
      // intensities in a headline row is a comparison nobody asked this screen
      // to make.
      value: intensity?.locationBasedIntensity ?? null,
      unit: "intensityEur",
      decimals: INTENSITY_DECIMALS,
    },
  ];
}

/** The two fractions the coverage tile reads (DM-8 — a total needs a boundary). */
export interface CoverageFraction {
  readonly key: "legalEntities" | "facilities";
  readonly included: number;
  readonly total: number;
}

/**
 * Coverage as two `included of total` pairs.
 *
 * THESE ARE COUNTS, AND A COUNT OF NOTHING IS A REAL ZERO. "0 of 3 entities in
 * the boundary" is a fact the user entered, not a figure a calculation withheld
 * — which is why this function returns numbers where {@link kpiFigures} returns
 * `string | null`. The two kinds of "zero" are different and the types say so.
 */
export function coverageFractions(
  emissions: DashboardEmissions,
): CoverageFraction[] {
  return [
    {
      key: "legalEntities",
      included: emissions.coverage.legal_entities_included,
      total: emissions.coverage.legal_entities_total,
    },
    {
      key: "facilities",
      included: emissions.coverage.facilities_included,
      total: emissions.coverage.facilities_total,
    },
  ];
}

/**
 * Does the block show TILES at all?
 *
 * `ok` and `stale` do — a stale run's figures are real figures, published by a
 * run somebody approved, and hiding them because a row moved afterwards would
 * withhold the only totals the company has. They are shown WITH the notice that
 * says what moved.
 *
 * `failed` and `no_run` do not. There is no figure to show in either — every
 * value would be the "no figure" wording, and six empty tiles say less than one
 * sentence explaining which lines failed or that nothing has been calculated.
 */
export function showsFigures(emissions: DashboardEmissions): boolean {
  return emissions.state === "ok" || emissions.state === "stale";
}
