"use client";

// =============================================================================
// THE FACILITY REGISTRY (UI-1, DM-5, PG-2/PG-5, UI-7).
//
// THE COUNTER IS THE ACCEPTANCE CRITERION. On Starter the badge reads "3 of 3
// facilities" and the add control is the PG-5 GENERAL case: still there, still
// explained, with an upgrade CTA — unlike "add a subsidiary", which the PDF says
// to hide. The two behaviours sit side by side on this screen on purpose, and
// both come from `../_lib/limits`.
//
// `included_in_boundary` is a REGISTRY flag (is the site operational for us),
// NOT the period boundary — that is `period_scope`, further down the page. It is
// a checkbox and therefore its own confirmation: it writes immediately rather
// than waiting for a debounce.
// =============================================================================
import { Factory } from "lucide-react";
import { useTranslations } from "next-intl";

import { useHelp } from "@/shared/hooks/useHelp";
import { useState } from "react";

import { FACILITY_TYPES, TENURE_TYPES } from "@/shared/enums";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import type {
  FacilityDto,
  LegalEntityDto,
  Refusal,
  WriteOutcome,
} from "../_lib/api";
import { limitAffordance } from "../_lib/limits";
import type { Draft } from "../_lib/useAutosave";
import styles from "../page.module.css";
import {
  AccessNote,
  LoadErrorNote,
  Muted,
  PlanLock,
  RefusalNote,
  SectionCard,
} from "../../_components/ScreenKit";
import { CounterBadge, useEnumOptions } from "./common";

export function FacilitiesSection({
  facilities,
  entities,
  used,
  limit,
  loading,
  accessChanged,
  loadError,
  canManage,
  onCreate,
  onUpdate,
}: {
  facilities: FacilityDto[];
  entities: LegalEntityDto[];
  used: number;
  limit: number;
  loading: boolean;
  accessChanged: boolean;
  loadError: boolean;
  canManage: boolean;
  onCreate: (body: Draft) => Promise<WriteOutcome<unknown>>;
  onUpdate: (id: string, body: Draft) => Promise<WriteOutcome<unknown>>;
}) {
  const t = useTranslations("organisation");
  const [rowRefusal, setRowRefusal] = useState<Refusal | null>(null);
  const entityName = (id: string) =>
    entities.find((entity) => entity.id === id)?.organisation_name ?? "—";

  const counter =
    limit === -1
      ? t("counters.facilitiesUnlimited", { used })
      : t("counters.facilities", { used, limit });
  const affordance = limitAffordance(limit, used);

  const toggleBoundary = async (facility: FacilityDto) => {
    setRowRefusal(null);
    const result = await onUpdate(facility.id, {
      included_in_boundary: facility.included_in_boundary ? "false" : "true",
    });
    if (!result.ok) setRowRefusal(result);
  };

  return (
    <SectionCard
      icon={<Factory size={20} className={styles.iconGreen} />}
      title={t("facilities.title")}
      subtitle={t("facilities.subtitle")}
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
      ) : facilities.length === 0 ? (
        <Muted>{t("facilities.empty")}</Muted>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t("fields.facilityName")}</th>
                <th>{t("fields.legalEntity")}</th>
                <th>{t("fields.facilityType")}</th>
                <th>{t("fields.country")}</th>
                <th>{t("fields.includedInBoundary")}</th>
              </tr>
            </thead>
            <tbody>
              {facilities.map((facility) => (
                <tr key={facility.id}>
                  <td>{facility.facility_name}</td>
                  <td>{entityName(facility.legal_entity_id)}</td>
                  <td>
                    {facility.facility_type
                      ? t(`enums.facilityType.${facility.facility_type}`)
                      : "—"}
                  </td>
                  <td>{facility.country ?? "—"}</td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t("facilities.boundaryFor", {
                        name: facility.facility_name,
                      })}
                      checked={facility.included_in_boundary}
                      disabled={!canManage}
                      onChange={() => void toggleBoundary(facility)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RefusalNote screen="organisation" refusal={rowRefusal} />

      {canManage && !accessChanged && (
        <div className={styles.sectionActions}>
          {affordance === "locked" ? (
            // PG-5 GENERAL rule: the feature stays visible and explains itself.
            <PlanLock
              title={t("facilities.lockedTitle")}
              body={t("facilities.lockedBody", { limit })}
            />
          ) : (
            <FacilityForm entities={entities} onCreate={onCreate} />
          )}
        </div>
      )}
    </SectionCard>
  );
}

/** Create one site. `legal_entity_id` is a choice among the OWN entities only. */
function FacilityForm({
  entities,
  onCreate,
}: {
  entities: LegalEntityDto[];
  onCreate: (body: Draft) => Promise<WriteOutcome<unknown>>;
}) {
  const t = useTranslations("organisation");
  const help = useHelp("organisation.help");
  const types = useEnumOptions("facilityType", FACILITY_TYPES);
  const tenures = useEnumOptions("tenure", TENURE_TYPES);
  const [draft, setDraft] = useState<Draft>({
    facility_name: "",
    legal_entity_id: entities[0]?.id ?? "",
    facility_type: "",
    country: "",
    tenure: "",
    opening_date: "",
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
    if (result.ok) set({ facility_name: "", country: "", opening_date: "" });
    else setRefusal(result);
  };

  return (
    <form className={styles.inlineForm} onSubmit={submit}>
      <p className={styles.inlineFormTitle}>{t("facilities.addTitle")}</p>
      <div className={styles.fourCol}>
        <Input
          label={t("fields.facilityName")}
          help={help("facilityName")}
          id="new-facility-facilityName"
          value={draft.facility_name}
          required
          onChange={(e) => set({ facility_name: e.target.value })}
        />
        <Select
          label={t("fields.legalEntity")}
          help={help("legalEntity")}
          id="new-facility-legalEntity"
          aria-required
          options={entities.map((entity) => ({
            value: entity.id,
            label: entity.organisation_name,
          }))}
          value={draft.legal_entity_id}
          onChange={(e) => set({ legal_entity_id: e.target.value })}
        />
        <Select
          label={t("fields.facilityType")}
          help={help("facilityType")}
          id="new-facility-facilityType"
          options={types}
          value={draft.facility_type}
          onChange={(e) => set({ facility_type: e.target.value })}
        />
        <Input
          label={t("fields.country")}
          help={help("country")}
          id="new-facility-country"
          value={draft.country}
          maxLength={2}
          hint={t("hints.country")}
          onChange={(e) => set({ country: e.target.value })}
        />
        <Select
          label={t("fields.tenure")}
          help={help("tenure")}
          id="new-facility-tenure"
          options={tenures}
          value={draft.tenure}
          onChange={(e) => set({ tenure: e.target.value })}
        />
        <Input
          label={t("fields.openingDate")}
          help={help("openingDate")}
          id="new-facility-openingDate"
          type="date"
          value={draft.opening_date}
          onChange={(e) => set({ opening_date: e.target.value })}
        />
      </div>
      <RefusalNote screen="organisation" refusal={refusal} />
      <div className={styles.formActions}>
        <Button type="submit" size="sm" loading={busy}>
          {t("facilities.add")}
        </Button>
      </div>
    </form>
  );
}
