// T-C2 integration tests — `POST /api/billing/subscription` against a REAL Postgres
// (T-13 harness). Proves the transition engine end-to-end:
//   • downgrade schedules pending columns — no payment, plan unchanged NOW;
//   • cancel sets cancelAtPeriodEnd; resume clears it AND any pending downgrade;
//   • upgrade with a saved card: prorated payment row + applyPlanChange applied
//     (planId updated, currentPeriodEnd UNCHANGED, companies.plan synced), MIT
//     charge called with the prorated amount;
//   • upgrade whose proration rounds to 0 applies with NO Revolut call;
//   • upgrade with no saved card returns {needsCheckout:true};
//   • a proration ORDER_COMPLETED webhook does NOT reset the period.
//
// `createOrder`/`chargeSavedMethod` are mocked so no network is hit; `getSession`
// is mocked so a test controls identity; `@/server/db` is the harness pool.
// `describeIntegration` self-skips with no DB → a green no-op in a DB-less CI.
import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getSessionMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  getSession: () => getSessionMock(),
}));

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return {
    get db() {
      return harness.getTestDb();
    },
  };
});

const createOrderMock = vi.fn();
const chargeSavedMethodMock = vi.fn();
const getOrderMock = vi.fn();
vi.mock("@/server/billing/revolut", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/billing/revolut")
  >("@/server/billing/revolut");
  return {
    ...actual,
    createOrder: (...args: unknown[]) => createOrderMock(...args),
    chargeSavedMethod: (...args: unknown[]) => chargeSavedMethodMock(...args),
    getOrder: (...args: unknown[]) => getOrderMock(...args),
  };
});

import { and, eq, inArray } from "drizzle-orm";

import { POST as subscriptionPOST } from "@/app/api/billing/subscription/route";
import { POST as webhookPOST } from "@/app/api/webhooks/revolut/route";
import { RevolutError } from "@/server/billing/revolut";
import { PLAN_SEED } from "@/server/billing/plan-catalog";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  companies,
  companySubscription,
  paymentEvents,
  payments,
  planPrices,
  plans,
} from "@/server/db/schema";
import type { DbCompany, DbSession } from "@/server/db/types";
import type { PlanId } from "@/shared/plans";

const WEBHOOK_SECRET = "wsk_test_secret";

/** Insert a company on `plan` + a real user/profile, and build the DbSession. */
async function setupSession(plan: PlanId): Promise<DbSession> {
  const company = await insertCompany({ plan, countryCode: "SI" });
  const { user } = await insertUserWithProfile({ companyId: company.id });
  const dbCompany: DbCompany = {
    id: company.id,
    name: "Acme",
    industry: null,
    nace_code: null,
    country: "Slovenia",
    country_code: "SI",
    headcount: 10,
    plan: company.plan ?? "trial",
    reporting_year: "2024",
    currency: "EUR",
  };
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    company: dbCompany,
    // esg_admin membership that production getSession() always resolves (§8, §14.1).
    membership: {
      companyId: dbCompany.id,
      role: "esg_admin",
      status: "active",
      hasIndependentApprover: true,
      activeMemberCount: 1,
    },
  };
}

/** Seed a live active subscription for `companyId`. Overrides tune plan/period/card. */
async function seedLiveSub(
  companyId: string,
  overrides: Partial<typeof companySubscription.$inferInsert> = {},
): Promise<void> {
  const now = new Date();
  const start = new Date(now.getTime() - 5 * 86_400_000); // 5 days ago
  const end = new Date(now.getTime() + 25 * 86_400_000); // 25 days ahead
  await getTestDb()
    .insert(companySubscription)
    .values({
      companyId,
      planId: "starter",
      period: "monthly",
      status: "active",
      currentPeriodStart: start,
      currentPeriodEnd: end,
      ...overrides,
    });
}

/** Seed the plan catalogue (plans + plan_prices) — idempotent; survives resets. */
async function seedCatalogue(): Promise<void> {
  const conn = getTestDb();
  await conn.insert(plans).values(PLAN_SEED.plans).onConflictDoNothing();
  await conn.insert(planPrices).values(PLAN_SEED.prices).onConflictDoNothing();
}

