/**
 * POST /api/webhooks/revolut — signed, idempotent Revolut Merchant webhook
 * (BILLING §5, T-B4). Revolut delivers `{event, order_id, merchant_order_ext_ref,
 * incremental_authorisation_ext_reference}` server-to-server.
 *
 * PUBLIC route — Revolut sends no session cookie, so this is NOT wrapped in the
 * session guard and needs no CORS (there is no browser origin). It returns a bare
 * status via `new Response(null, {status})` rather than the `ApiResult` envelope.
 *
 * Strict order (each numbered step matters):
 *   1. Read the RAW body BEFORE parsing — the signature is over the exact bytes.
 *   2. Require the `Revolut-Request-Timestamp` + `Revolut-Signature` headers → else 401.
 *   3. Anti-replay: reject a timestamp outside the ±5-minute window → 401.
 *   4. Verify the HMAC-SHA256 signature (constant-time, rotation-aware) → else 401.
 *   5. Parse the body. A MALFORMED body (not JSON / missing event|order_id) is a
 *      204 no-op, NOT a 4xx — a 4xx just makes Revolut retry the same bad body
 *      forever. (A missing/forged SIGNATURE is still 401 from steps 2-4.)
 *   6. Idempotency: insert a `payment_events` journal row keyed on `(event,
 *      order_id)` with `onConflictDoNothing`. Zero rows back ⇒ already processed
 *      ⇒ 204 with NO side effects.
 *   7. Map the event to a `payments.status` and update the payment matched by
 *      `order_id ↔ payments.revolutOrderId` (also record the raw event in
 *      `revolutState` for audit).
 *   8. ACTIVATION (T-C1): when the event is `ORDER_COMPLETED` for a matching
 *      `subscription` payment, ALSO activate the subscription — write/refresh the
 *      live `company_subscription` row to `active` and sync `companies.plan` — in
 *      the SAME transaction, so entitlements reflect the paid plan immediately.
 *      An unknown event, a missing payment, or a `one_off` payment is journaled
 *      and returns 204 (not an error) with no activation.
 *   9. Return 204. Keep the handler fast — Revolut retries 3×10min and heavy
 *      synchronous work here risks the prod-503 failure mode.
 */
import { and, eq, notInArray } from "drizzle-orm";

import { getOrder } from "@/server/billing/revolut";
import {
  activateSubscription,
  applyPlanChange,
} from "@/server/billing/subscription";
import {
  isReplay,
  verifyRevolutSignature,
} from "@/server/billing/webhook-signature";
import { db } from "@/server/db";
import { paymentEvents, payments } from "@/server/db/schema";

/** Revolut order event → the terminal `payments.status` it drives. */
const EVENT_STATUS: Record<string, string> = {
  ORDER_COMPLETED: "completed",
  ORDER_AUTHORISED: "authorised",
  ORDER_PAYMENT_FAILED: "failed",
  ORDER_PAYMENT_DECLINED: "failed",
  ORDER_CANCELLED: "cancelled",
};

// Money-received terminal states must never regress. Webhook deliveries can arrive
// out of order (a late `ORDER_PAYMENT_DECLINED` retry after `ORDER_COMPLETED`);
// without this guard that would flip a paid order back to `failed`.
const TERMINAL_STATUSES = ["completed", "refunded"];

const noContent = () => new Response(null, { status: 204 });
const unauthorized = () => new Response(null, { status: 401 });

