// =============================================================================
// Server-only Revolut Merchant API client (T-B1). A thin, typed `fetch` wrapper
// plus helpers for the Merchant API operations the billing flow needs: customers,
// orders, and merchant-initiated (MIT) charges against a saved card.
//
// Facts pinned to the Merchant API version 2026-04-20:
//   • Base URL from `REVOLUT_API_BASE` (sandbox `https://sandbox-merchant.revolut.com`,
//     prod `https://merchant.revolut.com`).
//   • EVERY request carries `Authorization: Bearer <sk_… secret key>`,
//     `Content-Type: application/json`, and the REQUIRED `Revolut-Api-Version`
//     header. `Idempotency-Key` is sent only when the caller supplies one.
//   • Money is ALWAYS an integer in minor units (cents) — never a float.
//   • An MIT charge sends `{saved_payment_method:{type:"card",id,initiator:"merchant"}}`
//     with NO `environment` object (that browser-3DS object is customer-initiated
//     only).
//
// `server-only` guards against accidental client bundling: the `sk_…` secret key
// is read from `process.env.REVOLUT_API_SECRET_KEY` and MUST never reach the
// browser. Only `NEXT_PUBLIC_REVOLUT_PUBLIC_KEY` (the `pk_…` widget key) is ever
// exposed client-side, and it lives elsewhere.
//
// This module intentionally has no route consumer yet (additive). On a non-2xx it
// THROWS `RevolutError` (status + Revolut's error body for the log); the consuming
// checkout route decides how to map that onto the `ApiResult` error contract — we
// do NOT invent a new `ApiErrorCode` here.
// =============================================================================

import "server-only";

/** Thrown on any non-2xx Merchant API response; carries the status + raw body. */
export class RevolutError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Revolut API error ${status}: ${body}`);
    this.name = "RevolutError";
    this.status = status;
    this.body = body;
  }
}

/** Per-call options common to the write helpers. */
export interface RevolutRequestOptions {
  /** Optional idempotency key — forwarded as the `Idempotency-Key` header. */
  idempotencyKey?: string;
}

/** Read `REVOLUT_API_BASE`, trimming any trailing slash so path joins are clean. */
function baseUrl(): string {
  const base = process.env.REVOLUT_API_BASE;
  if (!base) throw new Error("REVOLUT_API_BASE is not set");
  return base.replace(/\/+$/, "");
}

/** Read the `sk_…` secret key (server-only Bearer credential). */
function secretKey(): string {
  const key = process.env.REVOLUT_API_SECRET_KEY;
  if (!key) throw new Error("REVOLUT_API_SECRET_KEY is not set");
  return key;
}

/** Read the REQUIRED Merchant API version (e.g. `2026-04-20`). */
function apiVersion(): string {
  const version = process.env.REVOLUT_API_VERSION;
  if (!version) throw new Error("REVOLUT_API_VERSION is not set");
  return version;
}

/** Options for the private `revolut` core — a JSON body plus optional idempotency. */
interface RevolutCall extends RevolutRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Parsed as JSON and serialised; omit for bodyless GETs. */
  body?: unknown;
}

/**
 * Core Merchant API request: sets the always-on headers (Bearer auth, JSON
 * content-type, the required version header, optional idempotency), serialises the
 * JSON body, and parses the JSON response. Throws `RevolutError` on any non-2xx.
 */
async function revolut<T>(path: string, init: RevolutCall = {}): Promise<T> {
  const { method = "GET", body, idempotencyKey } = init;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey()}`,
    "Content-Type": "application/json",
    "Revolut-Api-Version": apiVersion(),
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new RevolutError(res.status, text);
  if (!text) return undefined as T; // 204 / empty body
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 2xx whose body isn't JSON (e.g. an HTML page from a gateway in front of
    // the API) surfaces as a RevolutError, not a raw SyntaxError, so callers'
    // catch blocks treat it uniformly with other API failures.
    throw new RevolutError(res.status, text);
  }
}

// --- Customers ---------------------------------------------------------------

/** Fields accepted when creating a Merchant API customer (all optional). */
export interface RevolutCustomerInput {
  full_name?: string;
  business_name?: string;
  email?: string;
  phone?: string;
}

/** A Merchant API customer resource. */
export interface RevolutCustomer {
  id: string;
  full_name?: string;
  business_name?: string;
  email?: string;
  phone?: string;
  created_at?: string;
  updated_at?: string;
}

/** `POST /api/customers` — create a customer. */
export function createCustomer(
  input: RevolutCustomerInput,
  opts?: RevolutRequestOptions,
): Promise<RevolutCustomer> {
  return revolut<RevolutCustomer>("/api/customers", {
    method: "POST",
    body: input,
    idempotencyKey: opts?.idempotencyKey,
  });
}

