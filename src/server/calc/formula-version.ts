// THE CALCULATION CONTRACT (T5.1 — CALC-2/3/4, CALC-7, §0.7, VAL-034).
//
// See docs/decisions/server-calc-formula-version.md for the full account.

/**
 * The identifier stamped into `calculation.formula_version` (DM-29). Bump it
 * whenever anything in {@link FORMULA_DEFINITION} changes — a human-readable
 * string, not a hash, so a reviewer can see which methodology a run used.
 * 1.1.0 market-based matching; 1.2.0 supplier rung matches the supplier;
 * 1.3.0 unit-distance rung; 1.4.0 set-scoped conversions; 1.5.0 output units. Stored rows never
 * move: a locked revision reproduces under the version it was produced with.
 *
 * See docs/decisions/formula-version-history.md for the full account.
 */
export const FORMULA_VERSION = "hosmos-calc-1.5.0";

/**
 * The geography ladder of CALC-2, best tier FIRST. **This array is the single
 * source of truth for the order** — `factors.ts` does not repeat it, it maps a
 * predicate onto each name through an exhaustive `Record`, so a tier added here
 * is a COMPILE ERROR until its predicate exists, and a tier added there is
 * impossible without touching this file (and therefore the version).
 *
 *   - `supplier_specific` — a factor published by THE ROW'S OWN energy supplier
 *     (`emission_factor.supplier_name` matches the activity row's `supplier`,
 *     0007). Beats geography because it describes the actual product bought,
 *     not the average grid around it — which is true only of the seller the row
 *     actually buys from, hence the identity match rather than a mere
 *     `source_name = 'supplier'` flag.
 *   - `site_country` — `geography` equals the facility's country (VAL-021 makes
 *     that country mandatory for Scope 2).
 *   - `global` — the `GLOBAL` fallback row.
 */
export const FACTOR_PRIORITY_TIERS = [
  "supplier_specific",
  "site_country",
  "global",
] as const;

/** One rung of {@link FACTOR_PRIORITY_TIERS}. */
export type FactorPriorityTier = (typeof FACTOR_PRIORITY_TIERS)[number];

/**
 * HOW FAR a factor is from the unit the activity row was ENTERED in, nearest
 * FIRST. The rung above {@link UNIT_CONVERSION_BASES} and below
 * {@link FACTOR_PRIORITY_TIERS}.
 *
 *   - `as_entered` — the factor is priced in the quantity the row was entered
 *     in and the entered number reaches it UNCHANGED: either the units are
 *     identical (the identity conversion) or `unit_conversion` renames one onto
 *     the other at exactly ×1.
 *   - `converted` — anything else: a conversion that multiplies the number by
 *     something other than one, whatever its basis.
 *
 * ── WHY ×1 COUNTS AS "AS ENTERED", AND NOT MERELY AN EQUAL UNIT CODE ────────
 * Because two unit CODES can name one quantity. `kWh` and `kWh_gross` are the
 * same kilowatt-hour under two names — the conversion table says so with an
 * explicit ×1 row and the note "a billed kWh is Gross CV (DEFRA convention)" —
 * and it is precisely that pair the rung exists to rank. Read as "the strings
 * are equal" the rung would score all three of `legacy-v1`'s gas factors alike
 * for a `kWh` row and would fix nothing at all. Read as "the number does not
 * change" it says the thing that actually matters: no calorific value, no
 * density, no published ratio stands between the invoice and the factor.
 *
 * ── WHY IT OUTRANKS THE CONTEXTUAL/UNIVERSAL BASIS ──────────────────────────
 * That basis ranks two ways of CHANGING a number, and says a fuel-specific
 * calorific value beats generic physics — true, and irrelevant when there is a
 * factor that needs no change at all. Every conversion, contextual ones very
 * much included, is a modelled ratio: `kWh → kWh_net` is DEFRA's 0.9026 and
 * `kWh → m3` is a calorific value of 11.0342 kWh/m³. Applying one where the set
 * already publishes a factor on the entered basis substitutes a derived number
 * for a published one, and — as the gas case proves — leaves two derived
 * routes tied with nothing to choose between them.
 *
 * ── WHY IT DOES NOT OUTRANK GEOGRAPHY ───────────────────────────────────────
 * The same argument `factors.ts` makes for the basis rung, unchanged: a
 * conversion is arithmetic on the right country's measurement, while a
 * geography fallback is a different country's measurement. A GLOBAL factor
 * priced in the row's own unit is still a GLOBAL factor, so a Slovenian factor
 * reached through a calorific value beats it.
 */
