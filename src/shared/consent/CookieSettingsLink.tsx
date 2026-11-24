"use client";

import { useTranslations } from "next-intl";
import clsx from "clsx";

import { openCookieSettings } from "./consent";
import styles from "./CookieSettingsLink.module.css";

/** A link-looking button that reopens the cookie banner. */
export function CookieSettingsLink({ className }: { className?: string }) {
  const t = useTranslations("cookies");
  return (
    <button
      type="button"
      className={clsx(styles.link, className)}
      onClick={openCookieSettings}
    >
      {t("settings")}
    </button>
  );
}
