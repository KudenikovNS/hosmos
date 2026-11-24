/**
 * POST /api/billing/subscription — the subscription-transition engine (BILLING §8,
 * T-C2). One endpoint, four actions: `upgrade | downgrade | cancel | resume`.
 *
 *   • upgrade   — applied IMMEDIATELY with a server-computed PRORATED charge. The
 *                 renewal date (`currentPeriodEnd`) is UNCHANGED — the customer
 *                 pays only the difference for the remaining period (§8.3). When
 *                 the proration rounds to 0 it applies with no charge; with a saved
 *                 card it is charged off-session (MIT) and applied on success; with
 *                 no saved card the UI is told to route through full checkout (T-C3).
 *   • downgrade — SCHEDULED for end-of-period (pending columns). No money moves; the
 *                 layer-D cron applies it at renewal. User keeps the higher plan.
 *   • cancel    — SCHEDULED (`cancelAtPeriodEnd`); cron expires it at renewal.
 *   • resume    — reverts a scheduled cancel/downgrade.
 *
 * Identity (companyId, userId) comes ONLY from `getSession()` (PATTERN 3), never
 * from the body. Money is ALWAYS read server-side from `plan_prices` — the body
 * carries only `{action, plan?, period?}` and can never influence what is charged.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import {
  RevolutError,
  chargeSavedMethod,
  createOrder,
} from "@/server/billing/revolut";
import {
  applyPlanChange,
  computeProration,
  resumeSubscription,
  scheduleCancel,
  scheduleDowngrade,
  type Period,
} from "@/server/billing/subscription";
import { db } from "@/server/db";
import { companySubscription, payments, planPrices } from "@/server/db/schema";
import { PLAN_ORDER, type PlanId } from "@/shared/plans";

const ACTIONS = ["upgrade", "downgrade", "cancel", "resume"] as const;
type Action = (typeof ACTIONS)[number];

/** Paid plans a subscription can move to (trial is never a paid transition target). */
const PAID_PLANS: readonly PlanId[] = ["starter", "pro", "enterprise"];
const PERIODS = ["monthly", "annual"] as const;

/** A live subscription (trialing/active/past_due) is the only one that can transition. */
const LIVE_SUB_STATUSES = ["trialing", "active", "past_due"] as const;

