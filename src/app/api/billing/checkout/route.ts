/**
 * POST /api/billing/checkout — open a Revolut order for a subscription plan
 * (BILLING §4, T-B2). The server half of the embedded-widget checkout; the widget
 * page is a later task (T-B3).
 *
 * The client sends ONLY `{plan, period}` — never a price. The amount is read
 * SERVER-SIDE from `plan_prices` (§0.3: money is integer minor units), so the body
 * can never influence what is charged. Identity (companyId, userId, email) comes
 * ONLY from `getSession()` (PATTERN 3), never from the request. The route opens a
 * Revolut order via the T-B1 client, records a `pending` `payments` row, and
 * returns ONLY the order `token` + the public widget key (`pk_…`) — the `sk_…`
 * secret and every internal id stay server-side. If the Revolut order fails to
 * open, the just-written pending payment is marked `failed` (no order id exists,
 * so a webhook could never reconcile it) and the client gets an opaque UNKNOWN.
 *
 * Layer-B scope: this route does NOT touch `company_subscription` lifecycle. When
 * a live subscription with a saved Revolut customer exists we reuse it; otherwise
 * the order is opened with `customer:{email}` and Revolut creates/attaches the
 * customer during order creation — T-C1 reads the customer id off the completed
 * order and persists it. The free/trial path returns `{free:true}` and opens no
 * order (full activation is also T-C1).
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import { and, eq, inArray } from "drizzle-orm";

import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { RevolutError, createOrder } from "@/server/billing/revolut";
import type { RevolutOrder } from "@/server/billing/revolut";
import { db } from "@/server/db";
import { companySubscription, payments, planPrices } from "@/server/db/schema";
import type { PlanId } from "@/shared/plans";

const PLAN_IDS: readonly PlanId[] = ["trial", "starter", "pro", "enterprise"];
// Annual only (партия 16): a new subscription is a 12-month one. Existing
// monthly subscriptions keep renewing; they just cannot be started here.
const PERIODS = ["annual"] as const;
type Period = (typeof PERIODS)[number];

/** A live subscription (§7.3) can carry a reusable Revolut customer. */
const LIVE_SUB_STATUSES = ["trialing", "active", "past_due"] as const;

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) — opening a checkout is a billing capability (§7.3).
  const forbidden = requireCapability(session, "billing.manage");
  if (forbidden) return apiResult(req, forbidden);

  // ── 1. Validate the body: only {plan, period}; price is NEVER read from it. ──
  const body = (await req.json().catch(() => ({}))) as {
    plan?: unknown;
    period?: unknown;
  };
  const { plan, period } = body;
  if (
    typeof plan !== "string" ||
    !PLAN_IDS.includes(plan as PlanId) ||
    typeof period !== "string" ||
    !PERIODS.includes(period as Period)
  ) {
    console.error("POST /api/billing/checkout: invalid body", { plan, period });
    return apiResult(req, { ok: false, error: "VALIDATION" });
  }
  const planId = plan as PlanId;
  const billingPeriod = period as Period;

  // ── 2. Price SERVER-SIDE from plan_prices (EUR). Missing row → VALIDATION. ───
  const [price] = await db
    .select({ amountMinor: planPrices.amountMinor })
    .from(planPrices)
    .where(
      and(
        eq(planPrices.planId, planId),
        eq(planPrices.period, billingPeriod),
        eq(planPrices.currency, "EUR"),
      ),
    )
    .limit(1);
  if (!price) {
    console.error("POST /api/billing/checkout: no plan_prices row", {
      planId,
      billingPeriod,
    });
    return apiResult(req, { ok: false, error: "VALIDATION" });
  }
  const amountMinor = price.amountMinor;

  // ── 3. Free path: no Revolut order, no payment row (activation is T-C1). ─────
  if (planId === "trial" || amountMinor === 0) {
    return apiResult(req, { ok: true, data: { free: true } });
  }

  // ── 4. Attach the customer WITHOUT creating a company_subscription here. ─────
  // Reuse a saved Revolut customer if a live subscription already has one; else
  // pass the email and let Revolut create/attach the customer on order creation
  // (T-C1 persists the id off the completed order). No subscription row is written.
  const [sub] = await db
    .select({ revolutCustomerId: companySubscription.revolutCustomerId })
    .from(companySubscription)
    .where(
      and(
        eq(companySubscription.companyId, company.id),
        inArray(companySubscription.status, [...LIVE_SUB_STATUSES]),
      ),
    )
    .limit(1);
  const customer: { id?: string; email?: string } = sub?.revolutCustomerId
    ? { id: sub.revolutCustomerId }
    : { email: session.email };

  // ── 5. Record the pending payment (UNIQUE idempotencyKey protects the table). ─
  const idempotencyKey = crypto.randomUUID();
  const [payment] = await db
    .insert(payments)
    .values({
      companyId: company.id,
      userId: session.userId,
      kind: "subscription",
      status: "pending",
      amountMinor,
      currency: "EUR",
      payload: { kind: "subscription", plan: planId, period: billingPeriod },
      idempotencyKey,
    })
    .returning({ id: payments.id });

  // ── 6. Open the Revolut order. On a RevolutError no order exists at Revolut, so
  // the webhook (keyed on order_id) can never reconcile this row — mark it `failed`
  // so it's terminal, not permanently `pending`. We surface UNKNOWN rather than
  // leak the API error body. ────────────────────────────────────────────────────
  const appOrigin = process.env.BETTER_AUTH_URL;
  let order: RevolutOrder;
  try {
    order = await createOrder(
      {
        amount: amountMinor,
        currency: "EUR",
        capture_mode: "automatic",
        customer,
        // Omit rather than send a broken URL when the origin is unconfigured.
        ...(appOrigin ? { redirect_url: `${appOrigin}/billing/return` } : {}),
        metadata: { payment_id: payment.id, company_id: company.id },
      },
      { idempotencyKey },
    );
  } catch (e) {
    if (e instanceof RevolutError) {
      console.error(
        "POST /api/billing/checkout: Revolut createOrder failed",
        e,
      );
      await db
        .update(payments)
        .set({ status: "failed" })
        .where(eq(payments.id, payment.id));
      return apiResult(req, { ok: false, error: "UNKNOWN" });
    }
    throw e;
  }

  // ── 7. Link the order to the payment; then return ONLY token + public key. ───
  await db
    .update(payments)
    .set({ revolutOrderId: order.id })
    .where(eq(payments.id, payment.id));

  return apiResult(req, {
    ok: true,
    data: {
      token: order.token,
      publicKey: process.env.NEXT_PUBLIC_REVOLUT_PUBLIC_KEY,
    },
  });
});

export const OPTIONS = optionsHandler;
