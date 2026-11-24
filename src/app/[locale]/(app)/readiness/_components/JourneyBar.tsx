"use client";

// The eight steps of the stage-1 flow (§7), as one horizontal track. Each step
// is the SERVER's verdict (`journey[]`); this component only draws it and links
// to the screen that owns the step. Scrolls horizontally on a phone rather than
// wrapping, so the order — which is the point — stays readable.
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { clsx } from "clsx";

import { Link } from "@/i18n/navigation";
import type { JourneyStep, JourneyStepId } from "@/server/readiness/readiness";

import styles from "../page.module.css";

export function JourneyBar({
  steps,
  next,
}: {
  steps: readonly JourneyStep[];
  next: JourneyStepId | null;
}) {
  const t = useTranslations("readiness.journey");
  return (
    <section className={styles.journey} aria-label={t("aria")}>
      <div className={styles.journeyHead}>
        <h2 className={styles.journeyTitle}>{t("title")}</h2>
        {next && (
          <p className={styles.journeyNext}>
            {t("next")} <strong>{t(`steps.${next}`)}</strong>
          </p>
        )}
      </div>
      <ol className={styles.track}>
        {steps.map((step, index) => (
          <li
            key={step.id}
            className={clsx(styles.step, styles[`step_${step.state}`])}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <Link href={step.href} className={styles.stepLink}>
              <span className={styles.stepIndex} aria-hidden="true">
                {step.state === "done" ? <Check size={14} /> : index + 1}
              </span>
              <span className={styles.stepLabel}>{t(`steps.${step.id}`)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
