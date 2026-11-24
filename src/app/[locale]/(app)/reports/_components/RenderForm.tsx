"use client";

// =============================================================================
// THE FORMAT, THE LANGUAGE AND THE BUTTON (T5.8 — PG-2/PG-5, О-14, REN-3).
//
// THREE THINGS THIS COMPONENT IS CAREFUL ABOUT:
//
//   1. AN UNSOLD FORMAT IS SHOWN, NOT HIDDEN (PG-5). Its radio is disabled and
//      selecting it is impossible, but it is on screen with a padlock, and
//      picking it up in the list is what makes the upgrade CTA appear beside the
//      one the customer wanted. Hiding `xlsx` on trial would make the plan
//      difference invisible and the upgrade unmotivated.
//   2. THE LANGUAGE IS AN INPUT, NOT A VIEW (О-14). It defaults to the interface
//      locale and is then CHOSEN: the value goes into an immutable row and into
//      the bytes, so the control is a real field of the form and not a display
//      preference. The hint under it says so, because a user who assumes it
//      follows the UI language will be surprised by a file that does not.
//   3. THE BUTTON IS DISABLED ONLY FOR REASONS THE SCREEN CAN NAME — no
//      renderable revision, no sellable format, a request in flight, or a
//      capability the session does not hold. It is NOT disabled by the REN-3
//      gate: that refusal is explained above it by `GateNote`, and a button that
//      is merely grey teaches nothing.
// =============================================================================
import { FileDown, Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import type { ReportLanguage } from "@/i18n/locales";
import { Button } from "@/shared/ui/Button";
import type { RenderFormat } from "@/shared/reports";

import type { FormatChoice, LockWarning } from "../_lib/wizard";
import { RENDER_LANGUAGES } from "../_lib/wizard";
import { FormatLock, LockGateNote, useEnumLabel } from "./common";
import styles from "../page.module.css";

export function RenderForm({
  formats,
  selectedFormat,
  onSelectFormat,
  language,
  onSelectLanguage,
  warning,
  canRender,
  busy,
  disabled,
  onRender,
}: {
  formats: readonly FormatChoice[];
  selectedFormat: RenderFormat | null;
  onSelectFormat: (format: RenderFormat) => void;
  language: ReportLanguage;
  onSelectLanguage: (language: ReportLanguage) => void;
  warning: LockWarning | null;
  canRender: boolean;
  busy: boolean;
  /** No renderable revision selected — the button has nothing to act on. */
  disabled: boolean;
  onRender: () => void;
}) {
  const t = useTranslations("reports");
  const label = useEnumLabel();
  // PG-5: the CTA is shown for the first blocked format, once — a padlock per
  // row plus one explanation, rather than the same paragraph twice.
  const blocked = formats.find((choice) => !choice.allowed);

  return (
    <div className={styles.form}>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t("output.format")}</legend>
        <div className={styles.choiceRow}>
          {formats.map((choice) => (
            <label
              key={choice.format}
              className={choice.allowed ? styles.choice : styles.choiceBlocked}
            >
              <input
                type="radio"
                name="reports-format"
                value={choice.format}
                checked={choice.format === selectedFormat}
                disabled={!choice.allowed}
                onChange={() => onSelectFormat(choice.format)}
              />
              <span>{label("formats", choice.format)}</span>
              {!choice.allowed && (
                <Lock size={12} className={styles.choiceLock} />
              )}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t("output.language")}</legend>
        <div className={styles.choiceRow}>
          {RENDER_LANGUAGES.map((locale) => (
            <label key={locale} className={styles.choice}>
              <input
                type="radio"
                name="reports-language"
                value={locale}
                checked={locale === language}
                onChange={() => onSelectLanguage(locale)}
              />
              <span>{label("languages", locale)}</span>
            </label>
          ))}
        </div>
        <p className={styles.hint}>{t("output.languageHint")}</p>
      </fieldset>

      {blocked && <FormatLock format={blocked.format} />}
      {warning && <LockGateNote warning={warning} />}

      <div className={styles.actionRow}>
        <Button
          onClick={onRender}
          loading={busy}
          disabled={disabled || !canRender || selectedFormat === null}
        >
          <FileDown size={16} /> {t("output.render")}
        </Button>
        {!canRender && <span className={styles.hint}>{t("readOnlyNote")}</span>}
      </div>
    </div>
  );
}
