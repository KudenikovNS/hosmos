// =============================================================================
// Daily billing cron engine (BILLING §5, T-D1/T-D2). `runBillingCron` processes every
// DUE subscription and is invoked by the protected `POST /api/billing/cron` route
// (a cPanel cron hits it once a day). It handles four transitions:
//
//   A. RENEWALS      — an `active`, non-cancelling sub past its period end is
//                      charged off-session (MIT) and its period reset. A sub with a
//                      scheduled downgrade (`pendingPlanId`) is charged on the NEW,
//                      lower plan instead — the downgrade applies at renewal.
//   B. CANCEL / EXPIRY — a sub with `cancelAtPeriodEnd` reaching its period end is
//                      expired (back to the free tier). No money.
//   C. TRIAL EXPIRY  — a `trialing` sub whose `trialEndsAt` has passed is expired.
//                      Open-ended trials (`trialEndsAt IS NULL`) are NEVER touched.
//                      This is the trial-EXPIRY (try-then-pay) model — no first
//                      charge is attempted here.
//
//   D. DUNNING RETRIES — a `past_due` sub whose `dunning_next_at` has elapsed is
//                      re-charged off-session. Success recovers it to `active` (period
//                      reset, plan restored). Failure bumps `dunning_attempts`; once
//                      they reach `DUNNING_RETRIES` the sub is expired (downgraded to
//                      free), otherwise the next retry is scheduled.
//
// Each subscription is processed INDEPENDENTLY in its own try/catch, so one failure
// (a bad price row, a Revolut outage) never aborts the batch — it is counted and
// the run continues. A FAILED renewal charge enters `past_due` with the first dunning
// attempt scheduled; branch D then walks the retry cycle. The renewal (A) and retry
// (D) branches share ONE guarded charge helper (`chargeSubscription`), so neither can
// double-charge an overlapping run.
//
// `server-only`: touches `db` + the Revolut secret. `now` is injectable so
// integration tests get deterministic period math.
// =============================================================================

import "server-only";

import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { applyPlanDowngradeSeatEffects } from "@/server/auth/seats";
import { dunningRetries, intervalDays } from "@/server/billing/dunning";
import {
  RevolutError,
  chargeSavedMethod,
  createOrder,
  getCustomerPaymentMethods,
} from "@/server/billing/revolut";
import {
  activateSubscription,
  expireSubscription,
  markPastDue,
  scheduleNextDunning,
  type Period,
} from "@/server/billing/subscription";
import { db } from "@/server/db";
import { companySubscription, payments, planPrices } from "@/server/db/schema";
import type { PlanId } from "@/shared/plans";

const DAY_MS = 86_400_000;

/** What a cron run did — logged by the route for observability. */
export interface CronSummary {
  /** Active subs renewed on their current plan. */
  renewed: number;
  /** Active subs renewed onto a scheduled-downgrade (lower) plan. */
  downgraded: number;
  /** Subs lapsed to the free tier (EOP cancel + elapsed trials). */
  expired: number;
  /** Renewals whose charge failed → moved to `past_due` (dunning begins). */
  pastDue: number;
  /** Past-due subs whose dunning retry SUCCEEDED → back to `active` (recovered). */
  recovered: number;
  /** Past-due retries that failed but still have attempts left → next retry scheduled. */
  retriesScheduled: number;
  /** Subs that could not be processed (missing price, unexpected error). */
  failed: number;
  /** Human-readable per-subscription failure notes (for the log). */
  errors: string[];
}

function emptySummary(): CronSummary {
  return {
    renewed: 0,
    downgraded: 0,
    expired: 0,
    pastDue: 0,
    recovered: 0,
    retriesScheduled: 0,
    failed: 0,
    errors: [],
  };
}

/** A (plan, period) price in EUR minor units, or null when no catalogue row exists. */
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

type SubRow = typeof companySubscription.$inferSelect;

/**
 * Move a company to `past_due` with the FIRST dunning retry scheduled. T-D2 extends
 * the cycle from here (later attempts, or expiry once retries run out).
 */
async function enterPastDue(companyId: string, now: Date): Promise<void> {
  const dunningNextAt = new Date(now.getTime() + intervalDays(1) * DAY_MS);
  await db.transaction((tx) => markPastDue(tx, { companyId, dunningNextAt }));
}

