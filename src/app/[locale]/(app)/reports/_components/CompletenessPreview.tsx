"use client";

// =============================================================================
// WHAT THE REPORT WILL AND WILL NOT COVER, BEFORE IT IS MADE (T5.8 — D14,
// AC-12, AC-13, REN-3).
//
// ── THIS IS NOT A SECOND OPINION ────────────────────────────────────────────
// Every value on screen here comes from `GET /api/revisions/[id]/render`, whose
// handler calls `renderPreview` — the same function `renderRevision` calls on
// its way to the row. The claim, the completeness note and the list of excluded
// records are the SAME OBJECTS that will be written into `coverage_claim`,
// `completeness_note` and `excluded_by_plan`. Nothing in this component counts a
// facility or compares it to a limit; if it did, the preview and the stamp would
// be two implementations of D14, and the day they diverged the customer would
// read one thing on screen and send a different one to their bank.
//
// ── WHY THE GATE AND THE COVERAGE ARE SHOWN TOGETHER ────────────────────────
// They answer different questions and are routinely in opposite states: a
// perfectly complete report from a draft revision (gate refuses, coverage
// `full`), and a publishable report that covers three of five sites (gate
// passes, coverage `partial`). Putting them in one card is what makes D14
// legible — one of these stops you, the other is disclosed and does not.
// =============================================================================
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import type { RenderPreviewDto } from "../_lib/api";
import { exclusionCounts } from "../_lib/wizard";
import { Muted } from "../../_components/ScreenKit";
import { CoverageBadge, InfoNote, useEnumLabel } from "./common";
import styles from "../page.module.css";

export function CompletenessPreview({
  preview,
  loading,
}: {
  preview: RenderPreviewDto | null;
  loading: boolean;
}) {
  const t = useTranslations("reports");
  const label = useEnumLabel();

  if (loading) return <Muted>{t("completeness.loading")}</Muted>;
  if (!preview) return <Muted>{t("completeness.noRevision")}</Muted>;

  const counts = exclusionCounts(preview.excluded_by_plan);
  const partial = preview.coverage_claim !== "full";

  return (
    <div className={styles.preview}>
      {/* REN-3, stated as the thing to go and fix. `gate_reason` is the route's
          own vocabulary, so the sentence cannot describe a refusal the server
          did not make. */}
      {!preview.renderable && preview.gate_reason && (
        <InfoNote>{t(`gate.${preview.gate_reason}`)}</InfoNote>
      )}

      <div className={styles.badgeRow}>
        {partial ? (
          <ShieldAlert size={16} className={styles.iconAmber} />
        ) : (
          <ShieldCheck size={16} className={styles.iconGreen} />
        )}
        <CoverageBadge claim={preview.coverage_claim} />
        <span className={styles.previewLanguage}>
          {t("completeness.inLanguage", {
            language: label("languages", preview.language),
          })}
        </span>
      </div>

      {!partial && <Muted>{t("completeness.fullBody")}</Muted>}

      {partial && (
        <>
          {/* The completeness NOTE is the server's sentence, in the render's
              language, and it is shown verbatim — this is the line that will be
              printed on the cover of the file. */}
          {preview.completeness_note && (
            <p className={styles.note}>{preview.completeness_note}</p>
          )}
          {counts.total > 0 && (
            <>
              <p className={styles.subsectionTitle}>
                {t("completeness.excludedTitle", { count: counts.total })}
              </p>
              <ul className={styles.exclusionList}>
                {preview.excluded_by_plan.map((exclusion) => (
                  <li key={`${exclusion.type}:${exclusion.id}`}>
                    <span className={styles.exclusionName}>
                      {exclusion.name}
                    </span>
                    <span className={styles.exclusionType}>
                      {label("objectType", exclusion.type)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