export const UNIT_CONVERSION_DISTANCES = ["as_entered", "converted"] as const;

/** One rung of {@link UNIT_CONVERSION_DISTANCES}. */
export type UnitConversionDistance = (typeof UNIT_CONVERSION_DISTANCES)[number];

/**
 * The unit-conversion preference of CALC-3, best FIRST. TWO DIMENSIONS, flattened
 * into one total order because that is what a rank tuple can compare: the outer
 * one is WHOSE row it is (the pinned factor set's own, or the shared table's),
 * the inner one is how specific the row is (contextual, then universal).
 *
 *   - `identity` — the activity's unit already IS the factor's `input_unit`;
 *     no row is read and the recorded multiplier is exactly 1.
 *   - `set_contextual` — a `unit_conversion` row belonging to the PINNED SET
 *     (`factor_set_id` = the period's pin, 0010) whose `activity_context`
 *     matches the activity type: this methodology's own calorific value.
 *   - `set_universal` — a row of the pinned set with `activity_context IS NULL`:
 *     a statement the set makes about every activity in it.
 *   - `contextual` — a SHARED row (`factor_set_id IS NULL`) whose
 *     `activity_context` matches (a calorific value: `natural_gas: m3 → kWh`).
 *   - `universal` — a shared row with `activity_context IS NULL` (physics:
 *     `kWh → MWh`).
 *
 * Contextual before universal is not a preference, it is correctness: a cubic
 * metre of gas converts to kWh only through that gas's calorific value, and the
 * universal table has no opinion about cubic metres of anything.
 *
 * ── WHY THE SET'S OWN ROW OUTRANKS EVEN A SHARED CONTEXTUAL ONE (1.4.0) ─────
 * Because the shared contextual row is a calorific value too, and a calorific
 * value is a MEASUREMENT of one country's fuel — i.e. part of a methodology, not
 * physics. The shared table's `natural_gas: m3 → kWh` is DEFRA's 11.0342 kWh/m³;
 * `si-2025` prices Slovenian gas from ARSO, whose own figure (implied by the
 * workbook's `conversion_to_gj = 0.037177 GJ/Nm³`) is 10.3269444444… kWh/m³. A
 * Slovenian bill of 1 kWh therefore came out as 0.186993… through the m³ factor
 * and 0.180337… through the kWh_net factor — 3.69% apart, tied on every rung of
 * the ladder, and CALC-2 refused with `FACTORS_AMBIGUOUS` rather than picking
 * one. Ranking the SCOPE above the basis is what lets the set state its own
 * calorific value and be believed. It does not weaken AC-8: the set is pinned
 * per period (К-24) and snapshotted per calculation row (DM-29), so a locked
 * revision still reads exactly the conversions it read when it was locked.
 */
export const UNIT_CONVERSION_BASES = [
  "identity",
  "set_contextual",
  "set_universal",
  "contextual",
  "universal",
] as const;

/** One rung of {@link UNIT_CONVERSION_BASES}. */
export type UnitConversionBasis = (typeof UNIT_CONVERSION_BASES)[number];

/**
 * `calculation.rounding_rule` — half-up to 6 decimal places, applied ONCE to the
 * stored kgCO2e result and never to an intermediate.
 *
 * Six places on a kilogram is a milligram of CO₂e: far below any factor's own
 * precision (the legacy set carries 5–6 significant digits), so the rounding
 * cannot bend a reported tonne, while still giving two runs of the same inputs
 * a bit-identical decimal string to compare (CALC-7/AC-8). Rounding earlier —
 * per multiplication — is what makes a chain of unit conversions drift, which
 * is why the rule names the moment as well as the precision.
 */
export const ROUNDING_RULE = "half_up_6dp";

/** Decimal places {@link ROUNDING_RULE} keeps. */
export const ROUNDING_DECIMALS = 6;

/**
 * VAL-034's tolerance: the sum of the detail rows may differ from the published
 * total by at most 0.5% RELATIVE.
 *
 * It exists because the detail rows are rounded and the total is a sum of
 * rounded things; it is deliberately far larger than {@link ROUNDING_DECIMALS}
 * can produce, so any hit is a real accounting gap and not float noise.
 */
export const VAL_034_TOLERANCE = 0.005;

