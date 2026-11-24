"use client";

// =============================================================================
// `/dashboard` — THE HUB (T3.7 + T5.9, О-6, UI-6).
//
// WHAT THIS SCREEN IS FOR, in one sentence: where does my report stand, what did
// the last one say, and where do I go next. Facts and links; NOTHING ON IT ACTS
// AND NOTHING ON IT COMPUTES — "no direct edits" (UI-6) is not a convention here
// but a checked property, see `__tests__/no-direct-edits.test.ts`.
//
// EVERY NUMBER IS THE SERVER'S. `period_status` is LC-2 as `/api/periods`
// derives it (К-4 — there is no `period_status` column and no client-side
// mapping of one here), the counters are the SAME query `/api/inventory` lists
// with (`countInventory`), and the validation summary is the stored
// `validation_result` rows, reported and never re-run. That is why the number
// beside "awaiting approval" here and the `?queue` badge on `/inventory` cannot
// disagree: they are one predicate, written once, on the server.
//
// THE TOTALS ARE THE LAST APPROVED RUN'S, AND THEY ARE NOT THIS PERIOD'S (T5.9).
// The cards above report the revision being WORKED ON; `EmissionsCard` reports
// the last revision anybody APPROVED, which is a different report as soon as a
// company opens next year. Both name their own period. The figures themselves
// are `GET /api/revisions/[id]/results`' own aggregate, passed through
// `/api/dashboard` unchanged — there is one implementation of the sum in this
// product and neither this file nor the card re-does any of it.
//
// LOADING WITHOUT AN EFFECT, as on `/organisation` and `/inventory`: one GET
// through the shared `useList`, and everything rendered is an expression over
// what is loaded right now. A 401/403 is `accessChanged` — a benign banner
// (R-11) — never a crash and never a red technical error.
// =============================================================================
import {
  ArrowRight,
  Boxes,
  Building2,
  CalendarRange,
  ShieldCheck,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import type { DashboardDto } from "@/server/dashboard/dashboard";
import type { PeriodStatus } from "@/shared/enums";
import { Badge } from "@/shared/ui/Badge";
import { NoReportingPeriodBanner } from "@/shared/ui/NoReportingPeriodBanner";
import { NoLegalEntityBanner } from "@/shared/ui/NoLegalEntityBanner";
import { useCompany } from "@/shared/hooks/useSession";

import { PageLayout } from "../_components/PageLayout";
import { useList } from "../inventory/_lib/useInventory";
import { useLegalEntities } from "../organisation/_lib/useOrganisation";
import { EmissionsCard } from "./_components/EmissionsCard";
import { HubCard } from "./_components/HubCard";
import { NoApprovedCalculationBanner } from "./_components/NoApprovedCalculationBanner";
import styles from "./page.module.css";

/** react-query key of the one read this screen makes. */
const DASHBOARD_KEY = ["dashboard"] as const;

/**
 * LC-2's six statuses carry spaces and capitals on the wire ("In review"),
 * which are not message-key material — mapped once, here, exactly as
 * `organisation/_components/PeriodsSection` does for the same wire values.
 */
const STATUS_KEY: Record<PeriodStatus, string> = {
  Draft: "draft",
  Submitted: "submitted",
  "In review": "inReview",
  Approved: "approved",
  Locked: "locked",
  Reopened: "reopened",
};

/** The same reading as on `/organisation`: open → blue, closed → gray/green. */
function statusVariant(status: PeriodStatus) {
  if (status === "Locked") return "gray" as const;
  if (status === "Approved") return "green" as const;
  if (status === "Draft" || status === "Reopened") return "blue" as const;
  return "yellow" as const;
}

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const { company } = useCompany();
  const isTrial = company?.plan === "trial";
  // One VAL-* code as a sentence, through the `validation.*` keys T2.1 seeded
  // for all 41 rules (О-12). A code with no copy renders as the code rather
  // than throwing — the canonical Russian stays in `validation_result.message`.
  const tRule = useTranslations("validation");

  const hub = useList<DashboardDto>(DASHBOARD_KEY, "/api/dashboard");
  const entities = useLegalEntities();
  const data = hub.data;
  const period = data?.period ?? null;
  const revision = data?.revision ?? null;
  const rows = data?.rows ?? null;
  const validation = data?.validation ?? null;
  const readable =
    !hub.accessChanged &&
    !hub.loadError &&
    !entities.accessChanged &&
    !entities.loadError;
  const hasLegalEntity = entities.entities.length > 0;

  return (
    <PageLayout
      title={t("title")}
      subtitle={t("subtitle")}
      loading={hub.loading || entities.loading}
    >
      {(hub.accessChanged || entities.accessChanged) && (
        <p role="alert" className={styles.accessBanner}>
          {t("errors.accessChanged")}
        </p>
      )}
      {(hub.loadError || entities.loadError) && (
        <p role="alert" className={styles.rowError}>
          {t("errors.loadFailed")}
        </p>
      )}

      {readable && !entities.loading && !hasLegalEntity && (
        <NoLegalEntityBanner />
      )}
      {readable &&
        hasLegalEntity &&
        data &&
        (period === null || (isTrial && !data.emissions)) && (
          <div className={styles.notices}>
            {period === null && <NoReportingPeriodBanner />}
            {isTrial && !data.emissions && <NoApprovedCalculationBanner />}
          </div>
        )}

      {period && (
        <HubCard
          icon={<CalendarRange size={20} className={styles.iconBlue} />}
          title={t("period.title")}
          subtitle={t("period.subtitle")}
          badge={
            <Badge variant={statusVariant(period.period_status)} size="sm">
              {t(`periodStatus.${STATUS_KEY[period.period_status]}`)}
            </Badge>
          }
        >
          <p className={styles.factTitle}>{period.period_name}</p>
          <p className={styles.factMeta}>
            {period.start_date} — {period.end_date} ·{" "}
            {t("period.factorSet", { version: period.factor_set_version })}
          </p>
          <p className={styles.factMeta}>
            {revision
              ? t("period.revision", { no: revision.revision_no })
              : t("period.noRevision")}
          </p>
        </HubCard>
      )}

      {period && rows && (
        <HubCard
          icon={<Boxes size={20} className={styles.iconGreen} />}
          title={t("rows.title")}
          subtitle={t("rows.subtitle")}
          badge={
            <Badge variant="gray" size="sm">
              {t("rows.count", { count: rows.total })}
            </Badge>
          }
        >
          {rows.total === 0 ? (
            <p className={styles.mutedNote}>{t("rows.empty")}</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{t("rows.scope")}</th>
                    <th className={styles.num}>{t("rows.total")}</th>
                    <th className={styles.num}>{t("rows.approved")}</th>
                    <th className={styles.num}>{t("rows.draft")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.by_scope.map((entry) => (
                    <tr key={entry.scope}>
                      <td>{t(`rows.scopes.${entry.scope}`)}</td>
                      <td className={styles.num}>{entry.total}</td>
                      <td className={styles.num}>{entry.approved}</td>
                      <td className={styles.num}>{entry.draft}</td>
                    </tr>
                  ))}
                  <tr className={styles.totalRow}>
                    <td>{t("rows.all")}</td>
                    <td className={styles.num}>{rows.total}</td>
                    <td className={styles.num}>{rows.approved}</td>
                    <td className={styles.num}>{rows.draft}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </HubCard>
      )}

      {period && validation && (
        <HubCard
          icon={<ShieldCheck size={20} className={styles.iconBlue} />}
          title={t("validation.title")}
          subtitle={t("validation.subtitle")}
          badge={
            <Badge
              variant={validation.blocking > 0 ? "red" : "green"}
              size="sm"
            >
              {t("validation.blocking", { count: validation.blocking })}
            </Badge>
          }
        >
          {validation.results === 0 ? (
            <p className={styles.mutedNote}>{t("validation.notRun")}</p>
          ) : (
            <>
              <p className={styles.factMeta}>
                {t("validation.warnings", { count: validation.warnings })}
              </p>
              {validation.blocking === 0 ? (
                <p className={styles.mutedNote}>{t("validation.clean")}</p>
              ) : (
                <ul className={styles.ruleList}>
                  {validation.blocking_codes.map((code) => (
                    <li key={code}>{tRule.has(code) ? tRule(code) : code}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </HubCard>
      )}

      {/* Trial keeps its next steps above; paid plans show the approved totals
          and the quick navigation cards. */}
      {readable && data && !isTrial && (
        <EmissionsCard emissions={data.emissions} />
      )}

      {!isTrial && (
        <div className={styles.linkGrid}>
          <Link href="/organisation" className={styles.linkCard}>
            <Building2 size={18} className={styles.iconBlue} />
            <span className={styles.linkMain}>
              <span className={styles.linkTitle}>
                {t("links.organisation")}
              </span>
              <span className={styles.linkBody}>
                {t("links.organisationBody")}
              </span>
            </span>
            <ArrowRight size={16} className={styles.linkArrow} />
          </Link>
          <Link href="/inventory" className={styles.linkCard}>
            <Boxes size={18} className={styles.iconGreen} />
            <span className={styles.linkMain}>
              <span className={styles.linkTitle}>{t("links.inventory")}</span>
              <span className={styles.linkBody}>
                {t("links.inventoryBody")}
              </span>
            </span>
            <ArrowRight size={16} className={styles.linkArrow} />
          </Link>
        </div>
      )}
    </PageLayout>
  );
}
