export const UNITS = {
  // ── Emissions ──────────────────────────────────────────────────────────
  tCO2e: "tCO₂e",
  kgCO2e: "kgCO₂e",
  co2e: "CO₂e",
  co2: "CO₂",

  // ── Emission factors (compound) ────────────────────────────────────────
  gCO2PerKwh: "gCO₂/kWh",
  kgCO2ePerKwh: "kgCO₂e/kWh",
  kgCO2ePerKm: "kgCO₂e/km",
  kgCO2ePerKg: "kgCO₂e/kg",

  // ── Energy ─────────────────────────────────────────────────────────────
  kWh: "kWh",
  kWhPerKm: "kWh/km",
  kWhPerYear: "kWh/yr",

  // ── Volume ─────────────────────────────────────────────────────────────
  m3: "m³",

  // ── Distance ───────────────────────────────────────────────────────────
  km: "km",
  pkm: "pkm",
  tkm: "tkm",

  // ── Fuel / mass ────────────────────────────────────────────────────────
  litres: "L",
  kg: "kg",
  tonnes: "t",

  // ── Money ──────────────────────────────────────────────────────────────
  eur: "EUR",
  eurSymbol: "€",

  // ── Ratio ──────────────────────────────────────────────────────────────
  percent: "%",
} as const;

/**
 * kg → t as a decimal-point shift of THREE places.
 *
 * Written as the exponent rather than as `1000` because the conversion below is
 * a string operation, not a division.
 */
const KG_PER_TONNE_EXPONENT = 3;

/**
 * kg → t, as a decimal STRING, WITHOUT going through a double.
 *
 * A division by 1000 in base ten is a decimal-point shift, so it is done as one:
 * `Number(kg) / 1000` would be correct for every figure this product will ever
 * carry and wrong in principle, and the principle is the one
 * `server/calc/decimal.ts` exists to defend — every reported figure travels as a
 * decimal string from the `numeric` column to the page, and never becomes a
 * float on the way.
 *
 * IT LIVES IN `shared/` BECAUSE TWO SURFACES PRINT THE SAME FIGURE: the report
 * renderer (`server/render/i18n.ts`, VSME B3 in tonnes) and the `/dashboard` KPI
 * block (T5.9), which shows the totals of the very run the report is made from.
 * Two copies of this shift would be two ways to round the same headline.
 *
 * `null` IS NOT CONVERTED AND NOT DEFAULTED — a figure a calculation withheld
 * stays withheld (§0.7). The signature says so.
 */
export function kilogramsToTonnes(kilograms: string): string {
  const negative = kilograms.startsWith("-");
  const bare = negative ? kilograms.slice(1) : kilograms;
  const [whole, fraction = ""] = bare.split(".");
  const digits = `${whole}${fraction}`;
  const point = whole.length - KG_PER_TONNE_EXPONENT;
  const shifted =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${negative ? "-" : ""}${shifted}`;
}
