// T-D1 integration tests — the daily billing cron against a REAL Postgres (T-13
// harness). Proves `runBillingCron` end-to-end plus the protected route:
//   • a due active sub with a saved card → renewed (MIT charged, period extended,
//     completed payment, companies.nextPaymentAt bumped);
//   • a due sub with a pending downgrade → charged on the NEW plan, plan switched,
//     pending cleared;
//   • a due sub whose charge throws RevolutError → past_due (dunning begins),
//     payment failed, plan NOT renewed;
//   • a due sub with no saved method and no customer → past_due (couldn't charge);
//   • a saved-method resolved from the customer's methods → used + persisted;
//   • cancel_at_period_end at EOP → expired + companies.plan='trial';
//   • an elapsed trial → expired; an open-ended trial is UNTOUCHED;
//   • the route: missing/wrong Bearer → 401 (no work); correct Bearer → 200 + summary.
//
// `createOrder`/`chargeSavedMethod`/`getCustomerPaymentMethods` are mocked so no
// network is hit; `@/server/db` is the harness pool. `describeIntegration` self-skips
// with no DATABASE_URL → a green no-op in a DB-less CI.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

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
const getCustomerPaymentMethodsMock = vi.fn();
vi.mock("@/server/billing/revolut", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/billing/revolut")
  >("@/server/billing/revolut");
  return {
    ...actual,
    createOrder: (...args: unknown[]) => createOrderMock(...args),
    chargeSavedMethod: (...args: unknown[]) => chargeSavedMethodMock(...args),
    getCustomerPaymentMethods: (...args: unknown[]) =>
      getCustomerPaymentMethodsMock(...args),
  };
});

import { and, eq, inArray } from "drizzle-orm";

import { POST as cronPOST } from "@/app/api/billing/cron/route";
import { PLAN_SEED } from "@/server/billing/plan-catalog";
import { RevolutError } from "@/server/billing/revolut";
import { runBillingCron } from "@/server/billing/cron";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  companies,
  companySubscription,
  payments,
  planPrices,
  plans,
} from "@/server/db/schema";
import type { PlanId } from "@/shared/plans";

const DAY = 86_400_000;
const CRON_SECRET = "cron_secret_test";

async function seedCatalogue(): Promise<void> {
  const conn = getTestDb();
  await conn.insert(plans).values(PLAN_SEED.plans).onConflictDoNothing();
  await conn.insert(planPrices).values(PLAN_SEED.prices).onConflictDoNothing();
}

/** Insert a due (period-ended) subscription for `companyId`. */
async function insertDueSub(
  companyId: string,
  overrides: Partial<typeof companySubscription.$inferInsert> = {},
): Promise<void> {
  const now = Date.now();
  await getTestDb()
    .insert(companySubscription)
    .values({
      companyId,
      planId: "starter",
      period: "monthly",
      status: "active",
      currentPeriodStart: new Date(now - 35 * DAY),
      currentPeriodEnd: new Date(now - 1 * DAY), // already elapsed
      ...overrides,
    });
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

const anySub = (companyId: string) =>
  getTestDb()
    .select()
    .from(companySubscription)
    .where(eq(companySubscription.companyId, companyId));

async function priceOf(plan: PlanId, period: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ amountMinor: planPrices.amountMinor })
    .from(planPrices)
    .where(
      and(
        eq(planPrices.planId, plan),
        eq(planPrices.period, period),
        eq(planPrices.currency, "EUR"),
      ),
    );
  return row.amountMinor;
}

