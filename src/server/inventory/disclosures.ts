// `disclosure_record` — the narrative and scalar half of a VSME report (DM-18,
// DM-19, §4.12, S1, PG-6). DM-19: the twelve DataTypes reach five value columns
// and EXACTLY ONE is non-null (NULL is the only emptiness; breakdown metrics
// live wholly in `value_json`). PG-6: a metric of a module the plan lacks is
// refused 422 in the SAME hook as an unknown metric — a module is not a quota,
// so it is deliberately not a 402 guard.
//
// See docs/decisions/disclosure-records-dm19-pg6.md for the full account.
import { eq } from "drizzle-orm";

import {
  booleanOrNull,
  decimalOrNull,
  isoDateOrNull,
  num,
  textOrNull,
  type ParseResult,
} from "@/server/api/parse";
import { getEntitlements } from "@/server/billing/guard";
import { moduleFeature } from "@/server/billing/modules";
import type { DbClient } from "@/server/db/client";
import { disclosureRecord, metricCatalog } from "@/server/db/schema";
import { isDataType, type DataType } from "@/shared/enums";

import type { NewRowValues, RowValues } from "./rows";
import type { InputRow } from "./tables";
import {
  asNewRowValues,
  collectMixin,
  fieldCollector,
  MIXIN_REFERENCES,
  objectBody,
  serialiseMixin,
  type CompanySession,
  type RowMixinDto,
  type RowPrepareContext,
  type RowPrepared,
  type RowWireContract,
} from "./wire";

/** A `disclosure_record` row as Drizzle returns it. */
type DisclosureRecordRow = typeof disclosureRecord.$inferSelect;

// ─── The five value columns ──────────────────────────────────────────────────

/**
 * The value columns of §4.12, API name → Drizzle column name.
 *
 * `value_type` is NOT one of them and is NOT in the parser: it is DERIVED from
 * the catalogue by the hook below, the same way `location_factor_id` is derived
 * by CALC-5 (`./purchased-energy`). Accepting it from a body would let a client
 * declare a metric's type — and a row whose `value_type` disagreed with its
 * metric would be unreadable by every consumer that trusts the catalogue.
 */
const VALUE_COLUMNS = {
  value_numeric: "valueNumeric",
  value_text: "valueText",
  value_boolean: "valueBoolean",
  value_date: "valueDate",
  value_json: "valueJson",
} as const;

/** One of the five value fields, as the API names it. */
export type ValueField = keyof typeof VALUE_COLUMNS;

const VALUE_FIELDS = Object.keys(VALUE_COLUMNS) as ValueField[];

/** DM-19 — the column each of the 12 `DataType`s writes into. See the header. */
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

// ─── DTO ─────────────────────────────────────────────────────────────────────

/**
 * One version of a disclosure as the API speaks it: the 19 mixin fields (§4.8)
 * — `metric_key` among them, never null on this table — plus the typed value.
 *
 * All five value fields are serialised, not just the populated one: a client
 * that only saw the field its metric uses could not tell a row that answers
 * `false` from a row that answers nothing, and the whole point of DM-19 is that
 * the answer's LOCATION is meaningful.
 */
export interface DisclosureDto extends RowMixinDto {
  value_type: string;
  value_numeric: number | null;
  value_text: string | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_json: unknown;
}

/** THE serialiser. Every response about a disclosure goes through it. */
function serialiseDisclosure(row: InputRow): DisclosureDto {
  const r = row as DisclosureRecordRow;
  return {
    ...serialiseMixin(row),
    value_type: r.valueType,
    value_numeric: num(r.valueNumeric),
    value_text: r.valueText,
    value_boolean: r.valueBoolean,
    value_date: r.valueDate,
    value_json: r.valueJson ?? null,
  };
}

// ─── Parsing, stage one: what a column can physically hold ───────────────────

/**
 * Whatever JSON the body carried, or NULL.
 *
 * The body has already been through `JSON.parse`, so anything here is storable
 * in a `jsonb`; WHICH json a metric's `value_type` allows is stage two's. `""`
 * clears the column for the same reason it does everywhere else — that is how a
 * form says "no answer".
 */
function jsonOrNull(raw: unknown): unknown {
  if (raw === null || raw === "") return null;
  return raw;
}

/**
 * Wire → columns, SHAPE only (the `@/server/api/parse` line).
 *
 * Every value field is OPTIONAL here, including on a create: "exactly one of
 * them" is not a property any single field has, and stage two — which knows
 * which one the metric wants — is the only place that can say so. What this
 * stage does refuse is a number where a date goes.
 */
