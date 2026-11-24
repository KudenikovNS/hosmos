// Unit tests for the Revolut webhook signature helper (T-B4). NO DB, NO HTTP.
// Real HMACs are computed here with `node:crypto` so a passing signature is a
// genuine signature, not a stub.
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  isReplay,
  REPLAY_WINDOW_MS,
  verifyRevolutSignature,
} from "@/server/billing/webhook-signature";

const SECRET = "wsk_primary_secret";
const OLD_SECRET = "wsk_rotated_out_secret";

/** Produce a genuine `v1=<hex>` header for a body/timestamp under `secret`. */
function sign(raw: string, timestamp: string, secret: string): string {
  return (
    "v1=" +
    crypto
      .createHmac("sha256", secret)
      .update(`v1.${timestamp}.${raw}`)
      .digest("hex")
  );
}

describe("verifyRevolutSignature", () => {
  const raw = JSON.stringify({ event: "ORDER_COMPLETED", order_id: "ord_1" });
  const ts = "1700000000000";

  it("accepts a correctly-signed payload", () => {
    expect(
      verifyRevolutSignature({
        raw,
        timestamp: ts,
        signatureHeader: sign(raw, ts, SECRET),
        secrets: [SECRET],
      }),
    ).toBe(true);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const header = sign(raw, ts, SECRET);
    expect(
      verifyRevolutSignature({
        raw: raw.replace("ord_1", "ord_evil"),
        timestamp: ts,
        signatureHeader: header,
        secrets: [SECRET],
      }),
    ).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(
      verifyRevolutSignature({
        raw,
        timestamp: ts,
        signatureHeader: sign(raw, ts, "wsk_attacker"),
        secrets: [SECRET],
      }),
    ).toBe(false);
  });

  it("accepts when one of several comma-separated signatures matches (rotation)", () => {
    // Revolut may send multiple v1=… values while a secret is rotating; a match
    // against ANY configured secret authenticates the delivery.
    const header = [sign(raw, ts, "wsk_unknown"), sign(raw, ts, SECRET)].join(
      ", ",
    );
    expect(
      verifyRevolutSignature({
        raw,
        timestamp: ts,
        signatureHeader: header,
        secrets: [OLD_SECRET, SECRET],
      }),
    ).toBe(true);
  });

  it("does not crash on a length-mismatched signature — returns false", () => {
    expect(() =>
      verifyRevolutSignature({
        raw,
        timestamp: ts,
        signatureHeader: "v1=deadbeef",
        secrets: [SECRET],
      }),
    ).not.toThrow();
    expect(
      verifyRevolutSignature({
        raw,
        timestamp: ts,
        signatureHeader: "v1=deadbeef",
        secrets: [SECRET],
      }),
    ).toBe(false);
  });

  it("rejects an empty signature header", () => {
    expect(
      verifyRevolutSignature({
        raw,
        timestamp: ts,
        signatureHeader: "",
        secrets: [SECRET],
      }),
    ).toBe(false);
  });

  it("rejects when no secrets are configured (fails closed)", () => {
    const sig =
      "v1=" +
      crypto
        .createHmac("sha256", SECRET)
        .update(`v1.${ts}.${raw}`)
        .digest("hex");
    expect(
      verifyRevolutSignature({
        raw,
        timestamp: ts,
        signatureHeader: sig,
        secrets: [],
      }),
    ).toBe(false);
  });
});

describe("isReplay", () => {
  const now = 1700000000000;

  it("passes a fresh timestamp within the window", () => {
    expect(isReplay(String(now - 1000), now)).toBe(false);
    expect(isReplay(String(now + 1000), now)).toBe(false);
  });

  it("flags an expired (too-old) timestamp", () => {
    expect(isReplay(String(now - REPLAY_WINDOW_MS - 1), now)).toBe(true);
  });

  it("flags a future timestamp beyond the window", () => {
    expect(isReplay(String(now + REPLAY_WINDOW_MS + 1), now)).toBe(true);
  });

  it("treats a missing or non-numeric timestamp as a replay", () => {
    expect(isReplay(null, now)).toBe(true);
    expect(isReplay("not-a-number", now)).toBe(true);
  });
});
