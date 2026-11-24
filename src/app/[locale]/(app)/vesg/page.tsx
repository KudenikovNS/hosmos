"use client";

// =============================================================================
// `/vesg` — readiness for the VESG voucher (stage-1 plan item 8.4).
//
// The 16 requirements of the expert's checklist (06.09.2026), each with what
// HOSMOS can see about it. Everything is `GET /api/vesg`; the judgement is
// `server/vesg/evaluate.ts`, and this screen renders its answer. ONE WRITE: a
// person confirms a MANUAL requirement (budget, expert contract, AJPES
// publication, ePortal application) with a note — `data.write` only.
//
// NOT A PROMISE. The screen says, as the public page does, that the voucher
// is the fund's to grant and the review a licensed audit firm's to give.
// =============================================================================
import { CheckCircle2, ExternalLink, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { clsx } from "clsx";

import { Link } from "@/i18n/navigation";
import type { VesgItem } from "@/server/vesg/evaluate";
import type { VesgDto } from "@/server/vesg/vesg";
import { useCapabilities } from "@/shared/hooks/useCapabilities";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Card } from "@/shared/ui/Card";
import { NoReportingPeriodBanner } from "@/shared/ui/NoReportingPeriodBanner";
import { Input } from "@/shared/ui/Input";
import { ProgressBar } from "@/shared/ui/ProgressBar";

import { PageLayout } from "../_components/PageLayout";
import { useList, useWrite } from "../inventory/_lib/useInventory";
import styles from "./page.module.css";

const VESG_KEY = ["vesg"] as const;

const BADGE = {
  met: "green",
  attention: "yellow",
  pending: "gray",
  confirmed: "green",
  info: "blue",
} as const;

export default function VesgPage() {
  const t = useTranslations("vesg");
  const caps = useCapabilities();
  const list = useList<VesgDto>(VESG_KEY, "/api/vesg");
  const data = list.data;
  const readable = !list.accessChanged && !list.loadError;
  const canConfirm = caps.has("data.write") && !!data?.can_confirm;
  const done = data ? data.summary.auto_met + data.summary.manual_confirmed : 0;
  const total = data ? data.summary.auto_total + data.summary.manual_total : 0;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <PageLayout
      title={t("title")}
      subtitle={t("subtitle")}
      loading={list.loading}
    >
      {list.accessChanged && (
        <p role="alert" className={styles.banner}>
          {t("errors.accessChanged")}
        </p>
      )}
      {list.loadError && (
        <p role="alert" className={styles.bannerError}>
          {t("errors.loadFailed")}
        </p>
      )}

      {readable && data && data.period === null && <NoReportingPeriodBanner />}

      {readable && data && data.period && (
        <>
          <section className={styles.summary} aria-labelledby="vesg-summary">
            <h2 id="vesg-summary" className={styles.summaryTitle}>
              {t("summary.title", { period: data.period.name })}
            </h2>
            <div className={styles.summaryFigure}>
              <span className={styles.percent}>{percent}%</span>
              <span className={styles.percentLabel}>
                {t("summary.figure", {
                  autoMet: data.summary.auto_met,
                  autoTotal: data.summary.auto_total,
                  manualConfirmed: data.summary.manual_confirmed,
                  manualTotal: data.summary.manual_total,
                })}
              </span>
            </div>
            <ProgressBar value={percent} />
            <p className={styles.note}>
              {t("summary.closes", { date: data.call_closes })}{" "}
              {t("summary.disclaimer")}
            </p>
          </section>

          <ul className={styles.list}>
            {data.items.map((item) => (
              <RequirementCard
                key={item.id}
                item={item}
                canConfirm={canConfirm}
              />
            ))}
          </ul>
        </>
      )}
    </PageLayout>
  );
}

function RequirementCard({
  item,
  canConfirm,
}: {
  item: VesgItem;
  canConfirm: boolean;
}) {
  const t = useTranslations("vesg");
  const write = useWrite();
  const [note, setNote] = useState(item.decision?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(confirmed: boolean) {
    setBusy(true);
    setError(null);
    const outcome = await write<{ ok: true }>(
      "/api/vesg/decision",
      "PUT",
      { requirement: item.id, confirmed, note: note.trim() || null },
      [["vesg"]],
    );
    setBusy(false);
    if (!outcome.ok) setError(t("decision.failed"));
  }

  return (
    <li>
      <Card className={clsx(styles.card, styles[`card_${item.status}`])}>
        <div className={styles.cardHead}>
          <div className={styles.cardHeadText}>
            <span className={styles.block}>{t(`blocks.${item.block}`)}</span>
            <h3 className={styles.cardTitle}>{t(`items.${item.id}.title`)}</h3>
          </div>
          <Badge variant={BADGE[item.status]} size="sm">
            {t(`status.${item.status}`)}
          </Badge>
        </div>
        <p className={styles.result}>
          {t(`items.${item.id}.result.${item.status}`, item.params)}
        </p>
        <dl className={styles.facts}>
          <div>
            <dt>{t("labels.hosmos")}</dt>
            <dd>{t(`items.${item.id}.hosmos`, item.params)}</dd>
          </div>
          <div>
            <dt>{t("labels.evidence")}</dt>
            <dd>{t(`items.${item.id}.evidence`, item.params)}</dd>
          </div>
        </dl>
        {item.kind === "manual" ? (
          <div className={styles.manual}>
            {item.decision?.confirmed ? (
              <p className={styles.confirmed}>
                <CheckCircle2 size={16} />
                {t("decision.confirmedOn", {
                  date: item.decision.decided_at?.slice(0, 10) ?? "",
                })}
                {item.decision.note && <> · {item.decision.note}</>}
              </p>
            ) : (
              !canConfirm && (
                <p className={styles.locked}>
                  <Lock size={14} /> {t("decision.readOnly")}
                </p>
              )
            )}
            {canConfirm && (
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit(true);
                }}
              >
                <Input
                  label={t(`items.${item.id}.noteLabel`)}
                  id={`vesg-note-${item.id}`}
                  hint={t("decision.noteHint")}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                {error && (
                  <p role="alert" className={styles.formError}>
                    {error}
                  </p>
                )}
                <div className={styles.formActions}>
                  {item.decision?.confirmed ? (
                    <>
                      <Button type="submit" size="sm" loading={busy}>
                        {t("decision.updateNote")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void submit(false)}
                      >
                        {t("decision.withdraw")}
                      </Button>
                    </>
                  ) : (
                    <Button type="submit" size="sm" loading={busy}>
                      {t("decision.confirm")}
                    </Button>
                  )}
                </div>
              </form>
            )}
          </div>
        ) : (
          item.status === "attention" && (
            <Link href={item.href} className={styles.workLink}>
              {t("workOn")} <ExternalLink size={14} />
            </Link>
          )
        )}
      </Card>
    </li>
  );
}
