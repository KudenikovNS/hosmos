"use client";

// One card of the hub: icon, title, optional subtitle and badge, body.
//
// It lives beside the page rather than in it because T5.9 gives the screen a
// SECOND card that needs the same shell (`EmissionsCard`), and a `page.tsx` is
// not a module other files may import from — Next reserves its export surface.
// Nothing here decides anything; it is the frame the two cards share.
import { Card } from "@/shared/ui/Card";

import styles from "../page.module.css";

export function HubCard({
  icon,
  title,
  subtitle,
  badge,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.iconBox}>{icon}</div>
        <div className={styles.headerGrow}>
          <h3 className={styles.cardTitle}>{title}</h3>
          {subtitle && <p className={styles.headerSubtitle}>{subtitle}</p>}
        </div>
        {badge}
      </div>
      {children}
    </Card>
  );
}
