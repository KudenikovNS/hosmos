// =============================================================================
// Subscription activation (BILLING §5, T-C1) — the write side that turns a
// completed payment into a LIVE subscription. `getEntitlements` (guard.ts) reads
// `company_subscription`: an `active` row (or a `trialing` row within its term)
// grants the paid features, and NO row degrades to the denormalized
// `companies.plan`. So writing/refreshing an `active` row here — and syncing
// `companies.plan` in the SAME breath — is what makes a paid plan real to
// `getSession` / `usePlan` / `getEntitlements` immediately.
//
// `activateSubscription` takes a Drizzle transaction handle so the caller (the
// Revolut webhook) can bundle it atomically with journaling the delivery and
// updating the payment status — everything commits or rolls back together.
//
// `server-only` guards against client bundling (this touches `db` schema). The
// date math (`addMonths` / `addYears` / `computePeriodEnd`) is pure and exported
// so it is unit-testable without a database.
// =============================================================================

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "@/server/db/schema";
import { companies, companySubscription } from "@/server/db/schema";
import type { PlanId } from "@/shared/plans";

/** Billing period of a subscription — matches the `period` CHECK. */
export type Period = "monthly" | "annual";

/** Statuses that count as ONE live subscription per company (partial-unique key). */
const LIVE_STATUSES = ["trialing", "active", "past_due"] as const;

/** The Drizzle transaction handle the webhook passes in (schema-bound). */
type Db = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Add `n` calendar months to `date`, clamping to the last day of the target month
 * so month-length edges stay sane (e.g. Jan 31 + 1 month → Feb 28/29, never a
 * silent overflow into March). Computed in UTC to be deterministic + testable.
 */
