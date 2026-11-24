"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import { setAnalyticsConsent } from "@/shared/analytics";

import {
  CONSENT_CHANGED_EVENT,
  OPEN_SETTINGS_EVENT,
  readConsent,
  storeConsent,
  type CookieChoice,
} from "./consent";
import styles from "./CookieConsent.module.css";

/**
 * The cookie banner, mounted once in the locale layout so every page — public
 * site, login, product — shows it until the visitor has answered.
 *
 * Two equally weighted buttons. A prominent "accept all" beside a muted
 * "necessary only" is the pattern that makes a choice not a choice, and the
 * site's own privacy policy would not survive it. The banner reopens on the
 * `hosmos:cookie-settings` event, which the footer and the settings page fire.
 */
export function CookieConsent() {
  const t = useTranslations("cookies");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const stored = readConsent();
    if (stored) {
      setAnalyticsConsent(stored === "all" ? "granted" : "denied");
    } else {
      // A setState in an effect on purpose: deciding visibility during render
      // would read the cookie on the client and nothing on the server, and the
      // hydration mismatch is worse than one extra render of `null`.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisible(true);
    }
    const open = () => setVisible(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open);
  }, []);

  function answer(choice: CookieChoice) {
    storeConsent(choice);
    setAnalyticsConsent(choice === "all" ? "granted" : "denied");
    // The GA4 tag mounts (or stops storing) on this, without a reload.
    window.dispatchEvent(
      new CustomEvent(CONSENT_CHANGED_EVENT, { detail: choice }),
    );
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      className={styles.banner}
      role="region"
      aria-labelledby="cookie-consent-title"
    >
      <div className={styles.text}>
        <p id="cookie-consent-title" className={styles.title}>
          {t("title")}
        </p>
        <p className={styles.body}>
          {t("text")}{" "}
          <Link href="/terms#cookies" className={styles.link}>
            {t("policy")}
          </Link>
        </p>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          onClick={() => answer("necessary")}
        >
          {t("necessary")}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => answer("all")}
        >
          {t("all")}
        </button>
      </div>
    </div>
  );
}
