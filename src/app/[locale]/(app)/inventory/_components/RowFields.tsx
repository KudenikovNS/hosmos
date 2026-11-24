"use client";

// =============================================================================
// THE FIELDS OF ONE INPUT ROW — the mixin (§4.8) once, and one body per table.
//
// THE SPLIT IS THE SERVER'S. `@/server/inventory/wire` holds what is the same
// for every input table (the 19 mixin columns and the eight of them a client may
// set) and each table's own module holds its body; this file draws exactly that
// line, so a field lives here in the same group it lives in there. That is not
// tidiness — it is what makes "did the form forget a column" answerable by
// putting two files side by side.
//
// EVERY VALUE IS A STRING, AND GOES ON THE WIRE AS IT STANDS. `useAutosave`'s
// header explains why: the server parsers already speak what a form control
// speaks (`""` clears a column, `"2024-01"` is a `year_month`, `"true"` is a
// boolean), so a conversion layer here would be a second, silent copy of the
// contract. The one consequence worth naming is that a CHECKBOX writes the
// literal `"true"`/`"false"`, which `booleanOrNull` accepts.
//
// WHAT IS **NOT** HERE, and cannot be: `location_factor_id` and
// `market_factor_id` (§4.10). They are Calculated — CALC-5 writes them and no
// request body has a path into them (`purchased-energy.ts` simply does not
// collect them). They are DISPLAYED, read-only, because a client has to be able
// to see which factor priced its figure; they are never editable, and the
// absence of an input is the whole enforcement on this side.
//
// THE HINTS (VR-2) hang under the control they are about and are advisory —
// `_lib/checks` states why that is the only honest arrangement.
// =============================================================================
import { useTranslations } from "next-intl";

import { useHelp } from "@/shared/hooks/useHelp";

import {
  CALCULATION_METHODS,
  ENERGY_UNITS,
  GENERATION_TECHNOLOGIES,
  INSTRUMENT_TYPES,
  QUALITY_CRITERIA_STATUSES,
  UNIT_CODES,
} from "@/shared/enums";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import type { Draft } from "../../organisation/_lib/useAutosave";
import type { AssetDto, FacilityDto, LegalEntityDto } from "../_lib/api";
import type { InlineCheck } from "../_lib/checks";
import { checksForField } from "../_lib/checks";
import { ENERGY_TYPE_VALUES, type TabSpec } from "../_lib/tabs";
import styles from "../page.module.css";
import { CheckHints, useEnumOptions } from "./common";

/** What every field group needs: the values, how to change them, the hints. */
export interface FieldGroupProps {
  tab: TabSpec;
  values: Draft;
  set: (patch: Draft) => void;
  checks: readonly InlineCheck[];
  /** The revision is frozen or the capability is missing — display only. */
  disabled: boolean;
  /** Distinguishes the create form's control ids from the drawer's. */
  idPrefix: string;
}

/** A control plus whatever rules have something to say about its value. */
function Field({
  field,
  checks,
  children,
}: {
  field: string;
  checks: readonly InlineCheck[];
  children: React.ReactNode;
}) {
  return (
    <div className={styles.field}>
      {children}
      <CheckHints codes={checksForField(checks, field)} />
    </div>
  );
}

// ─── The mixin (§4.8) ────────────────────────────────────────────────────────

/**
 * The eight mixin columns a client may set (`collectMixin`), minus the two the
 * screen decides for the user: `revision_id` (the revision being edited) and
 * `metric_key` (a disclosure's, not an activity's — T3.5b's screen).
 */
