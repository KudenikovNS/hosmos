"use client";

// =============================================================================
// THE GROUP AND ITS LEGAL ENTITIES (UI-1, DM-2…DM-4, F4, PG-2/PG-5, UI-7).
//
// Three things this section is careful about:
//
//   1. LEAVING THE GROUP IS A DATE, NOT A DELETE (F4/DM-4). Every row edits its
//      `effective_from`/`effective_to` and its consolidation method inline; there
//      is no delete control, because an entity that has ever reported anything is
//      refused deletion by `deleteLegalEntity` anyway and the honest way out is
//      `effective_to`. Offering a button whose every press is a refusal would be
//      worse than not offering it.
//
//   2. THE COUNTER IS THE SERVER'S (UI-7/API-3). "2 of 3 legal entities" comes
//      from `{used, limit}` on the list response — the WRITE entitlements, which
//      is what the next POST will actually be measured against — never from a
//      plan matrix re-derived on the client.
//
//   3. THE ADD CONTROL IS PG-5's ONE EXCEPTION, and it lives in its own file
//      (`./AddSubsidiary`) precisely so that "hidden means absent" stays a fact
//      one can check rather than a claim in a comment.
// =============================================================================
import { Network } from "lucide-react";
import { useTranslations } from "next-intl";

import { useHelp } from "@/shared/hooks/useHelp";
import { useCallback, useMemo, useState } from "react";

import { CONSOLIDATION_METHODS } from "@/shared/enums";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import type { LegalEntityDto, Refusal, WriteOutcome } from "../_lib/api";
import { overlapsPeriod } from "../_lib/dates";
import { subsidiaryAffordance } from "../_lib/limits";
import { useAutosave, type Draft } from "../_lib/useAutosave";
import styles from "../page.module.css";
import { AddSubsidiary } from "./AddSubsidiary";
import {
  AccessNote,
  LoadErrorNote,
  Muted,
  RefusalNote,
  SectionCard,
} from "../../_components/ScreenKit";
import { CounterBadge, SaveBar, useEnumOptions } from "./common";

/** The group-facing subset of an entity (the profile card owns the rest). */
function groupBaseline(entity: LegalEntityDto): Draft {
  return {
    consolidation_method: entity.consolidation_method ?? "",
    ownership_percentage:
      entity.ownership_percentage === null
        ? ""
        : String(entity.ownership_percentage),
    effective_from: entity.effective_from ?? "",
    effective_to: entity.effective_to ?? "",
  };
}

export function GroupSection({
  entities,
  used,
  limit,
  loading,
  accessChanged,
  loadError,
  canManage,
  rootId,
  onCreate,
  onUpdate,
  period,
}: {
  entities: LegalEntityDto[];
  used: number;
  limit: number;
  loading: boolean;
  accessChanged: boolean;
  loadError: boolean;
  canManage: boolean;
  rootId: string | null;
  onCreate: (body: Draft) => Promise<WriteOutcome<unknown>>;
  onUpdate: (id: string, body: Draft) => Promise<WriteOutcome<unknown>>;
  /** Партия 21 — the period a warning is judged against; null while loading. */
  period: { name: string; start_date: string; end_date: string } | null;
}) {
  const t = useTranslations("organisation");
  const [adding, setAdding] = useState(false);

  const counter =
    limit === -1
      ? t("counters.entitiesUnlimited", { used })
      : t("counters.entities", { used, limit });

  return (
    <SectionCard
      icon={<Network size={20} className={styles.iconViolet} />}
      title={t("group.title")}
      subtitle={t("group.subtitle")}
      badge={
        <CounterBadge label={counter} atLimit={limit !== -1 && used >= limit} />
      }
    >
      {accessChanged ? (
        <AccessNote />
      ) : loading ? (
        <Muted>{t("loadingSection")}</Muted>
      ) : loadError ? (
        <LoadErrorNote />
      ) : (
        <div className={styles.rowStack}>
          {entities.map((entity) => (
            <EntityRow
              key={entity.id}
              entity={entity}
              isRoot={entity.id === rootId}
              canManage={canManage}
              onUpdate={onUpdate}
              period={period}
            />
          ))}
          {entities.length === 0 && <Muted>{t("group.empty")}</Muted>}
        </div>
      )}

      {canManage && !accessChanged && (
        <div className={styles.sectionActions}>
          {adding ? (
            <SubsidiaryForm
              parentId={rootId}
              onCreate={onCreate}
              onDone={() => setAdding(false)}
            />
          ) : (
            <AddSubsidiary
              // THE decision, made by the pure predicate and nowhere else.
              affordance={subsidiaryAffordance(limit, used)}
              onAdd={() => setAdding(true)}
            />
          )}
        </div>
      )}
    </SectionCard>
  );
}

