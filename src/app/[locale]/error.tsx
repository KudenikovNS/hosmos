"use client";

// =============================================================================
// THE SCREEN A CLIENT-SIDE CRASH GETS (партия 19).
//
// Until this file the app had NO error boundary at all: one thrown error in one
// component took the whole tree down, and the browser showed its own «this page
// couldn't load» — a dead end with no explanation, no retry, and nothing said
// about what to do. That is exactly what the owner hit on 20.09.2026: with the
// page machine-translated, the first keystroke in a form killed the screen.
//
// WHAT IT OFFERS: what happened, one «try again» (React's own `reset`, which
// re-renders the segment without a full reload, so unsaved work elsewhere in
// the app survives), and — when the page looks TRANSLATED — the one sentence
// that actually fixes it: turn the browser's translation off and use the app's
// own language switcher.
//
// The translation check is a DOM fact, not a guess: Chrome stamps
// `translated-ltr`/`translated-rtl` on <html> and wraps text nodes in <font>.
// Both are cheap to read and neither can be true on an untranslated page.
//
// The error is also logged: a boundary that swallows the stack silently makes
// the next report unreproducible.
// =============================================================================
import { useTranslations } from "next-intl";
import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/shared/ui/Button";

import styles from "./error.module.css";

/** The page's translated-ness never changes while this screen is up. */
const subscribeNever = () => () => {};

/** Does the page look machine-translated (Chrome/Google Translate)? */
function looksTranslated(): boolean {
  if (typeof document === "undefined") return false;
  const html = document.documentElement;
  return (
    html.classList.contains("translated-ltr") ||
    html.classList.contains("translated-rtl") ||
    document.querySelector("font[style*='vertical-align']") !== null
  );
}

export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errorBoundary");
  // Read on the client, `false` on the server: the DOM is the only source of
  // this answer, and an effect that set it would fight React's own rules.
  const translated = useSyncExternalStore(
    subscribeNever,
    looksTranslated,
    () => false,
  );

  useEffect(() => {
    console.error("[client error]", error);
  }, [error]);

  return (
    <main className={styles.wrap} role="alert">
      <div className={styles.card}>
        <h1 className={styles.title}>{t("title")}</h1>
        <p className={styles.body}>{t("body")}</p>
        {translated && <p className={styles.hint}>{t("translated")}</p>}
        <div className={styles.actions}>
          <Button onClick={() => reset()}>{t("retry")}</Button>
          <Button variant="secondary" onClick={() => location.reload()}>
            {t("reload")}
          </Button>
        </div>
        {error.digest && (
          <p className={styles.digest}>
            {t("digest", { digest: error.digest })}
          </p>
        )}
      </div>
    </main>
  );
}
