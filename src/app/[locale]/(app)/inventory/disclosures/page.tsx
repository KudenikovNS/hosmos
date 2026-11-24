"use client";

// `/inventory/disclosures` — B1…B11 (and C1…C9) AS ONE GENERIC FORM
// (T3.5b — UI-2, DM-18, DM-19, S1, К-26, PG-6, О-5).
//
// See docs/decisions/app-inventory-disclosures-page-L3.md for the full account.
import { BookText, Building2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import type { WorkflowStatus } from "@/shared/enums";
import { useCapabilities } from "@/shared/hooks/useCapabilities";
import { usePlan } from "@/shared/hooks/usePlan";
import { Badge } from "@/shared/ui/Badge";
import { NoReportingPeriodBanner } from "@/shared/ui/NoReportingPeriodBanner";
import { NoLegalEntityBanner } from "@/shared/ui/NoLegalEntityBanner";
import { NoReportRevisionBanner } from "@/shared/ui/NoReportRevisionBanner";
import { Select } from "@/shared/ui/Select";

import { PageLayout } from "../../_components/PageLayout";
import {
  useFacilities,
  useLegalEntities,
} from "../../organisation/_lib/useOrganisation";
import {
  AccessNote,
  LoadErrorNote,
  Muted,
  SectionCard,
} from "../../_components/ScreenKit";
import { rowActionGates } from "../_lib/actions";
import { type ListState, usePeriods, useRevisions } from "../_lib/useInventory";
import { DisclosureSectionTabs } from "./_components/DisclosureSectionTabs";
import { MetricCard } from "./_components/MetricCard";
import { RestateBox } from "./_components/RestateBox";
import {
  comprehensiveWritable,
  recordsByMetric,
  sectionsOf,
  simplifiedEsrsWritable,
  visibleMetrics,
} from "./_lib/catalog";
import {
  useDisclosureRecords,
  useDisclosureWrites,
  useMetrics,
} from "./_lib/useDisclosures";
import { suggestionFor, type SuggestContext } from "./_lib/suggest";
import styles from "./page.module.css";

function DisclosuresStartState({
  loading,
  accessChanged,
  loadError,
  missingLegalEntity = false,
}: Pick<ListState<unknown>, "loading" | "accessChanged" | "loadError"> & {
  missingLegalEntity?: boolean;
}) {
  const t = useTranslations("disclosures");
  return (
    <PageLayout title={t("title")} subtitle={t("subtitle")} loading={loading}>
      {accessChanged ? (
        <AccessNote />
      ) : loadError ? (
        <LoadErrorNote />
      ) : missingLegalEntity ? (
        <NoLegalEntityBanner />
      ) : (
        <NoReportingPeriodBanner />
      )}
    </PageLayout>
  );
}

function DisclosureHelp({ open }: { open: boolean }) {
  const t = useTranslations("disclosures");
  return (
    <details className={styles.howTo} open={open}>
      <summary className={styles.howToTitle}>{t("howTo.title")}</summary>
      <ol className={styles.howToSteps}>
        <li>{t("howTo.step1")}</li>
        <li>{t("howTo.step2")}</li>
        <li>{t("howTo.step3")}</li>
        <li>{t("howTo.step4")}</li>
      </ol>
    </details>
  );
}

export default function DisclosuresPage() {
  const t = useTranslations("disclosures");
  const caps = useCapabilities();
  const capabilities = caps.capabilities;
  const plan = usePlan();
  // PG-6 on the client, resolved the way `getEntitlements` resolves it: the
  // WRITE features, never the plan name. The server is still the authority.
  const comprehensive = comprehensiveWritable({
    features: plan.features,
    mode: plan.mode,
  });
  // The second module (0021), resolved the same way.
  const simplifiedEsrs = simplifiedEsrsWritable({
    features: plan.features,
    mode: plan.mode,
  });

  const entities = useLegalEntities();
  const facilities = useFacilities();
  const periods = usePeriods();

  const [pickedPeriodId, setPickedPeriodId] = useState<string | null>(null);
  // No effect: the pick is an expression over what is loaded right now.
  const period =
    periods.periods.find((entry) => entry.id === pickedPeriodId) ??
    periods.periods[0] ??
    null;
  const periodId = period?.id ?? null;

  const [pickedEntityId, setPickedEntityId] = useState<string | null>(null);
  const entityId =
    pickedEntityId && entities.entities.some((e) => e.id === pickedEntityId)
      ? pickedEntityId
      : (entities.entities[0]?.id ?? null);

  const revisions = useRevisions(periodId);
  const revisionId = revisions.currentRevisionId;
  const revision = revisions.revisions.find((r) => r.id === revisionId) ?? null;
  const revisionStatus: WorkflowStatus | null = revision?.status ?? null;

  const catalogue = useMetrics();
  const records = useDisclosureRecords(revisionId);
  const writes = useDisclosureWrites(revisionId);

  // The answers of the entity being edited, indexed by metric — the input of
  // every state badge on the screen.
  const byMetric = useMemo(
    () => recordsByMetric(records.records, entityId),
    [records.records, entityId],
  );
  const sections = useMemo(
    () =>
      sectionsOf(visibleMetrics(catalogue.metrics, new Set(byMetric.keys()))),
    [catalogue.metrics, byMetric],
  );

  const [pickedCode, setPickedCode] = useState<string | null>(null);
  const section =
    sections.find((s) => s.code === pickedCode) ?? sections[0] ?? null;
  // Two strips, one per standard (0019): the VSME sections and, after them,
  // the simplified-ESRS ones. Still derived — a code of either standard that
  // the catalogue holds gets a button.
  const groups = (["vsme", "esrs"] as const)
    .map((standard) => ({
      standard,
      sections: sections.filter((entry) => entry.standard === standard),
    }))
    .filter((group) => group.sections.length > 0);

  const recordOf = (metricKey: string) => byMetric.get(metricKey)?.[0] ?? null;
  // Партия 18 — what the Organisation screen already knows, offered per card.
  const suggestContext: SuggestContext = {
    entity: entities.entities.find((e) => e.id === entityId) ?? null,
    entities: entities.entities,
    facilities: facilities.facilities,
    reportingBasis:
      periods.periods.find((p) => p.id === periodId)?.reporting_basis ?? null,
    comprehensive,
  };
  const gates = rowActionGates({ capabilities, revisionStatus, row: null });

  if (
    entities.loading ||
    entities.accessChanged ||
    entities.loadError ||
    entities.entities.length === 0
  ) {
    return <DisclosuresStartState {...entities} missingLegalEntity />;
  }

  if (
    periods.loading ||
    periods.accessChanged ||
    periods.loadError ||
    period === null
  ) {
    return <DisclosuresStartState {...periods} />;
  }

  const revisionReadable = !revisions.accessChanged && !revisions.loadError;
  const accessChanged =
    revisions.accessChanged ||
    entities.accessChanged ||
    catalogue.accessChanged ||
    records.accessChanged;
  const loadError =
    revisions.loadError ||
    entities.loadError ||
    catalogue.loadError ||
    records.loadError;
  const showDisclosures =
    !accessChanged && !loadError && revision !== null && entityId !== null;

  return (
    <PageLayout
      title={t("title")}
      subtitle={t("subtitle")}
      loading={
        revisions.loading ||
        entities.loading ||
        catalogue.loading ||
        records.loading
      }
    >
      {accessChanged && <AccessNote />}
      {loadError && <LoadErrorNote />}
      {showDisclosures && !caps.has("data.write") && (
        <div className={styles.readOnlyBanner}>
          <Muted>{t("readOnlyNote")}</Muted>
        </div>
      )}

      <SectionCard
        icon={<Building2 size={20} className={styles.iconBlue} />}
        title={t("scope.title")}
        subtitle={t("scope.subtitle")}
        badge={
          revision && (
            <Badge variant={gates.revisionOpen ? "green" : "gray"} size="sm">
              {t("scope.badge", {
                no: revision.revision_no,
                status: t.has(`revisionStatus.${revision.status}`)
                  ? t(`revisionStatus.${revision.status}`)
                  : revision.status,
              })}
            </Badge>
          )
        }
      >
        <div className={styles.twoCol}>
          <Select
            label={t("scope.period")}
            id="disclosures-period"
            options={periods.periods.map((period) => ({
              value: period.id,
              label: period.period_name,
            }))}
            value={periodId ?? ""}
            onChange={(e) => setPickedPeriodId(e.target.value)}
          />
          <Select
            label={t("scope.entity")}
            id="disclosures-entity"
            options={entities.entities.map((entity) => ({
              value: entity.id,
              label: entity.organisation_name,
            }))}
            value={entityId ?? ""}
            onChange={(e) => setPickedEntityId(e.target.value)}
          />
        </div>
        {revisionReadable && revision && !gates.revisionOpen && (
          <>
            <Muted>{t("scope.frozenBody")}</Muted>
            {gates.canSaveDraft || capabilities.includes("data.write") ? (
              <RestateBox periodId={periodId} revisionId={revisionId} />
            ) : null}
          </>
        )}
      </SectionCard>

      {revisionReadable && revisionId === null && (
        <NoReportRevisionBanner periodName={period.period_name} />
      )}
      {revisionReadable && revisionId !== null && !revision && (
        <LoadErrorNote />
      )}

      {showDisclosures && (
        <>
          <DisclosureHelp open={!byMetric.size} />
          {/* The section strip is DERIVED from the catalogue — every
          `disclosure_code` it holds gets a button, so none can be left without a
          screen (see `_lib/catalog#sectionsOf`). */}
          <DisclosureSectionTabs
            groups={groups}
            selectedCode={section?.code ?? null}
            onSelect={setPickedCode}
            recordOf={recordOf}
            comprehensive={comprehensive}
            simplifiedEsrs={simplifiedEsrs}
          />

          {section === null ? (
            <Muted>{t("noCatalogue")}</Muted>
          ) : (
            <SectionCard
              icon={<BookText size={20} className={styles.iconGreen} />}
              title={`${section.code} — ${section.title}`}
              subtitle={t(
                section.module === "comprehensive"
                  ? "moduleComprehensive"
                  : section.module === "simplified_esrs"
                    ? "moduleSimplifiedEsrs"
                    : "moduleBasic",
              )}
              badge={
                <Badge variant="gray" size="sm">
                  {t("metricCount", { count: section.metrics.length })}
                </Badge>
              }
            >
              {records.loadError && <LoadErrorNote />}
              {records.loading ? (
                <Muted>{t("loadingSection")}</Muted>
              ) : (
                <ul className={styles.metricList}>
                  {section.metrics.map((metric) => {
                    const metricRecords = byMetric.get(metric.metric_key) ?? [];
                    return (
                      <MetricCard
                        // Keyed by the HEAD's id: a save writes a new version with a
                        // new id, so the card remounts with the stored value as its
                        // baseline instead of holding the superseded one.
                        key={`${metric.metric_key}:${metricRecords[0]?.id ?? "new"}`}
                        metric={metric}
                        records={metricRecords}
                        comprehensive={comprehensive}
                        simplifiedEsrs={simplifiedEsrs}
                        capabilities={capabilities}
                        revisionStatus={revisionStatus}
                        revisionId={revisionId}
                        legalEntityId={entityId}
                        create={writes.create}
                        edit={writes.edit}
                        approve={writes.approve}
                        suggestion={suggestionFor(
                          metric.metric_key,
                          suggestContext,
                        )}
                      />
                    );
                  })}
                </ul>
              )}
            </SectionCard>
          )}
        </>
      )}
    </PageLayout>
  );
}