/** `GET /api/customers/{id}` — fetch a customer by id. */
export function getCustomer(id: string): Promise<RevolutCustomer> {
  return revolut<RevolutCustomer>(`/api/customers/${id}`);
}

/** A saved payment method on a customer (only the fields billing consumes). */
export interface RevolutPaymentMethod {
  id: string;
  type?: string;
  /** `"merchant"` = chargeable off-session (MIT); `"customer"` = CIT-only. */
  saved_for?: string;
}

/**
 * `GET /api/customers/{id}/payment-methods` — the customer's saved methods. Used by
 * the renewal cron (layer D) to resolve a missing `savedPaymentMethodId` from the
 * `revolutCustomerId`. Pass `{onlyMerchant:true}` to request just the
 * merchant-initiable (off-session) methods (`?only_merchant=true`).
 *
 * The Merchant API's top-level shape is probed defensively: it may return a BARE
 * array or a `{payment_methods:[...]}` wrapper — both normalize to the array here.
 */
export async function getCustomerPaymentMethods(
  customerId: string,
  opts?: { onlyMerchant?: boolean },
): Promise<RevolutPaymentMethod[]> {
  const qs = opts?.onlyMerchant ? "?only_merchant=true" : "";
  const res = await revolut<
    RevolutPaymentMethod[] | { payment_methods?: RevolutPaymentMethod[] } | null
  >(`/api/customers/${customerId}/payment-methods${qs}`);
  if (Array.isArray(res)) return res;
  return res?.payment_methods ?? [];
}

// --- Orders ------------------------------------------------------------------

/**
 * Body for `createOrder`. `amount` is an integer in minor units (cents) — never a
 * float. `capture_mode` defaults to `automatic` server-side when omitted.
 */
export interface RevolutOrderInput {
  /** Integer minor units (cents). */
  amount: number;
  /** ISO 4217 code, e.g. "EUR". */
  currency: string;
  capture_mode?: "automatic" | "manual";
  customer?: { id?: string; email?: string };
  redirect_url?: string;
  metadata?: Record<string, unknown>;
  subscription_data?: Record<string, unknown>;
}

/**
 * A Merchant API order resource. `token` is what the front-end widget consumes;
 * `checkout_url` is the hosted-checkout link. Extra fields are surfaced via the
 * index signature rather than dropped.
 */
export interface RevolutOrder {
  id: string;
  token: string;
  type: string;
  state: string;
  checkout_url?: string;
  [key: string]: unknown;
}

/** `POST /api/orders` — create an order. */
export function createOrder(
  input: RevolutOrderInput,
  opts?: RevolutRequestOptions,
): Promise<RevolutOrder> {
  // Money is integer minor units — make the doc-only invariant load-bearing so a
  // float can never be serialised straight to Revolut. Reject (not throw) so a
  // caller's `.catch` sees it uniformly with API failures, since this function
  // otherwise returns a promise.
  if (!Number.isInteger(input.amount)) {
    return Promise.reject(
      new RevolutError(
        0,
        `amount must be an integer in minor units, got ${input.amount}`,
      ),
    );
  }
  return revolut<RevolutOrder>("/api/orders", {
    method: "POST",
    body: input,
    idempotencyKey: opts?.idempotencyKey,
  });
}

/** `GET /api/orders/{id}` — fetch an order by id. */
export function getOrder(id: string): Promise<RevolutOrder> {
  return revolut<RevolutOrder>(`/api/orders/${id}`);
}

// --- Merchant-initiated (MIT) charges ---------------------------------------

/** Input for an MIT charge against a saved payment method. */
export interface ChargeSavedMethodInput {
  /** Id of the card saved with `savePaymentMethodFor: 'merchant'` on the widget. */
  savedPaymentMethodId: string;
}

/** A Merchant API payment resource (result of a charge). */
export interface RevolutPayment {
  id: string;
  order_id: string;
  state: string;
  payment_method?: unknown;
  [key: string]: unknown;
}

/**
 * `POST /api/orders/{order_id}/payments` — charge a saved card off-session
 * (merchant-initiated). Builds the fixed `saved_payment_method` body with
 * `initiator: "merchant"` and deliberately sends NO `environment` object (that
 * browser-3DS object is for customer-initiated payments only). Only methods saved
 * with `savePaymentMethodFor: 'merchant'` can be charged this way.
 */
export function chargeSavedMethod(
  orderId: string,
  input: ChargeSavedMethodInput,
  opts?: RevolutRequestOptions,
): Promise<RevolutPayment> {
  return revolut<RevolutPayment>(`/api/orders/${orderId}/payments`, {
    method: "POST",
    body: {
      saved_payment_method: {
        type: "card",
        id: input.savedPaymentMethodId,
        initiator: "merchant",
      },
    },
    idempotencyKey: opts?.idempotencyKey,
  });
}
