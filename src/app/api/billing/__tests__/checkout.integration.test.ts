// T-B2 integration tests — `POST /api/billing/checkout` against a REAL Postgres
// (T-13 harness). Proves the server half of the embedded-widget checkout:
//   • the price is read SERVER-SIDE from `plan_prices` (the client body can't set
//     it): a paid checkout writes a `pending` payments row whose amountMinor is
//     exactly the seeded price, and the Revolut order id is stored back;
//   • only `{token, publicKey}` leaves the server — never a secret or internal id;
//   • the free/trial path returns `{free:true}` with NO payments row and NO
//     Revolut call;
//   • with no live subscription row the customer is attached by email (the
//     no-customer-yet path) — createOrder never sees a fabricated customer id.
//
// `createOrder` is mocked so no network is hit; `getSession` is mocked so a test
// controls identity; `@/server/db` is the harness pool. `describeIntegration`
// self-skips with no DB, so this file is a green no-op in a DB-less CI.
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
vi.mock("@/server/billing/revolut", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/billing/revolut")
  >("@/server/billing/revolut");
  return {
    ...actual,
    createOrder: (...args: unknown[]) => createOrderMock(...args),
  };
});

import { eq } from "drizzle-orm";

import { POST as checkoutPOST } from "@/app/api/billing/checkout/route";
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
  companySubscription,
  payments,
  planPrices,
  plans,
} from "@/server/db/schema";
import type { DbCompany, DbSession } from "@/server/db/types";
import type { PlanId } from "@/shared/plans";

