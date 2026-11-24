"use client";

// =============================================================================
// The pieces every screen of the product shares: the section card, the muted
// line, the three notices about the wire ("we could not load this", "your
// access changed", "the server refused") and the plan lock.
//
// ONE COPY, ONE WORDING. These used to live in a `common.tsx` per screen; the
// code was identical and the copy had already drifted (four spellings of "we
// could not load this"). The generic sentences now come from `common.notices`.
//
// WHAT STAYS THE SCREEN'S: the words only that screen can say. `RefusalNote`
// takes the screen's namespace and reads three things from it — the field
// labels (`fields.*`), the named refusals (`refusals.*`, e.g. DM-21 on
// /admin/factors) and the explanation of a 422 (`errors.rejected`, which is
// about documents on /evidence and about rows on /inventory). The CLASSIFICATION
// of a refusal stays in `../_lib/refusal`, so no two screens can disagree about
// what a 403 or a 422 means.
//
// A 402 IS A PRODUCT STATEMENT, NEVER A RED ERROR (PG-5): `RefusalNote` renders
// `plan_required` as the plan lock with an upgrade CTA on every screen.
//
// A RULE IS ONE SENTENCE WHEREVER IT COMES FROM: `useRuleText` renders a VAL-*
// code through the `validation.*` keys (О-12); the canonical Russian stays in
// `validation_result.message` for the audit trail.
// =============================================================================
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import { Button } from "@/shared/ui/Button";
import { Card } from "@/shared/ui/Card";

import type { Refusal } from "../_lib/refusal";
import styles from "./ScreenKit.module.css";

/** The message namespace of a screen that writes through `/api/*`. */
export type ScreenNamespace =
  "factors" | "evidence" | "inventory" | "organisation" | "reports" | "review";

/** Where every upgrade CTA points (as elsewhere in the app). */
const UPGRADE_HREF = "/settings";

/** One card of a screen: icon, title, optional subtitle and badge, body. */
export function SectionCard({
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

/** A plain muted line (loading, empty listing, hints). */
export function Muted({ children }: { children: React.ReactNode }) {
  return <p className={styles.mutedNote}>{children}</p>;
}

/** The benign "your access changed" banner (R-11), never a red error. */
export function AccessNote() {
  const t = useTranslations("common.notices");
  return (
    <p role="alert" className={styles.accessBanner}>
      {t("accessChanged")}
    </p>
  );
}

/** "We could not load this" — distinct from an empty list. */
export function LoadErrorNote() {
  const t = useTranslations("common.notices");
  return (
    <p role="alert" className={styles.rowError}>
      {t("loadFailed")}
    </p>
  );
}

/**
 * A feature the PLAN does not include (PG-5): visible, explained, with an
 * upgrade CTA. Also how a 402 from the server is shown.
 */
export function PlanLock({ title, body }: { title: string; body: string }) {
  const t = useTranslations("common.notices");
  return (
    <div className={styles.planLock}>
      <Lock size={16} className={styles.planLockIcon} />
      <div className={styles.planLockMain}>
        <p className={styles.planLockTitle}>{title}</p>
        <p className={styles.planLockBody}>{body}</p>
      </div>
      <Link href={UPGRADE_HREF} className={styles.planLockCta}>
        <Button size="sm">{t("upgrade")}</Button>
      </Link>
    </div>
  );
}

/**
 * One VAL-* code as a sentence. An unknown code (impossible today — the registry
 * and the message file are asserted equal in `rules.test.ts`) degrades to naming it.
 */
export function useRuleText(): (code: string) => string {
  const t = useTranslations("common.notices");
  const tRule = useTranslations("validation");
  return (code) => (tRule.has(code) ? tRule(code) : t("ruleUnknown", { code }));
}

/** Whatever the server refused, in the register that refusal deserves. */
export function RefusalNote({
  refusal,
  screen,
}: {
  refusal: Refusal | null;
  /** Whose field labels, named refusals and 422 explanation to use. */
  screen: ScreenNamespace;
}) {
  const t = useTranslations("common.notices");
  const own = useTranslations(screen);
  const ruleText = useRuleText();
  if (!refusal) return null;
  if (refusal.kind === "plan_required") {
    return (
      <PlanLock title={t("planRequiredTitle")} body={t("planRequiredBody")} />
    );
  }
  const lines = ((): string[] => {
    switch (refusal.kind) {
      case "access_changed":
        return [t("accessChanged")];
      case "rules":
        return refusal.rules.map((entry) => ruleText(entry.code));
      case "refused": {
        const key = `refusals.${refusal.refusal}`;
        return [own.has(key) ? own(key) : t("generic")];
      }
      case "field": {
        const key = `fields.${refusal.field}`;
        return [t("field", { field: own.has(key) ? own(key) : refusal.field })];
      }
      case "rejected":
        return [
          own.has("errors.rejected") ? own("errors.rejected") : t("generic"),
        ];
      default:
        return [t("generic")];
    }
  })();
  return (
    <ul role="alert" className={styles.refusal}>
      {lines.map((line, index) => (
        <li key={index}>{line}</li>
      ))}
    </ul>
  );
}
