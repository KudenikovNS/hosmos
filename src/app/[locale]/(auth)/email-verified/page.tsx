"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ArrowRight, CheckCircle2, XCircle } from "lucide-react";

import { localisedPath } from "@/i18n/localised-path";
import { Link } from "@/i18n/navigation";
import { Button } from "@/shared/ui/Button";
import styles from "../auth.module.css";

/**
 * Where the email-verification link lands (BUG-002).
 *
 * The registration form passes this page as `callbackURL` to
 * `signUp.email`; the emailed link points at better-auth's
 * GET /api/auth/verify-email, which (better-auth 1.6.23) verifies the token,
 * signs the user in (`autoSignInAfterVerification`) and redirects here — or
 * here with `?error=<CODE>` (TOKEN_EXPIRED, INVALID_TOKEN, USER_NOT_FOUND,
 * INVALID_USER) when the link cannot be used. An already verified address
 * redirects here without an error, so a second click reads as success too.
 *
 * Before this page the link carried `callbackURL=/` and the user landed on the
 * public home page with no word about the verification or the next step.
 */
function EmailVerified() {
  const t = useTranslations("auth");
  const locale = useLocale();
  const error = useSearchParams().get("error");

  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.invalidInner}>
          <div className={styles.invalidIcon}>
            <XCircle size={32} className={styles.invalidCross} />
          </div>
          <h1 className={styles.successTitle}>{t("verifyInvalidTitle")}</h1>
          <p className={styles.successText}>
            {error === "TOKEN_EXPIRED"
              ? t("verifyExpiredText")
              : t("verifyInvalidText")}
          </p>
          <Link href="/login">
            <Button className={styles.submit}>
              {t("logIn")} <ArrowRight size={16} className={styles.arrowIcon} />
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.successInner}>
        <div className={styles.successIcon}>
          <CheckCircle2 size={32} className={styles.successCheck} />
        </div>
        <h1 className={styles.successTitle}>{t("verifiedTitle")}</h1>
        <p className={styles.successText}>{t("verifiedText")}</p>
        {/* A full navigation, as after sign-in: the session cookie set by the
            verification must reach the proxy and the app's RSC prefetch. A
            visitor without a session is sent to /login by the proxy. */}
        <Button
          className={styles.submit}
          onClick={() => {
            window.location.href = localisedPath("/readiness", locale);
          }}
        >
          {t("verifiedContinue")}{" "}
          <ArrowRight size={16} className={styles.arrowIcon} />
        </Button>
      </div>
    </div>
  );
}

export default function EmailVerifiedPage() {
  return (
    <Suspense>
      <EmailVerified />
    </Suspense>
  );
}
