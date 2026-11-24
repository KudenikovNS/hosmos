"use client";

// =============================================================================
// REPORTING PERIODS (UI-1, DM-7, DM-7a, К-4, К-24, PG-2/PG-5).
//
// FOUR FACTS THIS SECTION RENDERS AND DOES NOT COMPUTE:
//   • `period_status` (К-4) is DERIVED by the server from the current revision —
//     there is no `period_status` column and no client-side mapping of one here.
//   • `factor_set_version` (К-24) is the pinned set's code, shown read-only: the
//     pin is what makes a locked calculation reproducible, so it is stated, never
//     offered as a dropdown. A period takes the ACTIVE set at creation, which is
//     why the create form does not send `factor_set_id` at all.
//   • `methodology_version` (К-19) has exactly one entry in the Phase-1
//     dictionary, so it is shown as a fact rather than as a choice of one.
//   • THE FREEZE (DM-7a / VAL-106) is not enforced here. The six
//     calculation-bearing fields stay editable in the DOM and the server refuses
//     the write with VAL-106 once the revision has left `draft`/`rejected` — the
//     refusal is rendered by code, and the rule stays the single enforcement.
//
// PG-2/PG-5 — `consolidated` is offered on every plan. On a plan without
// `consolidatedReports` the option is VISIBLE with an explanation and a CTA
// (that is the general PG-5 rule), and the server answers the attempt with 402,
// which this screen renders as a plan explanation rather than an error.
// =============================================================================
import { CalendarRange } from "lucide-react";
import { useTranslations } from "next-intl";

import { useHelp } from "@/shared/hooks/useHelp";
import { useCallback, useMemo, useState } from "react";

import { REPORTING_BASES, type PeriodStatus } from "@/shared/enums";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import type { PeriodDto, Refusal, WriteOutcome } from "../_lib/api";
import { useAutosave, type Draft } from "../_lib/useAutosave";
import styles from "../page.module.css";
import {
  AccessNote,
  LoadErrorNote,
  Muted,
  PlanLock,
  RefusalNote,
  SectionCard,
} from "../../_components/ScreenKit";
import { CounterBadge, SaveBar, useEnumOptions } from "./common";

/**
 * LC-2's six statuses carry spaces and capitals on the wire ("In review"), which
 * are not message-key material — mapped once, here.
 */
const STATUS_KEY: Record<PeriodStatus, string> = {
  Draft: "draft",
  Submitted: "submitted",
  "In review": "inReview",
  Approved: "approved",
  Locked: "locked",
  Reopened: "reopened",
};

/** Only a Draft/Reopened period is still fully editable (DM-7a, VAL-106). */
function statusVariant(status: PeriodStatus) {
  if (status === "Locked") return "gray" as const;
  if (status === "Approved") return "green" as const;
  if (status === "Draft" || status === "Reopened") return "blue" as const;
  return "yellow" as const;
}

function periodBaseline(period: PeriodDto): Draft {
  return {
    period_name: period.period_name,
    start_date: period.start_date,
    end_date: period.end_date,
    reporting_year: String(period.reporting_year),
    base_year: period.base_year === null ? "" : String(period.base_year),
    reporting_basis: period.reporting_basis,
    comparative_period_id: period.comparative_period_id ?? "",
  };
}

