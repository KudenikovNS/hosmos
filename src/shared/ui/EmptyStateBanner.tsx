import { AlertCircle, ArrowRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// The LOCALE-AWARE Link (T3.7). `localePrefix: "as-needed"` means a bare
// `next/link` to `/organisation` is the ENGLISH route: a Slovene user following
// this CTA would silently change language. `@/i18n/navigation`'s Link keeps the
// prefix the visitor is already on.
import { Link } from "@/i18n/navigation";

import styles from "./EmptyStateBanner.module.css";

interface EmptyStateBannerProps {
  title: string;
  description: ReactNode;
  /** Where the banner links to (a CTA, e.g. "/calculator"). */
  href: string;
  icon?: LucideIcon;
}

/** Emphasizes a destination inside the banner's existing link. */
export function EmptyStateBannerLinkText({
  children,
}: {
  children: ReactNode;
}) {
  return <span className={styles.linkText}>{children}</span>;
}

/** Clickable amber prompt for "no data yet" empty states. */
export function EmptyStateBanner({
  title,
  description,
  href,
  icon: Icon = AlertCircle,
}: EmptyStateBannerProps) {
  return (
    <Link href={href} className={styles.banner}>
      <Icon size={20} className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.title}>{title}</p>
        <p className={styles.desc}>{description}</p>
      </div>
      <ArrowRight size={16} className={styles.arrow} />
    </Link>
  );
}