export function MixinFields({
  values,
  set,
  checks,
  disabled,
  idPrefix,
  entities,
  facilities,
  units,
}: Omit<FieldGroupProps, "tab"> & {
  entities: LegalEntityDto[];
  facilities: FacilityDto[];
  /** §4.10 narrows purchased energy to kWh/MWh/GJ; Scope 1 takes any code. */
  units: readonly string[];
}) {
  const t = useTranslations("inventory");
  const help = useHelp("inventory.help");
  return (
    <>
      <Field field="legal_entity_id" checks={checks}>
        <Select
          label={t("fields.legal_entity_id")}
          help={help("legal_entity_id")}
          id={`${idPrefix}-legal-entity`}
          options={entities.map((entity) => ({
            value: entity.id,
            label: entity.organisation_name,
          }))}
          value={values.legal_entity_id ?? ""}
          disabled={disabled}
          onChange={(e) => set({ legal_entity_id: e.target.value })}
        />
      </Field>
      <Field field="facility_id" checks={checks}>
        <Select
          label={t("fields.facility_id")}
          help={help("facility_id")}
          id={`${idPrefix}-facility`}
          options={facilities.map((facility) => ({
            value: facility.id,
            label: facility.facility_name,
          }))}
          value={values.facility_id ?? ""}
          disabled={disabled}
          onChange={(e) => set({ facility_id: e.target.value })}
        />
      </Field>
      <Field field="year_month" checks={checks}>
        <Input
          label={t("fields.year_month")}
          help={help("year_month")}
          id={`${idPrefix}-year-month`}
          type="month"
          hint={t("hints.year_month")}
          value={values.year_month ?? ""}
          disabled={disabled}
          onChange={(e) => set({ year_month: e.target.value })}
        />
      </Field>
      <Field field="unit" checks={checks}>
        <Select
          label={t("fields.unit")}
          help={help("unit")}
          id={`${idPrefix}-unit`}
          options={units}
          value={values.unit ?? ""}
          disabled={disabled}
          onChange={(e) => set({ unit: e.target.value })}
        />
      </Field>
      <Field field="notes" checks={checks}>
        <Input
          label={t("fields.notes")}
          help={help("notes")}
          id={`${idPrefix}-notes`}
          hint={t("hints.notes")}
          value={values.notes ?? ""}
          disabled={disabled}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </Field>
    </>
  );
}

// ─── `emission_activity` (DM-15, §4.9) ───────────────────────────────────────

/** The К-5 refrigerant column group — a `fugitive_emissions` row's own figures. */
const REFRIGERANT_FIELDS = [
  "refrigerant_added",
  "refrigerant_recovered",
  "equipment_capacity",
  "opening_stock",
  "closing_stock",
  "leakage_rate",
] as const;

export function EmissionFields({
  tab,
  values,
  set,
  checks,
  disabled,
  idPrefix,
}: FieldGroupProps) {
  const t = useTranslations("inventory");
  const help = useHelp("inventory.help");
  const methods = useEnumOptions("method", CALCULATION_METHODS);
  // К-6: the DD spells `activity_type` per category; the model keeps one column
  // and the tab supplies the vocabulary (fuels / vehicles / refrigerants / …).
  const activityTypes = useEnumOptions("activityType", tab.activityTypes);

  return (
    <>
      <Field field="source_name" checks={checks}>
        <Input
          label={t("fields.source_name")}
          help={help("source_name")}
          id={`${idPrefix}-source-name`}
          value={values.source_name ?? ""}
          disabled={disabled}
          onChange={(e) => set({ source_name: e.target.value })}
        />
      </Field>
      <Field field="activity_type" checks={checks}>
        <Select
          label={t("fields.activity_type")}
          help={help("activity_type")}
          id={`${idPrefix}-activity-type`}
          options={activityTypes}
          value={values.activity_type ?? ""}
          disabled={disabled}
          onChange={(e) => set({ activity_type: e.target.value })}
        />
      </Field>
      <Field field="activity_value" checks={checks}>
        <Input
          label={t("fields.activity_value")}
          help={help("activity_value")}
          id={`${idPrefix}-activity-value`}
          type="number"
          step="any"
          value={values.activity_value ?? ""}
          disabled={disabled}
          onChange={(e) => set({ activity_value: e.target.value })}
        />
      </Field>
      <Field field="method" checks={checks}>
        <Select
          label={t("fields.method")}
          help={help("method")}
          id={`${idPrefix}-method`}
          options={methods}
          value={values.method ?? ""}
          disabled={disabled}
          onChange={(e) => set({ method: e.target.value })}
        />
      </Field>
      <div className={styles.field}>
        <label className={styles.checkboxRow} htmlFor={`${idPrefix}-biogenic`}>
          <input
            id={`${idPrefix}-biogenic`}
            type="checkbox"
            checked={values.biogenic_flag === "true"}
            disabled={disabled}
            onChange={(e) =>
              set({ biogenic_flag: e.target.checked ? "true" : "false" })
            }
          />
          {t("fields.biogenic_flag")}
        </label>
      </div>
      {tab.id === "fugitive" &&
        REFRIGERANT_FIELDS.map((field) => (
          <Field key={field} field={field} checks={checks}>
            <Input
              label={t(`fields.${field}`)}
              help={help(field)}
              id={`${idPrefix}-${field}`}
              type="number"
              step="any"
              value={values[field] ?? ""}
              disabled={disabled}
              onChange={(e) => set({ [field]: e.target.value })}
            />
          </Field>
        ))}
    </>
  );
}

