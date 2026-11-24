// THE CATALOGUE, AS A FORM (T3.5b — UI-2, DM-18, DM-19, S1, К-26, PG-6, О-5).
// `/inventory/disclosures` is one generic form driven by `metric_catalog`:
// control from `value_type`, required-ness from `requirement_type`, section
// from `disclosure_code`, order from `sort_order`. Every decision that could
// silently go wrong is a pure function here, tested against the real catalogue.
//
// See docs/decisions/disclosure-form-catalogue.md for the full account.
import { isDataType, type DataType } from "@/shared/enums";

import type { DisclosureDto, MetricDto } from "./api";

// ─── DM-19: the five value columns ───────────────────────────────────────────

/** One of the five value fields of §4.12, as the API names it. */
export type ValueField =
  | "value_numeric"
  | "value_text"
  | "value_boolean"
  | "value_date"
  | "value_json";

/** Every value field, in the order §4.12 lists them. */
const VALUE_FIELDS: readonly ValueField[] = [
  "value_numeric",
  "value_text",
  "value_boolean",
  "value_date",
  "value_json",
];

/**
 * DM-19 — the column each of the 12 `DataType`s writes into.
 *
 * A COPY of `@/server/inventory/disclosures#VALUE_FIELD_BY_TYPE`, pinned equal
 * to it by the test. See the header for why it cannot be an import.
 */
export const VALUE_FIELD_BY_TYPE: Readonly<Record<DataType, ValueField>> = {
  string: "value_text",
  text: "value_text",
  integer: "value_numeric",
  decimal: "value_numeric",
  percentage: "value_numeric",
  boolean: "value_boolean",
  date: "value_date",
  datetime: "value_date",
  enum: "value_json",
  multi_enum: "value_json",
  reference: "value_json",
  multi_reference: "value_json",
};

// ─── The renderer map: one control per DataType ──────────────────────────────

/**
 * The controls the form knows how to draw. NINE for the twelve types, because
 * three pairs are the same control with different copy:
 *
 *   • `line` vs `paragraph` — `string` and `text` differ PRESENTATIONALLY (an
 *     input versus a textarea) and share one column; that is the whole
 *     difference, and it is a control difference, so both exist.
 *   • `date` serves `date` AND `datetime`. The server maps both onto
 *     `value_date`, which holds an ISO **date** (`isoDateOrNull`), so a
 *     datetime-picker would compose a value the API refuses. There is no
 *     `datetime` metric in the seeded 141; when one arrives, the time-of-day
 *     needs a spec decision (a second column is what DM-19 forbids), not a
 *     control the API would reject today.
 *   • `code` serves `enum` and `reference`, `codeList` serves `multi_enum` and
 *     `multi_reference`. `metric_catalog` declares NO option list for any of
 *     them — the choices live in the metric's own prose («OPTION A: Basic либо
 *     OPTION B: Basic + Comprehensive») — so a `<select>` here would have to
 *     invent a domain the standard did not give it. A code input renders what
 *     the catalogue actually knows: a string, or a list of them.
 *
 * `breakdown` is not in the map: it is chosen by `controlFor` from
 * `breakdown_dimensions`, over whatever the scalar type would have picked.
 */
export type ControlKind =
  | "decimal"
  | "integer"
  | "percentage"
  | "line"
  | "paragraph"
  | "boolean"
  | "date"
  | "code"
  | "codeList"
  | "breakdown";

/**
 * THE RENDERER MAP — a total function over the 12 `DataType`s.
 *
 * `Record<DataType, …>` is what makes the compiler the first line of defence: a
 * 13th type cannot be added to `DATA_TYPES` without this file failing to build.
 * The test is the second line and the one that reads the REAL catalogue.
 */
export const CONTROL_BY_TYPE: Readonly<Record<DataType, ControlKind>> = {
  string: "line",
  text: "paragraph",
  integer: "integer",
  decimal: "decimal",
  percentage: "percentage",
  boolean: "boolean",
  date: "date",
  datetime: "date",
  enum: "code",
  multi_enum: "codeList",
  reference: "code",
  multi_reference: "codeList",
};

// ─── `breakdown_dimensions` (S1) ─────────────────────────────────────────────

/** `metric_catalog.breakdown_dimensions` as the seed generator writes it. */
export interface BreakdownSpec {
  /** The axes a split may be reported along, e.g. `["energy_source"]`. */
  readonly dimensions: readonly string[];
  /** `true` — the split is reported "if obtainable", so it may be absent (S1). */
  readonly ifObtainable: boolean;
}

