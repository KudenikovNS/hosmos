/**
 * Client-side analytics for the public landing page (ТЗ §12 "Analytics и
 * экспериментирование").
 *
 * The spec's measurement rules are not advice, they are constraints, and two of
 * them are the reason this module exists rather than a bare `gtag(...)` call at
 * every call site:
 *
 *   • CONSENT MODE — optional analytics/marketing events fire ONLY after the
 *     visitor has consented. `track()` therefore never talks to a vendor
 *     directly: it appends to a queue, and the queue is flushed only while
 *     consent is granted. Events raised before consent are held, not dropped, so
 *     a visitor who accepts halfway down the page still produces a coherent
 *     funnel; events raised while consent is DENIED are discarded outright.
 *
 *   • NO PII — no email, name, company or free-text comment may ever reach an
 *     event (§12). `sanitizeParams` enforces that structurally: only
 *     allow-listed keys survive, so adding a new event cannot leak a field by
 *     forgetting a rule. The free-text `comment` is not on the list and cannot
 *     be added to it without editing this file deliberately.
 *
 * There is no vendor wired up yet (§17 leaves the CRM/analytics recipient open).
 * `deliver()` is the single seam where one gets attached; until then events go
 * to `window.dataLayer` if a tag manager has created it, and nowhere otherwise.
 * That keeps every call site final: the page does not change when the vendor is
 * chosen.
 */

/** Every event name §12 defines. Anything else is a typo, not an event. */
export type LandingEvent =
  | "landing_view"
  | "nav_click"
  | "hero_cta_click"
  | "feature_interaction"
  | "pricing_view"
  | "pricing_cta_click"
  | "vesg_block_view"
  | "vesg_cta_click"
  | "faq_toggle"
  | "form_start"
  | "form_error"
  | "form_submit_success"
  | "form_submit_failure";

/**
 * Parameter keys an event may carry — the §12 table, verbatim, plus the page
 * context keys (`lang`, `referrer`, `utm_*`) that `landing_view` sends.
 *
 * Note what is NOT here and must never be: `email`, `name`, `company`,
 * `comment`, `phone`, or any free-text field. `error_code` is a code, never an
 * error MESSAGE, because a message can quote the user's input back.
 */
const ALLOWED_PARAM_KEYS = new Set([
  "lang",
  "referrer",
  "item",
  "destination",
  "cta",
  "component",
  "placement",
  "plan",
  "plans_version",
  "content_version",
  "faq_id",
  "form_type",
  "field",
  "error_code",
  "selected_plan",
  "landing_version",
  "lead_source",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
]);

export type EventParams = Record<string, string | number | boolean | undefined>;

/** Consent state. `unknown` = the banner has not been answered yet. */
export type ConsentState = "unknown" | "granted" | "denied";

let consent: ConsentState = "unknown";
/** Events raised before the banner was answered, replayed on grant. */
const pending: Array<{ name: LandingEvent; params: EventParams }> = [];
/** Guards `landing_view` against React StrictMode's double effect in dev. */
let landingViewSent = false;

/**
 * Drop every key that is not on the allow-list, and every value that is not a
 * primitive. Values are additionally truncated: an allow-listed key with an
 * unexpectedly long value (a `destination` carrying a query string, say) is a
 * plausible way for something personal to arrive in a field nobody suspected.
 */
function sanitizeParams(params: EventParams): EventParams {
  const out: EventParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (!ALLOWED_PARAM_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      if (value.length === 0) continue;
      out[key] = value.slice(0, 120);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The one place a vendor is attached. Since партия 20 that vendor is GA4
 * (`@/shared/ga/GoogleAnalytics`), which the consent banner mounts: when its
 * `gtag` exists the event is sent as a GA4 event, because a `dataLayer` PUSH is
 * a Tag Manager idiom and GA4 alone would never read it. The push remains as
 * the fallback for a tag manager, and no tag at all is still a silent no-op —
 * a public page should not log its own telemetry into a visitor's console.
 */
function deliver(name: LandingEvent, params: EventParams): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  };
  if (typeof w.gtag === "function") {
    w.gtag("event", name, params);
    return;
  }
  if (Array.isArray(w.dataLayer)) w.dataLayer.push({ event: name, ...params });
}

/**
 * Record an event. Safe to call from anywhere, at any time, including during
 * SSR (where it does nothing) and before the consent banner is answered.
 */
export function track(name: LandingEvent, params: EventParams = {}): void {
  const clean = sanitizeParams(params);
  if (consent === "granted") {
    deliver(name, clean);
    return;
  }
  if (consent === "denied") return;
  // `unknown` — hold it. The cap keeps a visitor who never answers the banner
  // from growing an unbounded array while they scroll.
  if (pending.length < 50) pending.push({ name, params: clean });
}

/**
 * Set the consent state, replaying (on grant) or discarding (on denial) events
 * that were held while it was unknown. Call this from the consent banner.
 */
export function setAnalyticsConsent(state: ConsentState): void {
  consent = state;
  if (state === "granted") {
    for (const event of pending.splice(0)) deliver(event.name, event.params);
  } else if (state === "denied") {
    pending.length = 0;
  }
}

/**
 * Read the UTM parameters and referrer for `landing_view` (§12). Only the five
 * standard `utm_*` keys are read; the rest of the query string is ignored, since
 * a landing URL can legitimately carry an email token or a partner-supplied id
 * that has no business in analytics.
 */
function pageContext(lang: string): EventParams {
  if (typeof window === "undefined") return { lang };
  const query = new URLSearchParams(window.location.search);
  const utm: EventParams = {};
  for (const key of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
  ] as const) {
    const value = query.get(key);
    if (value) utm[key] = value;
  }
  return {
    lang,
    // Only the referring ORIGIN — a full referrer URL can carry a search query
    // or a path that identifies the individual who followed the link.
    referrer: safeOrigin(document.referrer),
    ...utm,
  };
}

/** Origin of a referrer URL, or `""` when there is none / it will not parse. */
function safeOrigin(referrer: string): string {
  if (!referrer) return "";
  try {
    return new URL(referrer).origin;
  } catch {
    return "";
  }
}

/**
 * `landing_view`, fired at most once per page load. Exposed separately from
 * `track` because the once-only guard is part of the event's definition: §12
 * calls it "первый page view", and a duplicate would inflate the denominator of
 * every conversion rate computed from it.
 */
export function trackLandingView(lang: string): void {
  if (landingViewSent) return;
  landingViewSent = true;
  track("landing_view", pageContext(lang));
}

/** Test seam — resets the module's state between cases. Not used by the page. */
export function __resetAnalyticsForTest(): void {
  consent = "unknown";
  pending.length = 0;
  landingViewSent = false;
}