/** One entity of the group: identity read-only, group facts autosaved (F4). */
function EntityRow({
  entity,
  isRoot,
  canManage,
  onUpdate,
  period,
}: {
  entity: LegalEntityDto;
  isRoot: boolean;
  canManage: boolean;
  onUpdate: (id: string, body: Draft) => Promise<WriteOutcome<unknown>>;
  period: { name: string; start_date: string; end_date: string } | null;
}) {
  const t = useTranslations("organisation");
  const help = useHelp("organisation.help");
  const methods = useEnumOptions("consolidationMethod", CONSOLIDATION_METHODS);
  const baseline = useMemo(() => groupBaseline(entity), [entity]);
  const save = useCallback(
    (patch: Draft) => onUpdate(entity.id, patch),
    [onUpdate, entity.id],
  );
  const form = useAutosave({
    contextKey: `group:${entity.id}`,
    baseline,
    save,
    enabled: canManage,
  });
  const { values, set } = form;

  return (
    <div className={styles.entityRow}>
      <div className={styles.entityHead}>
        <p className={styles.rowTitle}>{entity.organisation_name}</p>
        <Badge variant={isRoot ? "blue" : "gray"} size="sm">
          {isRoot ? t("group.root") : t("group.member")}
        </Badge>
      </div>
      <fieldset className={styles.fieldset} disabled={!canManage}>
        <div className={styles.fourCol}>
          <Select
            label={t("fields.consolidationMethod")}
            help={help("consolidationMethod")}
            id={`entity-${entity.id}-consolidationMethod`}
            options={methods}
            value={values.consolidation_method}
            onChange={(e) => set({ consolidation_method: e.target.value })}
          />
          <Input
            label={t("fields.ownershipPercentage")}
            help={help("ownershipPercentage")}
            id={`entity-${entity.id}-ownershipPercentage`}
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={values.ownership_percentage}
            onChange={(e) => set({ ownership_percentage: e.target.value })}
          />
          <Input
            label={t("fields.effectiveFrom")}
            help={help("effectiveFrom")}
            id={`entity-${entity.id}-effectiveFrom`}
            type="date"
            value={values.effective_from}
            onChange={(e) => set({ effective_from: e.target.value })}
          />
          <Input
            label={t("fields.effectiveTo")}
            help={help("effectiveTo")}
            id={`entity-${entity.id}-effectiveTo`}
            type="date"
            value={values.effective_to}
            onChange={(e) => set({ effective_to: e.target.value })}
          />
        </div>
      </fieldset>
      {period &&
        !overlapsPeriod(
          values.effective_from || null,
          values.effective_to || null,
          period.start_date,
          period.end_date,
        ) && (
          <p className={styles.dateWarning} role="status">
            {t("group.outsidePeriod", { period: period.name })}
          </p>
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

/** The create form behind the (available) "add a subsidiary" control. */
function SubsidiaryForm({
  parentId,
  onCreate,
  onDone,
}: {
  parentId: string | null;
  onCreate: (body: Draft) => Promise<WriteOutcome<unknown>>;
  onDone: () => void;
}) {
  const t = useTranslations("organisation");
  const help = useHelp("organisation.help");
  const methods = useEnumOptions("consolidationMethod", CONSOLIDATION_METHODS);
  const [draft, setDraft] = useState<Draft>({
    organisation_name: "",
    consolidation_method: "",
    ownership_percentage: "",
    effective_from: "",
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
    const result = await onCreate({
      ...draft,
      group_structure_type: "subsidiary",
      ...(parentId ? { parent_organisation_id: parentId } : {}),
    });
    setBusy(false);
    if (result.ok) onDone();
    else setRefusal(result);
  };

  return (
    <form className={styles.inlineForm} onSubmit={submit}>
      <div className={styles.fourCol}>
        <Input
          label={t("fields.organisationName")}
          help={help("organisationName")}
          id="new-subsidiary-organisationName"
          value={draft.organisation_name}
          required
          onChange={(e) => set({ organisation_name: e.target.value })}
        />
        <Select
          label={t("fields.consolidationMethod")}
          help={help("consolidationMethod")}
          id="new-subsidiary-consolidationMethod"
          options={methods}
          value={draft.consolidation_method}
          onChange={(e) => set({ consolidation_method: e.target.value })}
        />
        <Input
          label={t("fields.ownershipPercentage")}
          help={help("ownershipPercentage")}
          id="new-subsidiary-ownershipPercentage"
          type="number"
          min={0}
          max={100}
          step="0.01"
          value={draft.ownership_percentage}
          onChange={(e) => set({ ownership_percentage: e.target.value })}
        />
        <Input
          label={t("fields.effectiveFrom")}
          help={help("effectiveFrom")}
          id="new-subsidiary-effectiveFrom"
          type="date"
          value={draft.effective_from}
          onChange={(e) => set({ effective_from: e.target.value })}
        />
      </div>
      <RefusalNote screen="organisation" refusal={refusal} />
      <div className={styles.formActions}>
        <Button type="submit" size="sm" loading={busy}>
          {t("group.createSubsidiary")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t("actions.cancel")}
        </Button>
      </div>
    </form>
  );
}
