"use client";

// =============================================================================
// ORGANISATION PROFILE (§4.2) — the root legal entity, autosaved.
//
// The root is the entity with no parent (the wizard's creation). Everything on
// this form is a plain PATCH of `/api/org/entities/[id]`; the values go on the
// wire AS TYPED, because the service parsers already speak the vocabulary a form
// control speaks — `""` clears a column, a numeric string is a number, an ISO
// date is a date. Converting here would only add a second place for the contract
// to drift from `@/server/api/parse`.
//
// WHAT IS *NOT* CHECKED HERE. Required fields (VAL-001), the currency list
// (VAL-002) and the effective dating (VAL-004) are RULES: they are judged inside
// the write transaction and come back as codes this form renders. Re-checking
// them client-side would produce a second, untranslated opinion — and would make
// the rules unreachable from the API, which is the failure mode §6.2 warns about.
// =============================================================================
import { Building2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { useHelp } from "@/shared/hooks/useHelp";
import { useCallback, useMemo } from "react";

import { CONSOLIDATION_METHODS, GROUP_STRUCTURE_TYPES } from "@/shared/enums";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import type { LegalEntityDto, WriteOutcome } from "../_lib/api";
import { useAutosave, type Draft } from "../_lib/useAutosave";
import styles from "../page.module.css";
import { Muted, RefusalNote, SectionCard } from "../../_components/ScreenKit";
import { SaveBar, useEnumOptions } from "./common";

/** `null`/number → the string a control holds ("" is the cleared column). */
function text(value: string | number | null): string {
  return value === null || value === undefined ? "" : String(value);
}

/** The DTO → the form's baseline (§4.2, with the К-1/К-2 names on the wire). */
function entityBaseline(entity: LegalEntityDto): Draft {
  return {
    organisation_name: text(entity.organisation_name),
    registration_number: text(entity.registration_number),
    vat_number: text(entity.vat_number),
    registered_address: text(entity.registered_address),
    country: text(entity.country),
    nace_code: text(entity.nace_code),
    reporting_currency: text(entity.reporting_currency),
    employee_count: text(entity.employee_count),
    average_fte: text(entity.average_fte),
    turnover: text(entity.turnover),
    group_structure_type: text(entity.group_structure_type),
    consolidation_method: text(entity.consolidation_method),
    ownership_percentage: text(entity.ownership_percentage),
    effective_from: text(entity.effective_from),
    effective_to: text(entity.effective_to),
  };
}

export function ProfileSection({
  entity,
  addressRequired,
  canManage,
  onSave,
}: {
  entity: LegalEntityDto;
  addressRequired: boolean;
  canManage: boolean;
  onSave: (id: string, body: Draft) => Promise<WriteOutcome<unknown>>;
}) {
  const t = useTranslations("organisation");
  const help = useHelp("organisation.help");
  const structures = useEnumOptions(
    "groupStructureType",
    GROUP_STRUCTURE_TYPES,
  );
  const methods = useEnumOptions("consolidationMethod", CONSOLIDATION_METHODS);

  const baseline = useMemo(() => entityBaseline(entity), [entity]);
  const save = useCallback(
    (patch: Draft) => onSave(entity.id, patch),
    [onSave, entity.id],
  );
  const form = useAutosave({
    contextKey: `profile:${entity.id}`,
    baseline,
    save,
    enabled: canManage,
  });
  const { values, set } = form;

  return (
    <SectionCard
      icon={<Building2 size={20} className={styles.iconBlue} />}
      title={t("profile.title")}
      subtitle={t("profile.subtitle")}
    >
      {!canManage && <Muted>{t("readOnlyNote")}</Muted>}
      <fieldset className={styles.fieldset} disabled={!canManage}>
        <div className={styles.formStack}>
          <Input
            label={t("fields.organisationName")}
            help={help("organisationName")}
            id="profile-organisationName"
            aria-required
            value={values.organisation_name}
            onChange={(e) => set({ organisation_name: e.target.value })}
          />
          <div className={styles.twoCol}>
            <Input
              label={t("fields.registrationNumber")}
              help={help("registrationNumber")}
              id="profile-registrationNumber"
              aria-required
              value={values.registration_number}
              onChange={(e) => set({ registration_number: e.target.value })}
            />
            <Input
              label={t("fields.vatNumber")}
              help={help("vatNumber")}
              id="profile-vatNumber"
              value={values.vat_number}
              onChange={(e) => set({ vat_number: e.target.value })}
            />
          </div>
          <Input
            label={t("fields.registeredAddress")}
            help={help("registeredAddress")}
            id="profile-registeredAddress"
            aria-required={addressRequired}
            value={values.registered_address}
            onChange={(e) => set({ registered_address: e.target.value })}
          />
          <div className={styles.twoCol}>
            <Input
              label={t("fields.country")}
              help={help("country")}
              id="profile-country"
              aria-required
              value={values.country}
              maxLength={2}
              hint={t("hints.country")}
              onChange={(e) => set({ country: e.target.value })}
            />
            <Input
              label={t("fields.naceCode")}
              help={help("naceCode")}
              id="profile-naceCode"
              value={values.nace_code}
              onChange={(e) => set({ nace_code: e.target.value })}
            />
          </div>
          <div className={styles.twoCol}>
            <Input
              label={t("fields.reportingCurrency")}
              help={help("reportingCurrency")}
              id="profile-reportingCurrency"
              value={values.reporting_currency}
              maxLength={3}
              hint={t("hints.currency")}
              onChange={(e) => set({ reporting_currency: e.target.value })}
            />
            <Input
              label={t("fields.employeeCount")}
              help={help("employeeCount")}
              id="profile-employeeCount"
              type="number"
              min={0}
              value={values.employee_count}
              onChange={(e) => set({ employee_count: e.target.value })}
            />
          </div>
          <div className={styles.twoCol}>
            <Input
              label={t("fields.averageFte")}
              help={help("averageFte")}
              id="profile-averageFte"
              type="number"
              min={0}
              step="0.01"
              value={values.average_fte}
              onChange={(e) => set({ average_fte: e.target.value })}
            />
            <Input
              label={t("fields.turnover")}
              help={help("turnover")}
              id="profile-turnover"
              type="number"
              min={0}
              step="0.01"
              value={values.turnover}
              onChange={(e) => set({ turnover: e.target.value })}
            />
          </div>
          <div className={styles.twoCol}>
            <Select
              label={t("fields.groupStructureType")}
              help={help("groupStructureType")}
              id="profile-groupStructureType"
              options={structures}
              value={values.group_structure_type}
              onChange={(e) => set({ group_structure_type: e.target.value })}
            />
            <Select
              label={t("fields.consolidationMethod")}
              help={help("consolidationMethod")}
              id="profile-consolidationMethod"
              options={methods}
              value={values.consolidation_method}
              onChange={(e) => set({ consolidation_method: e.target.value })}
            />
          </div>
          <div className={styles.twoCol}>
            <Input
              label={t("fields.effectiveFrom")}
              help={help("effectiveFrom")}
              id="profile-effectiveFrom"
              type="date"
              value={values.effective_from}
              onChange={(e) => set({ effective_from: e.target.value })}
            />
            <Input
              label={t("fields.effectiveTo")}
              help={help("effectiveTo")}
              id="profile-effectiveTo"
              type="date"
              value={values.effective_to}
              onChange={(e) => set({ effective_to: e.target.value })}
            />
          </div>
        </div>
      </fieldset>
      <RefusalNote screen="organisation" refusal={form.refusal} />
      {canManage && (
        <SaveBar
          status={form.status}
          dirty={form.dirty}
          onConfirm={form.confirm}
        />
      )}
    </SectionCard>
  );
}
