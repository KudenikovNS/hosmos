"use client";

import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/shared/ui/Button";
import { PlanBadge } from "./PlanBadge";
import { usePlan } from "@/shared/hooks/usePlan";
import { minPlanFor, type PlanFeatures } from "@/shared/plans";
import styles from "./FeatureGate.module.css";

interface FeatureGateProps {
  feature: keyof PlanFeatures;
  children: React.ReactNode;
  // Optional override for the locked-state heading (defaults to a generic line).
  title?: string;
}

// Upgrade destination. The dedicated `/billing` page lands in layer B; until
// then every upsell CTA points at Settings (mirrors reports/dashboard locks).
const UPGRADE_HREF = "/settings";

// T-A5 (§13.2, §13.4): client-side feature gate. UX policy — never hide a paid
// surface. When the plan lacks `feature` we still render the real `children` as
// a dimmed, non-interactive preview and layer an unlock panel (required-tier
// PlanBadge + Upgrade CTA) on top. Access is decided on the SAME resolved
// matrix the server enforces (`usePlan().features`, T-A3), so it can't be faked.
export function FeatureGate({ feature, children, title }: FeatureGateProps) {
  const t = useTranslations("featureGate");
  const { features } = usePlan();

  if (features[feature]) {
    return <>{children}</>;
  }

  const requiredPlan = minPlanFor(feature);

  return (
    <div className={styles.gate}>
      {/* Dimmed preview of the real content. `inert` removes it from tab order
          and blocks interaction while keeping it visible behind the panel. */}
      <div className={styles.preview} inert aria-hidden="true">
        {children}
      </div>

      <div className={styles.overlay}>
        <div className={styles.panel}>
          <div className={styles.lockIconWrap}>
            <Lock size={24} className={styles.lockIcon} />
          </div>
          <h3 className={styles.title}>{title ?? t("defaultTitle")}</h3>
          <p className={styles.subtitle}>{t("subtitle")}</p>
          <div className={styles.badgeRow}>
            <span className={styles.badgeLabel}>{t("requires")}</span>
            <PlanBadge plan={requiredPlan} size="md" />
          </div>
          <Link href={UPGRADE_HREF} className={styles.cta}>
            <Button size="sm">{t("upgrade")}</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