/** Outcome of the shared MIT charge machinery (`chargeSubscription`). */
type ChargeOutcome =
  /** The card was charged; the sub was re-activated (period reset). */
  | "charged"
  /** No chargeable method, or the order/charge was declined (payment → failed). */
  | "failed"
  /** A concurrent run already handled this company (guard tripped). Nothing to do. */
  | "skipped";

/**
 * Shared MIT charge machinery used by BOTH the renewal (A) and the dunning-retry (D)
 * branches. Resolves the saved card, records a guarded pending payment under the
 * per-company advisory lock, creates the order, charges off-session, and on success
 * completes the payment and re-activates the subscription (which resets the period,
 * restores the plan, and clears dunning). The `stillDue` predicate is re-checked
 * under the lock so an overlapping run can't double-charge: it returns `true` only
 * while THIS row is still eligible. The caller maps the outcome onto its own counters
 * and failure FSM (renewal → `past_due`; dunning → increment / expire / reschedule).
 */
async function chargeSubscription(params: {
  sub: SubRow;
  plan: PlanId;
  period: Period;
  amount: number;
  now: Date;
  stillDue: (live: SubRow) => boolean;
}): Promise<ChargeOutcome> {
  const { sub, plan, period, amount, now, stillDue } = params;

  // Resolve the card to charge: the persisted method, else the customer's first
  // MERCHANT-saved method (`only_merchant=true`, re-checked here). Still nothing
  // (or no customer) → we can't charge. Network call — done BEFORE the lock so the
  // per-company advisory lock isn't held across a Revolut round-trip.
  let methodId = sub.savedPaymentMethodId ?? null;
  if (!methodId && sub.revolutCustomerId) {
    try {
      const methods = await getCustomerPaymentMethods(sub.revolutCustomerId, {
        onlyMerchant: true,
      });
      methodId =
        methods.find((m) => m.saved_for === "merchant")?.id ??
        methods[0]?.id ??
        null;
    } catch (e) {
      if (e instanceof RevolutError) return "failed";
      throw e;
    }
  }
  if (!methodId || !sub.revolutCustomerId) return "failed";

  // Concurrency guard (overlapping runs must NOT double-charge). Under the
  // per-company advisory lock, RE-CONFIRM the sub is still due (`stillDue`) and no
  // subscription charge is already in flight, then record the pending payment —
  // atomically. A second run then either sees the row no longer eligible (period
  // moved / recovered) or the in-flight pending payment, and skips before opening a
  // second charge.
  const idempotencyKey = crypto.randomUUID();
  const prep = await db.transaction(
    async (tx): Promise<{ paymentId: string } | { skip: true }> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${sub.companyId}))`,
      );
      const [live] = await tx
        .select()
        .from(companySubscription)
        .where(eq(companySubscription.id, sub.id))
        .limit(1);
      // Already handled by a concurrent run (renewed, recovered, or no longer due).
      if (!live || !stillDue(live)) return { skip: true };
      // A subscription charge already in flight for this company (this run's twin,
      // a checkout, or an upgrade) → don't open a second one.
      const inflight = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.companyId, sub.companyId),
            eq(payments.status, "pending"),
            eq(payments.kind, "subscription"),
          ),
        )
        .limit(1);
      if (inflight.length > 0) return { skip: true };

      // Pending payment first (idempotency key shared with the order + charge). NO
      // `proration` flag → the resulting ORDER_COMPLETED webhook does a FULL
      // activation (a fresh period), correct for a renewal/retry — and matches the
      // synchronous apply below, so the two are idempotent.
      const [payment] = await tx
        .insert(payments)
        .values({
          companyId: sub.companyId,
          kind: "subscription",
          status: "pending",
          amountMinor: amount,
          currency: "EUR",
          savedPaymentMethodId: methodId,
          payload: { kind: "subscription", plan, period },
          idempotencyKey,
        })
        .returning({ id: payments.id });
      return { paymentId: payment.id };
    },
  );
  if ("skip" in prep) return "skipped"; // another run already handled this company
  const paymentId = prep.paymentId;

  try {
    const order = await createOrder(
      {
        amount,
        currency: "EUR",
        capture_mode: "automatic",
        customer: { id: sub.revolutCustomerId },
        metadata: { payment_id: paymentId, company_id: sub.companyId },
      },
      { idempotencyKey },
    );
    await db
      .update(payments)
      .set({ revolutOrderId: order.id })
      .where(eq(payments.id, paymentId));
    await chargeSavedMethod(
      order.id,
      { savedPaymentMethodId: methodId },
      { idempotencyKey },
    );
  } catch (e) {
    if (e instanceof RevolutError) {
      await db
        .update(payments)
        .set({ status: "failed" })
        .where(eq(payments.id, paymentId));
      return "failed";
    }
    throw e;
  }

  // Charge succeeded → complete the payment and reset the period (clears pending +
  // dunning, syncs `companies`) in ONE transaction, persisting the resolved method.
  await db.transaction(async (tx) => {
    await tx
      .update(payments)
      .set({ status: "completed" })
      .where(eq(payments.id, paymentId));
    await activateSubscription(tx, {
      companyId: sub.companyId,
      plan,
      period,
      revolutCustomerId: sub.revolutCustomerId,
      savedPaymentMethodId: methodId,
      now,
    });
  });

  return "charged";
}

/** The plan/period a renewal or retry charges — the pending downgrade if scheduled. */
function chargeTarget(sub: SubRow): { plan: PlanId; period: Period } {
  const isDowngrade = sub.pendingPlanId != null;
  return {
    plan: (isDowngrade ? sub.pendingPlanId : sub.planId) as PlanId,
    period: (isDowngrade ? sub.pendingPeriod : sub.period) as Period,
  };
}

/**
 * Renew ONE due active subscription. Determines the target plan/period (a scheduled
 * downgrade charges the pending plan), charges the saved card off-session via the
 * shared machinery, and on success resets the period. A declined/failed charge — or
 * no chargeable method — moves the sub to `past_due`. Mutates `summary`.
 */
async function processRenewal(
  sub: SubRow,
  now: Date,
  summary: CronSummary,
): Promise<void> {
  const { plan, period } = chargeTarget(sub);
  const isDowngrade = sub.pendingPlanId != null;

  const amount = await priceOf(plan, period);
  if (amount == null) {
    summary.failed++;
    summary.errors.push(
      `renew ${sub.id}: no plan_prices row for ${plan}/${period} EUR`,
    );
    return;
  }

  const outcome = await chargeSubscription({
    sub,
    plan,
    period,
    amount,
    now,
    // Still an active, non-cancelling renewal whose period has elapsed.
    stillDue: (live) =>
      live.status === "active" &&
      !live.cancelAtPeriodEnd &&
      live.currentPeriodEnd != null &&
      live.currentPeriodEnd.getTime() <= now.getTime(),
  });

  if (outcome === "skipped") return; // another run already handled this company
  if (outcome === "failed") {
    await enterPastDue(sub.companyId, now);
    summary.pastDue++;
    return;
  }
  if (isDowngrade) {
    summary.downgraded++;
    // T2.2 (§10.3): the renewal just applied the scheduled lower plan (companies.plan
    // synced by activateSubscription). Revoke pending invitations + audit if this put
    // the company over-seat. System actor → actorRole/userId null. Best-effort, POST
    // the committed charge — never fails the renewal: the charge is already committed,
    // so a seat-effects failure MUST NOT propagate to the per-subscription catch (which
    // would count this successful, charged downgrade as `failed` and raise a false
    // alert). Swallow + log; the effect self-heals next time the plan is touched.
    try {
      await applyPlanDowngradeSeatEffects(db, {
        companyId: sub.companyId,
        oldPlan: sub.planId as PlanId,
        newPlan: plan,
        actorRole: null,
        userId: null,
      });
    } catch (e) {
      summary.errors.push(`downgrade-seat-effects ${sub.id}: ${String(e)}`);
    }
  } else summary.renewed++;
}

/**
 * Retry ONE `past_due` subscription's failed charge (dunning FSM, spec §11.2). Charges
 * the CURRENT plan/period (or the pending downgrade target, treated like a renewal) via
 * the SAME guarded machinery as `processRenewal`. On success → `activateSubscription`
 * recovers the sub to `active` (dunning reset, plan restored). On failure → bump the
 * attempt count; once it reaches `DUNNING_RETRIES` the sub is expired (downgraded to
 * free), otherwise the next retry is scheduled at `now + intervalDays(attempts)`.
 * Mutates `summary`.
 */
async function processDunningRetry(
  sub: SubRow,
  now: Date,
  summary: CronSummary,
): Promise<void> {
  const { plan, period } = chargeTarget(sub);

  const amount = await priceOf(plan, period);
  if (amount == null) {
    summary.failed++;
    summary.errors.push(
      `dunning ${sub.id}: no plan_prices row for ${plan}/${period} EUR`,
    );
    return;
  }

  const outcome = await chargeSubscription({
    sub,
    plan,
    period,
    amount,
    now,
    // Still a past_due row whose next retry is due.
    stillDue: (live) =>
      live.status === "past_due" &&
      live.dunningNextAt != null &&
      live.dunningNextAt.getTime() <= now.getTime(),
  });

  if (outcome === "skipped") return; // another run already handled this company
  if (outcome === "charged") {
    summary.recovered++;
    return;
  }

  // Failed retry → advance the dunning FSM. `dunningAttempts` counts the original
  // failed renewal as 1, so `attempts` is this retry's cumulative attempt number.
  const attempts = sub.dunningAttempts + 1;
  if (attempts >= dunningRetries()) {
    await db.transaction((tx) =>
      expireSubscription(tx, { companyId: sub.companyId }),
    );
    summary.expired++;
    return;
  }
  const dunningNextAt = new Date(
    now.getTime() + intervalDays(attempts) * DAY_MS,
  );
  await db.transaction((tx) =>
    scheduleNextDunning(tx, {
      companyId: sub.companyId,
      attempts,
      dunningNextAt,
    }),
  );
  summary.retriesScheduled++;
}

/**
 * Process every due subscription (renewals, end-of-period cancels, elapsed trials)
 * for the moment `now`. Never throws for a single bad subscription — failures are
 * counted in the returned `CronSummary`.
 */
export async function runBillingCron(
  now: Date = new Date(),
): Promise<CronSummary> {
  const summary = emptySummary();

  // ── A. Renewals — active, not cancelling, period elapsed. ──────────────────
  const dueRenewals = await db
    .select()
    .from(companySubscription)
    .where(
      and(
        eq(companySubscription.status, "active"),
        eq(companySubscription.cancelAtPeriodEnd, false),
        lte(companySubscription.currentPeriodEnd, now),
      ),
    );
  for (const sub of dueRenewals) {
    try {
      await processRenewal(sub, now, summary);
    } catch (e) {
      summary.failed++;
      summary.errors.push(`renew ${sub.id}: ${String(e)}`);
    }
  }

  // ── B. End-of-period cancel / expiry — cancelAtPeriodEnd reached. ──────────
  const dueCancels = await db
    .select()
    .from(companySubscription)
    .where(
      and(
        inArray(companySubscription.status, ["active", "cancelled"]),
        eq(companySubscription.cancelAtPeriodEnd, true),
        lte(companySubscription.currentPeriodEnd, now),
      ),
    );
  for (const sub of dueCancels) {
    try {
      await db.transaction((tx) =>
        expireSubscription(tx, { companyId: sub.companyId }),
      );
      summary.expired++;
    } catch (e) {
      summary.failed++;
      summary.errors.push(`expire ${sub.id}: ${String(e)}`);
    }
  }

  // ── C. Trial expiry — trialing with an elapsed, non-null trialEndsAt. ──────
  // Open-ended trials (trialEndsAt IS NULL) are never touched.
  const dueTrials = await db
    .select()
    .from(companySubscription)
    .where(
      and(
        eq(companySubscription.status, "trialing"),
        isNotNull(companySubscription.trialEndsAt),
        lte(companySubscription.trialEndsAt, now),
      ),
    );
  for (const sub of dueTrials) {
    try {
      await db.transaction((tx) =>
        expireSubscription(tx, { companyId: sub.companyId }),
      );
      summary.expired++;
    } catch (e) {
      summary.failed++;
      summary.errors.push(`trial-expire ${sub.id}: ${String(e)}`);
    }
  }

  // ── D. Dunning retries — past_due subs whose next retry (dunning_next_at) is due.
  const dueDunning = await db
    .select()
    .from(companySubscription)
    .where(
      and(
        eq(companySubscription.status, "past_due"),
        isNotNull(companySubscription.dunningNextAt),
        lte(companySubscription.dunningNextAt, now),
      ),
    );
  for (const sub of dueDunning) {
    try {
      await processDunningRetry(sub, now, summary);
    } catch (e) {
      summary.failed++;
      summary.errors.push(`dunning ${sub.id}: ${String(e)}`);
    }
  }

  return summary;
}
