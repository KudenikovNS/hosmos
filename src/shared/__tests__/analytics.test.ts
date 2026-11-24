/**
 * Landing analytics (ТЗ §12 "Правила измерения").
 *
 * Two of the spec's rules are privacy commitments rather than preferences, and
 * they are the reason this file exists: nothing may be measured before the
 * visitor consents, and no personal data may reach an event at all. Both are
 * enforced structurally in `@/shared/analytics`, and both would fail silently —
 * a page that leaks an email address into a `dataLayer` push looks exactly like
 * one that does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetAnalyticsForTest,
  setAnalyticsConsent,
  track,
  trackLandingView,
} from "../analytics";

/** Events the module has handed to the vendor seam (`window.dataLayer`). */
type Delivered = Array<Record<string, unknown>>;

function layer(): Delivered {
  return (globalThis as unknown as { window: { dataLayer: Delivered } }).window
    .dataLayer;
}

beforeEach(() => {
  __resetAnalyticsForTest();
  // A tag manager creates `dataLayer`; the module only pushes when it exists.
  vi.stubGlobal("window", {
    dataLayer: [] as Delivered,
    location: {
      search: "?utm_source=linkedin&utm_medium=post&token=secret-42",
    },
  });
  vi.stubGlobal("document", {
    referrer: "https://www.google.si/search?q=vsme",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("consent gate (§12)", () => {
  it("measures nothing before the banner has been answered", () => {
    track("pricing_view", { plans_version: "vsme-1.0" });
    expect(layer()).toHaveLength(0);
  });

  it("replays what was held once consent is granted", () => {
    // A visitor who accepts halfway down the page still produces a funnel that
    // starts at the top of it.
    track("pricing_view", { plans_version: "vsme-1.0" });
    track("faq_toggle", { faq_id: "faq_3" });
    setAnalyticsConsent("granted");

    expect(layer().map((e) => e.event)).toEqual(["pricing_view", "faq_toggle"]);
  });

  it("discards what was held when consent is denied, and stays quiet after", () => {
    track("pricing_view", { plans_version: "vsme-1.0" });
    setAnalyticsConsent("denied");
    track("vesg_cta_click", { placement: "vesg_block" });

    expect(layer()).toHaveLength(0);
  });

  it("delivers immediately once consent is granted", () => {
    setAnalyticsConsent("granted");
    track("hero_cta_click", { cta: "demo" });

    expect(layer()).toEqual([{ event: "hero_cta_click", cta: "demo" }]);
  });
});

describe("no PII (§12)", () => {
  beforeEach(() => setAnalyticsConsent("granted"));

  it("drops every key that is not on the allow-list", () => {
    // The exact shape of a careless call site: the whole form spread into an
    // event. Only `form_type` and `selected_plan` may survive it.
    track("form_submit_success", {
      form_type: "demo",
      selected_plan: "pro",
      email: "ana@primer.si",
      fullName: "Ana Novak",
      company: "Primer d.o.o.",
      comment: "prosim pokličite me na 040 123 456",
    } as never);

    expect(layer()[0]).toEqual({
      event: "form_submit_success",
      form_type: "demo",
      selected_plan: "pro",
    });
  });

  it("truncates an allow-listed value that arrived unexpectedly long", () => {
    track("nav_click", { item: "x".repeat(500) });
    expect((layer()[0]!.item as string).length).toBe(120);
  });

  it("keeps an error CODE and never an error message", () => {
    track("form_error", {
      form_type: "demo",
      field: "email",
      error_code: "email",
    });
    expect(layer()[0]).toEqual({
      event: "form_error",
      form_type: "demo",
      field: "email",
      error_code: "email",
    });
  });
});

describe("landing_view (§12)", () => {
  beforeEach(() => setAnalyticsConsent("granted"));

  it("fires once per page load, however many times it is called", () => {
    // React StrictMode runs effects twice in development; a duplicated first
    // view would inflate the denominator of every conversion rate.
    trackLandingView("sl");
    trackLandingView("sl");
    expect(layer()).toHaveLength(1);
  });

  it("carries the locale and the five standard UTM keys, and nothing else", () => {
    trackLandingView("sl");
    // `token=secret-42` is in the query string and must NOT be collected: a
    // landing URL can legitimately carry an email or partner token.
    expect(layer()[0]).toEqual({
      event: "landing_view",
      lang: "sl",
      referrer: "https://www.google.si",
      utm_source: "linkedin",
      utm_medium: "post",
    });
  });

  it("reduces the referrer to its origin", () => {
    // The full referrer carried `?q=vsme`; a search query can identify a person.
    trackLandingView("sl");
    expect(layer()[0]!.referrer).toBe("https://www.google.si");
  });
});

/**
 * Партия 20 — the vendor seam now prefers GA4. A `dataLayer` PUSH is a Tag
 * Manager idiom: GA4 alone never reads it, so an event delivered that way
 * while gtag exists would be measured nowhere.
 */
describe("delivery to GA4", () => {
  it("sends the event through gtag when the tag is loaded", () => {
    const calls: unknown[][] = [];
    const w = globalThis as unknown as {
      window: { dataLayer: unknown[]; gtag?: (...args: unknown[]) => void };
    };
    w.window.gtag = (...args: unknown[]) => calls.push(args);

    setAnalyticsConsent("granted");
    track("pricing_cta_click", { plan: "pro", cta: "header" });

    expect(calls).toEqual([
      ["event", "pricing_cta_click", { plan: "pro", cta: "header" }],
    ]);
    // …and nothing was duplicated into the tag-manager fallback.
    expect(w.window.dataLayer).toEqual([]);
    delete w.window.gtag;
  });

  it("still strips personal data before the tag sees it", () => {
    const calls: unknown[][] = [];
    const w = globalThis as unknown as {
      window: { dataLayer: unknown[]; gtag?: (...args: unknown[]) => void };
    };
    w.window.gtag = (...args: unknown[]) => calls.push(args);

    setAnalyticsConsent("granted");
    track("form_submit_success", {
      form_type: "demo",
      email: "someone@example.com",
      comment: "we emit 400 t of CO2",
    } as never);

    expect(calls).toEqual([
      ["event", "form_submit_success", { form_type: "demo" }],
    ]);
    delete w.window.gtag;
  });
});
