"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { localisedPath } from "@/i18n/localised-path";
import { Link } from "@/i18n/navigation";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { PlanetIcon } from "@/shared/ui/PlanetIcon";
import { authClient } from "@/server/auth/auth-client";
import { apiFetch } from "@/shared/api/client";
import styles from "../auth.module.css";

export default function RegisterPage() {
  const t = useTranslations("auth");
  const locale = useLocale();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [company, setCompany] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  // Step 1 (the account) succeeded but step 2 (the company) did not: the form
  // is replaced by a retry, because submitting it again would try to create
  // the account a second time.
  const [companyFailed, setCompanyFailed] = useState(false);

  // Step 2: create the company + link the profile, then land on the dashboard.
  // A failure is shown, never skipped (BUG-004): landing without a company is
  // an empty workspace. The server's step is idempotent (one company per
  // account), so retrying it cannot create a duplicate.
  const finishCompanyStep = async () => {
    let ok = false;
    try {
      const result = await apiFetch<{ ok: boolean }>("/api/register", {
        method: "POST",
        body: JSON.stringify({ company }),
      });
      ok = result.ok === true;
    } catch {
      ok = false;
    }
    if (!ok) {
      setCompanyFailed(true);
      setError(t("companyCreateError"));
      setLoading(false);
      return;
    }
    // Full navigation so middleware/RSC pick up the freshly set session cookie.
    // The proxy resolves the locale prefix for a bare path; there is no basePath.
    window.location.href = localisedPath("/readiness", locale);
  };

  const retryCompanyStep = async () => {
    setLoading(true);
    setError("");
    await finishCompanyStep();
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    if (password.length < 8) {
      setError(t("passwordMin8Error"));
      setLoading(false);
      return;
    }

    // Step 1 (§3.4): better-auth creates the user. `data.token` is present only
    // when a session was issued right away (auto-confirm); it is null when email
    // verification is required before sign-in.
    // `callbackURL` (BUG-002): the verification link returns to a page that
    // says the address is confirmed and leads on, not to the public home page
    // (better-auth defaults to `/`).
    const { data, error: signUpError } = await authClient.signUp.email({
      email,
      password,
      name,
      callbackURL: localisedPath("/email-verified", locale),
    });

    if (signUpError) {
      setError(signUpError.message || t("createAccountError"));
      setLoading(false);
      return;
    }

    // Auto-confirm branch: a session exists, so create the company + link the
    // profile (step 2), then land on the dashboard.
    if (data?.token) {
      await finishCompanyStep();
      return;
    }

    // Email-verification branch: no session yet — show "Check your email".
    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <div className={styles.page}>
        <div className={styles.successInner}>
          <div className={styles.successIcon}>
            <CheckCircle2 size={32} className={styles.successCheck} />
          </div>
          <h1 className={styles.successTitle}>{t("checkEmailTitle")}</h1>
          <p className={styles.successText}>
            {t.rich("checkEmailText", {
              email,
              b: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          <Link href="/login">
            <Button className={styles.submit}>
              {t("backToLogin")}{" "}
              <ArrowRight size={16} className={styles.arrowIcon} />
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
          <h1 className={styles.title}>{t("startTrialTitle")}</h1>
          <p className={styles.subtitle}>{t("startTrialSubtitle")}</p>

          {error && (
            <div className={styles.errorBox} role="alert">
              {error}
            </div>
          )}

          {companyFailed ? (
            <div className={styles.submitWrap}>
              <Button
                className={styles.submit}
                loading={loading}
                onClick={retryCompanyStep}
              >
                {t("companyRetry")}{" "}
                <ArrowRight size={16} className={styles.arrowIcon} />
              </Button>
            </div>
          ) : (
            <form onSubmit={handleRegister} className={styles.form}>
              <Input
                label={t("fullName")}
                placeholder={t("fullNamePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                label={t("workEmail")}
                type="email"
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                label={t("companyName")}
                placeholder={t("companyNamePlaceholder")}
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
              <Input
                label={t("password")}
                type="password"
                placeholder={t("passwordMin8Placeholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />

              <div className={styles.submitWrap}>
                <Button
                  type="submit"
                  className={styles.submit}
                  loading={loading}
                >
                  {t("createAccount")}{" "}
                  <ArrowRight size={16} className={styles.arrowIcon} />
                </Button>
              </div>
            </form>
          )}

          {!companyFailed && <p className={styles.terms}>{t("termsAgree")}</p>}
        </div>

        <p className={styles.footerText}>
          {t("haveAccount")}{" "}
          <Link href="/login" className={styles.footerLink}>
            {t("logIn")}
          </Link>
        </p>
      </div>
    </div>
  );
}
