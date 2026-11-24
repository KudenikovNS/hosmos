"use client";

// =============================================================================
// THE GA4 TAG, MOUNTED ONCE (партия 20).
//
// TWO GATES. It renders NOTHING unless (1) the visitor chose «Accept all» and
// (2) the page is part of the PUBLIC SITE — the owner's rule of 20.09.2026:
// the landing and its neighbours are measured, the product behind the login is
// not. `@/shared/routes` decides what is public, for the middleware and for
// this file alike.
//
// Until the first gate opens: the <Script> is
// not in the tree, so gtag.js is never fetched, no `_ga` cookie is written and
// no request reaches Google. That is stronger than Consent Mode's «denied»,
// which still pings, and it is what the banner and the privacy policy promise.
//
// WHEN CONSENT ARRIVES the component mounts the script, declares consent for
// analytics storage (and denies every advertising purpose — this property is
// not used for ads), and configures the property with `send_page_view: false`.
// Page views are sent by hand, from `usePathname`, because the App Router
// changes the URL without a document load: gtag's own automatic page view would
// count the first screen and nothing after it.
//
// WHEN CONSENT IS WITHDRAWN («Only necessary» from the footer link) the effect
// tells gtag the storage is denied again and the component unmounts the script.
// The library stays loaded in that tab — it cannot be un-loaded — but it is
// told not to store, and nothing further is sent.
//
// The path is sanitised (`analyticsPath`): no query strings, no ids. GA4 does
// not store full IP addresses, so there is no `anonymize_ip` flag to set — the
// GA3 option of that name is silently ignored and is not pretended at here.
// =============================================================================
import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

import {
  CONSENT_CHANGED_EVENT,
  readConsent,
  type CookieChoice,
} from "@/shared/consent/consent";

import {
  analyticsAllowed,
  analyticsPath,
  disableFlag,
  gaCookieNames,
  measuredHere,
  measurementId,
} from "./ga";

type Gtag = (...args: unknown[]) => void;

/** Re-read the consent cookie whenever the banner reports an answer. */
function subscribeToConsent(onChange: () => void): () => void {
  window.addEventListener(CONSENT_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(CONSENT_CHANGED_EVENT, onChange);
}

/**
 * Send a gtag command.
 *
 * THE SHAPE MATTERS. gtag.js reads commands out of `dataLayer` as `arguments`
 * objects, and IGNORES a plain array: pushing `["event", …]` puts a message in
 * the queue that the library never executes. Caught in the first live check —
 * the property initialised, yet no hit was sent and no `_ga` cookie appeared.
 * So the library's own `gtag` is used when it exists, and before it loads the
 * queue is fed an `arguments` object, exactly as Google's snippet does.
 */
function gtag(...args: unknown[]): void {
  const w = window as unknown as { dataLayer?: unknown[]; gtag?: Gtag };
  if (typeof w.gtag === "function") {
    w.gtag(...args);
    return;
  }
  w.dataLayer = w.dataLayer ?? [];
  const queue = w.dataLayer;
  function push(...rest: unknown[]) {
    void rest;
    // eslint-disable-next-line prefer-rest-params
    queue.push(arguments);
  }
  push(...args);
}

export function GoogleAnalytics() {
  const id = measurementId();
  const pathname = usePathname();
  // The banner's answer, now and whenever it changes. Read straight from the
  // cookie — the single source — rather than mirrored into state.
  const choice = useSyncExternalStore(
    subscribeToConsent,
    readConsent,
    () => null as CookieChoice | null,
  );
  // Two gates, and both must be open: the visitor said yes, AND this page is
  // part of the public site (партия 20 — the product is not measured).
  const consented = analyticsAllowed(choice);
  const onSite = measuredHere(pathname);
  const allowed = consented && onSite;

  // A withdrawal has to reach a tag that is already loaded in this tab: the
  // <script> cannot be un-loaded, so the library is switched off at its own
  // kill switch, told the storage is denied, and its cookies are expired.
  // Verified live: without the kill switch the next navigation still produced
  // a hit.
  useEffect(() => {
    if (!id || typeof window === "undefined") return;
    // Also covers walking from the site into the product: the library stays
    // loaded in the tab, and the switch keeps it silent there.
    const flagged = window as unknown as Record<string, unknown>;
    flagged[disableFlag(id)] = !allowed;
    if (choice === null || consented) return;
    if ((window as unknown as { gtag?: Gtag }).gtag) {
      gtag("consent", "update", {
        analytics_storage: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      });
    }
    for (const name of gaCookieNames(id)) {
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
      document.cookie = `${name}=; Path=/; Domain=${location.hostname}; Max-Age=0; SameSite=Lax`;
    }
  }, [id, choice, consented, allowed]);

  // One page view per screen, with the path stripped of ids and queries.
  useEffect(() => {
    if (!id || !allowed || !pathname) return;
    gtag("event", "page_view", {
      page_path: analyticsPath(pathname),
      page_location: `${window.location.origin}${analyticsPath(pathname)}`,
      page_title: document.title,
    });
  }, [id, allowed, pathname]);

  if (!id || !allowed) return null;

  return (
    <>
      <Script
        id="ga4-src"
        strategy="afterInteractive"
        src={`https://www.googletagmanager.com/gtag/js?id=${id}`}
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
window.gtag = gtag;
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied'
});
gtag('consent', 'update', { analytics_storage: 'granted' });
gtag('js', new Date());
gtag('config', '${id}', { send_page_view: false });`}
      </Script>
    </>
  );
}
