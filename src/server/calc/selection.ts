// =============================================================================
// CALC-1 — WHICH ROWS A RUN LOOKS AT, AND WHICH YEAR IT PRICES THEM IN.
//
// A LEAF: no database, no imports of ours. It exists because CALC-1 is one rule
// applied to FOUR tables — `emission_activity` (T5.2), `purchased_energy_
// activity` and `contractual_instrument` (T5.3), `disclosure_record` (a report
// input, not a calculation one) — and a rule copied per table is a rule that
// drifts per table. The four share the 20-column lifecycle mixin (§4.8), so the
// filter can be expressed once over the four columns it actually reads.
//
// THE RULE, VERBATIM FROM CALC-1: the current, approved, undeleted rows whose
// `year_month` falls in the period —
//   `superseded_by_id IS NULL AND is_deleted = false AND state = 'approved'`
// plus the window test below. Each rejection is REPORTED rather than silently
// filtered, because "the report is missing a site" and "the site's rows are
// still in draft" look identical in a total and very different in a review.
// =============================================================================

/**
 * The period a run is for: its window and the factor set it PINS (§4.5, К-24).
 *
 * `factorSetId` is here rather than beside the factors because it is a property
 * of the PERIOD — the pin is what CALC-7/AC-8 rest on, and a resolver that took
 * "the current set" instead would reproduce a locked report differently the day
 * an admin published a new one.
 */
export interface CalcPeriod {
  /** `YYYY-MM-DD`, inclusive. */
  readonly startDate: string;
  /** `YYYY-MM-DD`, inclusive. */
  readonly endDate: string;
  /** `reporting_period.factor_set_id` — never a "latest" lookup. */
  readonly factorSetId: string;
}

/**
 * Why CALC-1's filter dropped a row. Every rejection has exactly one.
 *
 * @public
 */
export const CALC1_EXCLUSION_REASONS = [
  /** `superseded_by_id IS NOT NULL` — an older version of a row (D5). */
  "superseded",
  /** `is_deleted = true` — a tombstone (К-21). */
  "deleted",
  /** `state <> 'approved'` — still draft, not part of the report yet. */
  "not_approved",
  /** `year_month` names a month that is not wholly inside the period. */
  "outside_period",
] as const;

/** One value of {@link CALC1_EXCLUSION_REASONS}. */
export type Calc1ExclusionReason = (typeof CALC1_EXCLUSION_REASONS)[number];

/**
 * The four lifecycle columns CALC-1 reads — a structural subset, so any of the
 * four input tables (and a test literal) satisfies it without a cast.
 */
export interface Calc1Selectable {
  readonly supersededById: string | null;
  readonly isDeleted: boolean;
  readonly state: string;
  readonly yearMonth: string | null;
}

/** `state` a row must hold to be calculated (CALC-1). */
const APPROVED_STATE = "approved";

/** The last day of `YYYY-MM`, leap years included. */
function lastDayOfMonth(yearMonth: string): string {
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(5, 7));
  // Day 0 of the NEXT month is the last day of this one; UTC keeps the local
  // timezone of whoever runs the calculation out of the answer.
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${yearMonth}-${String(day).padStart(2, "0")}`;
}

/**
 * CALC-1's window test: a month counts when it lies WHOLLY inside the period.
 *
 * `year_month = NULL` means "a record for the whole period" (DM-11) and is
 * always in — that is the NORMAL case for a `contractual_instrument` (§4.11),
 * whose vintage window is a separate pair of columns and is prorated by CALC-5
 * rather than tested here.
 *
 * A month straddling an edge is out: §9 names the partial month as a deferred
 * rule (D3/D12), and the two honest readings of a half-month (count it, prorate
 * it) disagree by an amount nobody has decided, so the calculation refuses to
 * pick one. Period edges are monthly in practice, so this stays theoretical
 * until the rule lands.
 */
function isInsidePeriod(yearMonth: string | null, period: CalcPeriod): boolean {
  if (yearMonth === null) return true;
  return (
    `${yearMonth}-01` >= period.startDate &&
    lastDayOfMonth(yearMonth) <= period.endDate
  );
}

/** CALC-1's four rejections, in the order a reviewer would check them. */
export function calc1Exclusion(
  row: Calc1Selectable,
  period: CalcPeriod,
): Calc1ExclusionReason | null {
  if (row.supersededById !== null) return "superseded";
  if (row.isDeleted) return "deleted";
  if (row.state !== APPROVED_STATE) return "not_approved";
  if (!isInsidePeriod(row.yearMonth, period)) return "outside_period";
  return null;
}

/**
 * The `applicable_year` CALC-2 resolves against: the row's own month-year, or —
 * for a whole-period row (`year_month IS NULL`) — the year the period ENDS in,
 * the same convention CALC-8 uses to pick an FX rate.
 */
export function applicableYearFor(
  yearMonth: string | null,
  period: CalcPeriod,
): number {
  return Number((yearMonth ?? period.endDate).slice(0, 4));
}
