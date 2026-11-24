// T-B3: pure helpers for the `/billing` checkout widget page. Kept free of React
// and the Revolut SDK so they can be unit-tested in isolation (node env).
//
// `parseCheckoutTarget` is the trust boundary between the URL query
// (`?plan=pro&period=monthly`, honoured because upgrade CTAs link here with those
// params) and the `POST /api/billing/checkout` call: only a PAID plan plus a valid
// billing period yields a target — the free `trial` plan and anything unrecognised
// return `null`, so the page shows its plan/period picker instead of charging.
// The server re-validates plan+period and prices server-side (T-B2), so this is a
// UX gate, not a security control.

/** Plans that have a price and can be paid for via the widget (trial is free). */
export const PAID_PLAN_IDS = ["starter", "pro", "enterprise"] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

/**
 * Billing periods a customer can BUY. Annual only (партия 16, 15.09.2026): the
 * public page sells a 12-month subscription and nothing else, so the checkout
 * offers nothing else. `plan_prices` keeps its monthly rows for the
 * subscriptions that already run on them; they simply cannot be started anew.
 */
const CHECKOUT_PERIODS = ["annual"] as const;
export type CheckoutPeriod = (typeof CHECKOUT_PERIODS)[number];

export interface CheckoutTarget {
  plan: PaidPlanId;
  period: CheckoutPeriod;
}

function isPaidPlan(value: string): value is PaidPlanId {
  return (PAID_PLAN_IDS as readonly string[]).includes(value);
}

function isPeriod(value: string): value is CheckoutPeriod {
  return (CHECKOUT_PERIODS as readonly string[]).includes(value);
}

/**
 * Validate a `{plan, period}` pair coming from URL search params. Returns a typed
 * target only when `plan` is a paid plan and `period` is valid; otherwise `null`.
 */
export function parseCheckoutTarget(
  plan: string | null | undefined,
  period: string | null | undefined,
): CheckoutTarget | null {
  if (!plan || !period) return null;
  if (!isPaidPlan(plan) || !isPeriod(period)) return null;
  return { plan, period };
}

export interface BillingAddressInput {
  countryCode?: string | null;
  city?: string | null;
  postcode?: string | null;
  streetLine1?: string | null;
}

export interface BillingAddress {
  countryCode: string;
  city: string;
  postcode: string;
  streetLine1: string;
}

/**
 * Build the `billingAddress` passed to `cardField.submit`. Revolut accepts cards
 * more reliably with a full address, but we must never block submit on a missing
 * field — so blanks fall back to sandbox-safe defaults. A 2-letter country code is
 * upper-cased (Revolut expects ISO-3166 alpha-2).
 */
export function buildBillingAddress(
  input: BillingAddressInput,
): BillingAddress {
  const clean = (v: string | null | undefined) => v?.trim() || "";
  const country = clean(input.countryCode).toUpperCase();
  // Only an ISO 3166-1 alpha-2 code is valid here. Reject anything else (a
  // 3-letter code sliced to 2 would be a *wrong* country, e.g. "SVN"→"SV") and
  // fall back to the default rather than silently corrupting the value.
  const countryCode = /^[A-Z]{2}$/.test(country) ? country : "GB";
  return {
    countryCode,
    city: clean(input.city) || "London",
    postcode: clean(input.postcode) || "SW1A 1AA",
    streetLine1: clean(input.streetLine1) || "1 Test Street",
  };
}
