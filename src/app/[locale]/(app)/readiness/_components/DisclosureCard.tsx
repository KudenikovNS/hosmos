"use client";

// One VSME disclosure (B1…B11 / C1…C9): its readiness bar, its datapoints with
// their status, and — for `data.write`, on an unlocked revision — the decision
// form that marks a datapoint not applicable or omitted as sensitive.
//
// The datapoint list is collapsed by default and expanded in place; the
// decision form is a disclosure-level `<details>` per datapoint, so no modal
// and no portal. Both survive a refetch: `open` state is the browser's.
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { clsx } from "clsx";

import { Link } from "@/i18n/navigation";
import type {
  ReadinessDatapoint,
  ReadinessDisclosure,
} from "@/server/readiness/readiness";
import type { DatapointStatus } from "@/server/readiness/status";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Card } from "@/shared/ui/Card";
import { Input } from "@/shared/ui/Input";
import { ProgressBar } from "@/shared/ui/ProgressBar";

import { useWrite } from "../../inventory/_lib/useInventory";
import styles from "../page.module.css";

const BADGE: Record<
  DatapointStatus,
  "green" | "red" | "yellow" | "blue" | "gray" | "violet"
> = {
  ready: "green",
  needs_data: "red",
  needs_evidence: "yellow",
  needs_confirmation: "blue",
  not_applicable: "gray",
  sensitive_omitted: "violet",
  open_conditional: "gray",
};

function title(
  item: { title_en: string; title_sl: string | null },
  locale: string,
): string {
  return locale === "sl" && item.title_sl ? item.title_sl : item.title_en;
}

