"use client";

// =============================================================================
// The pieces only `/admin/factors` has. The section card, the notices and the
// refusal renderer are shared (`../../../_components/ScreenKit`); this screen
// contributes its words to them through the `factors` namespace — notably the
// named refusals of DM-21 (`refusals.*`): a released set is never edited, and
// the message says so AND names the way out (make a new version).
// =============================================================================
import { useTranslations } from "next-intl";

import styles from "../page.module.css";

/** The status pill of a set — the lifecycle DM-21 turns on. */
export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("factors");
  const key = `status.${status}`;
  const variant =
    status === "active" ? "green" : status === "draft" ? "yellow" : "gray";
  return (
    <span className={styles.statusPill} data-variant={variant}>
      {t.has(key) ? t(key) : status}
    </span>
  );
}
