"use client";

import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import { Muted } from "../../../_components/ScreenKit";
import {
  moduleAvailable,
  sectionSummary,
  type RecordLike,
  type Section,
} from "../_lib/catalog";
import styles from "../page.module.css";

export function DisclosureSectionTabs({
  groups,
  selectedCode,
  onSelect,
  recordOf,
  comprehensive,
  simplifiedEsrs,
}: {
  groups: readonly {
    standard: "vsme" | "esrs";
    sections: readonly Section[];
  }[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
  recordOf: (key: string) => RecordLike | null;
  comprehensive: boolean;
  simplifiedEsrs: boolean;
}) {
  const t = useTranslations("disclosures");
  return (
    <>
      {groups.map((group) => (
        <div key={group.standard} className={styles.sectionGroup}>
          {groups.length > 1 && (
            <p className={styles.sectionGroupLabel}>
              {t(`groups.${group.standard}`)}
            </p>
          )}
          <div className={styles.sectionStrip} role="tablist">
            {group.sections.map((entry: Section) => {
              const summary = sectionSummary(
                entry,
                recordOf,
                comprehensive,
                simplifiedEsrs,
              );
              // Партия 21 — say on the strip itself which groups the plan
              // includes. The card already refuses a value and offers the
              // upgrade (PG-5/PG-6); until you opened one, «0 of 8» looked
              // exactly like a group you had simply not filled in yet.
              const included = moduleAvailable(
                entry.module,
                comprehensive,
                simplifiedEsrs,
              );
              return (
                <button
                  key={entry.code}
                  type="button"
                  role="tab"
                  aria-selected={entry.code === selectedCode}
                  title={included ? undefined : t("sectionLocked")}
                  className={
                    entry.code === selectedCode
                      ? styles.sectionButtonActive
                      : included
                        ? styles.sectionButton
                        : styles.sectionButtonLocked
                  }
                  onClick={() => onSelect(entry.code)}
                >
                  <span className={styles.sectionCode}>
                    {!included && (
                      <Lock size={12} className={styles.sectionLockIcon} />
                    )}
                    {entry.code}
                  </span>
                  <span className={styles.sectionCount}>
                    {included
                      ? t("sectionCount", {
                          filled: summary.filled,
                          total: entry.metrics.length,
                        })
                      : t("sectionLocked")}
                  </span>
                </button>
              );
            })}
          </div>
          {group.sections.some(
            (entry: Section) =>
              !moduleAvailable(entry.module, comprehensive, simplifiedEsrs),
          ) && <Muted>{t("lockedLegend")}</Muted>}
        </div>
      ))}
    </>
  );
}
