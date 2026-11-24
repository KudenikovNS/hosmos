// T-B4 integration tests — `POST /api/webhooks/revolut` against a REAL Postgres
// (T-13 harness). Proves the signed, idempotent webhook end-to-end:
//   • a correctly-signed ORDER_COMPLETED writes a `payment_events` journal row and
//     flips the matching `payments` row to `completed` (revolutState audited);
//   • a DUPLICATE (event, order_id) delivery is a 204 no-op — no second journal
//     row, no re-processing;
//   • a bad signature is a 401 with NO journal row written.
//
// `@/server/db` is the harness pool. `describeIntegration` self-skips with no DB,
// so this file is a green no-op in a DB-less CI. This exercises the RESHAPED 0001
// migration (payment_events keyed on (event, order_id)) via `setupSchema`.
import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return {
    get db() {
      return harness.getTestDb();
    },
  };
});

// Mock the Revolut client so activation captures customer/method WITHOUT any
// network. Tests override the return value per-case via `vi.mocked(getOrder)`.
vi.mock("@/server/billing/revolut", () => ({
  getOrder: vi.fn(),
}));

import { and, eq, inArray } from "drizzle-orm";

import { POST as webhookPOST } from "@/app/api/webhooks/revolut/route";
import { getOrder } from "@/server/billing/revolut";
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
  paymentEvents,
  payments,
} from "@/server/db/schema";

const SECRET = "wsk_test_secret";
const ORDER_ID = "ord_wh_1";