/**
 * `breakdown_dimensions` → the two facts the form needs, or `null`.
 *
 * Deliberately the same reading as the server's (`breakdownSpec` in
 * `@/server/inventory/disclosures`): an empty dimension list is NOT a breakdown,
 * so a catalogue row with `{dimensions: []}` renders as its scalar type instead
 * of as an editor with nothing to edit.
 */
export function breakdownSpec(raw: unknown): BreakdownSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const spec = raw as Record<string, unknown>;
  const dimensions = Array.isArray(spec.dimensions)
    ? spec.dimensions.filter((d): d is string => typeof d === "string")
    : [];
  if (dimensions.length === 0) return null;
  return { dimensions, ifObtainable: spec.if_obtainable !== false };
}

// ─── What one metric renders as ──────────────────────────────────────────────

/** The rendering decision for one metric — everything a control needs. */
export interface MetricControl {
  /** The catalogue's `value_type`, narrowed to the 12. */
  readonly valueType: DataType;
  /** The control to draw: `breakdown` when the metric declares dimensions. */
  readonly kind: ControlKind;
  /**
   * The control the TOTAL of a breakdown is typed as — i.e. what `kind` would
   * have been without the dimensions. Equal to `kind` for every other metric.
   */
  readonly scalar: ControlKind;
  /** The value field this metric's whole answer goes into (DM-19). */
  readonly field: ValueField;
  /** The declared split, or `null`. */
  readonly breakdown: BreakdownSpec | null;
}

/** The catalogue facts the pure layer reads. `MetricDto` satisfies it. */
export interface MetricLike {
  readonly metric_key: string;
  readonly value_type: string;
  readonly breakdown_dimensions: unknown;
}

/**
 * How this metric is rendered and where its value goes — or `null` when the
 * catalogue row carries a `value_type` outside the 12.
 *
 * `null` is not a theoretical branch: it is the same judgement the server makes
 * (`loadMetric` refuses a row whose `value_type` is not a `DataType`), and the
 * screen renders such a metric as unsupported rather than guessing a control for
 * it. The test asserts the real catalogue yields none.
 */
export function controlFor(metric: MetricLike): MetricControl | null {
  if (!isDataType(metric.value_type)) return null;
  const valueType: DataType = metric.value_type;
  const scalar = CONTROL_BY_TYPE[valueType];
  const breakdown = breakdownSpec(metric.breakdown_dimensions);
  return {
    valueType,
    kind: breakdown ? "breakdown" : scalar,
    scalar,
    // S1/DM-19 — a breakdown metric's whole value lives in `value_json`,
    // whatever the scalar type says. See the header.
    field: breakdown ? "value_json" : VALUE_FIELD_BY_TYPE[valueType],
    breakdown,
  };
}

// ─── Sections: `disclosure_code`, in `sort_order` ────────────────────────────

/** One disclosure of the standard (B1…B11, C1…C9) as a screen section. */
export interface Section {
  /** `disclosure_code` — the section's identity and its message-free label. */
  readonly code: string;
  /** The standard's own heading (О-20: `disclosure_title_en`, then the RU). */
  readonly title: string;
  /** `basic` | `comprehensive` | `simplified_esrs` — the section's module. */
  readonly module: string;
  /** `vsme` | `esrs` — which standard the section belongs to (0019). */
  readonly standard: string;
  /** The lowest `sort_order` in the section — the workbook's own order. */
  readonly sortOrder: number;
  /** The section's metrics, in `sort_order` then `metric_key`. */
  readonly metrics: readonly MetricDto[];
}

/** `sort_order`, then the key — the catalogue's own reading order. */
function byOrder(a: MetricDto, b: MetricDto): number {
  return (
    a.sort_order - b.sort_order || a.metric_key.localeCompare(b.metric_key)
  );
}

/**
 * THE GROUPING — every `disclosure_code` of the catalogue becomes a section.
 *
 * IT IS DERIVED, NOT LISTED. A hard-coded B1…B11 would be a screen that silently
 * drops C1…C9 (the Comprehensive module a `pro` plan pays for), and a catalogue
 * revision that added a code would leave its metrics with nowhere to be entered
 * — invisibly, because nothing would fail. Deriving the sections makes "no
 * disclosure_code is left without a screen" true by construction, and the test
 * asserts it against the real catalogue anyway.
 */
