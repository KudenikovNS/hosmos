"use client";

// =============================================================================
// `/readiness` — VSME readiness, the hub (stage 1, 13.08.2026 §5.2, §7).
//
// THE THREE QUESTIONS THE PILOT SELLS, on one screen: which VSME data the
// company already has, whether the energy and emissions figures can be
// defended, and what still has to be collected for a complete Basic Module.
// Everything is `GET /api/readiness`; nothing here computes a status — the
// judgement is `server/readiness/status.ts`, and the screen is a rendering of
// its answer, disclosure by disclosure, B1…B11 (C1…C9 on a Comprehensive plan).
//
// ONE WRITE. A datapoint can be declared not applicable or omitted as
// sensitive, with a reason (0016); that is the only thing this screen changes,
// and only for `data.write`. Every other action links to the screen that owns
// the datapoint. Loading without an effect, as on `/dashboard`.
//
// THE SECOND BLOCK (партия 9). Under the VSME disclosures sits the simplified
// ESRS: on a plan with the layer (0021) the 50 additional datapoints, judged
// and decided exactly like the VSME ones; on a plan without it, what the layer
// contains and an upgrade link — visible, so the upgrade has a face (PG-5).
// The VSME percentage never includes ESRS datapoints: the pilot sells VSME
// readiness, and the ESRS layer is a second figure, not a dilution of the
// first.
// =============================================================================
import { ListChecks, Lock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import type { ReadinessDto } from "@/server/readiness/readiness";
import { PLAN_FEATURES } from "@/shared/plans";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { NoLegalEntityBanner } from "@/shared/ui/NoLegalEntityBanner";
import { NoReportingPeriodBanner } from "@/shared/ui/NoReportingPeriodBanner";
import { ProgressBar } from "@/shared/ui/ProgressBar";
import { useCapabilities } from "@/shared/hooks/useCapabilities";

import { PageLayout } from "../_components/PageLayout";
import { useList } from "../inventory/_lib/useInventory";
import { DisclosureCard } from "./_components/DisclosureCard";
import { JourneyBar } from "./_components/JourneyBar";
import styles from "./page.module.css";

export const READINESS_KEY = ["readiness"] as const;

const STATUS_VARIANT = {
  draft: "gray",
  submitted: "blue",
  in_review: "blue",
  approved: "green",
  rejected: "red",
  locked: "violet",
} as const;

export default function ReadinessPage() {
  const t = useTranslations("readiness");
  const locale = useLocale();
  const caps = useCapabilities();
  const hub = useList<ReadinessDto>(READINESS_KEY, "/api/readiness");
  const data = hub.data;
  const readable = !hub.accessChanged && !hub.loadError;
  const canDecide = caps.has("data.write") && !!data?.can_decide;

  return (
    <PageLayout
      title={t("title")}
      subtitle={t("subtitle")}
      loading={hub.loading}
    >
      {hub.accessChanged && (
        <p role="alert" className={styles.banner}>
          {t("errors.accessChanged")}
        </p>
      )}
      {hub.loadError && (
        <p role="alert" className={styles.bannerError}>
          {t("errors.loadFailed")}
        </p>
      )}

      {readable && data && !data.has_legal_entity && <NoLegalEntityBanner />}

      {readable && data?.has_legal_entity && data.period === null && (
        <NoReportingPeriodBanner />
      )}

      {readable && data?.has_legal_entity && data.period && (
        <>
          <section
            className={styles.summary}
            aria-labelledby="readiness-summary"
          >
            <div className={styles.summaryHead}>
              <div>
                <h2 id="readiness-summary" className={styles.summaryTitle}>
                  {t("summary.title", { period: data.period.name })}
                </h2>
                <p className={styles.summaryMeta}>
                  {t(`summary.module.${data.plan.module}`)}
                  {data.plan.simplified_esrs && ` ${t("summary.esrsModule")}`}
                  {" · "}
                  {t(`summary.basis.${data.period.reporting_basis}`)}
                  {data.revision && (
                    <>
                      {" · "}
                      {t("summary.revision", { no: data.revision.revision_no })}
                    </>
                  )}
                </p>
              </div>
              {data.revision && (
                <Badge variant={STATUS_VARIANT[data.revision.status]} size="sm">
                  {t(`status.${data.revision.status}`)}
                </Badge>
              )}
            </div>
            <div className={styles.summaryFigure}>
              <span className={styles.percent}>{data.summary.percent}%</span>
              <span className={styles.percentLabel}>
                {t("summary.readyOf", {
                  ready: data.summary.ready,
                  applicable: data.summary.applicable,
                })}
              </span>
            </div>
            <ProgressBar value={data.summary.percent} />
            <ul className={styles.legend}>
              {(
                [
                  "needs_data",
                  "needs_evidence",
                  "needs_confirmation",
                  "open_conditional",
                  "not_applicable",
                  "sensitive_omitted",
                ] as const
              ).map((status) => (
                <li key={status} className={styles.legendItem}>
                  <span
                    className={`${styles.dot} ${styles[`dot_${status}`]}`}
                  />
                  {t(`datapoint.${status}`)}:{" "}
                  <strong>{data.summary[status]}</strong>
                </li>
              ))}
            </ul>
            {!data.revision && (
              <p className={styles.note}>
                {t("summary.noRevision")}{" "}
                <Link href="/organisation">{t("summary.noRevisionLink")}</Link>
              </p>
            )}
          </section>

          <JourneyBar steps={data.journey} next={data.next} />

          <h2 className={styles.sectionTitle}>
            <ListChecks size={18} className={styles.sectionIcon} />
            {t("disclosures.title")}
          </h2>
          <div className={styles.grid}>
            {data.disclosures.map((disclosure) => (
              <DisclosureCard
                key={disclosure.code}
                disclosure={disclosure}
                locale={locale}
                revisionId={data.revision?.id ?? null}
                canDecide={canDecide}
              />
            ))}
          </div>

          <section className={styles.esrs} aria-labelledby="readiness-esrs">
            <h2 id="readiness-esrs" className={styles.sectionTitle}>
              <ListChecks size={18} className={styles.sectionIcon} />
              {t("esrs.title")}
            </h2>
            {data.esrs.available ? (
              <>
                <div className={styles.esrsSummary}>
                  <div className={styles.summaryFigure}>
                    <span className={styles.percent}>
                      {data.esrs.summary.percent}%
                    </span>
                    <span className={styles.percentLabel}>
                      {t("esrs.readyOf", {
                        ready: data.esrs.summary.ready,
                        applicable: data.esrs.summary.applicable,
                      })}
                    </span>
                  </div>
                  <ProgressBar value={data.esrs.summary.percent} />
                  <p className={styles.note}>
                    {t("esrs.intro", {
                      additional: data.esrs.coverage.additional,
                      mapped: data.esrs.coverage.vsme_mapped,
                      mappedReady: data.esrs.coverage.vsme_mapped_ready,
                    })}{" "}
                    {t("esrs.note")}
                  </p>
                  {data.esrs.regulatory_status && (
                    <p className={styles.esrsRegulatory}>
                      {t("esrs.regulatory", {
                        status: data.esrs.regulatory_status,
                      })}
                    </p>
                  )}
                </div>
                <div className={styles.grid}>
                  {data.esrs.disclosures.map((disclosure) => (
                    <DisclosureCard
                      key={disclosure.code}
                      disclosure={disclosure}
                      locale={locale}
                      revisionId={data.revision?.id ?? null}
                      canDecide={canDecide}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className={styles.esrsLock}>
                <Lock size={18} className={styles.esrsLockIcon} />
                <div className={styles.esrsLockMain}>
                  <p className={styles.esrsLockTitle}>
                    {t("esrs.lockedTitle")}
                  </p>
                  <p className={styles.esrsLockBody}>
                    {t("esrs.lockedBody", {
                      additional: data.esrs.coverage.additional,
                      mapped: data.esrs.coverage.vsme_mapped,
                      plan: PLAN_FEATURES[data.esrs.required_plan].name,
                    })}
                  </p>
                </div>
                <Link href="/settings" className={styles.esrsLockCta}>
                  <Button size="sm">{t("esrs.lockedCta")}</Button>
                </Link>
              </div>
            )}
          </section>
        </>
      )}
    </PageLayout>
  );
}
