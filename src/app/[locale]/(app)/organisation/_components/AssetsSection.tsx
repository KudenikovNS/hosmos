"use client";

// =============================================================================
// THE ASSET REGISTRY (UI-1, DM-6, F5, К-7).
//
// NO COUNTER OF THE FORM "X OF Y", AND THAT IS THE POINT. F5 makes an asset a
// plain registry entry with no plan axis, so `GET /api/org/assets` answers `used`
// and deliberately no `limit`. Rendering "40 of ∞" here would assert a cap that
// does not exist; the badge states the count and stops.
//
// `meter` is a first-class asset type (К-7): a meter is not a seventh table, it
// is an asset whose type says so, and `purchased_energy_activity.meter_asset_id`
// (T3.2) will point at rows created right here.
//
// EVERY ENTRY IS EDITABLE AND REMOVABLE (партия 21). Until then this screen
// could only ADD: a mistyped plate stayed mistyped and a sold van stayed on the
// register for ever, though `PATCH`/`DELETE /api/org/assets/:id` have existed
// since T-9. An entry is edited the way an entity is (the debounced autosave of
// `../_lib/useAutosave`, one save bar per row) and removed after one question in
// place, because a delete has no undo. The server refuses a removal that would
// strand data — a meter with energy rows behind it — and says WHAT is in the
// way; that refusal is shown rather than translated into a guess.
// =============================================================================
import { Boxes } from "lucide-react";
import { useTranslations } from "next-intl";

import { useHelp } from "@/shared/hooks/useHelp";
import { useCallback, useMemo, useState } from "react";

import { ASSET_TYPES } from "@/shared/enums";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import type {
  AssetDto,
  FacilityDto,
  LegalEntityDto,
  Refusal,
  WriteOutcome,
} from "../_lib/api";
import { useAutosave, type Draft } from "../_lib/useAutosave";
import styles from "../page.module.css";
import {
  AccessNote,
  LoadErrorNote,
  Muted,
  RefusalNote,
  SectionCard,
} from "../../_components/ScreenKit";
import { CounterBadge, SaveBar, useEnumOptions } from "./common";

