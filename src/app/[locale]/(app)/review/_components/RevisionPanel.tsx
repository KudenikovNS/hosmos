"use client";

// =============================================================================
// THE REVISION PANEL — the §5.1 transitions, the status timeline, the mandatory
// comment on reject, the mandatory `change_reason` on a restatement, and the
// self-approval disclosure (T4.6; §5.1, §5.4, LC-1, LC-1a, LC-7, LC-9, F1).
//
// ONE REFERENCE PER DECISION, and every decision lives in `_lib`:
//   • WHICH BUTTONS — `actionOffers` (matrix ∩ capability). The component maps
//     over what it returns and filters on `permitted`; it never asks about a
//     role and never spells a status itself.
//   • WHAT A REFUSAL MEANT — `transitionNotice`. One branch per outcome, and the
//     402 branch renders `PlanNote` (an upgrade with the numbers) rather than
//     joining the error list. That separation is an acceptance criterion.
//   • WHICH RULES ARE IN THE WAY — `BlockingRules`, fed from the STORED results
//     of the revision, which the refused transition itself has just refreshed.
//
// THE COMMENT IS ASKED FOR BEFORE THE REQUEST, NOT AFTER THE REFUSAL. §5.1 makes
// it a PRECONDITION of `reject`, so a reject without one is a 422 the user would
// have to read and come back from. The panel opens the field and disables the
// button until there is text — the same belt-and-braces shape `/inventory` uses
// for LC-5's `change_reason`, and not a client refusing something the server
// would have taken: the server refuses this exact request.
//
// THE RESTATEMENT IS A CREATE, NOT A TRANSITION, and that is why it sits beside
// the buttons rather than among them. Over a LOCKED revision there is no
// transition left in the matrix — a locked revision is immutable (VAL-010) — and
// the way forward is §5.1's first row: a NEW revision, seeded from the locked
// one (LC-9, so the correction starts from the published numbers rather than
// from nothing), which MUST state `change_reason`. The server refuses without it
// (`restatement_needs_reason`) and the form demands it first.
// =============================================================================
import { GitBranch, History, Loader2, Calculator } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/shared/ui/Button";
import type { CalculationOutcome } from "../_lib/useReview";
import { Input } from "@/shared/ui/Input";

import type {
  InputTableName,
  Refusal,
  RevisionAction,
  RevisionDto,
} from "../_lib/api";
import type { BlockingItem } from "../_lib/blocking";
import { revisionTimeline } from "../_lib/timeline";
import type { ActionOffer, TransitionNotice } from "../_lib/transitions";
import styles from "../page.module.css";
import { BlockingRules } from "./BlockingRules";
import { Muted, RefusalNote } from "../../_components/ScreenKit";
import { useInstant } from "../../_lib/useInstant";
import { PlanNote, SelfApprovalNote, StatusBadge, useRuleText } from "./common";

