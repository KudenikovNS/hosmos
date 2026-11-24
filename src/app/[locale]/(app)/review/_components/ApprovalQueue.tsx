"use client";

// =============================================================================
// THE APPROVAL QUEUE (UI-3 second half, DM-14, LC-4, §5.4) — the rows of this
// revision that are still waiting for someone to stand behind them.
//
// THE QUEUE IS A NAME THE SERVER OWNS. `GET /api/inventory?queue=1` is a
// COMPOSITION — `state='draft'` over the listing's own invariants (current
// version, not a tombstone, this company) — and the route argues why it is a
// name rather than a shorthand a client could assemble: a screen that spelled
// the three conditions itself could disagree with the counter beside it. So this
// component receives rows and never filters them into existence.
//
// BULK APPROVE IS N REQUESTS AND REPORTS PER ROW. `_lib/bulk` holds the reason
// there is no bulk endpoint (partial refusal is the NORMAL outcome — VAL-036
// blocks exactly the rows whose evidence is missing) and the tally itself; this
// component renders it: how many went through, which ones did not, the rule that
// refused them, and a way to open each. "Some rows failed" would leave the user
// re-approving the successful twelve to find the failing three.
//
// THE BUTTON IS NOT THE GUARD (§0.1). `data.approve` decides whether the
// selection controls render at all; `POST …/[id]/approve` requires the
// capability itself and answers 403 to a direct request regardless. Without it
// the queue is still fully readable — that is the intended shape for a reviewer
// or an auditor, not a degraded one.
// =============================================================================
import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import type { InventoryRowDto } from "../_lib/api";
import { refusedCodes, type BulkReport } from "../_lib/bulk";
import styles from "../page.module.css";
import { LoadErrorNote, Muted } from "../../_components/ScreenKit";
import { StateBadge, useEnumLabel, useRuleText } from "./common";

export function ApprovalQueue({
  rows,
  truncated,
  loading,
  loadError,
  canApprove,
  selected,
  onToggle,
  onToggleAll,
  onApprove,
  busy,
  report,
  selectedRowId,
  onSelectRow,
}: {
  rows: readonly InventoryRowDto[];
  truncated: boolean;
  loading: boolean;
  loadError: boolean;
  /** `data.approve` — UX only; the row route enforces (see the header). */
  canApprove: boolean;
  selected: ReadonlySet<string>;
  onToggle: (rowId: string) => void;
  onToggleAll: (all: boolean) => void;
  onApprove: () => void;
  busy: boolean;
  report: BulkReport | null;
  selectedRowId: string | null;
  onSelectRow: (rowId: string) => void;
}) {
  const t = useTranslations("review");
  const label = useEnumLabel();
  const ruleText = useRuleText();

  if (loading) return <Muted>{t("loadingSection")}</Muted>;

  const allSelected =
    rows.length > 0 && rows.every((row) => selected.has(row.id));

  return (
    <>
      {loadError && <LoadErrorNote />}

      {canApprove && rows.length > 0 && (
        <div className={styles.queueBar}>
          <label className={styles.checkboxRow} htmlFor="review-select-all">
            <input
              id="review-select-all"
              type="checkbox"
              checked={allSelected}
              onChange={(e) => onToggleAll(e.target.checked)}
            />
            {t("queue.selectAll")}
          </label>
          <Button
            size="sm"
            disabled={selected.size === 0}
            loading={busy}
            onClick={onApprove}
          >
            {t("queue.approveSelected", { count: selected.size })}
          </Button>
          {busy && (
            <span className={styles.saveStatus}>
              <Loader2 size={14} className={styles.spin} /> {t("queue.busy")}
            </span>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <Muted>{t("queue.empty")}</Muted>
      ) : (
        <ul className={styles.rowList}>
          {rows.map((row) => (
            <li
              key={row.id}
              className={
                row.id === selectedRowId ? styles.rowItemActive : styles.rowItem
              }
            >
              {canApprove && (
                <input
                  type="checkbox"
                  className={styles.rowCheck}
                  aria-label={row.label ?? t("row.unnamed")}
                  checked={selected.has(row.id)}
                  onChange={() => onToggle(row.id)}
                />
              )}
              <button
                type="button"
                className={styles.rowButton}
                onClick={() => onSelectRow(row.id)}
              >
                <span className={styles.rowName}>
                  {row.label ?? t("row.unnamed")}
                </span>
                <span className={styles.rowMeta}>
                  {label("kind", row.kind)} ·{" "}
                  {row.year_month ?? t("row.wholePeriod")} ·{" "}
                  {label("sourceTable", row.source_table)}
                </span>
                <span className={styles.rowTags}>
                  <StateBadge state={row.state} />
                  {row.quantity !== null && (
                    <Badge variant="gray" size="sm">
                      {row.quantity} {row.unit ?? ""}
                    </Badge>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {truncated && <Muted>{t("queue.truncated")}</Muted>}

      {/* The tally of the last bulk run — both halves, always. */}
      {report && report.attempted > 0 && (
        <div className={styles.bulkReport}>
          <p className={styles.bulkTitle}>
            <CheckCircle2 size={14} className={styles.iconGreen} />{" "}
            {t("queue.bulkResult", {
              approved: report.approved,
              attempted: report.attempted,
            })}
          </p>
          {report.accessChanged && (
            <p role="alert" className={styles.accessBanner}>
              {t("errors.accessChanged")}
            </p>
          )}
          {refusedCodes(report).length > 0 && (
            <ul className={styles.hintList}>
              {refusedCodes(report).map((code) => (
                <li key={code}>{ruleText(code)}</li>
              ))}
            </ul>
          )}
          {report.refusals.length > 0 && (
            <ul className={styles.bulkRefusals}>
              {report.refusals.map((refusal) => (
                <li key={refusal.rowId}>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => onSelectRow(refusal.rowId)}
                  >
                    {refusal.label ?? t("row.unnamed")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
