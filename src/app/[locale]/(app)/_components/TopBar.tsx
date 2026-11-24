"use client";

import { useTranslations } from "next-intl";
import { Bell } from "lucide-react";
import { Badge } from "@/shared/ui/Badge";
import { getPlanBadgeVariant } from "@/shared/plans";
import { usePlan } from "@/shared/hooks/usePlan";
import { LanguageSwitcher } from "@/i18n/LanguageSwitcher";
import styles from "./TopBar.module.css";

interface TopBarProps {
  title: string;
  subtitle?: string;
}

export function TopBar({ title, subtitle }: TopBarProps) {
  const { features } = usePlan();
  const t = useTranslations("topbar");

  return (
    <header className={styles.header}>
      <div className={styles.titleWrap}>
        <h1 className={styles.title} title={title}>
          {title}
        </h1>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      <div className={styles.actions}>
        <span className={styles.badgeWrap}>
          <Badge variant={getPlanBadgeVariant(features.id)}>
            {features.name}
          </Badge>
        </span>
        <button aria-label={t("notifications")} className={styles.iconBtn}>
          <Bell size={18} className={styles.iconMuted} />
          <span className={styles.dot} />
        </button>
        <LanguageSwitcher />
      </div>
    </header>
  );
}