describeIntegration("T-D1 runBillingCron", () => {
  beforeAll(async () => {
    await setupSchema();
    await seedCatalogue();
    process.env.BILLING_CRON_SECRET = CRON_SECRET;
  });
  beforeEach(async () => {
    await resetAppTables();
    vi.clearAllMocks();
    createOrderMock.mockResolvedValue({
      id: "ord_renew_1",
      token: "tok_1",
      type: "payment",
      state: "pending",
    });
    chargeSavedMethodMock.mockResolvedValue({
      id: "pay_1",
      order_id: "ord_renew_1",
      state: "completed",
    });
    getCustomerPaymentMethodsMock.mockResolvedValue([]);
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it("renews a due active sub with a saved card (MIT charged, period extended)", async () => {
    const co = await insertCompany({ plan: "starter" });
    await insertDueSub(co.id, {
      savedPaymentMethodId: "pm_saved_1",
      revolutCustomerId: "cus_1",
    });
    const [before] = await liveSub(co.id);
    const oldEnd = before.currentPeriodEnd!.getTime();

    const now = new Date();
    const summary = await runBillingCron(now);
    expect(summary.renewed).toBe(1);
    expect(summary.pastDue).toBe(0);

    const [sub] = await liveSub(co.id);
    expect(sub.status).toBe("active");
    expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(oldEnd);

    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, co.id));
    expect(pay.status).toBe("completed");
    expect(pay.kind).toBe("subscription");
    expect(pay.payload).toMatchObject({
      kind: "subscription",
      plan: "starter",
      period: "monthly",
    });
    expect(pay.payload).not.toHaveProperty("proration");
    expect(pay.amountMinor).toBe(await priceOf("starter", "monthly"));

    const [company] = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.id, co.id));
    expect(company.nextPaymentAt!.getTime()).toBe(
      sub.currentPeriodEnd!.getTime(),
    );

    expect(createOrderMock).toHaveBeenCalledTimes(1);
    const [orderInput] = createOrderMock.mock.calls[0];
    expect(orderInput.amount).toBe(pay.amountMinor);
    expect(orderInput.customer).toEqual({ id: "cus_1" });
  });

  it("applies a scheduled downgrade at renewal (charges the NEW plan, clears pending)", async () => {
    const co = await insertCompany({ plan: "pro" });
    await insertDueSub(co.id, {
      planId: "pro",
      period: "monthly",
      pendingPlanId: "starter",
      pendingPeriod: "monthly",
      savedPaymentMethodId: "pm_saved_1",
      revolutCustomerId: "cus_1",
    });

    const summary = await runBillingCron(new Date());
    expect(summary.downgraded).toBe(1);
    expect(summary.renewed).toBe(0);

    const [sub] = await liveSub(co.id);
    expect(sub.planId).toBe("starter");
    expect(sub.pendingPlanId).toBeNull();
    expect(sub.pendingPeriod).toBeNull();

    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, co.id));
    expect(pay.amountMinor).toBe(await priceOf("starter", "monthly"));
    const [orderInput] = createOrderMock.mock.calls[0];
    expect(orderInput.amount).toBe(await priceOf("starter", "monthly"));
  });

  it("moves a sub to past_due when the MIT charge fails (payment failed, plan not renewed)", async () => {
    const co = await insertCompany({ plan: "starter" });
    await insertDueSub(co.id, {
      savedPaymentMethodId: "pm_saved_1",
      revolutCustomerId: "cus_1",
    });
    const [before] = await liveSub(co.id);
    const oldEnd = before.currentPeriodEnd!.getTime();
    chargeSavedMethodMock.mockRejectedValueOnce(
      new RevolutError(400, '{"code":"card_declined"}'),
    );

    const summary = await runBillingCron(new Date());
    expect(summary.pastDue).toBe(1);
    expect(summary.renewed).toBe(0);

    const [sub] = await liveSub(co.id);
    expect(sub.status).toBe("past_due");
    expect(sub.dunningAttempts).toBe(1);
    expect(sub.dunningNextAt).not.toBeNull();
    expect(sub.planId).toBe("starter"); // NOT renewed
    expect(sub.currentPeriodEnd!.getTime()).toBe(oldEnd); // period untouched

    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, co.id));
    expect(pay.status).toBe("failed");
  });

  it("moves a sub to past_due when there is no saved method and no customer", async () => {
    const co = await insertCompany({ plan: "starter" });
    await insertDueSub(co.id, {
      savedPaymentMethodId: null,
      revolutCustomerId: null,
    });

    const summary = await runBillingCron(new Date());
    expect(summary.pastDue).toBe(1);

    const [sub] = await liveSub(co.id);
    expect(sub.status).toBe("past_due");
    expect(sub.dunningAttempts).toBe(1);

    const pays = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, co.id));
    expect(pays).toHaveLength(0); // never opened a charge
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("resolves a missing saved method from the customer and persists it", async () => {
    const co = await insertCompany({ plan: "starter" });
    await insertDueSub(co.id, {
      savedPaymentMethodId: null,
      revolutCustomerId: "cus_1",
    });
    getCustomerPaymentMethodsMock.mockResolvedValueOnce([
      { id: "pm_resolved", type: "card", saved_for: "merchant" },
    ]);

    const summary = await runBillingCron(new Date());
    expect(summary.renewed).toBe(1);

    expect(getCustomerPaymentMethodsMock).toHaveBeenCalledWith("cus_1", {
      onlyMerchant: true,
    });
    const [chargeOrderId, chargeInput] = chargeSavedMethodMock.mock.calls[0];
    expect(chargeOrderId).toBe("ord_renew_1");
    expect(chargeInput).toEqual({ savedPaymentMethodId: "pm_resolved" });

    const [sub] = await liveSub(co.id);
    expect(sub.savedPaymentMethodId).toBe("pm_resolved"); // persisted
  });

  it("expires a sub cancelled at period end (companies.plan → trial)", async () => {
    const co = await insertCompany({ plan: "pro" });
    await insertDueSub(co.id, {
      planId: "pro",
      period: "monthly",
      cancelAtPeriodEnd: true,
    });

    const summary = await runBillingCron(new Date());
    expect(summary.expired).toBe(1);
    expect(summary.renewed).toBe(0);
    expect(createOrderMock).not.toHaveBeenCalled();

    const [sub] = await anySub(co.id);
    expect(sub.status).toBe("expired");
    const [company] = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.id, co.id));
    expect(company.plan).toBe("trial");
    expect(company.nextPaymentAt).toBeNull();
  });

  it("expires an elapsed trial but leaves an open-ended trial untouched", async () => {
    const now = Date.now();
    const elapsed = await insertCompany({ plan: "trial" });
    await getTestDb()
      .insert(companySubscription)
      .values({
        companyId: elapsed.id,
        planId: "starter",
        period: "monthly",
        status: "trialing",
        trialEndsAt: new Date(now - 1 * DAY),
      });
    const openEnded = await insertCompany({ plan: "trial" });
    await getTestDb().insert(companySubscription).values({
      companyId: openEnded.id,
      planId: "starter",
      period: "monthly",
      status: "trialing",
      trialEndsAt: null, // open-ended → never expires
    });

    const summary = await runBillingCron(new Date());
    expect(summary.expired).toBe(1);

    const [elapsedSub] = await anySub(elapsed.id);
    expect(elapsedSub.status).toBe("expired");
    const [openSub] = await anySub(openEnded.id);
    expect(openSub.status).toBe("trialing"); // untouched
  });

  it("processes each subscription independently — a poison row does not abort the batch", async () => {
    // A good renewable sub PLUS a poison row: a due `active` sub whose plan has NO
    // plan_prices row (period 'annual' isn't seeded for a bogus setup) → it must be
    // counted in `failed` while the good sub still renews.
    const good = await insertCompany({ plan: "starter" });
    await insertDueSub(good.id, {
      savedPaymentMethodId: "pm_saved_1",
      revolutCustomerId: "cus_1",
    });
    // Poison: delete the starter/annual price so this sub can't be priced.
    const poison = await insertCompany({ plan: "starter" });
    await insertDueSub(poison.id, {
      period: "annual",
      savedPaymentMethodId: "pm_saved_2",
      revolutCustomerId: "cus_2",
    });
    await getTestDb()
      .delete(planPrices)
      .where(
        and(eq(planPrices.planId, "starter"), eq(planPrices.period, "annual")),
      );

    const summary = await runBillingCron(new Date());
    expect(summary.renewed).toBe(1); // good sub processed despite the poison row
    expect(summary.failed).toBe(1); // poison counted, batch not aborted
    expect(summary.errors).toHaveLength(1);

    const [goodSub] = await liveSub(good.id);
    expect(goodSub.status).toBe("active"); // renewed
  });

  it("moves a sub to past_due when createOrder itself fails (not just the charge)", async () => {
    const co = await insertCompany({ plan: "starter" });
    await insertDueSub(co.id, {
      savedPaymentMethodId: "pm_saved_1",
      revolutCustomerId: "cus_1",
    });
    createOrderMock.mockRejectedValueOnce(new RevolutError(500, "{}"));

    const summary = await runBillingCron(new Date());
    expect(summary.pastDue).toBe(1);
    expect(summary.renewed).toBe(0);

    const [sub] = await liveSub(co.id);
    expect(sub.status).toBe("past_due");
    expect(sub.dunningAttempts).toBe(1);
    expect(chargeSavedMethodMock).not.toHaveBeenCalled();
  });

  it("route: missing or wrong Bearer → 401 (no work)", async () => {
    const noHeader = await cronPOST(
      new Request("http://x/api/billing/cron", { method: "POST" }),
    );
    expect(noHeader.status).toBe(401);

    const wrong = await cronPOST(
      new Request("http://x/api/billing/cron", {
        method: "POST",
        headers: { authorization: "Bearer nope" },
      }),
    );
    expect(wrong.status).toBe(401);
  });

  it("route: correct Bearer → 200 + summary", async () => {
    const res = await cronPOST(
      new Request("http://x/api/billing/cron", {
        method: "POST",
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      renewed: expect.any(Number),
      downgraded: expect.any(Number),
      expired: expect.any(Number),
      pastDue: expect.any(Number),
      recovered: expect.any(Number),
      retriesScheduled: expect.any(Number),
      failed: expect.any(Number),
      errors: expect.any(Array),
    });
  });

  // ── T-D2: dunning retries on `past_due` subs. `DUNNING_INTERVAL_DAYS`/`RETRIES`
  //    are pinned for deterministic interval math and a 3-attempt cap, restored after.
  describe("T-D2 dunning retries", () => {
    const savedInterval = process.env.DUNNING_INTERVAL_DAYS;
    const savedRetries = process.env.DUNNING_RETRIES;
    beforeAll(() => {
      process.env.DUNNING_INTERVAL_DAYS = "1,3,5";
      process.env.DUNNING_RETRIES = "3";
    });
    afterAll(() => {
      if (savedInterval === undefined) delete process.env.DUNNING_INTERVAL_DAYS;
      else process.env.DUNNING_INTERVAL_DAYS = savedInterval;
      if (savedRetries === undefined) delete process.env.DUNNING_RETRIES;
      else process.env.DUNNING_RETRIES = savedRetries;
    });

    /** Insert a `past_due` sub with an (elapsed period +) dunning schedule. */
    async function insertPastDueSub(
      companyId: string,
      overrides: Partial<typeof companySubscription.$inferInsert> = {},
    ): Promise<void> {
      const now = Date.now();
      await getTestDb()
        .insert(companySubscription)
        .values({
          companyId,
          planId: "starter",
          period: "monthly",
          status: "past_due",
          currentPeriodStart: new Date(now - 35 * DAY),
          currentPeriodEnd: new Date(now - 5 * DAY),
          dunningAttempts: 1,
          dunningNextAt: new Date(now - 1 * DAY), // retry due
          savedPaymentMethodId: "pm_saved_1",
          revolutCustomerId: "cus_1",
          ...overrides,
        });
    }

    it("recovers a past_due sub when the retry SUCCEEDS (back to active, dunning reset)", async () => {
      const co = await insertCompany({ plan: "starter" });
      await insertPastDueSub(co.id);

      const now = new Date();
      const summary = await runBillingCron(now);
      expect(summary.recovered).toBe(1);
      expect(summary.pastDue).toBe(0);
      expect(summary.expired).toBe(0);

      const [sub] = await liveSub(co.id);
      expect(sub.status).toBe("active");
      expect(sub.dunningAttempts).toBe(0);
      expect(sub.dunningNextAt).toBeNull();
      expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(now.getTime());

      const [pay] = await getTestDb()
        .select()
        .from(payments)
        .where(eq(payments.companyId, co.id));
      expect(pay.status).toBe("completed");

      const [company] = await getTestDb()
        .select()
        .from(companies)
        .where(eq(companies.id, co.id));
      expect(company.plan).toBe("starter"); // restored to the paid plan
      expect(company.nextPaymentAt!.getTime()).toBe(
        sub.currentPeriodEnd!.getTime(),
      );
    });

    it("schedules the next retry when the retry FAILS with attempts remaining", async () => {
      const co = await insertCompany({ plan: "starter" });
      await insertPastDueSub(co.id, { dunningAttempts: 1 });
      chargeSavedMethodMock.mockRejectedValueOnce(
        new RevolutError(400, '{"code":"card_declined"}'),
      );

      const now = new Date();
      const summary = await runBillingCron(now);
      expect(summary.retriesScheduled).toBe(1);
      expect(summary.recovered).toBe(0);
      expect(summary.expired).toBe(0);

      const [sub] = await liveSub(co.id);
      expect(sub.status).toBe("past_due");
      expect(sub.dunningAttempts).toBe(2);
      // intervalDays(2) with schedule "1,3,5" → 3 days after `now`.
      expect(sub.dunningNextAt!.getTime()).toBe(now.getTime() + 3 * DAY);

      const [pay] = await getTestDb()
        .select()
        .from(payments)
        .where(eq(payments.companyId, co.id));
      expect(pay.status).toBe("failed");
    });

    it("expires the sub when the LAST retry fails (companies.plan → trial)", async () => {
      const co = await insertCompany({ plan: "starter" });
      // dunningAttempts already DUNNING_RETRIES-1 (2) → this failure exhausts retries.
      await insertPastDueSub(co.id, { dunningAttempts: 2 });
      chargeSavedMethodMock.mockRejectedValueOnce(
        new RevolutError(400, '{"code":"card_declined"}'),
      );

      const summary = await runBillingCron(new Date());
      expect(summary.expired).toBe(1);
      expect(summary.recovered).toBe(0);
      expect(summary.retriesScheduled).toBe(0);

      const [sub] = await anySub(co.id);
      expect(sub.status).toBe("expired");

      const [company] = await getTestDb()
        .select()
        .from(companies)
        .where(eq(companies.id, co.id));
      expect(company.plan).toBe("trial");
      expect(company.nextPaymentAt).toBeNull();
    });

    it("does NOT retry a past_due sub whose dunning_next_at is in the future", async () => {
      const co = await insertCompany({ plan: "starter" });
      const future = new Date(Date.now() + 5 * DAY);
      await insertPastDueSub(co.id, {
        dunningAttempts: 1,
        dunningNextAt: future,
      });

      const summary = await runBillingCron(new Date());
      expect(summary.recovered).toBe(0);
      expect(summary.retriesScheduled).toBe(0);
      expect(summary.expired).toBe(0);
      expect(createOrderMock).not.toHaveBeenCalled();

      const [sub] = await liveSub(co.id);
      expect(sub.status).toBe("past_due"); // untouched
      expect(sub.dunningAttempts).toBe(1);
    });
  });
});