/**
 * VAL-024's tolerance — the market-based balance `covered + residual =
 * consumption` may miss by at most 0.5% of the consumption.
 *
 * IT IS THE SAME NUMBER AS {@link VAL_034_TOLERANCE}, DELIBERATELY AND BY
 * REFERENCE rather than by a second literal. Both rules ask one question — "do
 * the parts add up to the whole" — and the version fixes exactly ONE
 * aggregation tolerance; two literals is how they end up 0.5% and 0.05% after a
 * correction touches one of them.
 *
 * WHY A TOLERANCE AT ALL, when `residual` is DEFINED as `consumption − covered`
 * and the identity is therefore exact by construction. Because the rule does
 * not read the engine's variables, it reads STORED `numeric` strings: each
 * volume is a 6-decimal literal, so a legal entity with `n` energy rows can
 * accumulate up to `n × 10⁻⁶` MWh of last-place drift, and a prorated
 * instrument volume adds one more. That is nanoscopic beside 0.5%, which is the
 * point — anything this rule reports is a real hole (a row whose consumption
 * reached neither column, or a declared residual that contradicts the
 * calculation), never rounding.
 *
 * @alias
 */
export const VAL_024_TOLERANCE = VAL_034_TOLERANCE;

/**
 * CALC-5's matching granularity: instruments are matched against a LEGAL
 * ENTITY's whole-period consumption, never against a facility's.
 *
 * §9 says it outright, and adds why `facility_id` is on the instrument anyway:
 * it decides the ORDER of consumption (see {@link INSTRUMENT_CONSUMPTION_ORDER})
 * and nothing else. Site-level matching is deferred.
 */
const MATCHING_GRANULARITY = "legal_entity";

/** The unit CALC-5 matches in — `covered_volume` is MWh by DM-17 (§4.11). */
export const MATCHING_UNIT = "MWh";

/**
 * The order instruments are consumed in, best claim FIRST (§9).
 *
 *   - `facility_bound` — the instrument names a `facility_id`. It is offered
 *     THAT site's rows first and only spills onto the rest of the entity's
 *     consumption with whatever is left, which is what makes "the site is
 *     covered by its own PPA" survive the presence of an entity-wide GoO.
 *   - `entity_level` — no `facility_id`; it consumes whatever remains.
 *
 * Within one rank the order is NOT the order rows came out of the database —
 * see `scope2.ts`, `instrumentOrderKey`. That was T5.1's lesson about factors
 * and it applies with more force here, because when the cap binds the order
 * decides WHICH instrument is the one that was cut.
 */
export const INSTRUMENT_CONSUMPTION_ORDER = [
  "facility_bound",
  "entity_level",
] as const;

/** One rank of {@link INSTRUMENT_CONSUMPTION_ORDER}. */
export type InstrumentConsumptionRank =
  (typeof INSTRUMENT_CONSUMPTION_ORDER)[number];

/**
 * Decimal places the VINTAGE PRORATION keeps — the precision policy of the
 * engine's one quotient (`decimal.ts`, `divideHalfUp`).
 *
 * Six places on an MWh is a watt-hour, five orders of magnitude below any meter
 * this system will ever read, and the same width `ROUNDING_DECIMALS` uses for a
 * kilogram. A whole-window instrument never reaches the quotient at all
 * (`scope2.ts` short-circuits `overlap = window` to the exact volume), so this
 * only bites on a genuinely partial vintage.
 */
export const PRORATION_DECIMALS = 6;

/**
 * The ladder CALC-5 prices the UNMATCHED remainder by, best FIRST.
 *
 * The matched half needs no ladder: a cancelled GoO/REGO/REC/PPA/green tariff
 * IS a zero-emission attribute claim, which is a GENUINE zero (VAL-033 says
 * those exist) and not §0.7's forbidden substitute for a factor nobody found.
 * The remainder is the part that still has to be priced:
 *
 *   - `supplier_specific` — the row names a supplier and the pinned set carries
 *     that supplier's own factor. CALC-2's top rung (T5.1) already implements
 *     it; market-based is simply the query that PASSES the supplier, while
 *     location-based is the one that does not.
 *   - `residual_mix` — the untracked-attribute mix of the site's country,
 *     `activity_type = 'grid:residual_mix'`. Only electricity has one.
 *   - `grid_average` — the location-based factor itself, the GHGP hierarchy's
 *     last rung. It is REPORTED on the line (`marketFactorBasis`) rather than
 *     applied quietly: for district heating there is no attribute market to
 *     strip and the two bases genuinely coincide, but for electricity it means
 *     the set has no residual mix yet and the market-based figure is understated
 *     against a true one. A renderer that cannot see that would print a claim
 *     the data does not support.
 */
const MARKET_FACTOR_BASES = [
  "supplier_specific",
  "residual_mix",
  "grid_average",
] as const;