export function AssetsSection({
  assets,
  entities,
  facilities,
  used,
  loading,
  accessChanged,
  loadError,
  canManage,
  onCreate,
  onUpdate,
  onRemove,
}: {
  assets: AssetDto[];
  entities: LegalEntityDto[];
  facilities: FacilityDto[];
  used: number;
  loading: boolean;
  accessChanged: boolean;
  loadError: boolean;
  canManage: boolean;
  onCreate: (body: Draft) => Promise<WriteOutcome<unknown>>;
  onUpdate: (id: string, body: Draft) => Promise<WriteOutcome<unknown>>;
  onRemove: (id: string) => Promise<WriteOutcome<unknown>>;
}) {
  const t = useTranslations("organisation");
  const entityName = (id: string) =>
    entities.find((entity) => entity.id === id)?.organisation_name ?? "—";
  const facilityName = (id: string | null) =>
    id
      ? (facilities.find((facility) => facility.id === id)?.facility_name ??
        "—")
      : "—";

  return (
    <SectionCard
      icon={<Boxes size={20} className={styles.iconViolet} />}
      title={t("assets.title")}
      subtitle={t("assets.subtitle")}
      badge={
        <CounterBadge label={t("counters.assets", { used })} atLimit={false} />
      }
    >
      {accessChanged ? (
        <AccessNote />
      ) : loading ? (
        <Muted>{t("loadingSection")}</Muted>
      ) : loadError ? (
        <LoadErrorNote />
      ) : assets.length === 0 ? (
        <Muted>{t("assets.empty")}</Muted>
      ) : canManage ? (
        <div className={styles.rowList}>
          {assets.map((asset) => (
            <AssetRow
              key={asset.id}
              asset={asset}
              entities={entities}
              facilities={facilities}
              onUpdate={onUpdate}
              onRemove={onRemove}
            />
          ))}
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t("fields.assetName")}</th>
                <th>{t("fields.assetType")}</th>
                <th>{t("fields.legalEntity")}</th>
                <th>{t("fields.facility")}</th>
                <th>{t("fields.identifier")}</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr key={asset.id}>
                  <td>{asset.name}</td>
                  <td>{t(`enums.assetType.${asset.asset_type}`)}</td>
                  <td>{entityName(asset.legal_entity_id)}</td>
                  <td>{facilityName(asset.facility_id)}</td>
                  <td>{asset.identifier ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && !accessChanged && (
        <div className={styles.sectionActions}>
          <AssetForm
            entities={entities}
            facilities={facilities}
            onCreate={onCreate}
          />
        </div>
      )}
    </SectionCard>
  );
}

function AssetForm({
  entities,
  facilities,
  onCreate,
}: {
  entities: LegalEntityDto[];
  facilities: FacilityDto[];
  onCreate: (body: Draft) => Promise<WriteOutcome<unknown>>;
}) {
  const t = useTranslations("organisation");
  const help = useHelp("organisation.help");
  const types = useEnumOptions("assetType", ASSET_TYPES);
  const [draft, setDraft] = useState<Draft>({
    name: "",
    asset_type: "",
    legal_entity_id: entities[0]?.id ?? "",
    facility_id: "",
    identifier: "",
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
    if (result.ok) set({ name: "", identifier: "" });
    else setRefusal(result);
  };

  return (
    <form className={styles.inlineForm} onSubmit={submit}>
      <p className={styles.inlineFormTitle}>{t("assets.addTitle")}</p>
      <div className={styles.fourCol}>
        <Input
          label={t("fields.assetName")}
          help={help("assetName")}
          id="new-asset-assetName"
          value={draft.name}
          required
          onChange={(e) => set({ name: e.target.value })}
        />
        <Select
          label={t("fields.assetType")}
          help={help("assetType")}
          id="new-asset-assetType"
          aria-required
          options={types}
          value={draft.asset_type}
          onChange={(e) => set({ asset_type: e.target.value })}
        />
        <Select
          label={t("fields.legalEntity")}
          help={help("legalEntity")}
          id="new-asset-legalEntity"
          aria-required
          options={entities.map((entity) => ({
            value: entity.id,
            label: entity.organisation_name,
          }))}
          value={draft.legal_entity_id}
          onChange={(e) => set({ legal_entity_id: e.target.value })}
        />
        <Select
          label={t("fields.facility")}
          help={help("facility")}
          id="new-asset-facility"
          options={facilities.map((facility) => ({
            value: facility.id,
            label: facility.facility_name,
          }))}
          value={draft.facility_id}
          onChange={(e) => set({ facility_id: e.target.value })}
        />
        <Input
          label={t("fields.identifier")}
          help={help("identifier")}
          id="new-asset-identifier"
          value={draft.identifier}
          hint={t("hints.identifier")}
          onChange={(e) => set({ identifier: e.target.value })}
        />
      </div>
      <RefusalNote screen="organisation" refusal={refusal} />
      <div className={styles.formActions}>
        <Button type="submit" size="sm" loading={busy}>
          {t("assets.add")}
        </Button>
      </div>
    </form>
  );
}

/**
 * One register entry: its five fields, a save bar, and a removal that asks
 * once. `facility_id` may be cleared — an asset can belong to the entity
 * without sitting at a site — so the select carries the empty option the
 * shared `Select` renders as «Izberi …».
 */
function AssetRow({
  asset,
  entities,
  facilities,
  onUpdate,
  onRemove,
}: {
  asset: AssetDto;
  entities: LegalEntityDto[];
  facilities: FacilityDto[];
  onUpdate: (id: string, body: Draft) => Promise<WriteOutcome<unknown>>;
  onRemove: (id: string) => Promise<WriteOutcome<unknown>>;
}) {
  const t = useTranslations("organisation");
  const help = useHelp("organisation.help");
  const types = useEnumOptions("assetType", ASSET_TYPES);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeRefusal, setRemoveRefusal] = useState<Refusal | null>(null);

  const baseline: Draft = useMemo(
    () => ({
      name: asset.name,
      asset_type: asset.asset_type,
      legal_entity_id: asset.legal_entity_id,
      facility_id: asset.facility_id ?? "",
      identifier: asset.identifier ?? "",
    }),
    [asset],
  );
  const save = useCallback(
    (patch: Draft) => onUpdate(asset.id, patch),
    [onUpdate, asset.id],
  );
  const form = useAutosave({
    contextKey: `asset:${asset.id}`,
    baseline,
    save,
    enabled: true,
  });
  const { values, set } = form;

  const remove = async () => {
    if (removing) return;
    setRemoving(true);
    setRemoveRefusal(null);
    const result = await onRemove(asset.id);
    setRemoving(false);
    if (result.ok) setConfirming(false);
    else setRemoveRefusal(result);
  };

  return (
    <div className={styles.entityRow}>
      <div className={styles.fourCol}>
        <Input
          label={t("fields.assetName")}
          help={help("assetName")}
          id={`asset-${asset.id}-name`}
          aria-required
          value={values.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <Select
          label={t("fields.assetType")}
          help={help("assetType")}
          id={`asset-${asset.id}-type`}
          aria-required
          options={types}
          value={values.asset_type}
          onChange={(e) => set({ asset_type: e.target.value })}
        />
        <Select
          label={t("fields.legalEntity")}
          help={help("legalEntity")}
          id={`asset-${asset.id}-entity`}
          aria-required
          options={entities.map((entity) => ({
            value: entity.id,
            label: entity.organisation_name,
          }))}
          value={values.legal_entity_id}
          onChange={(e) => set({ legal_entity_id: e.target.value })}
        />
        <Select
          label={t("fields.facility")}
          help={help("facility")}
          id={`asset-${asset.id}-facility`}
          options={facilities.map((facility) => ({
            value: facility.id,
            label: facility.facility_name,
          }))}
          value={values.facility_id}
          onChange={(e) => set({ facility_id: e.target.value })}
        />
        <Input
          label={t("fields.identifier")}
          help={help("identifier")}
          id={`asset-${asset.id}-identifier`}
          value={values.identifier}
          hint={t("hints.identifier")}
          onChange={(e) => set({ identifier: e.target.value })}
        />
      </div>

      <RefusalNote screen="organisation" refusal={form.refusal} />
      <RefusalNote screen="organisation" refusal={removeRefusal} />

      <div className={styles.rowActions}>
        <SaveBar
          status={form.status}
          dirty={form.dirty}
          onConfirm={form.confirm}
        />
        {confirming ? (
          <div className={styles.confirmRow}>
            <Muted>{t("assets.removeConfirm", { name: asset.name })}</Muted>
            <Button
              size="sm"
              variant="danger"
              loading={removing}
              onClick={() => void remove()}
            >
              {t("assets.removeYes")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirming(false)}
            >
              {t("assets.removeNo")}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setConfirming(true)}
          >
            {t("assets.remove")}
          </Button>
        )}
      </div>
    </div>
  );
}
