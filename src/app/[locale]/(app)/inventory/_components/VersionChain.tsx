"use client";

// =============================================================================
// THE VERSION CHAIN OF ONE INPUT ROW (LC-10, API-2) — the audit trail, rendered.
//
// LC-10 IS EXPLICIT that the chain REPLACES a per-entry audit table: there is no
// `row_audit` to read, so whatever this component does not show about who did
// what to a figure is not recorded anywhere else on screen. Hence the four facts
// per version, and not fewer:
//
//   • WHO WROTE IT — `actor_id`, resolved to a name through the company roster.
//     After an approve the head's actor is the APPROVER (LC-4), and the author of
//     the data stays visible ONE LINK BACK. That is the whole reason the list is
//     a list rather than a "last modified by" line, and it is what makes LC-7's
//     self-approval question answerable by eye.
//   • WHAT STATE it was in, and `approved_by`/`approved_at` when it was approved.
//   • WHY it superseded its predecessor — `change_reason`, mandatory when the
//     version it replaced was approved (LC-5).
//   • WHICH REVISION it lives in — see below.
//
// THE REVISION COLUMN IS NOT DECORATION. A revision seeded from another (LC-9,
// T3.4) copies the source's current rows as fresh DRAFT rows whose
// `previous_version_id` points back at the row they came from — which is still
// in the SOURCE revision. So the chain of a seeded row legitimately crosses a
// revision boundary, and without the column the restatement would read as an
// ordinary edit that happened for no reason. Where a version's revision differs
// from the one being viewed, it is labelled as carried over: that is the visible
// difference between "somebody changed this figure" and "this figure was brought
// forward from last year's report".
//
// TRUNCATION IS STATED, never smoothed over: `history` walks at most
// `MAX_VERSION_CHAIN` links and says when it stopped, and a prefix presented as a
// whole history is exactly the kind of quiet lie an audit trail cannot afford.
// =============================================================================
import { History } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import type { RevisionDto, RowDto } from "../_lib/api";
import styles from "../page.module.css";
import { Muted } from "../../_components/ScreenKit";
import { StateBadge } from "./common";

/** An ISO instant as a date-time, or an em dash. */
function useInstant(): (iso: string | null) => string {
  const format = useFormatter();
  return (iso) =>
    iso
      ? format.dateTime(new Date(iso), {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "—";
}

export function VersionChain({
  versions,
  truncated,
  loading,
  selectedId,
  revisionId,
  revisions,
  nameOf,
  onSelect,
}: {
  /** Oldest first, as `GET …/history` returns them. */
  versions: RowDto[];
  truncated: boolean;
  loading: boolean;
  /** The version the drawer is showing. */
  selectedId: string | null;
  /** The revision being edited — anything else in the chain is carried over. */
  revisionId: string | null;
  /** The revisions of the current period, so a `revision_id` gets a number. */
  revisions: RevisionDto[];
  nameOf: (userId: string | null) => string | null;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations("inventory");
  const instant = useInstant();

  const revisionLabel = (id: string): string => {
    const revision = revisions.find((r) => r.id === id);
    return revision
      ? t("history.revisionNo", { no: revision.revision_no })
      : t("history.revisionOther");
  };

  const actor = (userId: string | null): string =>
    nameOf(userId) ?? t("history.unknownUser");

  if (loading) return <Muted>{t("loadingSection")}</Muted>;
  if (versions.length === 0) return <Muted>{t("history.empty")}</Muted>;

  return (
    <div className={styles.history}>
      <p className={styles.subsectionTitle}>
        <History size={14} /> {t("history.title")}
      </p>
      <ol className={styles.historyList}>
        {versions.map((version, index) => {
          const head = version.superseded_by_id === null && !version.is_deleted;
          const carried =
            revisionId !== null && version.revision_id !== revisionId;
          return (
            <li
              key={version.id}
              className={
                version.id === selectedId
                  ? styles.historyItemActive
                  : styles.historyItem
              }
            >
              <button
                type="button"
                className={styles.historyButton}
                onClick={() => onSelect(version.id)}
              >
                <span className={styles.historyHead}>
                  <span className={styles.historyNo}>
                    {t("history.version", { no: index + 1 })}
                  </span>
                  <StateBadge state={version.state} />
                  {head && (
                    <span className={styles.historyTag}>
                      {t("history.current")}
                    </span>
                  )}
                  {version.is_deleted && (
                    <span className={styles.historyTag}>
                      {t("history.tombstone")}
                    </span>
                  )}
                  {carried && (
                    <span className={styles.historyTag}>
                      {t("history.carriedOver", {
                        revision: revisionLabel(version.revision_id),
                      })}
                    </span>
                  )}
                </span>
                <span className={styles.historyMeta}>
                  {t("history.writtenBy", {
                    who: actor(version.actor_id),
                    when: instant(version.created_at),
                  })}
                </span>
                {version.approved_by && (
                  <span className={styles.historyMeta}>
                    {t("history.approvedBy", {
                      who: actor(version.approved_by),
                      when: instant(version.approved_at),
                    })}
                  </span>
                )}
                {version.change_reason && (
                  <span className={styles.historyReason}>
                    {t("history.reason", { reason: version.change_reason })}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      {truncated && <Muted>{t("history.truncated")}</Muted>}
    </div>
  );
}