// ─── `purchased_energy_activity` (DM-16, §4.10) ──────────────────────────────

export function EnergyFields({
  values,
  set,
  checks,
  disabled,
  idPrefix,
  assets,
}: Omit<FieldGroupProps, "tab"> & { assets: AssetDto[] }) {
  const t = useTranslations("inventory");
  const help = useHelp("inventory.help");
  const energyTypes = useEnumOptions("energyType", ENERGY_TYPE_VALUES);
  // К-7: there is no Meter entity — a meter is an `asset` with
  // `asset_type = 'meter'`, and the column is `meter_asset_id`.
  const meters = assets.filter((asset) => asset.asset_type === "meter");

  return (
    <>
      <Field field="energy_type" checks={checks}>
        <Select
          label={t("fields.energy_type")}
          help={help("energy_type")}
          id={`${idPrefix}-energy-type`}
          options={energyTypes}
          value={values.energy_type ?? ""}
          disabled={disabled}
          onChange={(e) => set({ energy_type: e.target.value })}
        />
      </Field>
      <Field field="consumption" checks={checks}>
        <Input
          label={t("fields.consumption")}
          help={help("consumption")}
          id={`${idPrefix}-consumption`}
          type="number"
          step="any"
          value={values.consumption ?? ""}
          disabled={disabled}
          onChange={(e) => set({ consumption: e.target.value })}
        />
      </Field>
      <Field field="supplier" checks={checks}>
        <Input
          label={t("fields.supplier")}
          help={help("supplier")}
          id={`${idPrefix}-supplier`}
          value={values.supplier ?? ""}
          disabled={disabled}
          onChange={(e) => set({ supplier: e.target.value })}
        />
      </Field>
      <Field field="meter_asset_id" checks={checks}>
        <Select
          label={t("fields.meter_asset_id")}
          help={help("meter_asset_id")}
          id={`${idPrefix}-meter`}
          options={meters.map((asset) => ({
            value: asset.id,
            label: asset.name,
          }))}
          value={values.meter_asset_id ?? ""}
          disabled={disabled}
          onChange={(e) => set({ meter_asset_id: e.target.value })}
        />
      </Field>
      <Field field="renewable_share" checks={checks}>
        <Input
          label={t("fields.renewable_share")}
          help={help("renewable_share")}
          id={`${idPrefix}-renewable-share`}
          type="number"
          step="any"
          min={0}
          max={100}
          unit="%"
          value={values.renewable_share ?? ""}
          disabled={disabled}
          onChange={(e) => set({ renewable_share: e.target.value })}
        />
      </Field>
    </>
  );
}

/** The two Calculated fields of §4.10 — shown, never editable (see the header). */
export function CalculatedFactors({
  locationFactorId,
  marketFactorId,
}: {
  locationFactorId: string | null;
  marketFactorId: string | null;
}) {
  const t = useTranslations("inventory");
  return (
    <div className={styles.calculated}>
      <p className={styles.subsectionTitle}>{t("calculated.title")}</p>
      <p className={styles.calculatedBody}>
        {t("calculated.location", {
          value: locationFactorId ?? t("calculated.pending"),
        })}
      </p>
      <p className={styles.calculatedBody}>
        {t("calculated.market", {
          value: marketFactorId ?? t("calculated.pending"),
        })}
      </p>
    </div>
  );
}