function parseInput(
  body: unknown,
  opts: { partial: boolean },
): ParseResult<RowValues> {
  const input = objectBody(body);
  if (!input) return { ok: false, field: "body" };

  const fields = fieldCollector(input, opts);
  collectMixin(fields, { metricKey: "required" });
  fields.optional("value_numeric", "valueNumeric", (raw) => decimalOrNull(raw));
  fields.optional("value_text", "valueText", textOrNull);
  fields.optional("value_boolean", "valueBoolean", booleanOrNull);
  fields.optional("value_date", "valueDate", isoDateOrNull);
  fields.optional("value_json", "valueJson", jsonOrNull);
  return fields.result();
}

/** POST body → the columns of a NEW disclosure. */
function parseNewDisclosure(body: unknown): ParseResult<NewRowValues> {
  const parsed = parseInput(body, { partial: false });
  return parsed.ok ? asNewRowValues(parsed.values) : parsed;
}

/** PATCH body → the columns to change (absent key = leave alone, LC-5). */
function parseDisclosurePatch(body: unknown): ParseResult<RowValues> {
  return parseInput(body, { partial: true });
}

// ─── Parsing, stage two: what THIS metric asks for ───────────────────────────

/** The catalogue facts a disclosure is judged against (DM-20, §4.13). */
interface CatalogMetric {
  readonly metricKey: string;
  readonly module: string;
  readonly valueType: DataType;
  readonly breakdown: BreakdownSpec | undefined;
}

/** `metric_catalog.breakdown_dimensions` (S1) as the seed generator writes it. */
interface BreakdownSpec {
  /** The dimensions a split may be reported along, e.g. `["energy_source"]`. */
  readonly dimensions: readonly string[];
  /** `true` — the split is reported "if obtainable", so it may be absent. */
  readonly ifObtainable: boolean;
}

/** `breakdown_dimensions` → the two facts the check needs, or `undefined`. */
function breakdownSpec(raw: unknown): BreakdownSpec | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const spec = raw as Record<string, unknown>;
  const dimensions = Array.isArray(spec.dimensions)
    ? spec.dimensions.filter((d): d is string => typeof d === "string")
    : [];
  if (dimensions.length === 0) return undefined;
  return { dimensions, ifObtainable: spec.if_obtainable !== false };
}

/**
 * The metric a body names, or `undefined` when the catalogue has no such key.
 *
 * `is_active` is NOT filtered. Deactivating a metric is how the catalogue is
 * versioned by data (DM-20), and a filter here would make every existing row on
 * a retired metric uneditable — including uneditable to correct or withdraw it.
 * Whether a retired metric may still be ANSWERED is a catalogue-versioning
 * question, and it belongs to whoever retires one, not to this parser.
 */
async function loadMetric(
  db: DbClient,
  metricKey: string,
): Promise<CatalogMetric | undefined> {
  const [row] = await db
    .select({
      metricKey: metricCatalog.metricKey,
      module: metricCatalog.module,
      valueType: metricCatalog.valueType,
      breakdownDimensions: metricCatalog.breakdownDimensions,
    })
    .from(metricCatalog)
    .where(eq(metricCatalog.metricKey, metricKey))
    .limit(1);
  if (!row) return undefined;
  // A `value_type` outside the 12 would be a corrupt catalogue row, not a bad
  // request: refuse the write rather than write a row nothing can read back.
  if (!isDataType(row.valueType)) return undefined;
  return {
    metricKey: row.metricKey,
    module: row.module,
    valueType: row.valueType,
    breakdown: breakdownSpec(row.breakdownDimensions),
  };
}

/**
 * PG-6 — may this company record a value against this metric? Returns the
 * plan feature the metric's module needs and the company lacks, or `null`.
 *
 * Two modules are gated the same way: VSME Comprehensive (`vsmeComprehensive`)
 * and, since партия 9, the simplified ESRS (`simplifiedEsrs`, 0021) —
 * `moduleFeature` is the one list of them.
 *
 * Reads `writeFeatures` rather than `features`: recording a disclosure is a
 * write, and a lapsed subscription in `readonly` mode writes at trial level
 * (§9). NOT `requireFeature`, which answers 402 — see the header.
 */
async function missingModuleFeature(
  session: CompanySession,
  metric: CatalogMetric,
): Promise<"vsmeComprehensive" | "simplifiedEsrs" | null> {
  const feature = moduleFeature(metric.module);
  if (!feature) return null;
  const entitlements = await getEntitlements(session);
  return entitlements.writeFeatures[feature] ? null : feature;
}

