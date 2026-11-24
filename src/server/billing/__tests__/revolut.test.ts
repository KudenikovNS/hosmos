// T-B1 unit tests — the server-only Revolut Merchant API client. Pure (no DB, no
// network): `fetch` is stubbed so we can pin the request contract the live API
// depends on — base URL, the ALWAYS-sent auth/version headers, JSON body
// serialisation, the MIT charge body shape (no `environment` object), optional
// idempotency, and the non-2xx → RevolutError mapping. `server-only` is
// neutralised for vitest's node env.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  RevolutError,
  chargeSavedMethod,
  createCustomer,
  createOrder,
  getCustomer,
  getCustomerPaymentMethods,
  getOrder,
} from "../revolut";

const BASE = "https://sandbox-merchant.revolut.com";
const SECRET = "sk_test_secret_key";
const VERSION = "2026-04-20";

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

/** Build a `Response`-like ok result carrying `body` as JSON. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The `RequestInit` passed to the most recent fetch call. */
function lastInit(): RequestInit {
  return fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
}

/** Parsed request headers of the most recent fetch call. */
function lastHeaders(): Record<string, string> {
  return lastInit().headers as Record<string, string>;
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [
    "REVOLUT_API_BASE",
    "REVOLUT_API_SECRET_KEY",
    "REVOLUT_API_VERSION",
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.REVOLUT_API_BASE = BASE;
  process.env.REVOLUT_API_SECRET_KEY = SECRET;
  process.env.REVOLUT_API_VERSION = VERSION;

  // Fresh Response per call — a Response body can only be read once.
  fetchMock = vi.fn().mockImplementation(() => jsonResponse({ id: "x" }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe("headers (every request)", () => {
  it("always sends Bearer auth, JSON content-type and Revolut-Api-Version", async () => {
    await getCustomer("cus_1");
    const h = lastHeaders();
    expect(h.Authorization).toBe(`Bearer ${SECRET}`);
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Revolut-Api-Version"]).toBe(VERSION);
  });

  it("omits Idempotency-Key unless one is supplied", async () => {
    await createOrder({ amount: 1000, currency: "EUR" });
    expect(lastHeaders()["Idempotency-Key"]).toBeUndefined();

    await createOrder(
      { amount: 1000, currency: "EUR" },
      { idempotencyKey: "idem-123" },
    );
    expect(lastHeaders()["Idempotency-Key"]).toBe("idem-123");
  });
});

describe("createCustomer", () => {
  it("POSTs the input to /api/customers and returns the parsed body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "cus_1", email: "a@b.co" }),
    );
    const out = await createCustomer({ email: "a@b.co", full_name: "A B" });

    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/customers`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "a@b.co",
      full_name: "A B",
    });
    expect(out).toEqual({ id: "cus_1", email: "a@b.co" });
  });
});

describe("getCustomer", () => {
  it("GETs /api/customers/{id}", async () => {
    await getCustomer("cus_42");
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/customers/cus_42`);
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
  });
});

describe("getCustomerPaymentMethods", () => {
  it("GETs the payment-methods path with only_merchant and returns a bare array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: "pm_1", type: "card", saved_for: "merchant" },
        { id: "pm_2", type: "card", saved_for: "customer" },
      ]),
    );
    const out = await getCustomerPaymentMethods("cus_7", {
      onlyMerchant: true,
    });
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(
      `${BASE}/api/customers/cus_7/payment-methods?only_merchant=true`,
    );
    expect(init.method ?? "GET").toBe("GET");
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("pm_1");
  });

  it("omits the query string when onlyMerchant is not set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await getCustomerPaymentMethods("cus_7");
    const [url] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/customers/cus_7/payment-methods`);
  });

  it("normalizes a { payment_methods: [...] } wrapper to the array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        payment_methods: [{ id: "pm_9", saved_for: "merchant" }],
      }),
    );
    const out = await getCustomerPaymentMethods("cus_7", {
      onlyMerchant: true,
    });
    expect(out).toEqual([{ id: "pm_9", saved_for: "merchant" }]);
  });

  it("returns [] for an empty 204 body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(getCustomerPaymentMethods("cus_7")).resolves.toEqual([]);
  });
});

describe("createOrder", () => {
  it("POSTs money as integer minor units to /api/orders", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "ord_1", token: "tok_1", state: "pending" }),
    );
    const out = await createOrder({
      amount: 2500,
      currency: "EUR",
      capture_mode: "automatic",
      customer: { id: "cus_1" },
    });

    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/orders`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      amount: 2500,
      currency: "EUR",
      capture_mode: "automatic",
      customer: { id: "cus_1" },
    });
    expect(out.token).toBe("tok_1");
  });
});

describe("getOrder", () => {
  it("GETs /api/orders/{id}", async () => {
    await getOrder("ord_9");
    const [url] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/orders/ord_9`);
  });
});

describe("chargeSavedMethod (MIT)", () => {
  it("POSTs the merchant-initiated saved-method body with NO environment object", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "pay_1", order_id: "ord_1", state: "completed" }),
    );
    const out = await chargeSavedMethod("ord_1", {
      savedPaymentMethodId: "spm_1",
    });

    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/orders/ord_1/payments`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      saved_payment_method: {
        type: "card",
        id: "spm_1",
        initiator: "merchant",
      },
    });
    expect(body).not.toHaveProperty("environment");
    expect(out.order_id).toBe("ord_1");
  });

  it("forwards an idempotency key when supplied", async () => {
    await chargeSavedMethod(
      "ord_1",
      { savedPaymentMethodId: "spm_1" },
      { idempotencyKey: "mit-1" },
    );
    expect(lastHeaders()["Idempotency-Key"]).toBe("mit-1");
  });
});

describe("error handling", () => {
  it("throws RevolutError with the status and response body on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "bad request" }, 422),
    );
    const err = await createOrder({ amount: 1, currency: "EUR" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RevolutError);
    const re = err as RevolutError;
    expect(re.status).toBe(422);
    expect(re.body).toContain("bad request");
  });

  it("throws a plain Error when a required env var is missing", async () => {
    delete process.env.REVOLUT_API_SECRET_KEY;
    await expect(getCustomer("cus_1")).rejects.toThrow(
      /REVOLUT_API_SECRET_KEY/,
    );
  });

  it("throws when REVOLUT_API_VERSION is missing (never sends without the version)", async () => {
    delete process.env.REVOLUT_API_VERSION;
    await expect(getCustomer("cus_1")).rejects.toThrow(/REVOLUT_API_VERSION/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer order amount before calling fetch (no float to Revolut)", async () => {
    const err = await createOrder({ amount: 25.5, currency: "EUR" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RevolutError);
    expect((err as RevolutError).body).toMatch(/integer in minor units/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps a 2xx body that isn't JSON in a RevolutError, not a raw SyntaxError", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const err = await getCustomer("cus_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevolutError);
    expect((err as RevolutError).body).toContain("gateway");
  });

  it("returns undefined for an empty 2xx body (204)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(getCustomer("cus_1")).resolves.toBeUndefined();
  });
});
