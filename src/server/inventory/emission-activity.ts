// =============================================================================
// `emission_activity` — THE WIRE CONTRACT of Scope 1 (DM-15, §4.9, К-5, К-6).
//
// WHY IT IS A MODULE OF ITS OWN, beside a service that is deliberately generic.
// `./rows` implements the append-only PROTOCOL, which is the same for all four
// input tables because it touches only the shared mixin. What is NOT the same is
// the row's BODY: `emission_activity` has an activity category, a method and a
// refrigerant column group; `purchased_energy_activity` has a supplier and a
// consumption. Those need a parser and a serialiser each, and putting all four
// in the service would make the "generic" service a switch over four bodies.
// So the split is: one protocol, four wire contracts.
//
// WHAT T3.2 TOOK OUT OF THIS FILE. Writing the second and third contracts showed
// which half of it was about Scope 1 and which half was about being an input row
// at all: the 19 mixin DTO fields, their serialiser, the mixin half of the
// parser, `change_reason` and the create-time placement re-check went to
// `./wire`, unchanged in behaviour and now written once. What is left below is
// exactly the DM-15 body — which is what "one wire contract per table" was
// supposed to mean.
//
// К-6 IN PRACTICE — WHAT THE API CALLS THESE FIELDS. The Data Dictionary names
// them per category (`stationary_source_name`, `mobile_activity_value`,
// `fugitive_activity_type`, …); the model flattens the prefix into
// `activity_category` and keeps ONE set of columns. The wire follows the model,
// not the DD: a client sends `activity_category` plus the unprefixed names. The
// alternative — accepting five prefixed spellings of every field — would put the
// discriminator in the field NAMES, which is exactly what К-6 removed.
//
// К-5 IN PRACTICE — the six refrigerant figures are a COLUMN GROUP, not a second
// table and not a nested object: they are ordinary optional fields that only a
// `fugitive_emissions` row fills. Nothing here refuses them on another category
// — VAL-015/VAL-018 judge whether they make sense, and a parser that pre-empted
// a rule would produce `{field: …}` where the client expects a rule code.
// =============================================================================
import {
  booleanOrNull,
  decimalOrNull,
  num,
  oneOfOrNull,
  textOrNull,
  type ParseResult,
} from "@/server/api/parse";
import { emissionActivity } from "@/server/db/schema";
import { isCalculationMethod } from "@/shared/enums";

import type { NewRowValues, RowValues } from "./rows";
import type { InputRow } from "./tables";
import {
  asNewRowValues,
  collectMixin,
  fieldCollector,
  MIXIN_REFERENCES,
  objectBody,
  serialiseMixin,
  type RowMixinDto,
  type RowWireContract,
} from "./wire";

/** An `emission_activity` row as Drizzle returns it. */
type EmissionActivityRow = typeof emissionActivity.$inferSelect;

/**
 * The five categories of §4.9 — the structural discriminator (К-6, §0.8).
 *
 * Written here rather than in `@/shared/enums` on purpose, and the enums module
 * says why: a discriminator is the SHAPE of the schema (the CHECK constraint
 * `emission_activity_category_check` is its pair), not a domain list that may be
 * extended by data. Adding a sixth category is a new table shape.
 */