const request = (body: unknown) =>
  new Request("http://api.example.com/api/billing/subscription", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

/** Build a correctly-signed Revolut webhook Request for `body`. */
function signedWebhook(body: unknown): Request {
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  const sig =
    "v1=" +
    crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(`v1.${ts}.${raw}`)
      .digest("hex");
  return new Request("http://api.example.com/api/webhooks/revolut", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "Revolut-Request-Timestamp": ts,
      "Revolut-Signature": sig,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

const liveSub = (companyId: string) =>
  getTestDb()
    .select()
    .from(companySubscription)
    .where(
      and(
        eq(companySubscription.companyId, companyId),
        inArray(companySubscription.status, ["trialing", "active", "past_due"]),
      ),
    );

describeIntegration("T-C2 POST /api/billing/subscription", () => {
  beforeAll(async () => {
    await setupSchema();
    await seedCatalogue();
    process.env.REVOLUT_WEBHOOK_SIGNING_SECRET = WEBHOOK_SECRET;
  });
  beforeEach(async () => {
    await resetAppTables();
    vi.clearAllMocks();
    createOrderMock.mockResolvedValue({
      id: "ord_prorate_1",
      token: "tok_1",
      type: "payment",
      state: "pending",
    });
    chargeSavedMethodMock.mockResolvedValue({
      id: "pay_1",
      order_id: "ord_prorate_1",
      state: "completed",
    });
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it("unauthenticated → UNAUTHENTICATED", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await subscriptionPOST(request({ action: "cancel" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "UNAUTHENTICATED" });
  });

  it("an unknown action → VALIDATION", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    await seedLiveSub(session.company!.id);
    const res = await subscriptionPOST(request({ action: "bogus" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });
  });

  it("no live subscription row → VALIDATION (must checkout first)", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    const res = await subscriptionPOST(request({ action: "cancel" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });
  });

  it("downgrade sets pending columns — no payment, plan unchanged NOW", async () => {
    const session = await setupSession("pro");
    getSessionMock.mockResolvedValue(session);
    await seedLiveSub(session.company!.id, { planId: "pro", period: "annual" });

    const res = await subscriptionPOST(
      request({ action: "downgrade", plan: "starter", period: "monthly" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { scheduled: true } });

    const [sub] = await liveSub(session.company!.id);
    expect(sub.planId).toBe("pro"); // still on the higher plan now
    expect(sub.period).toBe("annual");
    expect(sub.pendingPlanId).toBe("starter");
    expect(sub.pendingPeriod).toBe("monthly");
    expect(sub.cancelAtPeriodEnd).toBe(false);

    const pays = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, session.company!.id));
    expect(pays).toHaveLength(0); // no money moves on a downgrade
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("downgrade to a higher/equal plan → VALIDATION (not a downgrade)", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    await seedLiveSub(session.company!.id, { planId: "starter" });

    const res = await subscriptionPOST(
      request({ action: "downgrade", plan: "pro", period: "monthly" }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });
  });

  it("cancel sets cancelAtPeriodEnd; resume clears it and any pending downgrade", async () => {
    const session = await setupSession("pro");
    getSessionMock.mockResolvedValue(session);
    await seedLiveSub(session.company!.id, {
      planId: "pro",
      period: "monthly",
      pendingPlanId: "starter",
      pendingPeriod: "monthly",
    });

    const cancelRes = await subscriptionPOST(request({ action: "cancel" }));
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toEqual({
      ok: true,
      data: { cancelAtPeriodEnd: true },
    });
    let [sub] = await liveSub(session.company!.id);
    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(sub.pendingPlanId).toBe("starter"); // cancel doesn't touch pending

    const resumeRes = await subscriptionPOST(request({ action: "resume" }));
    expect(resumeRes.status).toBe(200);
    expect(await resumeRes.json()).toEqual({
      ok: true,
      data: { resumed: true },
    });
    [sub] = await liveSub(session.company!.id);
    expect(sub.cancelAtPeriodEnd).toBe(false);
    expect(sub.pendingPlanId).toBeNull();
    expect(sub.pendingPeriod).toBeNull();
    expect(sub.planId).toBe("pro"); // plan itself is unchanged
  });

  it("upgrade with a saved card: prorated payment + applyPlanChange, period UNCHANGED, MIT charged", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    await seedLiveSub(session.company!.id, {
      planId: "starter",
      period: "monthly",
      savedPaymentMethodId: "pm_saved_1",
      revolutCustomerId: "cus_1",
    });
    const [before] = await liveSub(session.company!.id);
    const periodEndBefore = before.currentPeriodEnd!.getTime();

    const res = await subscriptionPOST(
      request({ action: "upgrade", plan: "pro", period: "monthly" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { applied: true } });

    // Plan changed; billing period (renewal date) UNCHANGED — aligned billing.
    const [sub] = await liveSub(session.company!.id);
    expect(sub.planId).toBe("pro");
    expect(sub.period).toBe("monthly");
    expect(sub.currentPeriodEnd!.getTime()).toBe(periodEndBefore);

    // Denormalized companies.plan synced.
    const [co] = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.id, session.company!.id));
    expect(co.plan).toBe("pro");

    // A prorated, completed payment row exists.
    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, session.company!.id));
    expect(pay.status).toBe("completed");
    expect(pay.kind).toBe("subscription");
    expect(pay.payload).toMatchObject({
      kind: "subscription",
      plan: "pro",
      period: "monthly",
      proration: true,
    });
    // chargeNow is > 0 and < the full pro price (10000) — a real proration.
    expect(pay.amountMinor).toBeGreaterThan(0);
    expect(pay.amountMinor).toBeLessThan(10000);

    // MIT charge called with the prorated amount + saved method.
    expect(createOrderMock).toHaveBeenCalledTimes(1);
    const [orderInput, orderOpts] = createOrderMock.mock.calls[0];
    expect(orderInput.amount).toBe(pay.amountMinor);
    expect(orderInput.customer).toEqual({ id: "cus_1" });
    expect(chargeSavedMethodMock).toHaveBeenCalledTimes(1);
    const [orderId, chargeInput, chargeOpts] =
      chargeSavedMethodMock.mock.calls[0];
    expect(orderId).toBe("ord_prorate_1");
    expect(chargeInput).toEqual({ savedPaymentMethodId: "pm_saved_1" });
    expect(chargeOpts.idempotencyKey).toBe(orderOpts.idempotencyKey);
  });

  it("upgrade whose proration rounds to 0 applies with NO Revolut call", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    const now = new Date();
    // Period already ended → remaining 0 → chargeNow 0.
    await seedLiveSub(session.company!.id, {
      planId: "starter",
      period: "monthly",
      savedPaymentMethodId: "pm_saved_1",
      currentPeriodStart: new Date(now.getTime() - 30 * 86_400_000),
      currentPeriodEnd: new Date(now.getTime() - 1 * 86_400_000),
    });

    const res = await subscriptionPOST(
      request({ action: "upgrade", plan: "pro", period: "monthly" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { applied: true } });

    const [sub] = await liveSub(session.company!.id);
    expect(sub.planId).toBe("pro"); // applied
    const pays = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, session.company!.id));
    expect(pays).toHaveLength(0); // no payment row
    expect(createOrderMock).not.toHaveBeenCalled();
    expect(chargeSavedMethodMock).not.toHaveBeenCalled();
  });

  it("upgrade with no saved card returns needsCheckout:true (no plan change, no payment)", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    await seedLiveSub(session.company!.id, {
      planId: "starter",
      period: "monthly",
      savedPaymentMethodId: null,
    });

    const res = await subscriptionPOST(
      request({ action: "upgrade", plan: "pro", period: "monthly" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { needsCheckout: true, plan: "pro", period: "monthly" },
    });

    const [sub] = await liveSub(session.company!.id);
    expect(sub.planId).toBe("starter"); // NOT changed
    const pays = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, session.company!.id));
    expect(pays).toHaveLength(0);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("upgrade to a lower/equal plan → VALIDATION (not an upgrade)", async () => {
    const session = await setupSession("pro");
    getSessionMock.mockResolvedValue(session);
    await seedLiveSub(session.company!.id, {
      planId: "pro",
      period: "monthly",
    });

    const res = await subscriptionPOST(
      request({ action: "upgrade", plan: "starter", period: "monthly" }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });
  });

  it("a proration ORDER_COMPLETED webhook re-applies the upgrade idempotently WITHOUT resetting the period", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    await seedLiveSub(session.company!.id, {
      planId: "starter",
      period: "monthly",
      savedPaymentMethodId: "pm_saved_1",
      revolutCustomerId: "cus_1",
    });

    // Perform the upgrade (applies synchronously, writes the proration payment).
    await subscriptionPOST(
      request({ action: "upgrade", plan: "pro", period: "monthly" }),
    );
    const [afterUpgrade] = await liveSub(session.company!.id);
    const periodEnd = afterUpgrade.currentPeriodEnd!.getTime();
    expect(afterUpgrade.planId).toBe("pro");

    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, session.company!.id));

    // The MIT order now emits ORDER_COMPLETED. It must NOT re-activate/reset.
    const res = await webhookPOST(
      signedWebhook({ event: "ORDER_COMPLETED", order_id: pay.revolutOrderId }),
    );
    expect(res.status).toBe(204);

    const [sub] = await liveSub(session.company!.id);
    expect(sub.planId).toBe("pro");
    expect(sub.currentPeriodEnd!.getTime()).toBe(periodEnd); // period NOT reset
    // getOrder (customer capture) is only called on a real activation — not here.
    expect(getOrderMock).not.toHaveBeenCalled();

    // The delivery is journaled (idempotency/audit) and the payment stays completed
    // — the route already completed it, so the webhook's terminal-state guard leaves
    // that row untouched (it does NOT regress or re-activate).
    const journal = await getTestDb()
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.orderId, pay.revolutOrderId!));
    expect(journal).toHaveLength(1);
    const [pay2] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.id, pay.id));
    expect(pay2.status).toBe("completed");
  });

  it("SAFETY NET: a proration ORDER_COMPLETED applies the upgrade when the sync apply never ran", async () => {
    // Simulate the route charging the card but dying before applying (a crash /
    // non-RevolutError): a live sub still on `starter` + a pending proration payment
    // whose order later completes. The webhook must finish the upgrade to `pro`,
    // keeping the period unchanged.
    const session = await setupSession("starter");
    const companyId = session.company!.id;
    const periodEnd = new Date(Date.now() + 20 * 86_400_000);
    await seedLiveSub(companyId, {
      planId: "starter",
      period: "monthly",
      currentPeriodEnd: periodEnd,
    });
    await getTestDb()
      .insert(payments)
      .values({
        companyId,
        kind: "subscription",
        status: "pending",
        amountMinor: 5000,
        currency: "EUR",
        revolutOrderId: "ord_orphan_1",
        idempotencyKey: crypto.randomUUID(),
        payload: {
          kind: "subscription",
          plan: "pro",
          period: "monthly",
          proration: true,
        },
      });

    const res = await webhookPOST(
      signedWebhook({ event: "ORDER_COMPLETED", order_id: "ord_orphan_1" }),
    );
    expect(res.status).toBe(204);

    const [sub] = await liveSub(companyId);
    expect(sub.planId).toBe("pro"); // upgrade completed by the webhook
    expect(sub.currentPeriodEnd!.getTime()).toBe(periodEnd.getTime()); // period kept
    expect(getOrderMock).not.toHaveBeenCalled(); // proration ≠ full activation
  });

  it("upgrade whose MIT charge fails → payment marked failed, plan NOT changed, UNKNOWN", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    await seedLiveSub(session.company!.id, {
      planId: "starter",
      period: "monthly",
      savedPaymentMethodId: "pm_saved_1",
      revolutCustomerId: "cus_1",
    });
    chargeSavedMethodMock.mockRejectedValueOnce(
      new RevolutError(400, '{"code":"card_declined"}'),
    );

    const res = await subscriptionPOST(
      request({ action: "upgrade", plan: "pro", period: "monthly" }),
    );
    expect(res.status).toBe(500);
    // Opaque UNKNOWN — the Revolut error body never leaks to the client.
    expect(await res.json()).toEqual({ ok: false, error: "UNKNOWN" });

    const [sub] = await liveSub(session.company!.id);
    expect(sub.planId).toBe("starter"); // NOT upgraded
    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, session.company!.id));
    expect(pay.status).toBe("failed");
  });

  it("a cross-period upgrade (monthly → annual) is rejected in v1 (VALIDATION)", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    await seedLiveSub(session.company!.id, {
      planId: "starter",
      period: "monthly",
      savedPaymentMethodId: "pm_saved_1",
      revolutCustomerId: "cus_1",
    });

    const res = await subscriptionPOST(
      request({ action: "upgrade", plan: "pro", period: "annual" }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("double-charge guard: an in-flight prorated payment blocks a second concurrent upgrade", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    const companyId = session.company!.id;
    await seedLiveSub(companyId, {
      planId: "starter",
      period: "monthly",
      savedPaymentMethodId: "pm_saved_1",
      revolutCustomerId: "cus_1",
    });
    // A prorated charge already in flight (the first request's pending payment).
    await getTestDb()
      .insert(payments)
      .values({
        companyId,
        kind: "subscription",
        status: "pending",
        amountMinor: 5000,
        currency: "EUR",
        idempotencyKey: crypto.randomUUID(),
        payload: {
          kind: "subscription",
          plan: "pro",
          period: "monthly",
          proration: true,
        },
      });

    const res = await subscriptionPOST(
      request({ action: "upgrade", plan: "pro", period: "monthly" }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });
    // No second charge opened.
    expect(createOrderMock).not.toHaveBeenCalled();
    const rows = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, companyId));
    expect(rows).toHaveLength(1); // still just the in-flight one
  });
});
