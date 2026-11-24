// =============================================================================
// Revolut webhook signature verification (T-B4). Pure crypto — no HTTP, no env,
// no `server-only`: the caller passes in the raw body, headers and the parsed
// signing secret(s), so this is trivially unit-testable in isolation.
//
// Revolut signs each delivery with an HMAC-SHA256 over `v1.<timestamp>.<raw>`
// where `<raw>` is the EXACT request body bytes (verify BEFORE parsing) and
// `<timestamp>` is the `Revolut-Request-Timestamp` header (UNIX ms). The
// `Revolut-Signature` header is `v1=<hex>`, and during secret rotation MAY carry
// several comma-separated values — a delivery is authentic if ANY provided value
// matches ANY configured secret. Comparison is constant-time.
// =============================================================================

import crypto from "node:crypto";

/** Anti-replay window: a timestamp more than 5 minutes off `now` is rejected. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * True when the delivery timestamp is unusable or outside the ±5-minute window
 * (a replayed/stale delivery). A non-numeric header is treated as a replay.
 */
export function isReplay(timestamp: string | null, nowMs: number): boolean {
  const ts = Number(timestamp);
  return !Number.isFinite(ts) || Math.abs(nowMs - ts) > REPLAY_WINDOW_MS;
}

/** Constant-time string compare that treats a length mismatch as "no match". */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // `crypto.timingSafeEqual` THROWS on unequal lengths — guard it and treat a
  // length mismatch as a non-match rather than a crash (a forged signature of a
  // different length must fail cleanly, not 500 the handler).
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export interface VerifyRevolutSignatureArgs {
  /** RAW request body, exactly as received (signature is over these bytes). */
  raw: string;
  /** `Revolut-Request-Timestamp` header value (UNIX ms as a string). */
  timestamp: string;
  /** `Revolut-Signature` header — `v1=<hex>`, possibly comma-separated. */
  signatureHeader: string;
  /** Configured signing secret(s) — several during rotation. */
  secrets: string[];
}

/**
 * Verify the `Revolut-Signature` header against the raw body + timestamp.
 * Returns true if ANY provided `v1=…` value matches the HMAC computed with ANY
 * configured secret. Does NOT check replay — call `isReplay` for that.
 */
export function verifyRevolutSignature({
  raw,
  timestamp,
  signatureHeader,
  secrets,
}: VerifyRevolutSignatureArgs): boolean {
  const payloadToSign = `v1.${timestamp}.${raw}`;
  const provided = signatureHeader
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (provided.length === 0) return false;

  for (const secret of secrets) {
    if (!secret) continue;
    const expected =
      "v1=" +
      crypto.createHmac("sha256", secret).update(payloadToSign).digest("hex");
    for (const sig of provided) {
      if (timingSafeEqualStr(expected, sig)) return true;
    }
  }
  return false;
}
