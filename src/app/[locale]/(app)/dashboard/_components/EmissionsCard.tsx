"use client";

// =============================================================================
// THE KPI BLOCK OF `/dashboard` (T5.9 — UI-6) — the aggregates of the latest
// Approved/Locked calculation run, and nothing else.
//
// FIVE STATES, AND NOT ONE OF THEM RENDERS A ZERO. That is the acceptance
// criterion of this task and the reason the states are enumerated instead of
// being collapsed into "figures or nothing":
//
//   • NO APPROVED REVISION (`emissions === null`) — the company has not finished
//     a report yet. It gets the words for that and a route into `/inventory`.
//     `0 t CO₂e` here would be the most visible possible version of the lie the
//     whole calculation layer refuses to tell: a company that has entered no
//     data has not emitted nothing.
//   • NO RUN — approved, never calculated. There is no figure, and saying so is
//     not the same claim as "zero".
//   • FAILED — at least one line could not be priced, so `calc/aggregate.ts`
//     published NO total at all (§0.7, AC-6). The block reports the failure and
//     the number of lines to fix. The sum of the lines that worked is never
//     shown: it has the right magnitude, it reconciles with itself, and it is
//     silently too small.
//   • STALE — the run is complete and its figures are real, but an input moved
//     after it (CALC-6). They are SHOWN, because they are what somebody
//     approved, with a notice naming which of the three sources moved.
//   • OK — the figures, plainly.
//
// EVERY NUMBER IS THE SERVER'S, and specifically it is `GET
// /api/revisions/[id]/results`' own aggregate: `/api/dashboard` passes those
// objects through unchanged, `_lib/kpi.ts` changes kilograms into tonnes with
// the same shift the PDF renderer uses, and that is the only arithmetic on this
// side of the wire. There is one implementation of the sum in this product.
//
// NOTHING ON THIS CARD ACTS. No button, no form, no field, no write — "no direct
// edits" (UI-6). The only interactive element is a `Link`, and
// `__tests__/no-direct-edits.test.ts` asserts that for the whole screen rather
// than trusting this paragraph.
// =============================================================================
import { AlertTriangle, Clock, Sigma } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import type { DashboardEmissions } from "@/server/dashboard/dashboard";
import { Badge } from "@/shared/ui/Badge";
import { EmptyStateBanner } from "@/shared/ui/EmptyStateBanner";

import {
  coverageFractions,
  kpiFigures,
  showsFigures,
  type KpiFigure,
} from "../_lib/kpi";
import styles from "../page.module.css";
import { HubCard } from "./HubCard";
import { NoApprovedCalculationBanner } from "./NoApprovedCalculationBanner";

/** Where every "there is nothing to show yet" route on this card points. */
const DATA_ENTRY_HREF = "/inventory";

/**
 * A `numeric` column's value as `Intl.NumberFormat.format` will actually take it.
 *
 * `format` accepts a decimal STRING at runtime and reads it as a decimal rather
 * than a double — which is exactly why every figure travels as a string from the
 * `numeric` column to this line. Its published type admits only the
 * template-literal `StringNumericLiteral`, which a value read out of Postgres is
 * not statically one of, so the narrowing happens HERE, once, with the reason
 * attached. `server/render/i18n.ts` does the same thing for the same reason.
 */
type NumericLiteral = Parameters<Intl.NumberFormat["format"]>[0];

/** One KPI tile. A withheld figure prints WORDS, never a digit. */
function KpiTile({ figure }: { figure: KpiFigure }) {
  const t = useTranslations("dashboard");
  const locale = useLocale();
  return (
    <div className={styles.kpi}>
      <p className={styles.kpiLabel}>{t(`emissions.kpi.${figure.key}`)}</p>
      {figure.value === null ? (
        <p className={styles.kpiAbsent}>{t("emissions.noFigure")}</p>
      ) : (
        <p className={styles.kpiValue}>
          {new Intl.NumberFormat(locale, {
            minimumFractionDigits: 0,
            maximumFractionDigits: figure.decimals,
          }).format(figure.value as NumericLiteral)}{" "}
          <span className={styles.kpiUnit}>
            {t(`emissions.units.${figure.unit}`)}
          </span>
        </p>
      )}
    </div>
  );
}

