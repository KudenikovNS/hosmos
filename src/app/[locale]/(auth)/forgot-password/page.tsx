"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { ArrowRight, MailCheck } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { PlanetIcon } from "@/shared/ui/PlanetIcon";
import { authClient } from "@/server/auth/auth-client";
import styles from "../auth.module.css";

export default function ForgotPasswordPage() {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    // better-auth 1.6.23: `requestPasswordReset` → POST /request-password-reset
    // (the older `forgetPassword` name no longer exists in this version). The
    // server answers 200 whether or not the address exists, so the success
    // state below never reveals account existence. `redirectTo` becomes the
    // callbackURL of the emailed link: better-auth's GET callback forwards the
    // browser to /reset-password?token=… (or ?error=INVALID_TOKEN).
    try {
      const { error: requestError } = await authClient.requestPasswordReset({
        email,
        redirectTo: "/reset-password",
      });

      if (requestError) {
        setError(requestError.message || t("genericError"));
        setLoading(false);
        return;
      }

      setSuccess(true);
      setLoading(false);
    } catch {
      setError(t("genericError"));
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className={styles.page}>
        <div className={styles.successInner}>
          <div className={styles.successIcon}>
            <MailCheck size={32} className={styles.successCheck} />
          </div>
          <h1 className={styles.successTitle}>{t("checkEmailTitle")}</h1>
          <p className={styles.successText}>
            {t.rich("forgotSuccessText", {
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
          <h1 className={styles.title}>{t("forgotTitle")}</h1>
          <p className={styles.subtitle}>{t("forgotSubtitle")}</p>

          {error && <div className={styles.errorBox}>{error}</div>}

          <form onSubmit={handleSubmit} className={styles.form}>
            <Input
              label={t("email")}
              type="email"
              placeholder={t("emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />

            <div className={styles.submitWrap}>
              <Button type="submit" className={styles.submit} loading={loading}>
                {t("forgotSubmit")}{" "}
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
