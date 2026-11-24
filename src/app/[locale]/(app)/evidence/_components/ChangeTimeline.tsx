"use client";

// =============================================================================
// THE APPEND-ONLY CHANGE TIMELINE OF ONE ROW (UI-3, LC-10, D5, §11.2).
//
// EVERYTHING ON SCREEN HERE CAME OUT OF A GET. There is no locally appended
// "you just approved this" entry and no optimistic anything: an approval or an
// edit invalidates the two queries and the list is redrawn from what the server
// answered. That is deliberate and it is the reason this panel sits beside forms
// that can be refused — a timeline that showed an act the server rolled back
// would be the exact failure mode the rest of this screen is built to avoid.
//
// TWO SOURCES, ONE STORY (`_lib/timeline` states the argument):
//   • THE VERSION CHAIN is the row's audit trail — LC-10 is explicit that input
//     rows get no per-entry audit table. Who wrote each version, what state it
//     was in, why it superseded its predecessor, and which revision it lives in.
//   • THE `audit_log` ROWS ABOUT THOSE VERSIONS add the two facts a row cannot
//     carry: the actor's ROLE at the time (a snapshot, not an FK) and the
//     self-approval disclosure §11.2 writes into `summary`. "Approved by X" is on
//     the version; "…who is also the person who entered it" is only here.
//
// THE AUDIT HALF IS `audit.read`, AND ITS ABSENCE IS STATED RATHER THAN FAKED. A
// contributor does not hold it (§6.2), so no request is made and the panel says
// which half it is not showing. Pretending the trail is complete would be worse
// than the missing half.
//
// BOTH TRUNCATIONS ARE STATED. `history` walks at most `MAX_VERSION_CHAIN` links
// and says when it stopped; `/api/audit` returns the company's most recent rows
// only, so an approval older than that window is simply outside what we read
// (`auditWindowIncomplete`). A prefix presented as a whole history is the quiet
// lie an audit trail cannot afford.
// =============================================================================
import { History, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import type { AuditEntryDto, RowMixinDto } from "../_lib/api";
import { auditWindowIncomplete, buildTimeline } from "../_lib/timeline";
import styles from "../page.module.css";
import { Muted } from "../../_components/ScreenKit";
import { useInstant } from "../../_lib/useInstant";
import { StateBadge } from "./common";

/** `summary.self_approved` of an approval, when the disclosure is there (§11.2). */
function selfApproved(summary: Record<string, unknown>): boolean {
  return summary.self_approved === true;
}

/**
 * WHAT THE ENTRY SAYS HAPPENED — `summary.action` when the writer named it,
 * otherwise the coarse `action` column.
 *
 * A row's approval is written as `action: "update"` with
 * `summary.action: "approve_row"` (`@/server/inventory/rows`): the column says
 * what kind of mutation it was, the summary says which act it was. Reading the
 * column alone would print "Updated" for the one event on this timeline that a
 * reviewer is actually looking for.
 */
function actionOf(entry: AuditEntryDto): string {
  const named = entry.summary.action;
  return typeof named === "string" && named !== "" ? named : entry.action;
}

export function ChangeTimeline({
  versions,
  chainTruncated,
  loading,
  audit,
  auditLimit,
  auditAvailable,
  revisionId,
  nameOf,
}: {
  /** Oldest first, as `GET …/history` returns them. */
  versions: readonly RowMixinDto[];
  chainTruncated: boolean;
  loading: boolean;
  /** Newest first, as `GET /api/audit` returns them. Empty without `audit.read`. */
  audit: readonly AuditEntryDto[];
  auditLimit: number;
  /** Does this session hold `audit.read`? The route enforces either way. */
  auditAvailable: boolean;
  /** The revision being worked on — anything else in the chain is carried over. */
  revisionId: string | null;
  nameOf: (userId: string | null) => string | null;
}) {
  const t = useTranslations("evidence");
  // The ROLE SNAPSHOT is the app's own role vocabulary, so it is read from the
  // shared `roles` namespace rather than copied into this screen's: a role
  // renamed there must not read one way in the sidebar and another in an audit
  // trail. `actor_role` is a free `text` column, so an unknown value falls back
  // to its literal.
  const tRole = useTranslations("roles");
  const instant = useInstant();

  const entries = buildTimeline(versions, audit);
  const windowShort =
    auditAvailable && auditWindowIncomplete(versions, audit, auditLimit);

  const actor = (userId: string | null): string =>
    nameOf(userId) ?? t("timeline.unknownUser");

  if (loading) return <Muted>{t("loadingSection")}</Muted>;
  if (versions.length === 0) return <Muted>{t("timeline.empty")}</Muted>;

  return (
    <div className={styles.timeline}>
      <p className={styles.subsectionTitle}>
        <History size={14} /> {t("timeline.title")}
      </p>
      <ol className={styles.timelineList}>
        {entries.map((entry) =>
          entry.kind === "version" ? (
            <li key={entry.key} className={styles.timelineVersion}>
              <span className={styles.timelineHead}>
                <span className={styles.timelineNo}>
                  {t("timeline.version", { no: entry.no })}
                </span>
                <StateBadge state={entry.version.state} />
                {entry.head && (
                  <span className={styles.timelineTag}>
                    {t("timeline.current")}
                  </span>
                )}
                {entry.version.is_deleted && (
                  <span className={styles.timelineTag}>
                    {t("timeline.tombstone")}
                  </span>
                )}
                {revisionId !== null &&
                  entry.version.revision_id !== revisionId && (
                    <span className={styles.timelineTag}>
                      {t("timeline.carriedOver")}
                    </span>
                  )}
              </span>
              <span className={styles.timelineMeta}>
                {t("timeline.writtenBy", {
                  who: actor(entry.version.actor_id),
                  when: instant(entry.at),
                })}
              </span>
              {entry.version.approved_by && (
                <span className={styles.timelineMeta}>
                  {t("timeline.approvedBy", {
                    who: actor(entry.version.approved_by),
                    when: instant(entry.version.approved_at),
                  })}
                </span>
              )}
              {entry.version.change_reason && (
                <span className={styles.timelineReason}>
                  {t("timeline.reason", {
                    reason: entry.version.change_reason,
                  })}
                </span>
              )}
            </li>
          ) : (
            <li key={entry.key} className={styles.timelineAudit}>
              <span className={styles.timelineHead}>
                <ShieldCheck size={12} className={styles.iconGreen} />
                <span className={styles.timelineNo}>
                  {t.has(`timeline.action.${actionOf(entry.entry)}`)
                    ? t(`timeline.action.${actionOf(entry.entry)}`)
                    : actionOf(entry.entry)}
                </span>
                {entry.entry.actorRole && (
                  <span className={styles.timelineTag}>
                    {tRole.has(entry.entry.actorRole)
                      ? tRole(entry.entry.actorRole)
                      : entry.entry.actorRole}
                  </span>
                )}
              </span>
              <span className={styles.timelineMeta}>
                {t("timeline.auditBy", {
                  who:
                    entry.entry.userName ||
                    entry.entry.userEmail ||
                    t("timeline.unknownUser"),
                  when: instant(entry.at),
                })}
              </span>
              {selfApproved(entry.entry.summary) && (
                <span className={styles.timelineReason}>
                  {t("timeline.selfApproved")}
                </span>
              )}
            </li>
          ),
        )}
      </ol>
      {chainTruncated && <Muted>{t("timeline.chainTruncated")}</Muted>}
      {!auditAvailable && <Muted>{t("timeline.auditHidden")}</Muted>}
      {windowShort && <Muted>{t("timeline.auditWindow")}</Muted>}
    </div>
  );
}