/** The boundary the figures describe — counts, so a `0` here is a real zero. */
function CoverageTile({ emissions }: { emissions: DashboardEmissions }) {
  const t = useTranslations("dashboard");
  return (
    <div className={styles.kpi}>
      <p className={styles.kpiLabel}>{t("emissions.kpi.coverage")}</p>
      {coverageFractions(emissions).map((fraction) => (
        <p key={fraction.key} className={styles.kpiFraction}>
          {t(`emissions.coverage.${fraction.key}`, {
            included: fraction.included,
            total: fraction.total,
          })}
        </p>
      ))}
    </div>
  );
}

export function EmissionsCard({
  emissions,
}: {
  emissions: DashboardEmissions | null;
}) {
  const t = useTranslations("dashboard");
  const locale = useLocale();

  // ── The company has approved nothing. NOT zeros — a route to the next step.
  if (!emissions) {
    return (
      <HubCard
        icon={<Sigma size={20} className={styles.iconGray} />}
        title={t("emissions.title")}
      >
        <NoApprovedCalculationBanner />
      </HubCard>
    );
  }

  const calculatedAt =
    emissions.run === null
      ? null
      : new Intl.DateTimeFormat(locale, {
          dateStyle: "long",
          timeStyle: "short",
          timeZone: "UTC",
        }).format(new Date(emissions.run.calculated_at));

  return (
    <HubCard
      icon={<Sigma size={20} className={styles.iconBlue} />}
      title={t("emissions.title")}
      subtitle={t("emissions.subtitle")}
      badge={
        <Badge
          variant={emissions.status === "locked" ? "gray" : "green"}
          size="sm"
        >
          {t(`emissions.revisionStatus.${emissions.status}`)}
        </Badge>
      }
    >
      {/* WHICH REPORT THESE FIGURES ARE. It is not necessarily the period of the
          card above: the hub tracks the revision being written, this one tracks
          the last that was approved. Naming it is what keeps the two readable
          on one screen. */}
      <p className={styles.factTitle}>{emissions.period_name}</p>
      <p className={styles.factMeta}>
        {emissions.period_start} — {emissions.period_end} ·{" "}
        {t("emissions.revision", { no: emissions.revision_no })}
      </p>
      {calculatedAt && (
        <p className={styles.factMeta}>
          {t("emissions.calculatedAt", { at: calculatedAt })}
        </p>
      )}

      {emissions.state === "no_run" && (
        <p className={styles.mutedNote}>{t("emissions.noRun")}</p>
      )}

      {emissions.state === "failed" && (
        <p role="alert" className={styles.noteRed}>
          <AlertTriangle size={16} />
          <span>
            {t("emissions.failed", {
              count: emissions.run?.failed_count ?? 0,
            })}
          </span>
        </p>
      )}

      {emissions.state === "stale" && (
        <p className={styles.noteAmber}>
          <Clock size={16} />
          <span>
            {emissions.stale_sources.includes("context")
              ? t("emissions.historicalContextMissing")
              : emissions.stale_sources.includes("formula")
                ? t("emissions.outputUnitCorrectionRequired")
                : t("emissions.stale", {
                    sources: emissions.stale_sources
                      .map((source) =>
                        t.has(`emissions.staleSource.${source}`)
                          ? t(`emissions.staleSource.${source}`)
                          : source,
                      )
                      .join(", "),
                  })}
          </span>
        </p>
      )}

      {showsFigures(emissions) ? (
        <div className={styles.kpiGrid}>
          {kpiFigures(emissions).map((figure) => (
            <KpiTile key={figure.key} figure={figure} />
          ))}
          <CoverageTile emissions={emissions} />
        </div>
      ) : (
        <EmptyStateBanner
          href={DATA_ENTRY_HREF}
          icon={Sigma}
          title={t("emissions.noTotals")}
          description={t("emissions.noTotalsBody")}
        />
      )}
    </HubCard>
  );
}
