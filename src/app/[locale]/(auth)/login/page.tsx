"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { localisedPath } from "@/i18n/localised-path";
import { Link } from "@/i18n/navigation";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { PlanetIcon } from "@/shared/ui/PlanetIcon";
import { authClient } from "@/server/auth/auth-client";
import styles from "./page.module.css";

/**
 * Разрешаем только same-origin-пути ("/dashboard", "/reports?x=1"...) —
 * redirectTo приходит из query-строки и не должен уводить на чужой origin.
 * Перенесено 1:1 из бывшего server action `signIn` (auth-actions.ts): валидация
 * теперь живёт в клиенте, т.к. редирект после логина делает браузер (§3.4).
 *
 * Префиксного чека недостаточно: браузерный парсер URL резолвит `/\evil.com`,
 * `/\/evil.com` и варианты с внедрённым таб/CR/LF внутрь пути в https://evil.com.
 * Поэтому нормализуем через URL и сверяем origin. Одной сверки origin тоже мало:
 * `/..//evil.com` нормализуется в pathname `//evil.com` (origin наш, но снова
 * protocol-relative) — поэтому отклоняем pathname, начинающийся с `//` или `/\`.
 */
function safeRedirectPath(target: string | undefined): string {
  const FALLBACK = "/readiness";
  if (!target) return FALLBACK;

  try {
    const base = "https://placeholder.invalid";
    const url = new URL(target, base);
    if (url.origin !== base) return FALLBACK;
    if (url.pathname.startsWith("//") || url.pathname.startsWith("/\\")) {
      return FALLBACK;
    }
    return url.pathname + url.search + url.hash;
  } catch {
    return FALLBACK;
  }
}

function LoginForm() {
  const t = useTranslations("auth");
  const locale = useLocale();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") ?? undefined;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    // better-auth client (§3.4): signIn.email sets the httpOnly session cookie
    // on success and returns { data, error }; on failure we surface the message
    // in the form. The redirect target is validated same-origin here (the old
    // server action did this) since the browser now performs the navigation.
    try {
      const { error: signInError } = await authClient.signIn.email({
        email,
        password,
      });

      if (signInError) {
        setError(signInError.message || t("invalidCredentials"));
        setLoading(false);
        return;
      }

      // Full navigation so middleware/RSC pick up the freshly set session cookie.
      window.location.href = localisedPath(
        safeRedirectPath(redirectTo),
        locale,
      );
    } catch {
      setError(t("genericError"));
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      {/* Left — Form */}
      <div className={styles.formSide}>
        <div className={styles.formInner}>
          <Link href="/" className={styles.logo}>
            <div className={styles.logoIcon}>
              <PlanetIcon size={32} />
            </div>
            <span className={styles.logoText}>Hosmos</span>
          </Link>

          <h1 className={styles.title}>{t("welcomeBack")}</h1>
          <p className={styles.subtitle}>{t("loginSubtitle")}</p>

          {error && <div className={styles.errorBox}>{error}</div>}

          <form onSubmit={handleLogin} className={styles.form}>
            <Input
              label={t("email")}
              type="email"
              placeholder={t("emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <div className={styles.passwordField}>
              <Input
                label={t("password")}
                type={showPassword ? "text" : "password"}
                placeholder={t("passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className={styles.passwordToggle}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>

            <div className={styles.optionsRow}>
              <label className={styles.remember}>
                <input type="checkbox" className={styles.checkbox} />
                {t("rememberMe")}
              </label>
              <Link href="/forgot-password" className={styles.forgot}>
                {t("forgotPassword")}
              </Link>
            </div>

            <Button type="submit" className={styles.submit} loading={loading}>
              {t("logIn")} <ArrowRight size={16} className={styles.arrowIcon} />
            </Button>
          </form>

          <div className={styles.footer}>
            <p className={styles.footerText}>
              {t("noAccount")}{" "}
              <Link href="/register" className={styles.footerLink}>
                {t("startFreeTrial")}
              </Link>
            </p>
          </div>
        </div>
      </div>

      {/* Right — Visual */}
      <div className={styles.visualSide}>
        <div className={styles.visualInner}>
          <h2 className={styles.visualTitle}>{t("visualTitle")}</h2>
          <div className={styles.featureList}>
            {[t("feat1"), t("feat2"), t("feat3"), t("feat4")].map((item) => (
              <div key={item} className={styles.featureItem}>
                <div className={styles.featureBadge}>
                  <ArrowRight size={12} />
                </div>
                <span className={styles.featureText}>{item}</span>
              </div>
            ))}
          </div>
          <div className={styles.quoteCard}>
            {/* A statement of how responsibility is divided — not a testimonial.
                The invented «Maria K.» quote that stood here made claims the
                landing ТЗ (§6.3) forbids; removed 10.09.2026. */}
            <p className={styles.quoteText}>{t("quote")}</p>
            <p className={styles.quoteRole}>{t("quoteRole")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
