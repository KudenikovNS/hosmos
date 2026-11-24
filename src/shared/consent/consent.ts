/**
 * The visitor's cookie choice, site-wide.
 *
 * Two categories only, because the site sets only two kinds of cookie:
 *   • necessary — the session (better-auth), the language (`NEXT_LOCALE`) and
 *     this choice itself; no consent is needed for them (ePrivacy Art. 5(3),
 *     ZEKom-2 čl. 225), but they are disclosed in the policy;
 *   • analytics — nothing fires until the visitor has said yes
 *     (`@/shared/analytics` queues until then).
 *
 * The choice is kept in a first-party cookie rather than `localStorage`, so it
 * is visible on the first server render, survives the switch between the
 * public site and the product, and expires by itself after six months — the
 * horizon after which a consent is conventionally asked for again.
 */

export const CONSENT_COOKIE = "hosmos-consent";

/** Days a choice stays valid before the banner asks again. */
export const CONSENT_MAX_AGE_DAYS = 182;

export type CookieChoice = "necessary" | "all";

/** Event name for "open the cookie settings" — the banner listens for it. */
export const OPEN_SETTINGS_EVENT = "hosmos:cookie-settings";

/**
 * Партия 20 — "the answer changed", carrying the new choice. The analytics tag
 * (`@/shared/ga/GoogleAnalytics`) listens: a visitor who accepts must be
 * measured from that click, and one who withdraws must stop being measured
 * without a reload.
 */
export const CONSENT_CHANGED_EVENT = "hosmos:consent-changed";

/** Parse a raw `document.cookie` string. Anything unexpected is "not answered". */
export function parseConsent(cookieHeader: string): CookieChoice | null {
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== CONSENT_COOKIE) continue;
    const value = decodeURIComponent(rest.join("="));
    if (value === "necessary" || value === "all") return value;
    return null;
  }
  return null;
}

/** The `Set-Cookie`-style string that stores a choice. */
export function serializeConsent(choice: CookieChoice, secure = true): string {
  const maxAge = CONSENT_MAX_AGE_DAYS * 24 * 60 * 60;
  return `${CONSENT_COOKIE}=${choice}; Path=/; Max-Age=${maxAge}; SameSite=Lax${
    secure ? "; Secure" : ""
  }`;
}

export function readConsent(): CookieChoice | null {
  if (typeof document === "undefined") return null;
  try {
    return parseConsent(document.cookie);
  } catch {
    return null;
  }
}

export function storeConsent(choice: CookieChoice): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = serializeConsent(
      choice,
      window.location.protocol === "https:",
    );
  } catch {
    // An unwritable cookie jar means we ask again next visit — the safe
    // direction to fail in.
  }
}

/** Re-open the banner so a visitor can change an earlier choice. */
export function openCookieSettings(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
}
