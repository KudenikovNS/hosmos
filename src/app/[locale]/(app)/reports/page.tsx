"use client";

// `/reports` — the render wizard (T5.8; UI-5, AC-13, REN-3…REN-5, D14, PG-2,
// PG-5, F1, О-14, О-15).
//
// See docs/decisions/app-reports-page-L3.md for the full account.
import { Archive, FileText, FolderOpen, ShieldCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import type { ReportLanguage } from "@/i18n/locales";
import { useCapabilities } from "@/shared/hooks/useCapabilities";
import { usePlan } from "@/shared/hooks/usePlan";
import type { RenderFormat } from "@/shared/reports";
import { Badge } from "@/shared/ui/Badge";
import { Select } from "@/shared/ui/Select";
import { ReportApprovalRequiredBanner } from "@/shared/ui/ReportApprovalRequiredBanner";
import { NoReportingPeriodBanner } from "@/shared/ui/NoReportingPeriodBanner";
import { NoLegalEntityBanner } from "@/shared/ui/NoLegalEntityBanner";
import { NoReportRevisionBanner } from "@/shared/ui/NoReportRevisionBanner";

import { PageLayout } from "../_components/PageLayout";
import { useLegalEntities } from "../organisation/_lib/useOrganisation";
import {
  AccessNote,
  LoadErrorNote,
  Muted,
  RefusalNote,
  SectionCard,
} from "../_components/ScreenKit";
import { CompletenessPreview } from "./_components/CompletenessPreview";
import { RenderForm } from "./_components/RenderForm";
import { RenderList } from "./_components/RenderList";
import { RevisionPicker } from "./_components/RevisionPicker";
import type { Refusal } from "./_lib/api";
import {
  usePeriods,
  useRenderPreview,
  useRenderRevision,
  useRenders,
  useRevisions,
} from "./_lib/useReports";
import {
  defaultLanguage,
  formatChoices,
  lockWarning,
  pickedFormat,
  pickedRevision,
  revisionChoices,
} from "./_lib/wizard";
import styles from "./page.module.css";

export default function ReportsPage() {
  const t = useTranslations("reports");
  const tCommon = useTranslations("common");
  const caps = useCapabilities();
  // The SAME capability the route requires — read straight from the
  // server-resolved session, never reconstructed from a role.
  const canRender = caps.has("data.review");
  const plan = usePlan();
  const entities = useLegalEntities();
  const uiLocale = useLocale();

  const periods = usePeriods();
  const [pickedPeriodId, setPickedPeriodId] = useState<string | null>(null);
  // No effect: the pick is an expression over what is loaded right now.
  const period =
    periods.periods.find((entry) => entry.id === pickedPeriodId) ??
    periods.periods[0] ??
    null;
  const periodId = period?.id ?? null;

  const revisions = useRevisions(periodId);
  const [pickedRevisionId, setPickedRevisionId] = useState<string | null>(null);
  const choices = useMemo(
    () => revisionChoices(revisions.revisions, revisions.currentRevisionId),
    [revisions.revisions, revisions.currentRevisionId],
  );
  const revision = pickedRevision(choices, pickedRevisionId);
  const revisionId = revision?.id ?? null;

  // О-14 — defaulted from the interface locale, then CHOSEN. `pickedLanguage`
  // stays null until the user says otherwise, so a visitor who switches the
  // interface language before touching this control gets the new default rather
  // than a stale pick.
  const [pickedLanguage, setPickedLanguage] = useState<ReportLanguage | null>(
    null,
  );
  const language = pickedLanguage ?? defaultLanguage(uiLocale);

  const formats = useMemo(
    () => formatChoices(plan.features.reportFormats),
    [plan.features.reportFormats],
  );
  const [pickedFormatId, setPickedFormatId] = useState<string | null>(null);
  const format = pickedFormat(formats, pickedFormatId);

  const preview = useRenderPreview(revisionId, language);
  const renders = useRenders();
  const renderRevision = useRenderRevision();

  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [made, setMade] = useState<string | null>(null);

  const warning = lockWarning(preview.preview, revision?.status ?? null);

  const runRender = async () => {
    if (!revisionId || !format || busy) return;
    setBusy(true);
    setRefusal(null);
    setMade(null);
    const outcome = await renderRevision(revisionId, { format, language });
    setBusy(false);
    if (outcome.ok) setMade(outcome.data.render.file_name);
    else setRefusal(outcome);
  };

  const entitiesReadable =
    !entities.loading && !entities.accessChanged && !entities.loadError;
  const periodsReadable =
    entitiesReadable &&
    entities.entities.length > 0 &&
    !periods.loading &&
    !periods.accessChanged &&
    !periods.loadError;
  const revisionsReadable =
    periodsReadable &&
    period !== null &&
    !revisions.loading &&
    !revisions.accessChanged &&
    !revisions.loadError;
  const hasApprovedRevision = revisionsReadable && revision !== null;

  return (
    <PageLayout
      title={t("title")}
      subtitle={t("subtitle")}
      loading={periods.loading}
    >
      {(entities.accessChanged ||
        periods.accessChanged ||
        revisions.accessChanged ||
        renders.accessChanged) && <AccessNote />}
      {(entities.loadError || periods.loadError || revisions.loadError) && (
        <LoadErrorNote />
      )}

      {entitiesReadable && entities.entities.length === 0 && (
        <NoLegalEntityBanner />
      )}
      {periodsReadable && period === null && <NoReportingPeriodBanner />}
      {periodsReadable && period !== null && (
        <SectionCard
          icon={<FolderOpen size={20} className={styles.iconBlue} />}
          title={t("scope.title")}
          subtitle={t("scope.subtitle")}
        >
          <>
            <Select
              label={t("scope.period")}
              id="reports-period"
              options={periods.periods.map((period) => ({
                value: period.id,
                label: period.period_name,
              }))}
              value={periodId ?? ""}
              onChange={(e) => {
                setPickedPeriodId(e.target.value);
                setPickedRevisionId(null);
                setRefusal(null);
                setMade(null);
              }}
            />
            {hasApprovedRevision && (
              <RevisionPicker
                choices={choices}
                selectedId={revisionId}
                onSelect={(id) => {
                  setPickedRevisionId(id);
                  setRefusal(null);
                  setMade(null);
                }}
              />
            )}
          </>
        </SectionCard>
      )}
      {periodsReadable && period !== null && revisions.loading && (
        <Muted>{tCommon("loading")}</Muted>
      )}
      {revisionsReadable && choices.length === 0 && (
        <NoReportRevisionBanner periodName={period?.period_name ?? ""} />
      )}

      {revisionsReadable && choices.length > 0 && !revision && (
        <ReportApprovalRequiredBanner periodName={period?.period_name ?? ""} />
      )}
      {hasApprovedRevision && !preview.accessChanged && !preview.loadError && (
        <div className={styles.split}>
          <SectionCard
            icon={<FileText size={20} className={styles.iconBlue} />}
            title={t("output.title")}
            subtitle={t("output.subtitle")}
          >
            <RenderForm
              formats={formats}
              selectedFormat={format}
              onSelectFormat={(next: RenderFormat) => {
                setPickedFormatId(next);
                setMade(null);
              }}
              language={language}
              onSelectLanguage={(next) => {
                setPickedLanguage(next);
                setMade(null);
              }}
              warning={warning}
              canRender={canRender}
              busy={busy}
              disabled={revisionId === null}
              onRender={() => void runRender()}
            />
            {made && (
              <p className={styles.storedNote}>
                {t("output.done", { file: made })}
              </p>
            )}
            <RefusalNote screen="reports" refusal={refusal} />
          </SectionCard>

          <SectionCard
            icon={<ShieldCheck size={20} className={styles.iconGreen} />}
            title={t("completeness.title")}
            subtitle={t("completeness.subtitle")}
          >
            <CompletenessPreview
              preview={preview.preview}
              loading={preview.loading}
            />
          </SectionCard>
        </div>
      )}
      {hasApprovedRevision && preview.accessChanged && <AccessNote />}
      {hasApprovedRevision && preview.loadError && <LoadErrorNote />}

      <SectionCard
        icon={<Archive size={20} className={styles.iconViolet} />}
        title={t("renders.title")}
        subtitle={t("renders.subtitle")}
        badge={
          <Badge variant="gray" size="sm">
            {t("renders.count", { count: renders.renders.length })}
          </Badge>
        }
      >
        {renders.loadError && <LoadErrorNote />}
        {!renders.loadError && !renders.accessChanged && (
          <RenderList renders={renders.renders} loading={renders.loading} />
        )}
      </SectionCard>
    </PageLayout>
  );
}