export function addMonths(date: Date, n: number): Date {
  const day = date.getUTCDate();
  const d = new Date(date.getTime());
  d.setUTCDate(1); // avoid overflow while shifting the month
  d.setUTCMonth(d.getUTCMonth() + n);
  // Last day of the (now shifted) month: day 0 of the next month.
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** Add `n` years — month/day-clamping via `addMonths` (Feb 29 + 1y → Feb 28). */
export function addYears(date: Date, n: number): Date {
  return addMonths(date, n * 12);
}

/** Period end for a term starting at `start`: +1 year (annual) or +1 month. */
export function computePeriodEnd(start: Date, period: Period): Date {
  return period === "annual" ? addYears(start, 1) : addMonths(start, 1);
}

/** Inputs for `activateSubscription`. `now` is injectable for deterministic tests. */
export interface ActivateSubscriptionInput {
  companyId: string;
  plan: PlanId;
  period: Period;
  /** Revolut customer id captured from the order (best-effort — may be null). */
  revolutCustomerId?: string | null;
  /** Saved payment-method id for later MIT charges (best-effort — may be null). */
  savedPaymentMethodId?: string | null;
  /** Override the clock (tests). Defaults to `new Date()`. */
  now?: Date;
}

/**
 * Activate (or refresh) the company's live subscription and sync the denormalized
 * `companies` plan columns — all on the passed transaction `tx`.
 *
 * The partial-unique index `company_subscription_company_active_key` allows AT
 * MOST ONE live row (trialing/active/past_due) per company, so this is an
 * update-if-exists-else-insert keyed on that live row rather than a blind upsert
 * (the expression index has no arbiter usable by ON CONFLICT). Renewals and
 * upgrades therefore reuse the same row; a first activation inserts one.
 *
 * `revolutCustomerId` / `savedPaymentMethodId` are written only when provided —
 * a null never overwrites an existing non-null value (layer D can resolve a
 * missing saved-method id later without this clobbering it).
 */
export async function activateSubscription(
  tx: Tx,
  input: ActivateSubscriptionInput,
): Promise<void> {
  const now = input.now ?? new Date();
  const currentPeriodStart = now;
  const currentPeriodEnd = computePeriodEnd(now, input.period);
  const planStart = currentPeriodStart.toISOString().slice(0, 10); // date column
  const revolutCustomerId = input.revolutCustomerId ?? null;
  const savedPaymentMethodId = input.savedPaymentMethodId ?? null;

  // Serialize activations for this company within the transaction. Two DISTINCT
  // orders (different order_id → neither stopped by the (event,order_id) journal)
  // completing concurrently would otherwise both take the INSERT branch and the
  // second would violate the live-row partial-unique index. The xact-scoped
  // advisory lock makes the second wait for the first to commit, so it then sees
  // the live row and takes UPDATE. Released automatically at commit/rollback.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${input.companyId}))`,
  );

  // Find THIS company's live row (at most one, by the partial-unique index).
  const [live] = await tx
    .select({ id: companySubscription.id })
    .from(companySubscription)
    .where(
      and(
        eq(companySubscription.companyId, input.companyId),
        inArray(companySubscription.status, [...LIVE_STATUSES]),
      ),
    )
    .limit(1);

  if (live) {
    await tx
      .update(companySubscription)
      .set({
        status: "active",
        planId: input.plan,
        period: input.period,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: false,
        pendingPlanId: null,
        pendingPeriod: null,
        dunningAttempts: 0,
        dunningNextAt: null,
        // Only overwrite when we captured a value — never null out an existing id.
        ...(revolutCustomerId ? { revolutCustomerId } : {}),
        ...(savedPaymentMethodId ? { savedPaymentMethodId } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(companySubscription.id, live.id));
  } else {
    await tx.insert(companySubscription).values({
      companyId: input.companyId,
      planId: input.plan,
      period: input.period,
      status: "active",
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: false,
      revolutCustomerId,
      savedPaymentMethodId,
    });
  }

  // Sync the denormalized company plan so getSession/usePlan see the paid plan now.
  await tx
    .update(companies)
    .set({
      plan: input.plan,
      planStart,
      subscriptionStartedAt: currentPeriodStart,
      nextPaymentAt: currentPeriodEnd,
      updatedAt: sql`now()`,
    })
    .where(eq(companies.id, input.companyId));
}

// =============================================================================
// Subscription transitions (T-C2) — upgrade / downgrade / cancel / resume. These
// mutate the company's ONE live row (trialing/active/past_due). Upgrade is applied
// immediately (`applyPlanChange`); downgrade/cancel are SCHEDULED (pending columns
// / `cancelAtPeriodEnd`) for the layer-D cron to apply at end-of-period; resume
// reverts a scheduled cancel/downgrade. Every function takes a transaction `tx`
// so the route can bundle the DB change atomically with its money side effects.
// =============================================================================

/**
 * Proration for an immediate upgrade (impl-spec §8.3). Credits the unused paid
 * time on the old plan against the cost of the new plan for the SAME remaining
 * time, so the customer pays only the difference for what's left of the period.
 * Pure integer minor-unit math (`Math.round`), injectable clock — unit-testable
 * without a database.
 */
export interface ComputeProrationInput {
  /** Minor units the customer currently pays for the live plan/period. */
  oldMinor: number;
  /** Minor units of the target plan/period. */
  newMinor: number;
  /** Clock (the moment of the upgrade). */
  now: Date;
  /** Live period start. */
  periodStart: Date;
  /** Live period end (renewal date — unchanged by the upgrade). */
  periodEnd: Date;
}

export function computeProration(input: ComputeProrationInput): number {
  const { oldMinor, newMinor, now, periodStart, periodEnd } = input;
  const remaining = Math.max(0, periodEnd.getTime() - now.getTime()); // ms left
  const span = periodEnd.getTime() - periodStart.getTime();
  const frac = span > 0 ? remaining / span : 0;
  const credit = Math.round(oldMinor * frac); // unused paid time on the old plan
  const cost = Math.round(newMinor * frac); // new plan for the remaining time
  return Math.max(0, cost - credit); // integer minor units, never negative
}

/**
 * Serialize per-company writes within the transaction — same xact-scoped advisory
 * lock `activateSubscription` uses, so a transition and a concurrent activation
 * can't race on the live row. Released automatically at commit/rollback.
 */
async function lockCompany(tx: Tx, companyId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${companyId}))`);
}

/** The company's ONE live row (partial-unique on trialing/active/past_due), or undefined. */
async function findLiveRow(tx: Tx, companyId: string) {
  const [live] = await tx
    .select({
      id: companySubscription.id,
      currentPeriodEnd: companySubscription.currentPeriodEnd,
    })
    .from(companySubscription)
    .where(
      and(
        eq(companySubscription.companyId, companyId),
        inArray(companySubscription.status, [...LIVE_STATUSES]),
      ),
    )
    .limit(1);
  return live;
}

/** Inputs for a plan-changing transition (`applyPlanChange` / `scheduleDowngrade`). */
export interface PlanChangeInput {
  companyId: string;
  plan: PlanId;
  period: Period;
}

/**
 * Apply an upgrade IMMEDIATELY on the live row: switch `planId`/`period` and clear
 * any scheduled cancel/downgrade. Deliberately does NOT touch
 * `currentPeriodStart/End` — aligned billing keeps the renewal date fixed (the
 * proration charge, computed by the route, already covers the price difference for
 * the remaining period). Syncs the denormalized `companies.plan` and keeps
 * `nextPaymentAt` pinned to the (unchanged) `currentPeriodEnd`.
 */
export async function applyPlanChange(
  tx: Tx,
  input: PlanChangeInput,
): Promise<void> {
  await lockCompany(tx, input.companyId);
  const live = await findLiveRow(tx, input.companyId);
  if (!live) return; // caller guarantees a live row; no-op if it vanished

  await tx
    .update(companySubscription)
    .set({
      planId: input.plan,
      period: input.period,
      cancelAtPeriodEnd: false,
      pendingPlanId: null,
      pendingPeriod: null,
      updatedAt: sql`now()`,
    })
    .where(eq(companySubscription.id, live.id));

  await tx
    .update(companies)
    .set({
      plan: input.plan,
      // Renewal date is unchanged on an upgrade — keep nextPaymentAt aligned.
      nextPaymentAt: live.currentPeriodEnd,
      updatedAt: sql`now()`,
    })
    .where(eq(companies.id, input.companyId));
}

/**
 * SCHEDULE a downgrade for end-of-period: stash the target on `pendingPlanId`/
 * `pendingPeriod`. No money moves and the plan does NOT change now — the user
 * keeps the higher plan until the layer-D cron applies the pending change at
 * renewal. Leaves `cancelAtPeriodEnd` untouched.
 */
export async function scheduleDowngrade(
  tx: Tx,
  input: PlanChangeInput,
): Promise<void> {
  await lockCompany(tx, input.companyId);
  const live = await findLiveRow(tx, input.companyId);
  if (!live) return;

  await tx
    .update(companySubscription)
    .set({
      pendingPlanId: input.plan,
      pendingPeriod: input.period,
      updatedAt: sql`now()`,
    })
    .where(eq(companySubscription.id, live.id));
}

/** SCHEDULE a cancel at end-of-period: set `cancelAtPeriodEnd` on the live row. */
export async function scheduleCancel(
  tx: Tx,
  input: { companyId: string },
): Promise<void> {
  await lockCompany(tx, input.companyId);
  const live = await findLiveRow(tx, input.companyId);
  if (!live) return;

  await tx
    .update(companySubscription)
    .set({ cancelAtPeriodEnd: true, updatedAt: sql`now()` })
    .where(eq(companySubscription.id, live.id));
}

/**
 * REVERT a scheduled cancel/downgrade: clear `cancelAtPeriodEnd` and the pending
 * columns. Keeps the current plan/period as-is (the user stays on what they have).
 */
export async function resumeSubscription(
  tx: Tx,
  input: { companyId: string },
): Promise<void> {
  await lockCompany(tx, input.companyId);
  const live = await findLiveRow(tx, input.companyId);
  if (!live) return;

  await tx
    .update(companySubscription)
    .set({
      cancelAtPeriodEnd: false,
      pendingPlanId: null,
      pendingPeriod: null,
      updatedAt: sql`now()`,
    })
    .where(eq(companySubscription.id, live.id));
}

// =============================================================================
// End-of-life transitions (T-D1) — applied by the daily cron. `expireSubscription`
// lapses a subscription (scheduled cancel reached EOP, or a trial elapsed) back to
// the free tier; `markPastDue` records a failed renewal so the layer-D dunning
// retry cycle (T-D2) can pick it up. Both take a transaction `tx` and the
// per-company advisory lock, matching the other write helpers.
// =============================================================================

/** Statuses a subscription can be expired FROM (anything but an already-`expired` row). */
const EXPIRABLE_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "cancelled",
] as const;

/**
 * Lapse the company's subscription to `expired` and sync the denormalized company
 * back to the free tier: `plan='trial'`, `nextPaymentAt=null`. `subscriptionStartedAt`
 * is deliberately LEFT as-is (historical fact). Entitlements are NOT special-cased
 * here — a non-live sub already degrades to `companies.plan` via `getEntitlements`
 * (governed by `DOWNGRADE_MODE`).
 *
 * Includes `cancelled` in the target set (not just the live statuses) so a row that
 * some path already moved to `cancelled` still expires cleanly at end-of-period.
 */
export async function expireSubscription(
  tx: Tx,
  input: { companyId: string },
): Promise<void> {
  await lockCompany(tx, input.companyId);
  const [row] = await tx
    .select({ id: companySubscription.id })
    .from(companySubscription)
    .where(
      and(
        eq(companySubscription.companyId, input.companyId),
        inArray(companySubscription.status, [...EXPIRABLE_STATUSES]),
      ),
    )
    .limit(1);
  if (!row) return;

  await tx
    .update(companySubscription)
    .set({
      status: "expired",
      cancelAtPeriodEnd: false,
      updatedAt: sql`now()`,
    })
    .where(eq(companySubscription.id, row.id));

  await tx
    .update(companies)
    .set({ plan: "trial", nextPaymentAt: null, updatedAt: sql`now()` })
    .where(eq(companies.id, input.companyId));
}

/**
 * Record a FAILED renewal on the live row: `status='past_due'`, `dunningAttempts=1`,
 * `dunningNextAt` = when the first retry is due. This is the SEAM for T-D2, which
 * extends the retry cycle from `past_due` (incrementing `dunningAttempts` and
 * rescheduling `dunningNextAt`, or expiring once retries are exhausted). Does NOT
 * touch `companies.plan` — access stays on the paid plan through the grace period.
 */
export async function markPastDue(
  tx: Tx,
  input: { companyId: string; dunningNextAt: Date },
): Promise<void> {
  await lockCompany(tx, input.companyId);
  const live = await findLiveRow(tx, input.companyId);
  if (!live) return;

  await tx
    .update(companySubscription)
    .set({
      status: "past_due",
      dunningAttempts: 1,
      dunningNextAt: input.dunningNextAt,
      updatedAt: sql`now()`,
    })
    .where(eq(companySubscription.id, live.id));
}

/**
 * Schedule the NEXT dunning retry on a subscription that stays `past_due`: record the
 * new `dunningAttempts` count and when the next retry is due (`dunningNextAt`). Called
 * by the T-D2 retry loop when a retry fails but the retry cap is not yet reached — the
 * status and plan are unchanged (access stays on the paid plan through the grace
 * period). Takes the same per-company advisory lock as the other write helpers.
 */
export async function scheduleNextDunning(
  tx: Tx,
  input: { companyId: string; attempts: number; dunningNextAt: Date },
): Promise<void> {
  await lockCompany(tx, input.companyId);
  const live = await findLiveRow(tx, input.companyId);
  if (!live) return;

  // Only stamp dunning columns onto a still-`past_due` row. If a concurrent charge
  // recovered it to `active` (which clears these columns), matching 0 rows here is
  // the correct no-op — never re-decorate an active sub with a stale retry schedule.
  await tx
    .update(companySubscription)
    .set({
      dunningAttempts: input.attempts,
      dunningNextAt: input.dunningNextAt,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(companySubscription.id, live.id),
        eq(companySubscription.status, "past_due"),
      ),
    );
}
