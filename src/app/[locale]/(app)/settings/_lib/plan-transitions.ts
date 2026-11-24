// T-C3: pure helpers for the settings "Billing & Plan" modal. React-free so they
// unit-test in isolation. Money here is DISPLAY only — the server re-prices every
// transition from `plan_prices`; these values must merely stay visually in sync
// with the seed rule (annual = 10 × monthly, ~17% off — see 0001_billing.sql).

import { PLAN_ORDER, type PlanId } from "@/shared/plans";

/** Annual bills 10 months (two months free) — the seeded `plan_prices` rule. */
export const ANNUAL_MONTHS_CHARGED = 10;

/** Badge copy for the annual saving (12 → 10 months ≈ 17% off). */
export const ANNUAL_DISCOUNT_LABEL = "−17%"; // −17%

/** Display annual price for a monthly amount (server is the charge authority). */
export function annualPrice(monthly: number): number {
  return monthly * ANNUAL_MONTHS_CHARGED;
}

export type TransitionKind = "upgrade" | "downgrade" | "same";

/**
 * Direction of a plan change by `PLAN_ORDER` rank — the same ordering the server
 * (`/api/billing/subscription`) uses to accept an upgrade vs a downgrade. Drives
 * which action the modal button POSTs.
 */
export function transitionKind(
  current: PlanId,
  target: PlanId,
): TransitionKind {
  const c = PLAN_ORDER.indexOf(current);
  const t = PLAN_ORDER.indexOf(target);
  if (t > c) return "upgrade";
  if (t < c) return "downgrade";
  return "same";
}