/** The value fields that are non-empty on the row a write would produce. */
function filledFields(row: Readonly<Record<string, unknown>>): ValueField[] {
  return VALUE_FIELDS.filter((field) => {
    const value = row[VALUE_COLUMNS[field]];
    // NULL is the only emptiness (see the header): `false` and `0` are answers.
    return value !== null && value !== undefined;
  });
}

/**
 * The row a write would produce, as far as the value columns go: the body's
 * columns over the version being superseded (LC-5 — a PATCH is a delta).
 */
function mergedValues(
  values: RowValues,
  current: InputRow | undefined,
): Record<string, unknown> {
  const previous = (current ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const field of VALUE_FIELDS) {
    const column = VALUE_COLUMNS[field];
    merged[column] =
      column in values ? values[column] : (previous[column] ?? null);
  }
  return merged;
}

/** Is `value` a plain (non-array) JSON object? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string — what an `enum` code or a `reference` id has to be. */
function isCode(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Does the NUMERIC hold a figure of this type? `value_numeric` arrives as the
 * string the column stores, so the comparison is on `Number(...)`.
 *
 * `percentage` is bounded 0–100 HERE rather than by a rule, the `floor_area`
 * case of `org/facilities.ts`: no VAL-* code owns the range, so a parser that
 * passed `140` through would be handing the renderer a percentage nothing ever
 * refuses. `integer` refuses a fraction for the same reason — the column is
 * NUMERIC for all three types, so nothing else would.
 */
function numericFits(valueType: DataType, value: unknown): boolean {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  if (valueType === "integer") return Number.isInteger(n);
  if (valueType === "percentage") return n >= 0 && n <= 100;
  return true;
}

/** Does the JSON hold a value of this type (breakdowns aside)? */
function jsonFits(valueType: DataType, value: unknown): boolean {
  switch (valueType) {
    case "enum":
    case "reference":
      return isCode(value);
    case "multi_enum":
    case "multi_reference":
      return Array.isArray(value) && value.length > 0 && value.every(isCode);
    default:
      // A scalar type only reaches `value_json` through a breakdown metric, and
      // `breakdownFault` judges that shape instead.
      return false;
  }
}

/**
 * The fault in a breakdown value, or `undefined` when it is well-formed.
 *
 * WHAT IS CHECKED: `{total, breakdown}` — the total in the metric's own scalar
 * type, and the split as `{<dimension>: {<label>: <figure>}}` over the
 * dimensions the CATALOGUE declares. A dimension the catalogue never named is
 * refused, because a breakdown along an invented axis cannot be rendered against
 * the standard's own table.
 *
 * WHAT IS NOT CHECKED: whether the parts add up to the total. That is a
 * reconciliation, it has a rule family of its own (VAL-034 does it for the
 * calculation layer), and "breakdown if obtainable" (S1) means a partial split
 * is the NORMAL case — refusing one here would refuse the thing the workbook
 * asks for.
 */
function breakdownFault(
  metric: CatalogMetric,
  spec: BreakdownSpec,
  value: unknown,
): Record<string, unknown> | undefined {
  const shape = { reason: "breakdown_shape", expected: "{total, breakdown}" };
  if (!isPlainObject(value)) return shape;

  const total = value.total;
  if (total === undefined || total === null) {
    return { reason: "breakdown_total_required" };
  }
  if (!scalarFits(metric.valueType, total)) {
    return { reason: "breakdown_total_type", value_type: metric.valueType };
  }

  const split = value.breakdown;
  if (split === undefined || split === null) {
    // `if_obtainable` (S1) — the split may be missing; the TOTAL still lives in
    // `value_json`, so obtaining it later is an edit of one field, not a move
    // between two.
    return spec.ifObtainable ? undefined : { reason: "breakdown_required" };
  }
  if (!isPlainObject(split)) return shape;

  for (const [dimension, parts] of Object.entries(split)) {
    if (!spec.dimensions.includes(dimension)) {
      return {
        reason: "breakdown_unknown_dimension",
        dimension,
        dimensions: spec.dimensions,
      };
    }
    if (!isPlainObject(parts) || Object.keys(parts).length === 0) {
      return { reason: "breakdown_parts_shape", dimension };
    }
    for (const [label, part] of Object.entries(parts)) {
      if (label.trim() === "" || !scalarFits(metric.valueType, part)) {
        return { reason: "breakdown_part_type", dimension, label };
      }
    }
  }
  return undefined;
}

/** A total or a part of a breakdown, judged by the metric's own scalar type. */
function scalarFits(valueType: DataType, value: unknown): boolean {
  if (typeof value !== "number") return false;
  return numericFits(valueType, value);
}

/**
 * DM-19 — the whole typed-value check, as a refusal payload or `undefined`.
 *
 * The order is the order a form fills in: which field, then what is in it.
 */
function valueFault(
  metric: CatalogMetric,
  merged: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const spec = metric.breakdown;
  // A breakdown metric OVERRIDES the type→column map: total and split together
  // in `value_json`, whatever the scalar type says (S1, DM-19).
  const expected: ValueField = spec
    ? "value_json"
    : VALUE_FIELD_BY_TYPE[metric.valueType];
  const filled = filledFields(merged);

  if (filled.length === 0) {
    return {
      field: expected,
      reason: "value_required",
      value_type: metric.valueType,
    };
  }
  if (filled.length > 1) {
    return { field: "value", reason: "one_value_only", provided: filled };
  }

  const [field] = filled;
  if (field !== expected) {
    return {
      field,
      reason: spec ? "breakdown_requires_json" : "value_type_mismatch",
      value_type: metric.valueType,
      expected_field: expected,
    };
  }

  const value = merged[VALUE_COLUMNS[field]];
  if (spec) {
    const fault = breakdownFault(metric, spec, value);
    return fault ? { field: "value_json", ...fault } : undefined;
  }
  if (field === "value_numeric" && !numericFits(metric.valueType, value)) {
    return {
      field,
      reason: "value_type_mismatch",
      value_type: metric.valueType,
    };
  }
  if (field === "value_json" && !jsonFits(metric.valueType, value)) {
    return {
      field,
      reason: "value_type_mismatch",
      value_type: metric.valueType,
    };
  }
  // `value_text`, `value_boolean` and `value_date` are already exactly what
  // their column can hold — stage one saw to that, and no `DataType` narrows
  // them further.
  return undefined;
}

/**
 * THE SECOND PARSING STAGE (`RowPrepare`, `./wire`) — the catalogue lookup,
 * PG-6 and DM-19, in the order a refusal should be read in: does the metric
 * exist, may this company answer it, is the answer the right shape.
 *
 * IT ALSO WRITES `value_type`, which is why it returns values rather than a
 * verdict: the column is NOT NULL and its authority is `metric_catalog`, so the
 * only honest source is the row that was just read.
 */
async function prepareDisclosure(ctx: RowPrepareContext): Promise<RowPrepared> {
  const current = ctx.current as DisclosureRecordRow | undefined;
  const bodyKey = ctx.values.metricKey;
  const metricKey = typeof bodyKey === "string" ? bodyKey : current?.metricKey;
  if (typeof metricKey !== "string") {
    // Only reachable on a PATCH of a row that does not exist; `editRow` answers
    // NOT_FOUND for it, and pre-empting that here would answer the wrong thing.
    return { ok: true, values: ctx.values };
  }

  const metric = await loadMetric(ctx.db, metricKey);
  if (!metric) {
    return {
      ok: false,
      detail: { field: "metric_key", reason: "unknown_metric", metricKey },
    };
  }

  // PG-6 fires on a CREATE and on an edit that MOVES a row onto a comprehensive
  // metric — both of which are a plan recording Comprehensive data it is not
  // entitled to. It does NOT fire on an edit that leaves the metric alone: a
  // company that downgrades must still be able to correct or withdraw the rows
  // it already has, and stranding them would make the gate a data trap rather
  // than a module boundary.
  const adoptsMetric = !current || current.metricKey !== metric.metricKey;
  const missing = adoptsMetric
    ? await missingModuleFeature(ctx.session, metric)
    : null;
  if (missing) {
    return {
      ok: false,
      detail: {
        field: "metric_key",
        // The Comprehensive wording predates the second module and is kept
        // (`disclosures.integration` asserts it); the ESRS one follows it.
        reason:
          missing === "vsmeComprehensive"
            ? "comprehensive_module_unavailable"
            : "simplified_esrs_module_unavailable",
        module: metric.module,
        metric_key: metric.metricKey,
        required_feature: missing,
      },
    };
  }

  const fault = valueFault(metric, mergedValues(ctx.values, current));
  if (fault) return { ok: false, detail: fault };

  return { ok: true, values: { ...ctx.values, valueType: metric.valueType } };
}

/** The contract `./row-routes` serves `/api/disclosures` from. */
export const DISCLOSURE_CONTRACT: RowWireContract<DisclosureDto> = {
  table: "disclosure_record",
  listKey: "disclosures",
  serialise: serialiseDisclosure,
  parseNew: parseNewDisclosure,
  parsePatch: parseDisclosurePatch,
  references: MIXIN_REFERENCES,
  prepare: prepareDisclosure,
};