export const ACTIVITY_CATEGORIES = [
  "stationary_combustion",
  "mobile_combustion",
  "fugitive_emissions",
  "process_emissions",
  "onsite_generation",
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

/** Is `value` one of the five §4.9 categories? */
export function isActivityCategory(value: string): value is ActivityCategory {
  return (ACTIVITY_CATEGORIES as readonly string[]).includes(value);
}

// ─── DTO ─────────────────────────────────────────────────────────────────────

/**
 * One version of a Scope-1 row as the API speaks it: the 19 mixin fields
 * (`RowMixinDto`, §4.8) plus the DM-15 body, snake_case, NUMERIC as numbers.
 */
export interface EmissionActivityDto extends RowMixinDto {
  activity_category: string;
  source_name: string;
  activity_type: string;
  activity_value: number | null;
  method: string;
  biogenic_flag: boolean | null;
  refrigerant_added: number | null;
  refrigerant_recovered: number | null;
  equipment_capacity: number | null;
  opening_stock: number | null;
  closing_stock: number | null;
  leakage_rate: number | null;
}

/**
 * THE serialiser. Every response about a Scope-1 row goes through it.
 *
 * It takes the generic `InputRow` (what `./rows` returns) and narrows: the
 * service is honest about not knowing which table it wrote, and this is the one
 * place that knowledge comes back. The cast is the mirror image of the one in
 * `insertVersion` and is safe for the same reason — the caller named the table.
 */
function serialiseEmissionActivity(row: InputRow): EmissionActivityDto {
  const r = row as EmissionActivityRow;
  return {
    ...serialiseMixin(row),
    activity_category: r.activityCategory,
    source_name: r.sourceName,
    activity_type: r.activityType,
    activity_value: num(r.activityValue),
    method: r.method,
    biogenic_flag: r.biogenicFlag,
    refrigerant_added: num(r.refrigerantAdded),
    refrigerant_recovered: num(r.refrigerantRecovered),
    equipment_capacity: num(r.equipmentCapacity),
    opening_stock: num(r.openingStock),
    closing_stock: num(r.closingStock),
    leakage_rate: num(r.leakageRate),
  };
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** The six К-5 figures, API name → column. All optional, all kilograms but one. */
const REFRIGERANT_FIELDS = [
  ["refrigerant_added", "refrigerantAdded"],
  ["refrigerant_recovered", "refrigerantRecovered"],
  ["equipment_capacity", "equipmentCapacity"],
  ["opening_stock", "openingStock"],
  ["closing_stock", "closingStock"],
  ["leakage_rate", "leakageRate"],
] as const;

/**
 * Wire → columns, with per-field SHAPE validation only (see `./wire`'s header
 * for where that line is). Two consequences worth naming because they look like
 * omissions:
 *   • `activity_value` takes any finite number INCLUDING a negative one — the
 *     sign is VAL-011's, and narrowing it here would answer `{field:
 *     "activity_value"}` where the UI wants a rule code, leaving VAL-011
 *     implemented and unreachable;
 *   • `unit` is a code list, checked in `collectMixin`, but NOT against what the
 *     activity type can be priced in — that is VAL-014, which reads the pinned
 *     factor set rather than a constant.
 */
function parseInput(
  body: unknown,
  opts: { partial: boolean },
): ParseResult<RowValues> {
  const input = objectBody(body);
  if (!input) return { ok: false, field: "body" };

  const fields = fieldCollector(input, opts);
  collectMixin(fields);
  fields.required("activity_category", "activityCategory", (raw) =>
    oneOfOrNull(raw, isActivityCategory),
  );
  fields.required("source_name", "sourceName", textOrNull);
  fields.required("activity_type", "activityType", textOrNull);
  fields.required("activity_value", "activityValue", decimalOrNull);
  fields.required("method", "method", (raw) =>
    oneOfOrNull(raw, isCalculationMethod),
  );
  fields.optional("biogenic_flag", "biogenicFlag", booleanOrNull);
  for (const [api, column] of REFRIGERANT_FIELDS) {
    fields.optional(api, column, decimalOrNull);
  }
  return fields.result();
}

/** POST body → the columns of a NEW Scope-1 row. */
function parseNewEmissionActivity(body: unknown): ParseResult<NewRowValues> {
  const parsed = parseInput(body, { partial: false });
  return parsed.ok ? asNewRowValues(parsed.values) : parsed;
}

/**
 * PATCH body → the columns to change (absent key = leave alone).
 *
 * `revision_id` is accepted by the parser and DROPPED by the service: an edit
 * makes a new version of the same row in the same revision (LC-5), and moving
 * rows between revisions is seeding (LC-9, T3.4). It is stripped rather than
 * rejected so a client that echoes back the DTO it just read is not refused for
 * sending a field it did not change.
 */
function parseEmissionActivityPatch(body: unknown): ParseResult<RowValues> {
  return parseInput(body, { partial: true });
}

/** The contract `./row-routes` serves `/api/activities/emission` from. */
export const EMISSION_ACTIVITY_CONTRACT: RowWireContract<EmissionActivityDto> =
  {
    table: "emission_activity",
    listKey: "activities",
    serialise: serialiseEmissionActivity,
    parseNew: parseNewEmissionActivity,
    parsePatch: parseEmissionActivityPatch,
    references: MIXIN_REFERENCES,
  };