/** One rung of {@link MARKET_FACTOR_BASES}. */
export type MarketFactorBasis = (typeof MARKET_FACTOR_BASES)[number];

/**
 * The four values `calculation.calculation_status` may hold (CALC-2/CALC-3).
 *
 * THE THREE FAILURES ARE THE POINT (§0.7). A calculation that cannot find its
 * factor does not produce a zero — a zero is indistinguishable from a genuine
 * zero (VAL-033 says those exist), it survives into a signed report, and nobody
 * audits a number that looks fine. So the row is stored with its reason and the
 * whole run is `failed`, blocking approve, render and lock.
 *
 *   - `failed_missing_factor` — no eligible factor at all in the pinned set.
 *   - `failed_unit` — a factor exists, but no conversion path reaches its
 *     `input_unit` from the unit the row was entered in.
 *   - `failed_ambiguous_factor` — several factors survived the whole ladder
 *     (CALC-2); the run raises `FACTORS_AMBIGUOUS` rather than picking one.
 *
 * @public
 */
export const CALCULATION_STATUSES = [
  "ok",
  "failed_missing_factor",
  "failed_unit",
  "failed_ambiguous_factor",
] as const;

/** One value of `calculation.calculation_status`. */
export type CalculationStatus = (typeof CALCULATION_STATUSES)[number];

/**
 * EVERYTHING {@link FORMULA_VERSION} identifies, in one readable object.
 *
 * It is not consumed by the engine (the engine reads the individual constants);
 * it exists so the version has a written meaning that a test can pin and a
 * reviewer can diff. `factor_snapshot` (T5.4) embeds the version string; this is
 * what that string resolves to.
 */
export const FORMULA_DEFINITION = {
  version: FORMULA_VERSION,
  formula:
    "co2e_kg = input_value × conversion_factor × factor_value × output_to_kg",
  outputUnitRule:
    "kgCO2e ×1; tCO2e ×1000; unsupported or energy numerators failed_unit; round only the final line",
  factorPriority: FACTOR_PRIORITY_TIERS,
  factorSupplierRule:
    "the supplier_specific rung admits a factor only when its `supplier_name` " +
    "is the SAME seller as the activity row's `supplier` (compared case- and " +
    "whitespace-insensitively, never fuzzily); a factor of any other supplier " +
    "is on no rung at all and can price no row",
  factorYearRule:
    "exact applicable_year, else a year-agnostic (NULL) factor of the same tier; " +
    "a factor published for a DIFFERENT year never substitutes",
  factorTieBreak:
    "greatest publication_date (NULL counts as the oldest); a surviving tie " +
    "raises FACTORS_AMBIGUOUS and never picks a candidate",
  unitDistance: UNIT_CONVERSION_DISTANCES,
  unitDistanceRule:
    "a factor priced in the quantity the row was ENTERED in — the same unit, " +
    "or one `unit_conversion` renames it onto at exactly ×1 — outranks every " +
    "factor reached by a conversion that changes the number, whatever that " +
    "conversion's basis; the rung sits BELOW geography and ABOVE the " +
    "contextual/universal preference",
  unitConversion: UNIT_CONVERSION_BASES,
  unitConversionRule:
    "a `unit_conversion` row belonging to the period's PINNED factor set " +
    "outranks a shared one (`factor_set_id IS NULL`) whatever their bases, " +
    "because a calorific value is a measurement of one country's fuel and " +
    "therefore part of a methodology; contextual still beats universal INSIDE " +
    "each scope, and a row belonging to any OTHER set is on no rung at all",
  roundingRule: ROUNDING_RULE,
  roundingDecimals: ROUNDING_DECIMALS,
  aggregationTolerance: VAL_034_TOLERANCE,
  balanceTolerance: VAL_024_TOLERANCE,
  scope2Matching: {
    granularity: MATCHING_GRANULARITY,
    unit: MATCHING_UNIT,
    prorationRule:
      "an instrument's volume is multiplied by (days of its vintage window " +
      "inside the period) / (days of that window); a window with an open end " +
      "is closed at the period's edge, and a window wholly outside the period " +
      "contributes nothing",
    prorationDecimals: PRORATION_DECIMALS,
    consumptionOrder: INSTRUMENT_CONSUMPTION_ORDER,
    cap: "the matched total is capped by the legal entity's period consumption",
    marketFactorLadder: MARKET_FACTOR_BASES,
    matchedFactor:
      "a cancelled attribute certificate prices its matched MWh at an explicit " +
      "zero; `supplier_product` is not a volume claim and is priced through the " +
      "supplier_specific rung instead",
  },
} as const;