export async function POST(req: Request): Promise<Response> {
  // 1. RAW body first — the signature covers the exact bytes, so read before parse.
  const raw = await req.text();

  // 2. Both headers are mandatory.
  const ts = req.headers.get("Revolut-Request-Timestamp");
  const sigHeader = req.headers.get("Revolut-Signature");
  if (!ts || !sigHeader) return unauthorized();

  // 3. Anti-replay window (±5 min).
  if (isReplay(ts, Date.now())) return unauthorized();

  // 4. Verify the HMAC signature. Multiple comma-separated secrets support rotation.
  const secrets = (process.env.REVOLUT_WEBHOOK_SIGNING_SECRET ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    !verifyRevolutSignature({
      raw,
      timestamp: ts,
      signatureHeader: sigHeader,
      secrets,
    })
  ) {
    return unauthorized();
  }

  // 5. Parse. Malformed → 204 no-op (never make Revolut retry a bad body forever).
  let body: {
    event?: unknown;
    order_id?: unknown;
    merchant_order_ext_ref?: unknown;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    console.error("POST /api/webhooks/revolut: body is not JSON");
    return noContent();
  }
  const { event, order_id: orderId } = body;
  if (typeof event !== "string" || typeof orderId !== "string") {
    console.error("POST /api/webhooks/revolut: missing event/order_id", {
      event,
      orderId,
    });
    return noContent();
  }

  // 6. Cheap idempotency pre-check: if this exact (event, order_id) was already
  //    journaled, short-circuit BEFORE the external getOrder call and the tx.
  //    The transaction's ON CONFLICT below remains the authoritative guard against
  //    a concurrent race; this only spares the network round-trip on obvious retries.
  const [seen] = await db
    .select({ id: paymentEvents.id })
    .from(paymentEvents)
    .where(
      and(eq(paymentEvents.event, event), eq(paymentEvents.orderId, orderId)),
    )
    .limit(1);
  if (seen) return noContent();

  // The payment this order belongs to (may be absent — e.g. a stranded order).
  const [pmt] = await db
    .select({
      id: payments.id,
      companyId: payments.companyId,
      kind: payments.kind,
      payload: payments.payload,
      status: payments.status,
    })
    .from(payments)
    .where(eq(payments.revolutOrderId, orderId))
    .limit(1);

  // A completed order for a subscription payment drives a plan change. Two shapes:
  //   • FULL activation (fresh subscription / renewal) → `activateSubscription`,
  //     which (re)sets `currentPeriodStart/End` to a new term.
  //   • PRORATED upgrade (T-C2, `payload.proration`) → `applyPlanChange`, which
  //     switches the plan but LEAVES `currentPeriodEnd` unchanged (aligned billing —
  //     a full re-activation would extend the paid term for a prorated price).
  // The upgrade route also applies the change synchronously; doing it here too is
  // the SAFETY NET — if the route charged the card but died before applying (a
  // non-RevolutError, a crash), this webhook still completes the upgrade. Both
  // paths are idempotent re-applications of the same plan.
  const isCompletedSub =
    event === "ORDER_COMPLETED" && pmt != null && pmt.kind === "subscription";
  const isProration =
    isCompletedSub &&
    (pmt!.payload as { proration?: boolean })?.proration === true;
  const isActivation = isCompletedSub && !isProration;

  // For a FULL activation, best-effort capture the Revolut customer id (and a saved
  // payment-method id if the order exposes one) BEFORE the transaction. A failure
  // here must NOT block activation — layer D can resolve the saved method later.
  // Proration upgrades don't need this (the saved method is already on the row).
  let revolutCustomerId: string | null = null;
  let savedPaymentMethodId: string | null = null;
  if (isActivation) {
    try {
      const order = await getOrder(orderId);
      // The order shape is `unknown` past the pinned fields — probe defensively.
      const cust = (order as { customer?: { id?: unknown } }).customer;
      revolutCustomerId = typeof cust?.id === "string" ? cust.id : null;
      const pm = (
        order as { payments?: Array<{ payment_method?: { id?: unknown } }> }
      ).payments?.[0]?.payment_method;
      savedPaymentMethodId = typeof pm?.id === "string" ? pm.id : null;
    } catch (err) {
      console.error(
        "POST /api/webhooks/revolut: getOrder failed; activating without customer capture",
        err,
      );
    }
  }

  // 7+8. Journal the delivery and apply its effects ATOMICALLY (status update +
  //    activation). If any half fails the whole thing rolls back, so the
  //    idempotency key is not burned without its side effects — Revolut's retry
  //    then re-does everything.
  const status = EVENT_STATUS[event];
  await db.transaction(async (tx) => {
    // Idempotency journal — insert-or-noop on (event, order_id). Zero rows back
    // means this exact delivery was already processed (race) → no side effects.
    const inserted = await tx
      .insert(paymentEvents)
      .values({
        event,
        orderId,
        merchantOrderExtRef:
          typeof body.merchant_order_ext_ref === "string"
            ? body.merchant_order_ext_ref
            : null,
        paymentId: pmt?.id ?? null,
        raw: body,
      })
      .onConflictDoNothing({
        target: [paymentEvents.event, paymentEvents.orderId],
      })
      .returning({ id: paymentEvents.id });
    if (inserted.length === 0) return; // duplicate delivery

    // Map event → payment status (audit the raw event). Unknown event or missing
    // payment → journaled only. Never regress a money-received terminal state.
    if (status && pmt) {
      await tx
        .update(payments)
        .set({ status, revolutState: event })
        .where(
          and(
            eq(payments.id, pmt.id),
            notInArray(payments.status, TERMINAL_STATUSES),
          ),
        );
    }

    // Apply the plan change in the same transaction (safety net + idempotent).
    if (isCompletedSub && pmt && pmt.payload.kind === "subscription") {
      if (isProration) {
        // Upgrade: switch the plan, keep the renewal date (period NOT reset).
        await applyPlanChange(tx, {
          companyId: pmt.companyId,
          plan: pmt.payload.plan,
          period: pmt.payload.period,
        });
      } else {
        // Fresh subscription / renewal: (re)set the term.
        await activateSubscription(tx, {
          companyId: pmt.companyId,
          plan: pmt.payload.plan,
          period: pmt.payload.period,
          revolutCustomerId,
          savedPaymentMethodId,
        });
      }
    }
  });

  // 9. Success — empty 204 (duplicate, unknown event, and applied all end here).
  return noContent();
}
