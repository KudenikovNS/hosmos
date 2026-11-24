"use client";

// =============================================================================
// The pieces only `/reports` has: the two PLAN explanations and the small
// badges. The section card, the notices and the refusal renderer are shared
// (`../../_components/ScreenKit`).
//
// TWO PLAN NOTES, AND THEY SAY OPPOSITE THINGS. That is not duplication, it is
// D14:
//   • `FormatLock` is PG-2/PG-5 — "your plan does not sell this FORMAT". It
//     appears beside a format the user cannot pick, with an upgrade CTA. The 402
//     behind it is `requireReportFormat`'s.
//   • `LockGateNote` is F1/PG-3 — "your plan will not let this report be
//     CLOSED". It appears while the report is perfectly renderable, because a
//     plan limit on coverage is a stamp and not a refusal (AC-12). Showing it as
//     an error would say the render failed, which is the exact confusion D14
//     exists to prevent.
// Neither is a gate. Both are sentences with numbers and a way out.
// =============================================================================
import { Info, Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import type { LockWarning } from "../_lib/wizard";
import styles from "../page.module.css";

/** Where every upgrade CTA on this screen points (as elsewhere in the app). */
const UPGRADE_HREF = "/settings";

/** A localised label for one wire value, falling back to the literal. */
export function useEnumLabel(): (list: string, value: string) => string {
  const t = useTranslations("reports");
  return (list, value) => {
    const key = `${list}.${value}`;
    return t.has(key) ? t(key) : value;
  };
}

/** PG-2/PG-5 — a format the plan does not sell, visible and explained. */
export function FormatLock({ format }: { format: string }) {
  const t = useTranslations("reports");
  const label = useEnumLabel();
  return (
    <div className={styles.planLock}>
      <Lock size={16} className={styles.planLockIcon} />
      <div className={styles.planLockMain}>
        <p className={styles.planLockTitle}>
          {t("output.formatLockTitle", { format: label("formats", format) })}
        </p>
        <p className={styles.planLockBody}>{t("output.formatLockBody")}</p>
      </div>
      <Link href={UPGRADE_HREF} className={styles.planLockCta}>
        <Button size="sm">{t("actions.upgrade")}</Button>
      </Link>
    </div>
  );
}

/**
 * F1/PG-3 before the Lock (§11.3) — the two numbers, the plan, and a CTA.
 *
 * Deliberately NOT in the refusal register: nothing has been refused, the report
 * on offer is complete for what the plan covers, and the only thing the customer
 * cannot do is declare it final. Saying that here, while the report is being
 * produced, is the entire point — the alternative is learning it from a 402 on a
 * screen they have not opened yet.
 */
export function LockGateNote({ warning }: { warning: LockWarning }) {
  const t = useTranslations("reports");
  return (
    <div className={styles.planLock}>
      <Lock size={16} className={styles.planLockIcon} />
      <div className={styles.planLockMain}>
        <p className={styles.planLockTitle}>{t("lock.title")}</p>
        <p className={styles.planLockBody}>
          {t("lock.body", {
            facilities: warning.facilities,
            limit: warning.limit,
            plan: warning.plan,
          })}
        </p>
        <p className={styles.planLockHint}>{t("lock.hint")}</p>
      </div>
      <Link href={UPGRADE_HREF} className={styles.planLockCta}>
        <Button size="sm">{t("actions.upgrade")}</Button>
      </Link>
    </div>
  );
}

/** A revision status (§5.1) as a badge — the vocabulary of the whole screen. */
export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("reports");
  const key = `revisionStatus.${status}`;
  const variant =
    status === "locked"
      ? "violet"
      : status === "approved"
        ? "green"
        : status === "rejected"
          ? "red"
          : status === "in_review" || status === "submitted"
            ? "blue"
            : "gray";
  return (
    <Badge variant={variant} size="sm">
      {t.has(key) ? t(key) : status}
    </Badge>
  );
}

/** D14's claim as a badge: `full` is a statement, `partial` is a disclosure. */
export function CoverageBadge({ claim }: { claim: string }) {
  const t = useTranslations("reports");
  const key = `coverage.${claim}`;
  return (
    <Badge variant={claim === "full" ? "green" : "yellow"} size="sm">
      {t.has(key) ? t(key) : claim}
    </Badge>
  );
}

/** A neutral, informative line — used for the REN-3 gate explanation. */
export function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.disclosure}>
      <Info size={16} className={styles.disclosureIcon} />
      <span>{children}</span>
    </div>
  );
}
