"use client";

// =============================================================================
// ONE CONTROL PER `DataType` (T3.5b — DM-18, DM-19, S1).
//
// THE CONTROL IS CHOSEN BY DATA, NOT BY A BRANCH PER METRIC. `_lib/catalog`
// decides (`controlFor` → `ControlKind`) and this file draws; the `switch` below
// is exhaustive over `ControlKind`, so a type added to `DATA_TYPES` fails the
// BUILD here as well as in the map. That is the whole defence against "we did
// Decimal and Text, the rest later" — plus the catalogue-wide test, which is the
// defence against a control that exists but is never selected.
//
// CHOICE LISTS COME FROM THE STANDARD, NOT FROM `metric_catalog` (партия 18).
// The catalogue declares no option list for `enum` / `multi_enum`: the choices
// sit in the metric's prose. Where the standard itself names them (reporting
// option, basis of preparation, legal form, risk horizon…), `@/shared/catalog/options`
// lists them and `ChoiceControl` draws a select or a checkbox list; the STORED
// value is still the plain string the text box used to store, so reports and
// earlier answers read back unchanged. Every other code field stays free text.
//
// WHY BOOLEAN IS A THREE-WAY SELECT AND NOT A CHECKBOX. A checkbox has two
// states and this form has three: yes, no, and NOT COLLECTED. 25 of the seeded
// 141 metrics are booleans; a checkbox would answer every one of them `false` on
// sight, and `false` is an ANSWER (DM-19 — it is stored, it is printed, and it
// is not a blank). The empty option is therefore the absence of an answer, and
// nothing is sent for it.
//
// EVERY VALUE IS A STRING HERE AND CROSSES THE WIRE AS ONE, except where JSON
// demands otherwise — `_lib/catalog#valueBody` performs that one conversion, in
// a tested function, so no control has to know about it.
// =============================================================================
import { Minus, Plus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import type { MetricDto } from "../_lib/api";
import { METRIC_CHOICES, choicesFor, isListed } from "@/shared/catalog/options";
import type {
  BreakdownRow,
  ControlKind,
  MetricControl,
  ValueDraft,
} from "../_lib/catalog";
import styles from "../page.module.css";

/** What every control needs: the decision, the draft, and how to change it. */
export interface ValueControlProps {
  readonly metric: MetricDto;
  readonly control: MetricControl;
  readonly draft: ValueDraft;
  readonly set: (patch: Partial<ValueDraft>) => void;
  /** The revision is frozen, the capability is missing, or PG-6 locked it. */
  readonly disabled: boolean;
  /** Distinguishes one metric's control ids from the next one's. */
  readonly idPrefix: string;
}

/** The label a control carries — the standard's own wording (О-20). */
function metricLabel(metric: MetricDto): string {
  return metric.text?.label ?? metric.title_en ?? metric.title;
}

/** The unit in the UI language (`metricText`), else the catalogue's own. */
function metricUnit(metric: MetricDto): string | null {
  return metric.text?.unit ?? metric.unit;
}

const OTHER = "__other__";

/**
 * Партия 18 — a datapoint whose choices the standard names (`@/shared/catalog/options`):
 * a select for one choice, a checkbox list for several. The stored value is
 * the option's `value` string, exactly what the free-text box stored before;
 * a value outside the list (typed earlier, or «Other») stays editable as text.
 */
function ChoiceControl({
  metric,
  control,
  draft,
  set,
  disabled,
  idPrefix,
}: ValueControlProps) {
  const t = useTranslations("disclosures");
  const locale = useLocale();
  const choices = choicesFor(metric.metric_key, locale)!;
  const id = `${idPrefix}-value`;
  const label = metricLabel(metric);
  const hint = metric.text?.hint ?? undefined;
  const value = draft.text;
  const listed = value === "" || isListed(metric.metric_key, value);
  const [otherOpen, setOtherOpen] = useState(!listed);

  if (control.kind === "codeList") {
    const picked = draft.lines
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const toggle = (value: string) => {
      const next = picked.includes(value)
        ? picked.filter((v) => v !== value)
        : [...picked, value];
      set({ lines: next.join("\n") });
    };
    return (
      <fieldset className={styles.choiceGroup} disabled={disabled}>
        <legend className={styles.textareaLabel}>{label}</legend>
        <div className={styles.choiceList}>
          {choices.options.map((o) => (
            <label key={o.value} className={styles.choiceItem}>
              <input
                type="checkbox"
                checked={picked.includes(o.value)}
                onChange={() => toggle(o.value)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
        {hint && <p className={styles.controlHint}>{hint}</p>}
      </fieldset>
    );
  }

  const showOther = choices.other && (otherOpen || !listed);
  const selectValue = showOther ? OTHER : value;

  return (
    <div className={styles.textareaWrap}>
      <Select
        id={id}
        label={label}
        disabled={disabled}
        options={[
          ...choices.options,
          ...(choices.other
            ? [{ value: OTHER, label: t("controls.other") }]
            : []),
          // A stored value outside a closed list is shown, never silently lost.
          ...(!choices.other && !listed ? [{ value, label: value }] : []),
        ]}
        value={selectValue}
        onChange={(e) => {
          const next = e.target.value;
          if (next === OTHER) {
            setOtherOpen(true);
            set({ text: listed ? "" : value });
          } else {
            setOtherOpen(false);
            set({ text: next });
          }
        }}
      />
      {showOther && (
        <Input
          id={`${id}-other`}
          label={t("controls.otherLabel")}
          disabled={disabled}
          value={value}
          onChange={(e) => set({ text: e.target.value })}
        />
      )}
      {hint && <p className={styles.controlHint}>{hint}</p>}
    </div>
  );
}

/**
 * THE SCALAR CONTROLS — nine `ControlKind`s minus `breakdown`, which is a
 * composition of one of them (the total) and a table.
 */
function ScalarControl({
  kind,
  id,
  label,
  unit,
  value,
  onChange,
  disabled,
  hint,
}: {
  kind: Exclude<ControlKind, "breakdown">;
  id: string;
  label: string;
  unit: string | null;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  hint?: string;
}) {
  const t = useTranslations("disclosures");
  const common = { id, label, disabled, ...(hint ? { hint } : {}) };

  switch (kind) {
    case "decimal":
      return (
        <Input
          {...common}
          type="number"
          step="any"
          {...(unit ? { unit } : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "integer":
      return (
        <Input
          {...common}
          type="number"
          step="1"
          {...(unit ? { unit } : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "percentage":
      return (
        <Input
          {...common}
          type="number"
          step="any"
          min={0}
          max={100}
          unit="%"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "date":
      return (
        <Input
          {...common}
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "boolean":
      return (
        <Select
          {...common}
          options={[
            { value: "true", label: t("controls.yes") },
            { value: "false", label: t("controls.no") },
          ]}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "paragraph":
      return (
        <div className={styles.textareaWrap}>
          <label className={styles.textareaLabel} htmlFor={id}>
            {label}
          </label>
          <textarea
            id={id}
            className={styles.textarea}
            rows={4}
            disabled={disabled}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {hint && <p className={styles.controlHint}>{hint}</p>}
        </div>
      );
    case "code":
      return (
        <Input
          {...common}
          hint={hint ?? t("controls.codeHint")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "codeList":
      return (
        <div className={styles.textareaWrap}>
          <label className={styles.textareaLabel} htmlFor={id}>
            {label}
          </label>
          <textarea
            id={id}
            className={styles.textarea}
            rows={3}
            disabled={disabled}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <p className={styles.controlHint}>{t("controls.codeListHint")}</p>
        </div>
      );
    case "line":
      return (
        <Input
          {...common}
          {...(unit ? { unit } : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/**
 * A metric with `breakdown_dimensions` (S1): the TOTAL and its split, drawn as
 * one control because they are written as one field.
 *
 * `_lib/catalog#valueBody` folds both into a single `value_json`
 * (`{total, breakdown}`) and the server refuses the same metric answered as a
 * number (422, T3.3), so the total and its parts cannot drift apart — not
 * through this form, and not through any other client.
 *
 * The split may be left empty: the workbook says "breakdown if obtainable", and
 * a total-only answer is the normal case rather than a half-filled one.
 */
function BreakdownControl({
  metric,
  control,
  draft,
  set,
  disabled,
  idPrefix,
}: ValueControlProps) {
  const t = useTranslations("disclosures");
  const dimensions = control.breakdown?.dimensions ?? [];
  // The catalogue names an axis by its key (`energy_source`); the words come
  // from the messages, and an axis nobody named yet shows its key.
  const dimensionLabel = (d: string) =>
    t.has(`dimensions.${d}`) ? t(`dimensions.${d}`) : d;
  const unit = metricUnit(metric);

  const setRow = (index: number, patch: Partial<BreakdownRow>) => {
    set({
      rows: draft.rows.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    });
  };

  return (
    <div className={styles.breakdown}>
      <ScalarControl
        kind={control.scalar === "breakdown" ? "decimal" : control.scalar}
        id={`${idPrefix}-total`}
        label={t("controls.total", { metric: metricLabel(metric) })}
        unit={unit}
        value={draft.text}
        onChange={(text) => set({ text })}
        disabled={disabled}
      />

      <p className={styles.breakdownTitle}>
        {t("controls.breakdownTitle", {
          dimensions: dimensions.map(dimensionLabel).join(", "),
        })}
      </p>
      <p className={styles.controlHint}>
        {control.breakdown?.ifObtainable
          ? t("controls.breakdownOptional")
          : t("controls.breakdownRequired")}
      </p>

      {draft.rows.map((row, index) => (
        <div className={styles.breakdownRow} key={index}>
          {dimensions.length > 1 && (
            <Select
              id={`${idPrefix}-dimension-${index}`}
              label={t("controls.dimension")}
              options={dimensions.map((d) => ({
                value: d,
                label: dimensionLabel(d),
              }))}
              value={row.dimension}
              disabled={disabled}
              onChange={(e) => setRow(index, { dimension: e.target.value })}
            />
          )}
          <Input
            id={`${idPrefix}-label-${index}`}
            label={t("controls.partLabel")}
            value={row.label}
            disabled={disabled}
            onChange={(e) => setRow(index, { label: e.target.value })}
          />
          <Input
            id={`${idPrefix}-amount-${index}`}
            label={t("controls.partAmount")}
            type="number"
            step="any"
            {...(unit ? { unit } : {})}
            value={row.amount}
            disabled={disabled}
            onChange={(e) => setRow(index, { amount: e.target.value })}
          />
          <button
            type="button"
            className={styles.rowButton}
            disabled={disabled}
            aria-label={t("controls.removePart")}
            onClick={() =>
              set({ rows: draft.rows.filter((_, i) => i !== index) })
            }
          >
            <Minus size={14} />
          </button>
        </div>
      ))}

      <button
        type="button"
        className={styles.rowButton}
        disabled={disabled}
        onClick={() =>
          set({
            rows: [
              ...draft.rows,
              { dimension: dimensions[0] ?? "", label: "", amount: "" },
            ],
          })
        }
      >
        <Plus size={14} /> {t("controls.addPart")}
      </button>
    </div>
  );
}

/** THE control of one metric — the only place a `ControlKind` is drawn. */
export function ValueControl(props: ValueControlProps) {
  const { metric, control, draft, set, disabled, idPrefix } = props;
  if (control.kind === "breakdown") return <BreakdownControl {...props} />;
  if (
    (control.kind === "code" || control.kind === "codeList") &&
    METRIC_CHOICES[metric.metric_key]
  )
    return <ChoiceControl {...props} />;

  const value = control.kind === "codeList" ? draft.lines : draft.text;
  const onChange = (next: string) =>
    set(control.kind === "codeList" ? { lines: next } : { text: next });

  return (
    <ScalarControl
      kind={control.kind}
      id={`${idPrefix}-value`}
      label={metricLabel(metric)}
      unit={metricUnit(metric)}
      value={value}
      onChange={onChange}
      disabled={disabled}
      {...(metric.text?.hint ? { hint: metric.text.hint } : {})}
    />
  );
}
