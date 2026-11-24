"use client";

// =============================================================================
// WHICH REVISION THE REPORT IS MADE FROM (T5.8 acceptance — "a `draft` revision
// is unavailable WITH AN EXPLANATION"; REN-3).
//
// A `<select>` WOULD HAVE BEEN WRONG HERE, and that is the whole reason this is
// a list of radios. The criterion is not "a draft cannot be chosen" — a disabled
// `<option>` achieves that — it is that the user LEARNS WHY, in place. A picker
// that silently omits the draft answers "where is my period?" with nothing; one
// that greys the option out answers it with a shrug. Each row here carries its
// status badge and, when it is not renderable, the sentence that says what has
// to happen first and where (`/review` is the only screen that approves).
//
// The decision itself is not made in this component: `revisionChoices` labels
// them and `pickedRevision` chooses the default, both in `_lib/wizard` and both
// tested. This renders the answer.
// =============================================================================
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";

import type { RevisionChoice } from "../_lib/wizard";
import { Muted } from "../../_components/ScreenKit";
import { StatusBadge } from "./common";
import styles from "../page.module.css";

/** Where a revision that is not yet approved gets approved (§5.1). */
const REVIEW_HREF = "/review";

export function RevisionPicker({
  choices,
  selectedId,
  onSelect,
}: {
  choices: readonly RevisionChoice[];
  selectedId: string | null;
  onSelect: (revisionId: string) => void;
}) {
  const t = useTranslations("reports");

  if (choices.length === 0) return <Muted>{t("scope.noRevision")}</Muted>;

  return (
    <ul className={styles.revisionList}>
      {choices.map((choice) => (
        <li
          key={choice.id}
          className={
            choice.id === selectedId
              ? styles.revisionItemActive
              : styles.revisionItem
          }
        >
          <label className={styles.revisionLabel}>
            <input
              type="radio"
              name="reports-revision"
              className={styles.revisionRadio}
              value={choice.id}
              checked={choice.id === selectedId}
              disabled={!choice.renderable}
              onChange={() => onSelect(choice.id)}
            />
            <span className={styles.revisionMain}>
              <span className={styles.revisionTitle}>
                {t("scope.revisionNo", { no: choice.revisionNo })}
              </span>
              <span className={styles.revisionTags}>
                <StatusBadge status={choice.status} />
                {choice.isCurrent && (
                  <span className={styles.revisionMeta}>
                    {t("scope.current")}
                  </span>
                )}
              </span>
              {choice.reason !== null && (
                <span className={styles.revisionBlocked}>
                  {t(`scope.blocked.${choice.reason}`)}{" "}
                  <Link href={REVIEW_HREF} className={styles.inlineLink}>
                    {t("scope.blockedCta")}
                  </Link>
                </span>
              )}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