export function RevisionPanel({
  revision,
  offers,
  notice,
  busy,
  onTransition,
  blocking,
  advisory,
  blockingLoading,
  onSelectRow,
  nameOf,
  showSelfApproval,
  canRestate,
  restating,
  restateRefusal,
  onRestate,
  onCalculate,
  calculating,
  calculation,
}: {
  revision: RevisionDto | null;
  offers: readonly ActionOffer[];
  notice: TransitionNotice | null;
  busy: RevisionAction | null;
  onTransition: (action: RevisionAction, comment: string) => void;
  blocking: readonly BlockingItem[];
  /** Findings that stop nothing and are still worth saying (warnings, VR-3). */
  advisory: readonly BlockingItem[];
  blockingLoading: boolean;
  onSelectRow: (table: InputTableName, id: string) => void;
  nameOf: (userId: string | null) => string | null;
  /** LC-7 — this viewer holds `data.approve` and the company has no approver. */
  showSelfApproval: boolean;
  /** `data.write` — starting a revision is a write (§5.4). */
  canRestate: boolean;
  restating: boolean;
  restateRefusal: Refusal | null;
  onRestate: (changeReason: string) => void;
  /** Партия 17 — the run `approve` demands, started from this screen. */
  onCalculate: () => void;
  calculating: boolean;
  calculation: CalculationOutcome | null;
}) {
  const t = useTranslations("review");
  const instant = useInstant();
  const ruleText = useRuleText();
  const [comment, setComment] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [pending, setPending] = useState<RevisionAction | null>(null);

  if (!revision) return <Muted>{t("revision.none")}</Muted>;

  const permitted = offers.filter((offer) => offer.permitted);
  const entries = revisionTimeline(revision);
  const commentReady = comment.trim() !== "";
  const reasonReady = changeReason.trim() !== "";
  const locked = revision.status === "locked";

  return (
    <div className={styles.revisionPanel}>
      <div className={styles.badgeRow}>
        <StatusBadge status={revision.status} />
        <span className={styles.revisionNo}>
          {t("revision.number", { no: revision.revision_no })}
        </span>
        {!revision.is_current && (
          <span className={styles.revisionNo}>{t("revision.notCurrent")}</span>
        )}
      </div>

      {revision.change_reason && (
        <p className={styles.reasonLine}>
          {t("revision.changeReason", { reason: revision.change_reason })}
        </p>
      )}
      {revision.review_comment && (
        <p className={styles.reasonLine}>
          {t("revision.reviewComment", { comment: revision.review_comment })}
        </p>
      )}
      {revision.assigned_to && (
        <Muted>
          {t("revision.assignedTo", {
            name: nameOf(revision.assigned_to) ?? revision.assigned_to,
          })}
        </Muted>
      )}

      {/* ── The status timeline (LC-10; see `_lib/timeline` for its limits) ── */}
      <p className={styles.subsectionTitle}>
        <History size={14} /> {t("timeline.title")}
      </p>
      {entries.length === 0 ? (
        <Muted>{t("timeline.empty")}</Muted>
      ) : (
        <ol className={styles.timeline}>
          {entries.map((entry) => (
            <li key={entry.step} className={styles.timelineItem}>
              <span className={styles.timelineStep}>
                {t(`timeline.steps.${entry.step}`)}
              </span>
              <span className={styles.timelineMeta}>
                {instant(entry.at)}
                {entry.userId
                  ? ` · ${nameOf(entry.userId) ?? entry.userId}`
                  : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
      <Muted>{t("timeline.latestPassOnly")}</Muted>

      {/* ── LC-7: the disclosure, before the button it is about ───────────── */}
      {showSelfApproval && <SelfApprovalNote />}

      {/* ── The calculation (партия 17) ───────────────────────────────────── */}
      {!locked && (
        <>
          <p className={styles.subsectionTitle}>
            <Calculator size={14} /> {t("calculation.title")}
          </p>
          <Muted>{t("calculation.hint")}</Muted>
          <div className={styles.actionRow}>
            <Button
              size="sm"
              variant="secondary"
              loading={calculating}
              onClick={onCalculate}
            >
              {t("calculation.run")}
            </Button>
          </div>
          {calculation !== null &&
            (calculation.ok ? (
              <p
                className={
                  calculation.run.status === "ok"
                    ? styles.storedNote
                    : styles.refusalLine
                }
                role={calculation.run.status === "ok" ? undefined : "alert"}
              >
                {t(
                  calculation.run.status === "ok"
                    ? "calculation.done"
                    : "calculation.failed",
                  {
                    lines: calculation.run.lineCount,
                    failed: calculation.run.failedCount,
                  },
                )}
              </p>
            ) : calculation.refusal.kind === "concurrent_modification" ? (
              <p className={styles.refusalLine} role="alert">
                {t("calculation.concurrentModification")}
              </p>
            ) : (
              <RefusalNote screen="review" refusal={calculation.refusal} />
            ))}
        </>
      )}

      {/* ── The transitions ───────────────────────────────────────────────── */}
      <p className={styles.subsectionTitle}>
        <GitBranch size={14} /> {t("actions.title")}
      </p>
      {permitted.length === 0 ? (
        <Muted>
          {locked ? t("actions.lockedNothing") : t("actions.noneAvailable")}
        </Muted>
      ) : (
        <div className={styles.actionRow}>
          {permitted.map((offer) => (
            <Button
              key={offer.action}
              size="sm"
              variant={
                offer.action === "reject" || offer.action === "abandon"
                  ? "secondary"
                  : "primary"
              }
              loading={busy === offer.action}
              onClick={() => {
                // A comment-bearing action opens its field first; the second
                // press is the one that sends (§5.1's precondition).
                if (offer.needsComment && pending !== offer.action) {
                  setPending(offer.action);
                  return;
                }
                onTransition(offer.action, comment);
                setPending(null);
                setComment("");
              }}
              disabled={
                offer.needsComment && pending === offer.action && !commentReady
              }
            >
              {t(`actions.${offer.action}`)}
            </Button>
          ))}
        </div>
      )}

      {pending !== null && (
        <Input
          id="review-comment"
          label={t("fields.comment")}
          required
          hint={t("actions.commentHint")}
          error={commentReady ? undefined : t("actions.commentRequired")}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      )}

      {/* The revision's `resume` row is a SERVICE action (§5.1): editing a row
          of a rejected revision performs it. Saying so is better than a button
          that would be a 422. */}
      {revision.status === "rejected" && (
        <Muted>{t("actions.resumeHint")}</Muted>
      )}

      <TransitionResult notice={notice} ruleText={ruleText} />

      {/* ── The restatement (§5.1 row 1, LC-9) ────────────────────────────── */}
      {locked && canRestate && (
        <div className={styles.restate}>
          <p className={styles.subsectionTitle}>{t("restate.title")}</p>
          <Muted>{t("restate.body")}</Muted>
          <Input
            id="review-change-reason"
            label={t("fields.change_reason")}
            required
            hint={t("restate.reasonHint")}
            error={reasonReady ? undefined : t("restate.reasonRequired")}
            value={changeReason}
            onChange={(e) => setChangeReason(e.target.value)}
          />
          <div className={styles.actionRow}>
            <Button
              size="sm"
              disabled={!reasonReady}
              loading={restating}
              onClick={() => {
                onRestate(changeReason);
                setChangeReason("");
              }}
            >
              {t("restate.submit")}
            </Button>
            {restating && (
              <span className={styles.saveStatus}>
                <Loader2 size={14} className={styles.spin} />{" "}
                {t("restate.busy")}
              </span>
            )}
          </div>
          <RefusalNote screen="review" refusal={restateRefusal} />
        </div>
      )}

      {/* ── What is in the way (VR-3) ─────────────────────────────────────── */}
      <p className={styles.subsectionTitle}>{t("blocking.title")}</p>
      <BlockingRules
        items={blocking}
        loading={blockingLoading}
        onSelectRow={onSelectRow}
      />

      {/* ── What is NOT in the way, and is still true ─────────────────────────
          A separate list because it answers a separate question: the one above
          is why this revision cannot move, this one is what will still hold
          after it does. VAL-107 lives here — a figure priced by a weaker basis
          than the pinned set offers is not a defect and must not refuse a
          submit, and a reviewer signing the report has to have seen it. Printed
          only when there IS something: a permanent "no advisories" line would
          train the eye to skip the place the advisories appear. */}
      {advisory.length > 0 && (
        <>
          <p className={styles.subsectionTitle}>{t("advisory.title")}</p>
          <p className={styles.mutedNote}>{t("advisory.subtitle")}</p>
          <BlockingRules
            items={advisory}
            loading={blockingLoading}
            onSelectRow={onSelectRow}
          />
        </>
      )}
    </div>
  );
}

/**
 * The sentence a transition attempt ended with — ONE reference per branch of
 * `TransitionNotice`, so the acceptance criteria are decided by a tested
 * function and not by the shape of this JSX.
 *
 * `plan` is `PlanNote` and NEVER the error list: F1 is a price, not a fault.
 */
function TransitionResult({
  notice,
  ruleText,
}: {
  notice: TransitionNotice | null;
  ruleText: (code: string) => string;
}) {
  const t = useTranslations("review");
  if (notice === null) return null;

  switch (notice.kind) {
    case "done":
      return (
        <p className={styles.storedNote}>
          {t("result.done", {
            action: t(`actions.${notice.action}`),
            to: t.has(`revisionStatus.${notice.to}`)
              ? t(`revisionStatus.${notice.to}`)
              : notice.to,
          })}
        </p>
      );
    case "plan":
      return <PlanNote facilities={notice.facilities} limit={notice.limit} />;
    case "rowsPending":
      return (
        <p role="alert" className={styles.refusalLine}>
          {t("result.rowsPending", {
            pending: notice.pending,
            total: notice.total,
          })}
        </p>
      );
    case "needsComment":
      return (
        <p role="alert" className={styles.refusalLine}>
          {t("result.needsComment")}
        </p>
      );
    case "blocked":
      return (
        <div role="alert" className={styles.refusalBlock}>
          <p>{t("result.blocked", { count: notice.failures.length })}</p>
          <ul className={styles.hintList}>
            {notice.rules.map((rule) => (
              <li key={rule.code}>{ruleText(rule.code)}</li>
            ))}
          </ul>
        </div>
      );
    case "notAllowed":
      return (
        <p role="alert" className={styles.refusalLine}>
          {t("result.notAllowed", {
            from: t.has(`revisionStatus.${notice.from}`)
              ? t(`revisionStatus.${notice.from}`)
              : notice.from,
            allowed:
              notice.allowed.length === 0
                ? t("result.nothing")
                : notice.allowed
                    .map((action) =>
                      t.has(`actions.${action}`)
                        ? t(`actions.${action}`)
                        : action,
                    )
                    .join(", "),
          })}
        </p>
      );
    case "notCurrent":
      return (
        <p role="alert" className={styles.refusalLine}>
          {t("result.notCurrent")}
        </p>
      );
    case "raced":
      return (
        <p role="alert" className={styles.refusalLine}>
          {t("result.raced")}
        </p>
      );
    case "calculationMissing":
      return (
        <p role="alert" className={styles.refusalLine}>
          {t("result.calculationMissing")}
        </p>
      );
    case "calculationFailed":
      return (
        <p role="alert" className={styles.refusalLine}>
          {t("result.calculationFailed", { failed: notice.failed })}
        </p>
      );
    default:
      return <RefusalNote screen="review" refusal={notice.refusal} />;
  }
}