/** Insert a company on `plan` + a real user/profile, and build the DbSession. */
async function setupSession(plan: PlanId): Promise<DbSession> {
  const company = await insertCompany({ plan, countryCode: "SI" });
  const { user } = await insertUserWithProfile({ companyId: company.id });
  const dbCompany: DbCompany = {
    id: company.id,
    name: "Acme",
    industry: "Manufacturing",
    nace_code: "C25",
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

/** Seed the plan catalogue (plans + plan_prices) — idempotent; survives resets. */
async function seedCatalogue(): Promise<void> {
  const conn = getTestDb();
  await conn.insert(plans).values(PLAN_SEED.plans).onConflictDoNothing();
  await conn.insert(planPrices).values(PLAN_SEED.prices).onConflictDoNothing();
}

const request = (body: unknown) =>
  new Request("http://api.example.com/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describeIntegration("T-B2 POST /api/billing/checkout", () => {
  beforeAll(async () => {
    await setupSchema();
    await seedCatalogue();
    process.env.NEXT_PUBLIC_REVOLUT_PUBLIC_KEY = "pk_test_123";
  });
  beforeEach(async () => {
    await resetAppTables();
    vi.clearAllMocks();
    createOrderMock.mockResolvedValue({
      id: "ord_1",
      token: "tok_1",
      type: "payment",
      state: "pending",
    });
  });
  afterAll(async () => {
    await closeTestDb();
  });

  /** Starter, annual, in minor units — whatever `PLAN_SEED` prices it at. */
  const STARTER_MONTHLY_MINOR = PLAN_SEED.prices.find(
    (p) => p.planId === "starter" && p.period === "annual",
  )!.amountMinor;

  it("prices server-side: writes a pending payment with the seeded amount and stores the order id", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);

    // starter annual, in minor units, as PLAN_SEED prices it (300 EUR → 30000).
    const res = await checkoutPOST(
      request({ plan: "starter", period: "annual" }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    const rows = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, session.company!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].amountMinor).toBe(STARTER_MONTHLY_MINOR);
    expect(rows[0].currency).toBe("EUR");
    expect(rows[0].kind).toBe("subscription");
    expect(rows[0].revolutOrderId).toBe("ord_1");
    expect(rows[0].payload).toEqual({
      kind: "subscription",
      plan: "starter",
      period: "annual",
    });

    // Price comes from the DB, not the client → createOrder got the seeded amount, not any
    // client-supplied figure, and the customer is attached by EMAIL (no sub row).
    expect(createOrderMock).toHaveBeenCalledTimes(1);
    const [orderInput, orderOpts] = createOrderMock.mock.calls[0];
    expect(orderInput.amount).toBe(STARTER_MONTHLY_MINOR);
    expect(orderInput.currency).toBe("EUR");
    expect(orderInput.capture_mode).toBe("automatic");
    expect(orderInput.customer).toEqual({ email: session.email });
    expect(orderOpts.idempotencyKey).toBe(rows[0].idempotencyKey);
  });

  it("returns ONLY {token, publicKey} — never a secret or an internal id", async () => {
    getSessionMock.mockResolvedValue(await setupSession("pro"));

    const res = await checkoutPOST(request({ plan: "pro", period: "annual" }));
    const json = await res.json();

    expect(json).toEqual({
      ok: true,
      data: { token: "tok_1", publicKey: "pk_test_123" },
    });
    expect(Object.keys(json.data).sort()).toEqual(["publicKey", "token"]);
    // No order id / payment id / secret key ever leaks.
    const blob = JSON.stringify(json);
    expect(blob).not.toContain("ord_1");
    expect(blob).not.toContain("sk_");
  });

  it("reuses an existing Revolut customer id when a live subscription has one", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    await getTestDb().insert(companySubscription).values({
      companyId: session.company!.id,
      planId: "starter",
      period: "annual",
      status: "active",
      revolutCustomerId: "cus_existing",
    });

    await checkoutPOST(request({ plan: "starter", period: "annual" }));

    const [orderInput] = createOrderMock.mock.calls[0];
    expect(orderInput.customer).toEqual({ id: "cus_existing" });
  });

  it("free/trial path returns {free:true}, writes NO payment and calls NO Revolut", async () => {
    const session = await setupSession("trial");
    getSessionMock.mockResolvedValue(session);

    const res = await checkoutPOST(
      request({ plan: "trial", period: "annual" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { free: true } });

    const rows = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, session.company!.id));
    expect(rows).toHaveLength(0);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid plan/period with VALIDATION and no side effects", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);

    const res = await checkoutPOST(
      request({ plan: "bogus", period: "weekly" }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });

    const rows = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, session.company!.id));
    expect(rows).toHaveLength(0);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("unauthenticated → UNAUTHENTICATED", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await checkoutPOST(
      request({ plan: "starter", period: "annual" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "UNAUTHENTICATED" });
  });

  it("a Revolut order failure → opaque UNKNOWN, the pending row is marked failed, no API body leaks", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);
    createOrderMock.mockRejectedValueOnce(
      new RevolutError(400, '{"code":"card_declined_secret"}'),
    );

    const res = await checkoutPOST(
      request({ plan: "starter", period: "annual" }),
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ ok: false, error: "UNKNOWN" });
    // The Revolut error body must never reach the client.
    expect(JSON.stringify(json)).not.toContain("card_declined_secret");

    // The row is terminal (`failed`), not left permanently `pending` with no order.
    const rows = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, session.company!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].revolutOrderId).toBeNull();
  });

  it("ignores a client-supplied amount/currency — price stays the seeded value", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);

    // The route reads only {plan, period}; extra body fields must be inert.
    await checkoutPOST(
      request({
        plan: "starter",
        period: "annual",
        amount: 1,
        amountMinor: 1,
        currency: "USD",
        price: 0,
      }),
    );

    const [orderInput] = createOrderMock.mock.calls[0];
    expect(orderInput.amount).toBe(STARTER_MONTHLY_MINOR);
    expect(orderInput.currency).toBe("EUR");
    const rows = await getTestDb()
      .select()
      .from(payments)
      .where(eq(payments.companyId, session.company!.id));
    expect(rows[0].amountMinor).toBe(STARTER_MONTHLY_MINOR);
    expect(rows[0].currency).toBe("EUR");
  });

  it("layer-B scope: a paid checkout writes NO company_subscription row", async () => {
    const session = await setupSession("starter");
    getSessionMock.mockResolvedValue(session);

    await checkoutPOST(request({ plan: "starter", period: "annual" }));

    const subs = await getTestDb()
      .select()
      .from(companySubscription)
      .where(eq(companySubscription.companyId, session.company!.id));
    expect(subs).toHaveLength(0);
  });
});