export function sectionsOf(metrics: readonly MetricDto[]): Section[] {
  const groups = new Map<string, MetricDto[]>();
  for (const metric of metrics) {
    const group = groups.get(metric.disclosure_code);
    if (group) group.push(metric);
    else groups.set(metric.disclosure_code, [metric]);
  }
  return [...groups.entries()]
    .map(([code, group]): Section => {
      const sorted = [...group].sort(byOrder);
      const first = sorted[0];
      return {
        code,
        // Партия 18 — the disclosure's name in the UI language when the
        // catalogue came with `text`; the English title otherwise.
        title:
          first.text?.disclosure ??
          first.disclosure_title_en ??
          first.disclosure_title ??
          code,
        module: first.module,
        standard: first.standard,
        sortOrder: Math.min(...sorted.map((m) => m.sort_order)),
        metrics: sorted,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}

/**
 * The metrics a screen offers: the active ones, plus any RETIRED metric this
 * revision already holds an answer for.
 *
 * Deactivating a metric is how the catalogue is versioned by data (DM-20), and
 * the server deliberately does not filter `is_active` when judging a write — a
 * retired metric's existing row must stay correctable and withdrawable. Hiding
 * it here would strand exactly that row: visible in the report, uneditable on
 * the screen.
 */
export function visibleMetrics(
  metrics: readonly MetricDto[],
  answered: ReadonlySet<string>,
): MetricDto[] {
  return metrics.filter(
    (metric) => metric.is_active || answered.has(metric.metric_key),
  );
}

// ─── The three states ────────────────────────────────────────────────────────

/** The state set this screen shows and `T5.6` prints. See the header. */
export const DISCLOSURE_STATES = [
  "filled",
  "not_collected",
  "not_applicable",
] as const;
export type DisclosureState = (typeof DISCLOSURE_STATES)[number];

/** A `disclosure_record` as the state derivation reads it. */
export type RecordLike = Pick<DisclosureDto, ValueField>;

/**
 * WHICH value field this record answers in, or `null` when it answers none.
 *
 * NULL IS THE ONLY EMPTINESS — the server's own rule (`filledFields`), restated
 * because the screen must agree with it: `false` and `0` are answers, and `""`
 * never reaches the column (the parser stores NULL for it). Two non-empty fields
 * cannot be written through the API, so they read as "no single answer" rather
 * than as one picked arbitrarily.
 */
export function filledField(record: RecordLike | null): ValueField | null {
  if (!record) return null;
  const filled = VALUE_FIELDS.filter((field) => {
    const value = record[field];
    return value !== null && value !== undefined;
  });
  return filled.length === 1 ? filled[0] : null;
}

/** May this company record a value against a metric of this module (PG-6)? */
export function moduleAvailable(
  module: string,
  comprehensive: boolean,
  simplifiedEsrs = false,
): boolean {
  if (module === "comprehensive") return comprehensive;
  if (module === "simplified_esrs") return simplifiedEsrs;
  return true;
}

/**
 * The simplified-ESRS layer (0021), resolved like `comprehensiveWritable`: the
 * WRITE features and an active subscription. Same gate shape, second module.
 */
export function simplifiedEsrsWritable(entitlement: {
  readonly features: { readonly simplifiedEsrs: boolean };
  readonly mode: "active" | "locked" | "readonly";
}): boolean {
  return entitlement.mode === "active" && entitlement.features.simplifiedEsrs;
}

/**
 * THE STATE of one metric in one revision — the function `T5.6`'s three
 * printings correspond to.
 *
 * `comprehensive` is the entitlement, not the plan name: the caller resolves it
 * the way `getEntitlements` does (see `comprehensiveWritable`).
 */
export function metricState(input: {
  readonly metric: { readonly module: string };
  readonly record: RecordLike | null;
  readonly comprehensive: boolean;
  readonly simplifiedEsrs?: boolean;
}): DisclosureState {
  if (
    !moduleAvailable(
      input.metric.module,
      input.comprehensive,
      input.simplifiedEsrs ?? false,
    )
  ) {
    return "not_applicable";
  }
  return filledField(input.record) ? "filled" : "not_collected";
}

/**
 * PG-6 on the client — may this session WRITE Comprehensive metrics?
 *
 * It mirrors `getEntitlements`' `writeFeatures`, not `features`: recording a
 * disclosure is a write, and a lapsed subscription (`readonly`/`locked`) writes
 * at trial level (§9), where `vsmeComprehensive` is false. Getting this wrong in
 * the permissive direction would offer a form whose every save is refused; in
 * the strict direction it locks a metric the server would have accepted. Hence
 * the same two inputs the server uses, and nothing derived from the plan NAME.
 */
export function comprehensiveWritable(entitlement: {
  readonly features: { readonly vsmeComprehensive: boolean };
  readonly mode: "active" | "locked" | "readonly";
}): boolean {
  return (
    entitlement.mode === "active" && entitlement.features.vsmeComprehensive
  );
}

/** How many metrics of a section are in each state — the section's headline. */
export function sectionSummary(
  section: Section,
  recordOf: (metricKey: string) => RecordLike | null,
  comprehensive: boolean,
  simplifiedEsrs = false,
): Record<DisclosureState, number> {
  const counts: Record<DisclosureState, number> = {
    filled: 0,
    not_collected: 0,
    not_applicable: 0,
  };
  for (const metric of section.metrics) {
    counts[
      metricState({
        metric,
        record: recordOf(metric.metric_key),
        comprehensive,
        simplifiedEsrs,
      })
    ] += 1;
  }
  return counts;
}

// ─── The draft of one answer ─────────────────────────────────────────────────

/** One row of a split: which axis, which label, how much. */
export interface BreakdownRow {
  readonly dimension: string;
  readonly label: string;
  readonly amount: string;
}

/**
 * One metric's answer as its controls hold it — strings, like every other form
 * of this app (`useAutosave`'s header).
 *
 * THE ONE PLACE THAT IS NOT A STRING ON THE WIRE is `value_json`: a breakdown's
 * total and parts must cross as JSON **numbers** (the server's `scalarFits`
 * requires `typeof value === "number"`), and a list of codes as a JSON array.
 * `valueBody` is where the conversion happens — once, in a tested function,
 * rather than scattered across the controls.
 */
export interface ValueDraft {
  /** The scalar answer, the breakdown TOTAL, or the single code. */
  readonly text: string;
  /** `codeList` — one code per line. */
  readonly lines: string;
  /** `breakdown` — the split, one row per (dimension, label). */
  readonly rows: readonly BreakdownRow[];
}

export const EMPTY_DRAFT: ValueDraft = { text: "", lines: "", rows: [] };

/** A wire value as a control holds it: `null` → `""`, `false` → `"false"`. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** One code per line, blanks dropped — the `codeList` reading, both ways. */
function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Is this JSON value a plain (non-array) object? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The record's stored answer, back in the controls' vocabulary.
 *
 * The inverse of `valueBody` for everything the form can compose, which is what
 * makes an EDIT an edit: the user sees what is stored, changes one part of it,
 * and the whole value is written back as one field (DM-19). A value the form
 * cannot represent (hand-written JSON, say) yields an empty draft rather than a
 * lossy one — the screen says the record holds a value it cannot edit instead of
 * offering to overwrite it with a misreading.
 */
export function draftOf(
  control: MetricControl,
  record: RecordLike | null,
): ValueDraft {
  if (!record || filledField(record) !== control.field) return EMPTY_DRAFT;

  if (control.kind === "breakdown") {
    const json = record.value_json;
    if (!isPlainObject(json)) return EMPTY_DRAFT;
    const rows: BreakdownRow[] = [];
    const split = json.breakdown;
    if (isPlainObject(split)) {
      for (const [dimension, parts] of Object.entries(split)) {
        if (!isPlainObject(parts)) continue;
        for (const [label, amount] of Object.entries(parts)) {
          rows.push({ dimension, label, amount: asText(amount) });
        }
      }
    }
    return { text: asText(json.total), lines: "", rows };
  }

  if (control.kind === "codeList") {
    const json = record.value_json;
    if (!Array.isArray(json)) return EMPTY_DRAFT;
    return {
      ...EMPTY_DRAFT,
      lines: json.filter((c): c is string => typeof c === "string").join("\n"),
    };
  }

  if (control.kind === "code") {
    const json = record.value_json;
    return typeof json === "string"
      ? { ...EMPTY_DRAFT, text: json }
      : EMPTY_DRAFT;
  }

  return { ...EMPTY_DRAFT, text: asText(record[control.field]) };
}

/** Why a draft cannot be composed into a body. Never a refusal of a VALUE. */
type ValueFault = "empty" | "total_required" | "not_a_number";

/** A composed answer: ONE value field, or the reason there is nothing to send. */
export type ValueBody =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly fault: ValueFault };

/** Is this text a finite number? The only client-side judgement of a VALUE. */
function numeric(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * THE COMPOSER — one draft → the ONE value field DM-19 assigns the metric.
 *
 * IT NEVER REFUSES A VALUE THE SERVER WOULD ACCEPT (VR-2). The three faults are
 * not verdicts about a value:
 *   • `empty` — there is nothing to send at all, i.e. the metric is still `not
 *     collected`. Posting it would be refused as `value_required` anyway.
 *   • `total_required` — a breakdown with parts but no total. The total is the
 *     figure the report prints; a split without one is not a partial answer, it
 *     is an answer to a different question.
 *   • `not_a_number` — the draft cannot be turned into the JSON **number** a
 *     breakdown needs. This is a limit of the COMPOSITION, not a judgement of
 *     the figure: a `value_numeric` metric's text is passed through untouched
 *     and it is the server that decides whether `12,5` is a decimal.
 *
 * Everything else goes as the control holds it, because the server parsers
 * already speak exactly that vocabulary (`decimalOrNull` takes `"12.5"`,
 * `booleanOrNull` takes `"true"`, `isoDateOrNull` takes `"2024-01-31"`), and a
 * conversion layer here would be a second, silent copy of the contract.
 */
export function valueBody(
  control: MetricControl,
  draft: ValueDraft,
): ValueBody {
  if (control.kind === "breakdown") return breakdownBody(control, draft);

  if (control.kind === "codeList") {
    const codes = parseLines(draft.lines);
    if (codes.length === 0) return { ok: false, fault: "empty" };
    return { ok: true, body: { value_json: codes } };
  }

  const text = draft.text.trim();
  if (text === "") return { ok: false, fault: "empty" };
  if (control.kind === "code") return { ok: true, body: { value_json: text } };
  return { ok: true, body: { [control.field]: text } };
}

/**
 * A breakdown answer as ONE `value_json` (S1, DM-19): `{total, breakdown}`.
 *
 * `breakdown` is OMITTED when no row carries both a label and a figure —
 * "breakdown if obtainable" (S1) makes a total-only answer the normal case, and
 * an empty `{}` would be a claim that the split is known to be empty. A row half
 * filled in is dropped for the same reason: it is a row being typed, not a part.
 */
function breakdownBody(control: MetricControl, draft: ValueDraft): ValueBody {
  const rows = draft.rows.filter(
    (row) => row.label.trim() !== "" || row.amount.trim() !== "",
  );
  const total = numeric(draft.text);
  if (total === null) {
    // The three ways a total can be missing say three different things: nothing
    // has been entered at all (the metric is still not collected), the parts are
    // there but the figure the report prints is not, or what was typed is not a
    // number this form can turn into JSON.
    if (draft.text.trim() !== "") return { ok: false, fault: "not_a_number" };
    if (rows.length > 0) return { ok: false, fault: "total_required" };
    return { ok: false, fault: "empty" };
  }

  const split: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const label = row.label.trim();
    const amount = numeric(row.amount);
    if (label === "" || amount === null) {
      return { ok: false, fault: "not_a_number" };
    }
    const dimension = control.breakdown?.dimensions.includes(row.dimension)
      ? row.dimension
      : (control.breakdown?.dimensions[0] ?? row.dimension);
    split[dimension] = { ...(split[dimension] ?? {}), [label]: amount };
  }

  const value: Record<string, unknown> = { total };
  if (Object.keys(split).length > 0) value.breakdown = split;
  return { ok: true, body: { value_json: value } };
}

// ─── The records of a revision, by metric ────────────────────────────────────

/**
 * The current records of ONE legal entity, indexed by metric.
 *
 * WHY THE ENTITY IS PART OF THE KEY. `disclosure_record` carries the mixin's
 * `legal_entity_id` (NOT NULL, §4.8), so a consolidated report can hold one
 * answer per entity for the same metric. This screen edits ONE entity at a time
 * — the picker at the top — and a map keyed by metric alone would silently show
 * a subsidiary's answer while writing the parent's.
 *
 * Several records for one metric and one entity are possible (the mixin also
 * carries `facility_id` and `year_month`): the FIRST is the one the form edits,
 * and the count is returned so the screen can say the others exist rather than
 * pretend they do not.
 */
export function recordsByMetric(
  records: readonly DisclosureDto[],
  legalEntityId: string | null,
): Map<string, DisclosureDto[]> {
  const byMetric = new Map<string, DisclosureDto[]>();
  for (const record of records) {
    if (legalEntityId && record.legal_entity_id !== legalEntityId) continue;
    if (!record.metric_key) continue;
    const group = byMetric.get(record.metric_key);
    if (group) group.push(record);
    else byMetric.set(record.metric_key, [record]);
  }
  return byMetric;
}
