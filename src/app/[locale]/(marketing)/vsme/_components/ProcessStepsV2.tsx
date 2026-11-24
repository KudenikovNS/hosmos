"use client";

/**
 * "Five steps from reporting boundaries to export" — variant 2 (ТЗ §5).
 *
 * Same interaction contract as variant 1 (one disclosure per step, first open,
 * `display: contents` so the open panel moves into a second column at ≥1024 px,
 * 180–240 ms animation dropped under `prefers-reduced-motion`), with one
 * addition: the panel now carries a small preview of the fields that step
 * actually produces.
 *
 * The preview is field/value pairs, not a picture. Three reasons that is the
 * right form here: it stays legible at 360 px where a scaled-down screenshot
 * would not, it costs no image request against the §13 LCP budget, and it can
 * be translated — a screenshot of a Slovenian screen would have to be re-taken
 * for the English page and would silently go stale the first time a label
 * changes.
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { track } from "@/shared/analytics";

import type { ProcessStepCopy } from "./copy";
import styles from "./ProcessStepsV2.module.css";

/** The mini screen shown beside a step: a caption and a few field/value rows. */
export interface StepPreviewCopy {
  caption: string;
  rows: string[][];
}

export function ProcessStepsV2({
  steps,
  previews,
  resultLabel,
  previewLabel,
}: {
  steps: ProcessStepCopy[];
  previews: StepPreviewCopy[];
  resultLabel: string;
  previewLabel: string;
}) {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <ol className={styles.list}>
      {steps.map((step, index) => {
        const expanded = index === openIndex;
        const headerId = `v2-step-${index}`;
        const panelId = `v2-panel-${index}`;
        const preview = previews[index];
        return (
          <li key={step.title} className={styles.item}>
            <h3 className={styles.headerWrap}>
              <button
                type="button"
                id={headerId}
                aria-expanded={expanded}
                aria-controls={panelId}
                className={
                  expanded
                    ? `${styles.header} ${styles.headerOpen}`
                    : styles.header
                }
                onClick={() => {
                  setOpenIndex(index);
                  // §5: clicking a step reports an analytics event.
                  track("feature_interaction", {
                    component: "process_steps",
                    item: `step_${index + 1}`,
                  });
                }}
              >
                <span className={styles.number} aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className={styles.headerText}>
                  <span className={styles.headerTitle}>{step.title}</span>
                  <span className={styles.headerAction}>{step.action}</span>
                </span>
                <ChevronDown
                  size={18}
                  aria-hidden="true"
                  className={
                    expanded
                      ? `${styles.chevron} ${styles.chevronOpen}`
                      : styles.chevron
                  }
                />
              </button>
            </h3>

            {expanded && (
              <div
                id={panelId}
                role="region"
                aria-labelledby={headerId}
                className={styles.panel}
              >
                {preview && (
                  <div className={styles.preview}>
                    <p className={styles.previewLabel}>{previewLabel}</p>
                    <p className={styles.previewCaption}>{preview.caption}</p>
                    <dl className={styles.previewRows}>
                      {preview.rows.map(([field, value]) => (
                        <div key={field} className={styles.previewRow}>
                          <dt className={styles.previewField}>{field}</dt>
                          <dd className={styles.previewValue}>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
                <p className={styles.result}>
                  <span className={styles.resultLabel}>{resultLabel}</span>
                  {step.result}
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