/** Build a correctly-signed webhook Request for `body` (optionally forge the sig). */
function signedRequest(
  body: unknown,
  opts: { secret?: string; timestamp?: number } = {},
): Request {
  const raw = JSON.stringify(body);
  const ts = String(opts.timestamp ?? Date.now());
  const sig =
    "v1=" +
    crypto
      .createHmac("sha256", opts.secret ?? SECRET)
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

/**
 * Insert a `pending` payment carrying `revolutOrderId = ORDER_ID`. Defaults to a
 * `subscription` payment for `starter`/`monthly`; overrides tune kind/plan/period.
 * Returns the payment id + owning company id.
 */
async function insertPendingPayment(
  opts: {
    kind?: "subscription" | "one_off";
    plan?: "starter" | "pro" | "enterprise";
    period?: "monthly" | "annual";
  } = {},
): Promise<{ paymentId: string; companyId: string }> {
  const company = await insertCompany({ countryCode: "SI", plan: "trial" });
  const kind = opts.kind ?? "subscription";
  const payload =
    kind === "subscription"
      ? {
          kind: "subscription" as const,
          plan: opts.plan ?? "starter",
          period: opts.period ?? "monthly",
        }
      : {
          kind: "one_off" as const,
          sku: "credits_100",
          qty: 1,
          description: "100 credits",
        };
  const [row] = await getTestDb()
    .insert(payments)
    .values({
      companyId: company.id,
      kind,
      status: "pending",
      amountMinor: 2000,
      currency: "EUR",
      revolutOrderId: ORDER_ID,
      idempotencyKey: crypto.randomUUID(),
      payload,
    })
    .returning({ id: payments.id });
  return { paymentId: row.id, companyId: company.id };
}

describeIntegration("T-B4 POST /api/webhooks/revolut", () => {
  beforeAll(async () => {
    await setupSchema();
    process.env.REVOLUT_WEBHOOK_SIGNING_SECRET = SECRET;
  });
  beforeEach(async () => {
    await resetAppTables();
    vi.clearAllMocks();
    // Default: a completed order exposing a customer id + saved payment method.
    vi.mocked(getOrder).mockResolvedValue({
      id: ORDER_ID,
      token: "tok_1",
      type: "payment",
      state: "completed",
      customer: { id: "cus_test_1" },
      payments: [{ payment_method: { id: "pm_test_1" } }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it("signed ORDER_COMPLETED: journals the event and flips the payment to completed", async () => {
    const { paymentId } = await insertPendingPayment();

    const res = await webhookPOST(
      signedRequest({ event: "ORDER_COMPLETED", order_id: ORDER_ID }),
    );
    expect(res.status).toBe(204);

    const events = await getTestDb()
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.orderId, ORDER_ID));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("ORDER_COMPLETED");
    expect(events[0].paymentId).toBe(paymentId); // journal row links its payment

    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(pay.status).toBe("completed");
    expect(pay.revolutState).toBe("ORDER_COMPLETED");
  });

  it("maps ORDER_PAYMENT_DECLINED to failed", async () => {
    const { paymentId } = await insertPendingPayment();

    const res = await webhookPOST(
      signedRequest({ event: "ORDER_PAYMENT_DECLINED", order_id: ORDER_ID }),
    );
    expect(res.status).toBe(204);

    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(pay.status).toBe("failed");
  });

  it("a duplicate (event, order_id) delivery is a 204 no-op — no second row, no re-processing", async () => {
    const { paymentId } = await insertPendingPayment();

    const first = await webhookPOST(
      signedRequest({ event: "ORDER_COMPLETED", order_id: ORDER_ID }),
    );
    expect(first.status).toBe(204);

    // Simulate a stale state the second delivery must NOT overwrite.
    await getTestDb()
      .update(payments)
      .set({ status: "refunded" })
      .where(eq(payments.id, paymentId));

    const second = await webhookPOST(
      signedRequest({ event: "ORDER_COMPLETED", order_id: ORDER_ID }),
    );
    expect(second.status).toBe(204);

    const events = await getTestDb()
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.orderId, ORDER_ID));
    expect(events).toHaveLength(1); // still exactly one journal row

    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(pay.status).toBe("refunded"); // duplicate did NOT re-process
  });

  it("a bad signature → 401 with no journal row written", async () => {
    await insertPendingPayment();

    const res = await webhookPOST(
      signedRequest(
        { event: "ORDER_COMPLETED", order_id: ORDER_ID },
        { secret: "wsk_attacker" },
      ),
    );
    expect(res.status).toBe(401);

    const events = await getTestDb().select().from(paymentEvents);
    expect(events).toHaveLength(0);
  });

  it("an expired timestamp → 401 with no journal row written", async () => {
    await insertPendingPayment();

    const res = await webhookPOST(
      signedRequest(
        { event: "ORDER_COMPLETED", order_id: ORDER_ID },
        { timestamp: Date.now() - 10 * 60 * 1000 },
      ),
    );
    expect(res.status).toBe(401);

    const events = await getTestDb().select().from(paymentEvents);
    expect(events).toHaveLength(0);
  });

  it("a late out-of-order delivery never regresses a completed payment", async () => {
    const { paymentId } = await insertPendingPayment();

    // Order completes...
    await webhookPOST(
      signedRequest({ event: "ORDER_COMPLETED", order_id: ORDER_ID }),
    );
    // ...then a late/retried DECLINED for the SAME order arrives (distinct event,
    // so it journals a new row) — it must NOT downgrade completed → failed.
    const late = await webhookPOST(
      signedRequest({ event: "ORDER_PAYMENT_DECLINED", order_id: ORDER_ID }),
    );
    expect(late.status).toBe(204);

    const events = await getTestDb()
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.orderId, ORDER_ID));
    expect(events).toHaveLength(2); // both deliveries journaled

    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(pay.status).toBe("completed"); // terminal state preserved
  });

  it("a malformed (non-JSON) body with a valid signature → 204 and no journal row", async () => {
    const raw = "not-json";
    const ts = String(Date.now());
    const sig =
      "v1=" +
      crypto
        .createHmac("sha256", SECRET)
        .update(`v1.${ts}.${raw}`)
        .digest("hex");
    const req = new Request("http://api.example.com/api/webhooks/revolut", {
      method: "POST",
      body: raw,
      headers: {
        "content-type": "application/json",
        "Revolut-Request-Timestamp": ts,
        "Revolut-Signature": sig,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const res = await webhookPOST(req);
    expect(res.status).toBe(204);
    const events = await getTestDb().select().from(paymentEvents);
    expect(events).toHaveLength(0);
  });

  it("missing signature headers → 401 with no journal row", async () => {
    const req = new Request("http://api.example.com/api/webhooks/revolut", {
      method: "POST",
      body: JSON.stringify({ event: "ORDER_COMPLETED", order_id: ORDER_ID }),
      headers: { "content-type": "application/json" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const res = await webhookPOST(req);
    expect(res.status).toBe(401);
    const events = await getTestDb().select().from(paymentEvents);
    expect(events).toHaveLength(0);
  });

  it("an unknown event for a matching order is journaled but leaves the payment untouched (204)", async () => {
    const { paymentId } = await insertPendingPayment();

    const res = await webhookPOST(
      signedRequest({ event: "ORDER_SOMETHING_NEW", order_id: ORDER_ID }),
    );
    expect(res.status).toBe(204);

    const events = await getTestDb()
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.orderId, ORDER_ID));
    expect(events).toHaveLength(1);

    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(pay.status).toBe("pending"); // unknown event → no status change
  });

  // ─── T-C1: activation on ORDER_COMPLETED for a subscription payment ─────────

  const liveSub = (companyId: string) =>
    getTestDb()
      .select()
      .from(companySubscription)
      .where(
        and(
          eq(companySubscription.companyId, companyId),
          inArray(companySubscription.status, [
            "trialing",
            "active",
            "past_due",
          ]),
        ),
      );

  it("ORDER_COMPLETED for a subscription payment activates the sub and syncs companies.plan", async () => {
    const { companyId } = await insertPendingPayment({
      plan: "pro",
      period: "annual",
    });

    const res = await webhookPOST(
      signedRequest({ event: "ORDER_COMPLETED", order_id: ORDER_ID }),
    );
    expect(res.status).toBe(204);

    const [sub] = await liveSub(companyId);
    expect(sub).toBeDefined();
    expect(sub.status).toBe("active");
    expect(sub.planId).toBe("pro");
    expect(sub.period).toBe("annual");
    expect(sub.currentPeriodStart).toBeInstanceOf(Date);
    expect(sub.currentPeriodEnd).toBeInstanceOf(Date);
    // annual term ≈ 1 year later.
    const days =
      (sub.currentPeriodEnd!.getTime() - sub.currentPeriodStart!.getTime()) /
      86_400_000;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(370);
    // Customer/method captured from the (mocked) order.
    expect(sub.revolutCustomerId).toBe("cus_test_1");
    expect(sub.savedPaymentMethodId).toBe("pm_test_1");

    const [co] = await getTestDb()
      .select()
      .from(companies)
      .where(eq(companies.id, companyId));
    expect(co.plan).toBe("pro"); // denormalized plan synced
    expect(co.subscriptionStartedAt).toBeInstanceOf(Date);
    expect(co.nextPaymentAt).toBeInstanceOf(Date);
  });

  it("refreshes the company's existing trialing row in place (one live row, no duplicate)", async () => {
    const { companyId } = await insertPendingPayment({ plan: "starter" });
    // Pre-seed a live trialing row for the same company.
    await getTestDb().insert(companySubscription).values({
      companyId,
      planId: "trial",
      period: "monthly",
      status: "trialing",
    });

    const res = await webhookPOST(
      signedRequest({ event: "ORDER_COMPLETED", order_id: ORDER_ID }),
    );
    expect(res.status).toBe(204);

    const rows = await liveSub(companyId);
    expect(rows).toHaveLength(1); // reused the row, no second live row
    expect(rows[0].status).toBe("active");
    expect(rows[0].planId).toBe("starter");
  });

  it("a duplicate ORDER_COMPLETED does not double-activate", async () => {
    const { companyId } = await insertPendingPayment({ plan: "starter" });

    await webhookPOST(
      signedRequest({ event: "ORDER_COMPLETED", order_id: ORDER_ID }),
    );
    const [first] = await liveSub(companyId);
    // Nudge the row so a re-activation would be observable.
    await getTestDb()
      .update(companySubscription)
      .set({ status: "past_due" })
      .where(eq(companySubscription.id, first.id));

    const second = await webhookPOST(
      signedRequest({ event: "ORDER_COMPLETED", order_id: ORDER_ID }),
    );
    expect(second.status).toBe(204);

    const rows = await liveSub(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("past_due"); // duplicate did NOT re-activate
    // getOrder is not called again on the idempotent retry.
    expect(vi.mocked(getOrder)).toHaveBeenCalledTimes(1);
  });

  it("ORDER_COMPLETED for a one_off payment does NOT create a subscription", async () => {
    const { companyId, paymentId } = await insertPendingPayment({
      kind: "one_off",
    });

    const res = await webhookPOST(
      signedRequest({ event: "ORDER_COMPLETED", order_id: ORDER_ID }),
    );
    expect(res.status).toBe(204);

    const rows = await liveSub(companyId);
    expect(rows).toHaveLength(0); // no subscription for a one-off

    const [pay] = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(pay.status).toBe("completed"); // payment still completes
    expect(vi.mocked(getOrder)).not.toHaveBeenCalled(); // no capture for one_off
  });

  it("activates even when getOrder throws — customer/method left null", async () => {
    vi.mocked(getOrder).mockRejectedValueOnce(new Error("network down"));
    const { companyId } = await insertPendingPayment({ plan: "starter" });

    const res = await webhookPOST(
      signedRequest({ event: "ORDER_COMPLETED", order_id: ORDER_ID }),
    );
    expect(res.status).toBe(204);

    const [sub] = await liveSub(companyId);
    expect(sub.status).toBe("active");
    expect(sub.planId).toBe("starter");
    expect(sub.revolutCustomerId).toBeNull();
    expect(sub.savedPaymentMethodId).toBeNull();
  });
});