/** Read a (plan, period) price in EUR minor units, or null when no catalogue row. */
async function priceOf(plan: PlanId, period: Period): Promise<number | null> {
  const [row] = await db
    .select({ amountMinor: planPrices.amountMinor })
    .from(planPrices)
    .where(
      and(
        eq(planPrices.planId, plan),
        eq(planPrices.period, period),
        eq(planPrices.currency, "EUR"),
      ),
    )
    .limit(1);
  return row ? row.amountMinor : null;
}

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) — subscription transitions are a billing capability (§7.3).
  const forbidden = requireCapability(session, "billing.manage");
  if (forbidden) return apiResult(req, forbidden);

  // ── 1. Validate the action (and plan/period for plan-changing actions). ──────
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    plan?: unknown;
    period?: unknown;
  };
  const { action } = body;
  if (typeof action !== "string" || !ACTIONS.includes(action as Action)) {
    console.error("POST /api/billing/subscription: invalid action", { action });
    return apiResult(req, { ok: false, error: "VALIDATION" });
  }

  let targetPlan: PlanId | undefined;
  let targetPeriod: Period | undefined;
  if (action === "upgrade" || action === "downgrade") {
    const { plan, period } = body;
    if (
      typeof plan !== "string" ||
      !PAID_PLANS.includes(plan as PlanId) ||
      typeof period !== "string" ||
      !PERIODS.includes(period as Period)
    ) {
      console.error("POST /api/billing/subscription: invalid plan/period", {
        plan,
        period,
      });
      return apiResult(req, { ok: false, error: "VALIDATION" });
    }
    targetPlan = plan as PlanId;
    targetPeriod = period as Period;
  }

  // ── 2. Load THIS company's live subscription — no live row → can't transition. ─
  const [sub] = await db
    .select()
    .from(companySubscription)
    .where(
      and(
        eq(companySubscription.companyId, company.id),
        inArray(companySubscription.status, [...LIVE_SUB_STATUSES]),
      ),
    )
    .limit(1);
  if (!sub) {
    // A company with no subscription can't transition — it must checkout (T-B2).
    return apiResult(req, { ok: false, error: "VALIDATION" });
  }
  const currentPlan = sub.planId as PlanId;

  // ── 3. cancel / resume — no money, no plan args. ─────────────────────────────
  if (action === "cancel") {
    await db.transaction((tx) => scheduleCancel(tx, { companyId: company.id }));
    return apiResult(req, { ok: true, data: { cancelAtPeriodEnd: true } });
  }
  if (action === "resume") {
    await db.transaction((tx) =>
      resumeSubscription(tx, { companyId: company.id }),
    );
    return apiResult(req, { ok: true, data: { resumed: true } });
  }

  // ── 4. downgrade — target must rank STRICTLY LOWER; schedule for EOP, no money. ─
  const currentIdx = PLAN_ORDER.indexOf(currentPlan);
  const targetIdx = PLAN_ORDER.indexOf(targetPlan!);
  if (action === "downgrade") {
    if (targetIdx >= currentIdx) {
      return apiResult(req, { ok: false, error: "VALIDATION" }); // not a downgrade
    }
    await db.transaction((tx) =>
      scheduleDowngrade(tx, {
        companyId: company.id,
        plan: targetPlan!,
        period: targetPeriod!,
      }),
    );
    return apiResult(req, { ok: true, data: { scheduled: true } });
  }

  // ── 5. upgrade — target must rank STRICTLY HIGHER. Prorate server-side. ───────
  if (targetIdx <= currentIdx) {
    return apiResult(req, { ok: false, error: "VALIDATION" }); // not an upgrade
  }

  // A period switch (e.g. monthly → annual) alongside the tier upgrade is NOT
  // supported by the in-place prorated upgrade in v1: prorating the annual price
  // over the remaining monthly window while keeping the monthly renewal date would
  // mis-charge. Keep the current period; a period change is a separate flow / applies
  // at renewal.
  if (targetPeriod !== (sub.period as Period)) {
    return apiResult(req, { ok: false, error: "VALIDATION" });
  }

  const oldMinor = await priceOf(currentPlan, sub.period as Period);
  const newMinor = await priceOf(targetPlan!, targetPeriod!);
  if (oldMinor === null || newMinor === null) {
    console.error("POST /api/billing/subscription: missing plan_prices row", {
      currentPlan,
      currentPeriod: sub.period,
      targetPlan,
      targetPeriod,
    });
    return apiResult(req, { ok: false, error: "VALIDATION" });
  }

  const now = new Date();
  const chargeNow = computeProration({
    oldMinor,
    newMinor,
    now,
    periodStart: sub.currentPeriodStart ?? now,
    periodEnd: sub.currentPeriodEnd ?? now,
  });

  // 5a. Nothing to charge (rounds to 0) → apply the upgrade for free.
  if (chargeNow === 0) {
    await db.transaction((tx) =>
      applyPlanChange(tx, {
        companyId: company.id,
        plan: targetPlan!,
        period: targetPeriod!,
      }),
    );
    return apiResult(req, { ok: true, data: { applied: true } });
  }

  // 5b. No saved card (or no customer to attach it to) → we can't charge off-session.
  //     An MIT charge needs BOTH the saved method id AND the Revolut customer id;
  //     with either missing, route the user through the full /billing checkout for
  //     the new plan (documented v1 limit).
  if (!sub.savedPaymentMethodId || !sub.revolutCustomerId) {
    return apiResult(req, {
      ok: true,
      data: { needsCheckout: true, plan: targetPlan!, period: targetPeriod! },
    });
  }

  // 5c. Saved card → MIT charge for the prorated amount, then apply on success.
  const savedPaymentMethodId = sub.savedPaymentMethodId;
  const revolutCustomerId = sub.revolutCustomerId;
  const idempotencyKey = crypto.randomUUID();

  // Guard against a concurrent double-charge (double-click / client retry). In ONE
  // transaction: take the per-company advisory lock, re-read the live plan UNDER it,
  // reject if it's no longer an upgrade (a concurrent request already applied) or if
  // a prorated charge is already in flight, then record the pending payment. A
  // second request blocks on the lock and then short-circuits BEFORE any money moves
  // — without this, both requests read the old plan and open two distinct charges.
  const guard = await db.transaction(
    async (tx): Promise<{ paymentId: string } | { error: "VALIDATION" }> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${company.id}))`,
      );
      const [live] = await tx
        .select({
          planId: companySubscription.planId,
        })
        .from(companySubscription)
        .where(
          and(
            eq(companySubscription.companyId, company.id),
            inArray(companySubscription.status, [...LIVE_SUB_STATUSES]),
          ),
        )
        .limit(1);
      // Live row gone, or already at/above the target (a concurrent upgrade won) →
      // not an upgrade any more.
      if (!live || PLAN_ORDER.indexOf(live.planId as PlanId) >= targetIdx) {
        return { error: "VALIDATION" };
      }
      // A prorated charge already in flight for this company → don't open a second.
      const inflight = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.companyId, company.id),
            eq(payments.status, "pending"),
            sql`(${payments.payload} ->> 'proration') = 'true'`,
          ),
        )
        .limit(1);
      if (inflight.length > 0) return { error: "VALIDATION" };

      const [payment] = await tx
        .insert(payments)
        .values({
          companyId: company.id,
          userId: session.userId,
          kind: "subscription",
          status: "pending",
          amountMinor: chargeNow,
          currency: "EUR",
          savedPaymentMethodId,
          payload: {
            kind: "subscription",
            plan: targetPlan!,
            period: targetPeriod!,
            proration: true,
          },
          idempotencyKey,
        })
        .returning({ id: payments.id });
      return { paymentId: payment.id };
    },
  );
  if ("error" in guard) {
    return apiResult(req, { ok: false, error: guard.error });
  }
  const paymentId = guard.paymentId;

  // Open the order. On failure no order exists at Revolut, so mark the row failed
  // and surface an opaque UNKNOWN (never leak the API body). Do NOT apply the change.
  let order;
  try {
    order = await createOrder(
      {
        amount: chargeNow,
        currency: "EUR",
        capture_mode: "automatic",
        customer: { id: revolutCustomerId },
        metadata: { payment_id: paymentId, company_id: company.id },
      },
      { idempotencyKey },
    );
  } catch (e) {
    if (e instanceof RevolutError) {
      console.error("POST /api/billing/subscription: createOrder failed", e);
      await db
        .update(payments)
        .set({ status: "failed" })
        .where(eq(payments.id, paymentId));
      return apiResult(req, { ok: false, error: "UNKNOWN" });
    }
    throw e;
  }
  await db
    .update(payments)
    .set({ revolutOrderId: order.id })
    .where(eq(payments.id, paymentId));

  // Charge the saved method (MIT). A synchronous RevolutError → the charge did not
  // succeed: mark failed and do NOT apply the plan change.
  try {
    await chargeSavedMethod(
      order.id,
      { savedPaymentMethodId },
      { idempotencyKey },
    );
  } catch (e) {
    if (e instanceof RevolutError) {
      console.error("POST /api/billing/subscription: MIT charge failed", e);
      await db
        .update(payments)
        .set({ status: "failed" })
        .where(eq(payments.id, paymentId));
      return apiResult(req, { ok: false, error: "UNKNOWN" });
    }
    throw e;
  }

  // Charge succeeded synchronously (no widget involved) → apply the upgrade and mark
  // the payment completed in ONE transaction, for instant feedback. The webhook's
  // later ORDER_COMPLETED for this order re-applies the SAME plan change idempotently
  // (period-preserving, `proration` flag) — the safety net if this synchronous apply
  // never runs (a crash / non-RevolutError after the card was charged).
  await db.transaction(async (tx) => {
    await applyPlanChange(tx, {
      companyId: company.id,
      plan: targetPlan!,
      period: targetPeriod!,
    });
    await tx
      .update(payments)
      .set({ status: "completed" })
      .where(eq(payments.id, paymentId));
  });

  return apiResult(req, { ok: true, data: { applied: true } });
});

export const OPTIONS = optionsHandler;