export function DisclosureCard({
  disclosure,
  locale,
  revisionId,
  canDecide,
}: {
  disclosure: ReadinessDisclosure;
  locale: string;
  revisionId: string | null;
  canDecide: boolean;
}) {
  const t = useTranslations("readiness");
  const [open, setOpen] = useState(false);
  const gaps =
    disclosure.counts.needs_data +
    disclosure.counts.needs_evidence +
    disclosure.counts.needs_confirmation;

  return (
    <Card className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.cardHeadText}>
          <span className={styles.code}>{disclosure.code}</span>
          <h3 className={styles.cardTitle}>{title(disclosure, locale)}</h3>
        </div>
        <Badge
          variant={
            disclosure.applicable === 0
              ? "gray"
              : disclosure.percent === 100
                ? "green"
                : gaps > 0
                  ? "yellow"
                  : "gray"
          }
          size="sm"
        >
          {disclosure.applicable === 0 ? "—" : `${disclosure.percent}%`}
        </Badge>
      </div>
      <ProgressBar
        value={disclosure.applicable === 0 ? 0 : disclosure.percent}
      />
      <p className={styles.cardMeta}>
        {t("card.readyOf", {
          ready: disclosure.counts.ready,
          applicable: disclosure.applicable,
        })}
        {disclosure.counts.open_conditional > 0 && (
          <>
            {" "}
            · {t("card.open", { count: disclosure.counts.open_conditional })}
          </>
        )}
        {disclosure.counts.not_applicable +
          disclosure.counts.sensitive_omitted >
          0 && (
          <>
            {" · "}
            {t("card.excluded", {
              count:
                disclosure.counts.not_applicable +
                disclosure.counts.sensitive_omitted,
            })}
          </>
        )}
      </p>
      <div className={styles.cardActions}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown
            size={16}
            className={clsx(styles.chevron, open && styles.chevronOpen)}
          />
          {t("card.datapoints", { count: disclosure.datapoints.length })}
        </button>
        <Link href={disclosure.href} className={styles.workLink}>
          {t("card.work")} <ExternalLink size={14} />
        </Link>
      </div>
      {open && (
        <ul className={styles.datapoints}>
          {disclosure.datapoints.map((datapoint) => (
            <DatapointRow
              key={datapoint.metric_key}
              datapoint={datapoint}
              locale={locale}
              revisionId={revisionId}
              canDecide={canDecide}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function DatapointRow({
  datapoint,
  locale,
  revisionId,
  canDecide,
}: {
  datapoint: ReadinessDatapoint;
  locale: string;
  revisionId: string | null;
  canDecide: boolean;
}) {
  const t = useTranslations("readiness");
  const write = useWrite();
  const queryClient = useQueryClient();
  const [deciding, setDeciding] = useState<
    "not_applicable" | "sensitive_omitted" | null
  >(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decided =
    datapoint.status === "not_applicable" ||
    datapoint.status === "sensitive_omitted";
  // Партия 18 — the condition in the UI language; the catalogue original
  // (Russian) only in the Russian UI, never in another one.
  const conditionText = datapoint.applicability_text;
  const appliesWhen = conditionText?.[locale] ?? conditionText?.en ?? null;

  async function submit(status: "not_applicable" | "sensitive_omitted" | null) {
    if (!revisionId) return;
    setBusy(true);
    setError(null);
    const outcome = await write<{ ok: true }>(
      "/api/readiness/applicability",
      "PUT",
      {
        revision_id: revisionId,
        metric_key: datapoint.metric_key,
        status,
        reason: status ? reason : null,
      },
      [["readiness"]],
    );
    setBusy(false);
    if (outcome.ok) {
      setDeciding(null);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["readiness"] });
    } else {
      setError(t("decision.failed"));
    }
  }

  return (
    <li className={styles.datapoint}>
      <div className={styles.datapointMain}>
        <span className={styles.metricKey}>{datapoint.metric_key}</span>
        <span className={styles.datapointTitle}>
          {title(datapoint, locale)}
        </span>
        <Badge variant={BADGE[datapoint.status]} size="sm">
          {t(`datapoint.${datapoint.status}`)}
        </Badge>
      </div>
      <div className={styles.datapointMeta}>
        <span>{t(`requirement.${datapoint.requirement_type}`)}</span>
        <span>· {t(`source.${datapoint.source}`)}</span>
        {datapoint.esrs_reference && (
          <span className={styles.refChip}>
            {t("esrsRef", {
              reference: datapoint.esrs_reference.replace(/^ESRS\s*/i, ""),
            })}
          </span>
        )}
        {datapoint.evidence_count > 0 && (
          <span>
            · {t("datapointEvidence", { count: datapoint.evidence_count })}
          </span>
        )}
        {datapoint.reason && (
          <span className={styles.reason}>· {datapoint.reason}</span>
        )}
      </div>
      {appliesWhen && datapoint.status === "open_conditional" && (
        <p className={styles.appliesWhen}>
          {t("appliesWhen", { condition: appliesWhen })}
        </p>
      )}
      <div className={styles.datapointActions}>
        {!decided && datapoint.status !== "ready" && (
          <Link href={datapoint.href} className={styles.workLink}>
            {t(`action.${datapoint.status}`)}
          </Link>
        )}
        {canDecide && !decided && deciding === null && (
          <>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setDeciding("not_applicable")}
            >
              {t("decision.markNotApplicable")}
            </button>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setDeciding("sensitive_omitted")}
            >
              {t("decision.markSensitive")}
            </button>
          </>
        )}
        {canDecide && decided && (
          <button
            type="button"
            className={styles.linkButton}
            disabled={busy}
            onClick={() => void submit(null)}
          >
            {t("decision.withdraw")}
          </button>
        )}
      </div>
      {deciding && (
        <form
          className={styles.decisionForm}
          onSubmit={(e) => {
            e.preventDefault();
            void submit(deciding);
          }}
        >
          <Input
            label={t(`decision.reasonFor.${deciding}`)}
            id={`reason-${datapoint.metric_key}`}
            hint={t("decision.reasonHint")}
            value={reason}
            required
            onChange={(e) => setReason(e.target.value)}
          />
          {error && (
            <p role="alert" className={styles.formError}>
              {error}
            </p>
          )}
          <div className={styles.formActions}>
            <Button
              type="submit"
              size="sm"
              loading={busy}
              disabled={reason.trim() === ""}
            >
              {t("decision.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDeciding(null);
                setReason("");
                setError(null);
              }}
            >
              {t("decision.cancel")}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