export function PeriodsSection({
  periods,
  used,
  consolidatedAvailable,
  loading,
  accessChanged,
  loadError,
  canManage,
  selectedId,
  onSelect,
  onCreate,
  onUpdate,
  onStartRevision,
}: {
  periods: PeriodDto[];
  used: number;
  consolidatedAvailable: boolean;
  loading: boolean;
  accessChanged: boolean;
  loadError: boolean;
  canManage: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (body: Draft) => Promise<WriteOutcome<unknown>>;
  onUpdate: (id: string, body: Draft) => Promise<WriteOutcome<unknown>>;
  onStartRevision: (id: string) => Promise<WriteOutcome<unknown>>;
}) {
  const t = useTranslations("organisation");
  const [adding, setAdding] = useState(false);
  const selected = periods.find((period) => period.id === selectedId) ?? null;

  return (
    <SectionCard
      icon={<CalendarRange size={20} className={styles.iconBlue} />}
      title={t("periods.title")}
      subtitle={t("periods.subtitle")}
      badge={
        <CounterBadge label={t("counters.periods", { used })} atLimit={false} />
      }
    >
      {accessChanged ? (
        <AccessNote />
      ) : loading ? (
        <Muted>{t("loadingSection")}</Muted>
      ) : loadError ? (
        <LoadErrorNote />
      ) : periods.length === 0 ? (
        <Muted>{t("periods.empty")}</Muted>
      ) : (
        <div className={styles.rowStack}>
          {periods.map((period) => (
            <button
              key={period.id}
              type="button"
              aria-pressed={period.id === selectedId}
              className={
                period.id === selectedId
                  ? styles.periodRowActive
                  : styles.periodRow
              }
              onClick={() => onSelect(period.id)}
            >
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{period.period_name}</span>
                <span className={styles.rowSubtitle}>
                  {period.start_date} — {period.end_date} ·{" "}
                  {t("periods.factorSet", {
                    version: period.factor_set_version,
                  })}
                </span>
              </span>
              <Badge variant={statusVariant(period.period_status)} size="sm">
                {t(`enums.periodStatus.${STATUS_KEY[period.period_status]}`)}
              </Badge>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <PeriodConfig
          period={selected}
          canManage={canManage}
          consolidatedAvailable={consolidatedAvailable}
          periods={periods}
          onUpdate={onUpdate}
          onStartRevision={onStartRevision}
        />
      )}

      {canManage && !accessChanged && (
        <div className={styles.sectionActions}>
          {adding ? (
            <PeriodForm
              consolidatedAvailable={consolidatedAvailable}
              onCreate={onCreate}
              onDone={() => setAdding(false)}
            />
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAdding(true)}
            >
              {t("periods.add")}
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}

/** The selected period's settings, autosaved (VAL-106 governs what sticks). */
function PeriodConfig({
  period,
  periods,
  canManage,
  consolidatedAvailable,
  onUpdate,
  onStartRevision,
}: {
  period: PeriodDto;
  periods: PeriodDto[];
  canManage: boolean;
  consolidatedAvailable: boolean;
  onUpdate: (id: string, body: Draft) => Promise<WriteOutcome<unknown>>;
  onStartRevision: (id: string) => Promise<WriteOutcome<unknown>>;
}) {
  const t = useTranslations("organisation");
  const help = useHelp("organisation.help");
  const bases = useEnumOptions("reportingBasis", REPORTING_BASES);
  const baseline = useMemo(() => periodBaseline(period), [period]);
  const save = useCallback(
    (patch: Draft) => onUpdate(period.id, patch),
    [onUpdate, period.id],
  );
  const form = useAutosave({
    contextKey: `period:${period.id}`,
    baseline,
    save,
    enabled: canManage,
  });
  const { values, set } = form;
  const [starting, setStarting] = useState(false);

  return (
    <div className={styles.subsection}>
      <p className={styles.subsectionTitle}>
        {t("periods.configureTitle", { name: period.period_name })}
      </p>
      <p className={styles.headerSubtitle}>
        {t("periods.methodology", { version: period.methodology_version })}
      </p>
      {canManage && period.current_revision_id === null && (
        <div className={styles.formActions}>
          <Button
            type="button"
            size="sm"
            loading={starting}
            onClick={async () => {
              setStarting(true);
              await onStartRevision(period.id);
              setStarting(false);
            }}
          >
            {t("periods.startRevision")}
          </Button>
          <Muted>{t("periods.startRevisionHint")}</Muted>
        </div>
      )}
      <fieldset className={styles.fieldset} disabled={!canManage}>
        <div className={styles.fourCol}>
          <Input
            label={t("fields.periodName")}
            help={help("periodName")}
            id="period-periodName"
            aria-required
            value={values.period_name}
            onChange={(e) => set({ period_name: e.target.value })}
          />
          <Input
            label={t("fields.startDate")}
            help={help("startDate")}
            id="period-startDate"
            aria-required
            type="date"
            value={values.start_date}
            onChange={(e) => set({ start_date: e.target.value })}
          />
          <Input
            label={t("fields.endDate")}
            help={help("endDate")}
            id="period-endDate"
            aria-required
            type="date"
            value={values.end_date}
            onChange={(e) => set({ end_date: e.target.value })}
          />
          <Input
            label={t("fields.reportingYear")}
            help={help("reportingYear")}
            id="period-reportingYear"
            aria-required
            type="number"
            value={values.reporting_year}
            onChange={(e) => set({ reporting_year: e.target.value })}
          />
          <Input
            label={t("fields.baseYear")}
            help={help("baseYear")}
            id="period-baseYear"
            type="number"
            value={values.base_year}
            onChange={(e) => set({ base_year: e.target.value })}
          />
          <Select
            label={t("fields.reportingBasis")}
            help={help("reportingBasis")}
            id="period-reportingBasis"
            aria-required
            options={bases}
            value={values.reporting_basis}
            onChange={(e) => set({ reporting_basis: e.target.value })}
          />
          <Select
            label={t("fields.comparativePeriod")}
            help={help("comparativePeriod")}
            id="period-comparativePeriod"
            options={periods
              .filter((other) => other.id !== period.id)
              .map((other) => ({
                value: other.id,
                label: other.period_name,
              }))}
            value={values.comparative_period_id}
            onChange={(e) => set({ comparative_period_id: e.target.value })}
          />
        </div>
      </fieldset>
      {/* PG-5 general rule: the paid option is visible, and explained. */}
      {!consolidatedAvailable && (
        <PlanLock
          title={t("periods.consolidatedLockedTitle")}
          body={t("periods.consolidatedLockedBody")}
        />
      )}
      <RefusalNote screen="organisation" refusal={form.refusal} />
      {canManage && (
        <SaveBar
          status={form.status}
          dirty={form.dirty}
          onConfirm={form.confirm}
        />
      )}
    </div>
  );
}

/**
 * Create a period. `factor_set_id` is NOT sent — the service pins the ACTIVE set
 * (К-24), and letting a screen choose it would let a user pin a retired one.
 */
function PeriodForm({
  consolidatedAvailable,
  onCreate,
  onDone,
}: {
  consolidatedAvailable: boolean;
  onCreate: (body: Draft) => Promise<WriteOutcome<unknown>>;
  onDone: () => void;
}) {
  const t = useTranslations("organisation");
  const help = useHelp("organisation.help");
  const bases = useEnumOptions("reportingBasis", REPORTING_BASES);
  const [draft, setDraft] = useState<Draft>({
    period_name: "",
    start_date: "",
    end_date: "",
    reporting_basis: "individual",
    base_year: "",
  });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const set = (patch: Draft) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setRefusal(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const result = await onCreate(draft);
    setBusy(false);
    if (result.ok) onDone();
    else setRefusal(result);
  };

  return (
    <form className={styles.inlineForm} onSubmit={submit}>
      <p className={styles.inlineFormTitle}>{t("periods.addTitle")}</p>
      <div className={styles.fourCol}>
        <Input
          label={t("fields.periodName")}
          help={help("periodName")}
          id="new-period-periodName"
          value={draft.period_name}
          required
          onChange={(e) => set({ period_name: e.target.value })}
        />
        <Input
          label={t("fields.startDate")}
          help={help("startDate")}
          id="new-period-startDate"
          type="date"
          value={draft.start_date}
          required
          onChange={(e) => set({ start_date: e.target.value })}
        />
        <Input
          label={t("fields.endDate")}
          help={help("endDate")}
          id="new-period-endDate"
          type="date"
          value={draft.end_date}
          required
          onChange={(e) => set({ end_date: e.target.value })}
        />
        <Select
          label={t("fields.reportingBasis")}
          help={help("reportingBasis")}
          id="new-period-reportingBasis"
          aria-required
          options={bases}
          value={draft.reporting_basis}
          onChange={(e) => set({ reporting_basis: e.target.value })}
        />
        <Input
          label={t("fields.baseYear")}
          help={help("baseYear")}
          id="new-period-baseYear"
          type="number"
          value={draft.base_year}
          onChange={(e) => set({ base_year: e.target.value })}
        />
      </div>
      {!consolidatedAvailable && draft.reporting_basis === "consolidated" && (
        <PlanLock
          title={t("periods.consolidatedLockedTitle")}
          body={t("periods.consolidatedLockedBody")}
        />
      )}
      <RefusalNote screen="organisation" refusal={refusal} />
      <div className={styles.formActions}>
        <Button type="submit" size="sm" loading={busy}>
          {t("periods.create")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t("actions.cancel")}
        </Button>
      </div>
    </form>
  );
}
