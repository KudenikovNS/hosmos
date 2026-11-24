"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { localisedPath } from "@/i18n/localised-path";
import { Link } from "@/i18n/navigation";
import { ArrowRight, CheckCircle2, Eye, EyeOff, XCircle } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { PlanetIcon } from "@/shared/ui/PlanetIcon";
import { authClient } from "@/server/auth/auth-client";
import styles from "../auth.module.css";

/**
 * The emailed link points at better-auth's GET /api/auth/reset-password/:token
 * callback (better-auth 1.6.23), which redirects here with `?token=<token>`
 * when the token is valid, or `?error=INVALID_TOKEN` when it is invalid or
 * expired — so this page only ever sees the token in the query string.
 */
function InvalidLink() {
  const t = useTranslations("auth");
  return (
    <div className={styles.page}>
      <div className={styles.invalidInner}>
        <div className={styles.invalidIcon}>
          <XCircle size={32} className={styles.invalidCross} />
        </div>
        <h1 className={styles.successTitle}>{t("resetInvalidTitle")}</h1>
        <p className={styles.successText}>{t("resetInvalidText")}</p>
        <Link href="/forgot-password">
          <Button className={styles.submit}>
            {t("resetRequestNew")}{" "}
            <ArrowRight size={16} className={styles.arrowIcon} />
          </Button>
        </Link>
      </div>
    </div>
  );
}

function ResetPasswordForm() {
  const t = useTranslations("auth");
  const locale = useLocale();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [tokenRejected, setTokenRejected] = useState(false);
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const linkError = searchParams.get("error");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Mirrors better-auth's own minimum (minPasswordLength defaults to 8) and
    // the register page's client-side check.
    if (password.length < 8) {
      setError(t("passwordMin8Error"));
      return;
    }
    if (password !== confirm) {
      setError(t("passwordsMismatch"));
      return;
    }
    if (!token) return;

    setLoading(true);
    // better-auth 1.6.23: resetPassword → POST /reset-password with
    // { newPassword, token }. It sets the new password but does NOT sign the
    // user in, so on success we send them to /login.
    try {
      const { error: resetError } = await authClient.resetPassword({
        newPassword: password,
        token,
      });

      if (resetError) {
        // A consumed/expired token comes back as 400 INVALID_TOKEN — show the
        // dedicated "request a new link" state rather than an inline error.
        if (resetError.code === "INVALID_TOKEN") {
          setTokenRejected(true);
          return;
        }
        setError(resetError.message || t("genericError"));
        setLoading(false);
        return;
      }

      setSuccess(true);
      window.setTimeout(() => {
        // Full navigation on purpose: the reset consumed the session state and the
        // login page must render from a clean request, not a client transition.
        window.location.href = localisedPath("/login", locale);
      }, 2500);
    } catch {
      setError(t("genericError"));
      setLoading(false);
    }
  };

  if (!token || linkError || tokenRejected) {
    return <InvalidLink />;
  }

  if (success) {
    return (
      <div className={styles.page}>
        <div className={styles.successInner}>
          <div className={styles.successIcon}>
            <CheckCircle2 size={32} className={styles.successCheck} />
          </div>
          <h1 className={styles.successTitle}>{t("resetSuccessTitle")}</h1>
          <p className={styles.successText}>{t("resetSuccessText")}</p>
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
      <div className={styles.inner}>
        <Link href="/" className={styles.logo}>
          <div className={styles.logoIcon}>
            <PlanetIcon size={32} />
          </div>
          <span className={styles.logoText}>Hosmos</span>
        </Link>

        <div className={styles.card}>
          <h1 className={styles.title}>{t("resetTitle")}</h1>
          <p className={styles.subtitle}>{t("resetSubtitle")}</p>

          {error && <div className={styles.errorBox}>{error}</div>}

          <form onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.passwordField}>
              <Input
                label={t("newPassword")}
                type={showPassword ? "text" : "password"}
                placeholder={t("passwordMin8Placeholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className={styles.passwordToggle}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <Input
              label={t("confirmPassword")}
              type={showPassword ? "text" : "password"}
              placeholder={t("confirmPasswordPlaceholder")}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />

            <div className={styles.submitWrap}>
              <Button type="submit" className={styles.submit} loading={loading}>
                {t("resetSubmit")}{" "}
                <ArrowRight size={16} className={styles.arrowIcon} />
              </Button>
            </div>
          </form>
        </div>

        <p className={styles.footerText}>
          {t("rememberedPassword")}{" "}
          <Link href="/login" className={styles.footerLink}>
            {t("logIn")}
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
