"use client";

import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { TopBar } from "./TopBar";
import styles from "./PageLayout.module.css";

interface PageLayoutProps {
  title: string;
  subtitle?: string;
  loading?: boolean;
  header?: React.ReactNode;
  children?: React.ReactNode;
}

export function PageLayout({
  title,
  subtitle,
  loading = false,
  header,
  children,
}: PageLayoutProps) {
  const t = useTranslations("common");
  return (
    <>
      <TopBar title={title} subtitle={loading ? t("loading") : subtitle} />
      {header}
      {loading ? (
        <div className={styles.loader}>
          <Loader2 className={styles.spinner} />
        </div>
      ) : (
        <div className={styles.body}>{children}</div>
      )}
    </>
  );
}
