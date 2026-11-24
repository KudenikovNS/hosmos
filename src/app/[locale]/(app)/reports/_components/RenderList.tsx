"use client";

// =============================================================================
// THE IMMUTABLE RENDERS (T5.8 — DM-30, REN-5, О-14).
//
// ── WHY EVERY ROW CARRIES A LANGUAGE, A FORMAT AND A HASH ───────────────────
// О-14's acceptance criterion is that two renders of ONE revision are
// DISTINGUISHABLE in this list. They share a period, a revision number and a
// calculation run; what differs is the language, and — because the bytes differ
// — the `file_hash`. So both are columns, not tooltips: a list that showed
// "Revision 2 · PDF" twice would be a list in which the acceptance criterion is
// literally invisible, and the user picking a file to send would be guessing.
//
// The hash is shown TRUNCATED with the full digest in `title`: it is there to be
// compared against a counterparty's copy, and twelve characters is what a person
// can check by eye. The download is an ordinary link (see `_lib/api`).
//
// The whole company's renders are listed, newest first, not just the selected
// revision's — a report published for last year is still the artefact somebody
// has to find, and scoping the list to the wizard's current selection would hide
// it behind a picker.
// =============================================================================
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";

import type { RenderDto } from "../_lib/api";
import { downloadHref } from "../_lib/api";
import { shortHash } from "../_lib/wizard";
import { Muted } from "../../_components/ScreenKit";
import { useInstant } from "../../_lib/useInstant";
import { CoverageBadge, useEnumLabel } from "./common";
import styles from "../page.module.css";

export function RenderList({
  renders,
  loading,
}: {
  renders: readonly RenderDto[];
  loading: boolean;
}) {
  const t = useTranslations("reports");
  const label = useEnumLabel();
  const instant = useInstant();

  if (loading) return <Muted>{t("renders.loading")}</Muted>;
  if (renders.length === 0) return <Muted>{t("renders.empty")}</Muted>;

  return (
    <ul className={styles.renderList}>
      {renders.map((render) => (
        <li key={render.id} className={styles.renderItem}>
          <div className={styles.renderMain}>
            <p className={styles.renderTitle}>
              {render.period_name ?? t("renders.unknownPeriod")}
              {render.period_name_is_current &&
                ` (${t("renders.currentPeriodName")})`}
              {" · "}
              {t("scope.revisionNo", { no: render.revision_no ?? 0 })}
            </p>
            <p className={styles.renderMeta}>
              {label("formats", render.format)}
              {" · "}
              {label("languages", render.language)}
              {" · "}
              {instant(render.rendered_at)}
            </p>
            <p className={styles.renderHash} title={render.file_hash}>
              {t("renders.hash", { hash: shortHash(render.file_hash) })}
            </p>
          </div>
          <div className={styles.renderSide}>
            <CoverageBadge claim={render.coverage_claim} />
            <a
              className={styles.downloadLink}
              href={downloadHref(render.id)}
              download={render.file_name}
              rel="noopener"
            >
              <Download size={14} /> {t("renders.download")}
            </a>
          </div>
        </li>
      ))}
    </ul>
  );
}
