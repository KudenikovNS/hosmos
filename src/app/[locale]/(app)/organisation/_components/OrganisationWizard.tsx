"use client";

// =============================================================================
// FIRST RUN (DM-1) — the company has no `legal_entity` yet, so the screen has
// nothing to show and everything downstream (facilities, periods, boundary) has
// nothing to hang on. The wizard creates the ROOT entity.
//
// THE SEED IS `companies` (DM-1), field for field:
//   name → organisation_name (К-1), country_code → country, nace_code,
//   headcount → employee_count, currency → reporting_currency.
// `companies.country` is NOT used: it holds a display name ("Slovenia") while
// `legal_entity.country` is `char(2)`, so `country_code` is the only field of
// the two that can be copied without inventing a mapping. A company without one
// starts the field empty rather than guessing.
//
// THE SEED IS A DRAFT, NOT A FACT. The values are prefilled and fully editable
// before the single explicit confirm — this is the one form on the screen with
// no autosave, because there is no row to save into until it succeeds, and a
// half-written organisation is worse than none.
//
// STATE WITHOUT AN EFFECT. The seed is a lazy `useState` initialiser over the
// props, and the caller mounts this component only once the session company is
// known (with a `key` on its id). Nothing here synchronises state in an effect.
// =============================================================================
import { Building2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { useHelp } from "@/shared/hooks/useHelp";
import { useState } from "react";

import type { DbCompany } from "@/server/db/types";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";
import { GROUP_STRUCTURE_TYPES } from "@/shared/enums";

import type { Refusal, WriteOutcome } from "../_lib/api";
import type { Draft } from "../_lib/useAutosave";
import styles from "../page.module.css";
import { Muted, RefusalNote, SectionCard } from "../../_components/ScreenKit";
import { useEnumOptions } from "./common";

/** `companies` → the root entity's starting values (DM-1). */
function seedFromCompany(company: DbCompany): Draft {
  return {
    organisation_name: company.name ?? "",
    // VAL-001 needs the registration number; the company profile has none, so
    // the wizard asks for it (and the VAT number and address, which B1 prints).
    registration_number: "",
    vat_number: "",
    registered_address: "",
    // `country_code` is the char(2) one; `country` is a display name (header).
    country: company.country_code ?? "",
    nace_code: company.nace_code ?? "",
    employee_count:
      company.headcount === null || company.headcount === undefined
        ? ""
        : String(company.headcount),
    reporting_currency: company.currency ?? "",
    group_structure_type: "standalone",
  };
}

export function OrganisationWizard({
  company,
  onCreate,
}: {
  company: DbCompany;
  onCreate: (body: Draft) => Promise<WriteOutcome<unknown>>;
}) {
  const t = useTranslations("organisation");
  const help = useHelp("organisation.help");
  const structures = useEnumOptions(
    "groupStructureType",
    GROUP_STRUCTURE_TYPES,
  );
  const [draft, setDraft] = useState<Draft>(() => seedFromCompany(company));
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
    // A refused create wrote NOTHING (VR-3) — the draft stays on screen with the
    // reason under it, so the user edits and retries rather than starting over.
    if (!result.ok) setRefusal(result);
  };

  return (
    <SectionCard
      icon={<Building2 size={20} className={styles.iconBlue} />}
      title={t("wizard.title")}
      subtitle={t("wizard.subtitle")}
    >
      <Muted>{t("wizard.seededNote")}</Muted>
      <form className={styles.formStack} onSubmit={submit}>
        <Input
          label={t("fields.organisationName")}
          help={help("organisationName")}
          id="wizard-organisationName"
          value={draft.organisation_name}
          required
          onChange={(e) => set({ organisation_name: e.target.value })}
        />
        <div className={styles.twoCol}>
          <Input
            label={t("fields.registrationNumber")}
            help={help("registrationNumber")}
            id="wizard-registrationNumber"
            value={draft.registration_number}
            required
            onChange={(e) => set({ registration_number: e.target.value })}
          />
          <Input
            label={t("fields.vatNumber")}
            help={help("vatNumber")}
            id="wizard-vatNumber"
            value={draft.vat_number}
            onChange={(e) => set({ vat_number: e.target.value })}
          />
        </div>
        <Input
          label={t("fields.registeredAddress")}
          help={help("registeredAddress")}
          id="wizard-registeredAddress"
          value={draft.registered_address}
          onChange={(e) => set({ registered_address: e.target.value })}
        />
        <div className={styles.twoCol}>
          <Input
            label={t("fields.country")}
            help={help("country")}
            id="wizard-country"
            required
            value={draft.country}
            maxLength={2}
            hint={t("hints.country")}
            onChange={(e) => set({ country: e.target.value })}
          />
          <Input
            label={t("fields.naceCode")}
            help={help("naceCode")}
            id="wizard-naceCode"
            value={draft.nace_code}
            onChange={(e) => set({ nace_code: e.target.value })}
          />
        </div>
        <div className={styles.twoCol}>
          <Input
            label={t("fields.employeeCount")}
            help={help("employeeCount")}
            id="wizard-employeeCount"
            type="number"
            min={0}
            value={draft.employee_count}
            onChange={(e) => set({ employee_count: e.target.value })}
          />
          <Input
            label={t("fields.reportingCurrency")}
            help={help("reportingCurrency")}
            id="wizard-reportingCurrency"
            value={draft.reporting_currency}
            maxLength={3}
            hint={t("hints.currency")}
            onChange={(e) => set({ reporting_currency: e.target.value })}
          />
        </div>
        <Select
          label={t("fields.groupStructureType")}
          help={help("groupStructureType")}
          id="wizard-groupStructureType"
          options={structures}
          value={draft.group_structure_type}
          onChange={(e) => set({ group_structure_type: e.target.value })}
        />
        <RefusalNote screen="organisation" refusal={refusal} />
        <div className={styles.formActions}>
          <Button type="submit" loading={busy}>
            {t("wizard.create")}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