// ─── `contractual_instrument` (DM-17, §4.11) ─────────────────────────────────

/** The three date columns of §4.11 — the vintage window plus cancellation. */
const INSTRUMENT_DATES = [
  "generation_period_start",
  "generation_period_end",
  "cancellation_date",
] as const;

export function InstrumentFields({
  values,
  set,
  checks,
  disabled,
  idPrefix,
}: Omit<FieldGroupProps, "tab">) {
  const t = useTranslations("inventory");
  const help = useHelp("inventory.help");
  const types = useEnumOptions("instrumentType", INSTRUMENT_TYPES);
  const technologies = useEnumOptions("technology", GENERATION_TECHNOLOGIES);
  const quality = useEnumOptions("qualityCriteria", QUALITY_CRITERIA_STATUSES);

  return (
    <>
      <Field field="instrument_type" checks={checks}>
        <Select
          label={t("fields.instrument_type")}
          help={help("instrument_type")}
          id={`${idPrefix}-instrument-type`}
          options={types}
          value={values.instrument_type ?? ""}
          disabled={disabled}
          onChange={(e) => set({ instrument_type: e.target.value })}
        />
      </Field>
      <Field field="certificate_id" checks={checks}>
        <Input
          label={t("fields.certificate_id")}
          help={help("certificate_id")}
          id={`${idPrefix}-certificate-id`}
          value={values.certificate_id ?? ""}
          disabled={disabled}
          onChange={(e) => set({ certificate_id: e.target.value })}
        />
      </Field>
      <Field field="covered_volume" checks={checks}>
        <Input
          label={t("fields.covered_volume")}
          help={help("covered_volume")}
          id={`${idPrefix}-covered-volume`}
          type="number"
          step="any"
          min={0}
          unit="MWh"
          value={values.covered_volume ?? ""}
          disabled={disabled}
          onChange={(e) => set({ covered_volume: e.target.value })}
        />
      </Field>
      <Field field="production_country" checks={checks}>
        <Input
          label={t("fields.production_country")}
          help={help("production_country")}
          id={`${idPrefix}-production-country`}
          maxLength={2}
          hint={t("hints.production_country")}
          value={values.production_country ?? ""}
          disabled={disabled}
          onChange={(e) => set({ production_country: e.target.value })}
        />
      </Field>
      <Field field="technology" checks={checks}>
        <Select
          label={t("fields.technology")}
          help={help("technology")}
          id={`${idPrefix}-technology`}
          options={technologies}
          value={values.technology ?? ""}
          disabled={disabled}
          onChange={(e) => set({ technology: e.target.value })}
        />
      </Field>
      {INSTRUMENT_DATES.map((field) => (
        <Field key={field} field={field} checks={checks}>
          <Input
            label={t(`fields.${field}`)}
            help={help(field)}
            id={`${idPrefix}-${field}`}
            type="date"
            value={values[field] ?? ""}
            disabled={disabled}
            onChange={(e) => set({ [field]: e.target.value })}
          />
        </Field>
      ))}
      <Field field="quality_criteria_status" checks={checks}>
        <Select
          label={t("fields.quality_criteria_status")}
          help={help("quality_criteria_status")}
          id={`${idPrefix}-quality`}
          options={quality}
          value={values.quality_criteria_status ?? ""}
          disabled={disabled}
          onChange={(e) => set({ quality_criteria_status: e.target.value })}
        />
      </Field>
      <Field field="residual_mix_volume" checks={checks}>
        <Input
          label={t("fields.residual_mix_volume")}
          help={help("residual_mix_volume")}
          id={`${idPrefix}-residual-mix-volume`}
          type="number"
          step="any"
          min={0}
          unit="MWh"
          value={values.residual_mix_volume ?? ""}
          disabled={disabled}
          onChange={(e) => set({ residual_mix_volume: e.target.value })}
        />
      </Field>
    </>
  );
}

/** The unit vocabulary a tab's rows are measured in (§4.10 narrows Scope 2). */
export function unitsFor(tab: TabSpec): readonly string[] {
  return tab.table === "purchased_energy_activity" ? ENERGY_UNITS : UNIT_CODES;
}
