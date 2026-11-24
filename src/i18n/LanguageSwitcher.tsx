"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { ChevronDown, Globe } from "lucide-react";

import { useRouter, usePathname } from "./navigation";
import { locales, localeNames, type Locale } from "./locales";
import styles from "./LanguageSwitcher.module.css";

/**
 * The one language control of the product and the public site. The visible
 * part names the current language in that language ("Slovenščina", not "SL"),
 * so a visitor who landed on the wrong one recognises it; the native `<select>`
 * behind it lists all six the way every keyboard, screen reader and phone
 * already knows. The route is kept and only the prefix changes.
 *
 * `variant="block"` stretches it to the container (mobile drawer).
 */
export function LanguageSwitcher({
  variant = "inline",
}: {
  variant?: "inline" | "block";
}) {
  const active = useLocale() as Locale;
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  return (
    <label
      className={variant === "block" ? styles.block : styles.trigger}
      title={t("language")}
      data-pending={isPending || undefined}
    >
      <Globe size={16} className={styles.icon} aria-hidden="true" />
      <span className={styles.name} lang={active} aria-hidden="true">
        {localeNames[active]}
      </span>
      <ChevronDown size={14} className={styles.chevron} aria-hidden="true" />
      <select
        className={styles.select}
        aria-label={t("language")}
        value={active}
        disabled={isPending}
        onChange={(event) => {
          const next = event.target.value as Locale;
          if (next === active) return;
          startTransition(() => {
            router.replace(pathname, { locale: next });
          });
        }}
      >
        {locales.map((locale) => (
          <option key={locale} value={locale} lang={locale}>
            {localeNames[locale]}
          </option>
        ))}
      </select>
    </label>
  );
}
