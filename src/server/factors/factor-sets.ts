// FACTOR SETS AND THEIR FACTORS (T2.8 — DM-21, DM-22, UI-4, §12.2).
//
// See docs/decisions/server-factors-factor-sets.md for the full account.
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";

import {
  booleanOrNull,
  booleanValue,
  decimalOrNull,
  integerOrNull,
  isoDateOrNull,
  num,
  oneOfOrNull,
  textOrNull,
  uuidOrNull,
  type ParseResult,
} from "@/server/api/parse";
import type { DbClient } from "@/server/db/client";
import {
  isFactorOutputUnit,
  isCompatibleFactorOutput,
} from "@/shared/factor-output-units";
import { emissionFactor, factorSet, unitConversion } from "@/server/db/schema";
import { findKeyConflict } from "@/server/validation/evaluators/factors";
import {
  refuseValidation,
  ruleRef,
  writeValidated,
  type RuleRef,
} from "@/server/validation/write";
import {
  isBiogenicTreatment,
  isFactorStatus,
  isGWPBasis,
  isUnitCode,
  type FactorStatus,
} from "@/shared/enums";

/** A `factor_set` row as Drizzle returns it. */
export type FactorSetRow = typeof factorSet.$inferSelect;
/** An `emission_factor` row as Drizzle returns it. */
export type EmissionFactorRow = typeof emissionFactor.$inferSelect;

/** The column values a factor create/update writes (never `id`). */
export type FactorValues = Partial<
  Omit<typeof emissionFactor.$inferInsert, "id" | "factorSetId">
>;

/** A create's values: the eight NOT NULL columns without a default are present. */
export type NewFactorValues = FactorValues & {
  factorCode: string;
  factorName: string;
  sourceName: string;
  sourceVersion: string;
  geography: string;
  activityType: string;
  inputUnit: string;
  factorValue: string;
};

/** The values a `factor_set` create/update writes. */
export interface FactorSetValues {
  code?: string;
  name?: string;
  description?: string | null;
  status?: FactorStatus;
}

/** A create's values: `code` and `name` are NOT NULL. */
export type NewFactorSetValues = FactorSetValues & {
  code: string;
  name: string;
  /** Copy this set's factors and own conversions — the "new version" action. */
  copyFrom?: string;
};

// ─── Wire contract (§4.14 — DD names, 1:1) ───────────────────────────────────

/** One factor set as the API speaks it, plus the two facts the screen needs. */
export interface FactorSetDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  published_at: string | null;
  created_at: string | null;
  /** How many `emission_factor` rows the set holds. */
  factor_count: number;
  /** May a factor of this set still be written? `status === 'draft'` (DM-21). */
  editable: boolean;
}

/** One factor as the API speaks it. `numeric` columns cross the wire as numbers. */
export interface EmissionFactorDto {
  id: string;
  factor_set_id: string;
  factor_code: string;
  factor_name: string;
  source_name: string;
  source_version: string;
  /** Whose factor it is, when it is a supplier's own (0007); else `null`. */
  supplier_name: string | null;
  publication_date: string | null;
  applicable_year: number | null;
  geography: string;
  activity_type: string;
  input_unit: string;
  factor_value: number | null;
  output_unit: string;
  co2_value: number | null;
  ch4_value: number | null;
  n2o_value: number | null;
  gwp_basis: string | null;
  wtt_included: boolean;
  biogenic_treatment: string | null;
  rf_included: boolean | null;
  valid_from: string | null;
  valid_to: string | null;
  source_url: string | null;
  source_locator: string | null;
  licence: string | null;
  status: string;
}

/**
 * One (source, version, licence) group inside a set — UI-4's "sources and
 * licences" panel.
 *
 * It is DERIVED rather than stored because `emission_factor` carries the
 * provenance per row (DM-22 has no source table; the legacy
 * `emission_factor_sources` was a different thing, dropped by 0005). Grouping is
 * therefore the only honest way to answer "under what licences is this set
 * usable", and it also shows the answer the seed gives today: `'unspecified'`,
 * said out loud rather than left blank (MIG-4).
 */
export interface FactorProvenanceDto {
  source_name: string;
  source_version: string;
  licence: string | null;
  source_url: string | null;
  factors: number;
}

/** Is this set still writable? THE predicate of DM-21 (see the header). */
function isEditable(row: Pick<FactorSetRow, "status">): boolean {
  return row.status === "draft";
}

/** THE set serialiser. `factor_count` is counted by the caller's query. */
export function serialiseFactorSet(
  row: FactorSetRow,
  factorCount: number,
): FactorSetDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    published_at: row.publishedAt?.toISOString() ?? null,
    created_at: row.createdAt?.toISOString() ?? null,
    factor_count: factorCount,
    editable: isEditable(row),
  };
}

/** THE factor serialiser. Every response about a factor goes through it. */
export function serialiseFactor(row: EmissionFactorRow): EmissionFactorDto {
  return {
    id: row.id,
    factor_set_id: row.factorSetId,
    factor_code: row.factorCode,
    factor_name: row.factorName,
    source_name: row.sourceName,
    source_version: row.sourceVersion,
    supplier_name: row.supplierName,
    publication_date: row.publicationDate,
    applicable_year: row.applicableYear,
    geography: row.geography,
    activity_type: row.activityType,
    input_unit: row.inputUnit,
    factor_value: num(row.factorValue),
    output_unit: row.outputUnit,
    co2_value: num(row.co2Value),
    ch4_value: num(row.ch4Value),
    n2o_value: num(row.n2oValue),
    gwp_basis: row.gwpBasis,
    wtt_included: row.wttIncluded,
    biogenic_treatment: row.biogenicTreatment,
    rf_included: row.rfIncluded,
    valid_from: row.validFrom,
    valid_to: row.validTo,
    source_url: row.sourceUrl,
    source_locator: row.sourceLocator,
    licence: row.licence,
    status: row.status,
  };
}

// ─── Parsers (shape only — the header of `@/server/api/parse` draws the line) ─

/**
 * The factor's plain text columns: API name → column, all of them nullable.
 *
 * `supplier_name` is one of them and not a special case: it is free text, it may
 * be cleared, and WHAT it means is enforced elsewhere — the CHECK
 * `emission_factor_supplier_name_check` refuses a `source_name='supplier'` row
 * that leaves it NULL, and CALC-2 matches it against the activity row (0007).
 */
const FACTOR_TEXT_FIELDS = [
  ["source_url", "sourceUrl"],
  ["source_locator", "sourceLocator"],
  ["licence", "licence"],
  ["supplier_name", "supplierName"],
] as const;

/** The factor's `date` columns, all nullable (an open validity window is legal). */
const FACTOR_DATE_FIELDS = [
  ["publication_date", "publicationDate"],
  ["valid_from", "validFrom"],
  ["valid_to", "validTo"],
] as const;

/** The factor's optional `numeric` columns — the per-gas split (DM-22). */
const FACTOR_GAS_FIELDS = [
  ["co2_value", "co2Value"],
  ["ch4_value", "ch4Value"],
  ["n2o_value", "n2oValue"],
] as const;

/** The eight NOT NULL text columns a factor cannot be created without. */
const FACTOR_REQUIRED_TEXT = [
  ["factor_code", "factorCode"],
  ["factor_name", "factorName"],
  ["source_name", "sourceName"],
  ["source_version", "sourceVersion"],
  ["geography", "geography"],
  ["activity_type", "activityType"],
] as const;

/** `integer` is int4 — the COLUMN's range. VAL-032 owns which years are sane. */
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

/**
 * Wire → columns for one factor, with per-field SHAPE validation only.
 *
 * WHAT IS DELIBERATELY *NOT* CHECKED HERE, because a rule owns it (see the
 * header of `@/server/api/parse`):
 *   • `factor_value` keeps the default numeric bounds. Zero is VAL-033's
 *     subject and passes the parser — refusing it here would answer with a
 *     FIELD name where the acceptance case expects the rule code.
 *   • `applicable_year` is bounded by int4 and nothing else. 1990…+5y is
 *     VAL-032's range, and `-1` (the resolution key's sentinel) has to reach
 *     the rule to be told apart from "no year at all".
 *   • `valid_from`/`valid_to` are shape-checked, never ORDERED — VAL-032 again.
 *
 * What IS checked here is what the column cannot hold or what has no rule:
 * `input_unit` against `UNIT_CODES` (an unresolvable unit has no conversion
 * path at all — CALC-3 would meet it as `failed_unit` two stages later, with
 * nothing to say), `gwp_basis`/`biogenic_treatment`/`status` against their
 * §0.8 lists. `source_name` is NOT guarded against `FACTOR_SOURCES`: DM-22
 * calls that list open, and the seed writes authority prose into the column.
 */
function parseFactorInput(
  body: unknown,
  opts: { partial: boolean },
): ParseResult<FactorValues> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, field: "body" };
  }
  const input = body as Record<string, unknown>;
  const values: FactorValues = {};
  const reject = (field: string): ParseResult<FactorValues> => ({
    ok: false,
    field,
  });

  for (const [api, column] of FACTOR_REQUIRED_TEXT) {
    if (input[api] === undefined && opts.partial) continue;
    const parsed = textOrNull(input[api]);
    if (parsed === undefined || parsed === null) return reject(api);
    values[column] = parsed;
  }

  if (input.input_unit !== undefined || !opts.partial) {
    const unit = oneOfOrNull(input.input_unit, isUnitCode);
    if (unit === undefined || unit === null) return reject("input_unit");
    values.inputUnit = unit;
  }
  if (input.factor_value !== undefined || !opts.partial) {
    const value = decimalOrNull(input.factor_value);
    if (value === undefined || value === null) return reject("factor_value");
    values.factorValue = value;
  }
  // Explicit numerator vocabulary; kWh is reserved for the EV energy intensity.
  if (input.output_unit !== undefined) {
    const unit = textOrNull(input.output_unit);
    if (unit === undefined || unit === null || !isFactorOutputUnit(unit))
      return reject("output_unit");
    values.outputUnit = unit;
  }

  if (input.applicable_year !== undefined) {
    const year = integerOrNull(input.applicable_year, INT4_MIN, INT4_MAX);
    if (year === undefined) return reject("applicable_year");
    values.applicableYear = year;
  }
  for (const [api, column] of FACTOR_DATE_FIELDS) {
    if (input[api] === undefined) continue;
    const parsed = isoDateOrNull(input[api]);
    if (parsed === undefined) return reject(api);
    values[column] = parsed;
  }
  for (const [api, column] of FACTOR_GAS_FIELDS) {
    if (input[api] === undefined) continue;
    const parsed = decimalOrNull(input[api]);
    if (parsed === undefined) return reject(api);
    values[column] = parsed;
  }
  for (const [api, column] of FACTOR_TEXT_FIELDS) {
    if (input[api] === undefined) continue;
    const parsed = textOrNull(input[api]);
    if (parsed === undefined) return reject(api);
    values[column] = parsed;
  }

  if (input.gwp_basis !== undefined) {
    const basis = oneOfOrNull(input.gwp_basis, isGWPBasis);
    if (basis === undefined) return reject("gwp_basis");
    values.gwpBasis = basis;
  }
  if (input.biogenic_treatment !== undefined) {
    const treatment = oneOfOrNull(
      input.biogenic_treatment,
      isBiogenicTreatment,
    );
    if (treatment === undefined) return reject("biogenic_treatment");
    values.biogenicTreatment = treatment;
  }
  if (input.status !== undefined) {
    const status = oneOfOrNull(input.status, isFactorStatus);
    if (status === undefined || status === null) return reject("status");
    values.status = status;
  }
  if (input.wtt_included !== undefined) {
    const wtt = booleanValue(input.wtt_included);
    if (wtt === undefined) return reject("wtt_included");
    values.wttIncluded = wtt;
  }
  if (input.rf_included !== undefined) {
    const rf = booleanOrNull(input.rf_included);
    if (rf === undefined) return reject("rf_included");
    values.rfIncluded = rf;
  }

  if (opts.partial && Object.keys(values).length === 0) return reject("body");
  if (
    !opts.partial &&
    !isCompatibleFactorOutput(
      values.outputUnit ?? "kgCO2e",
      values.activityType ?? "",
      values.inputUnit ?? "",
    )
  )
    return reject("output_unit");
  return { ok: true, values };
}

/** POST body → the values of a NEW factor (the eight required ones re-checked). */
export function parseNewFactor(body: unknown): ParseResult<NewFactorValues> {
  const parsed = parseFactorInput(body, { partial: false });
  if (!parsed.ok) return parsed;
  const v = parsed.values;
  const required = [
    ["factor_code", v.factorCode],
    ["factor_name", v.factorName],
    ["source_name", v.sourceName],
    ["source_version", v.sourceVersion],
    ["geography", v.geography],
    ["activity_type", v.activityType],
    ["input_unit", v.inputUnit],
    ["factor_value", v.factorValue],
  ] as const;
  for (const [field, value] of required) {
    if (value === undefined) return { ok: false, field };
  }
  return { ok: true, values: v as NewFactorValues };
}

/** PATCH body → the factor values to change (absent key = leave alone). */
export function parseFactorPatch(body: unknown): ParseResult<FactorValues> {
  return parseFactorInput(body, { partial: true });
}

/** Wire → columns for a factor SET. `copy_from` is the "new version" action. */
function parseSetInput(
  body: unknown,
  opts: { partial: boolean },
): ParseResult<NewFactorSetValues | FactorSetValues> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, field: "body" };
  }
  const input = body as Record<string, unknown>;
  const values: NewFactorSetValues = {} as NewFactorSetValues;
  const reject = (field: string): ParseResult<FactorSetValues> => ({
    ok: false,
    field,
  });

  // `code` is the set's business identity (UNIQUE) and is NEVER re-writable: it
  // is what a pinned period's `factor_set_version` shows, so renaming it would
  // rewrite the provenance of every locked report that pinned the set.
  if (!opts.partial) {
    const code = textOrNull(input.code);
    if (code === undefined || code === null) return reject("code");
    values.code = code;
  }
  if (input.name !== undefined || !opts.partial) {
    const name = textOrNull(input.name);
    if (name === undefined || name === null) return reject("name");
    values.name = name;
  }
  if (input.description !== undefined) {
    const description = textOrNull(input.description);
    if (description === undefined) return reject("description");
    values.description = description;
  }
  if (input.status !== undefined) {
    // A CREATE may not name a status at all: a new set is always `draft`
    // (see `createFactorSet`), or "new version only" would be a formality.
    if (!opts.partial) return reject("status");
    const status = oneOfOrNull(input.status, isFactorStatus);
    if (status === undefined || status === null) return reject("status");
    values.status = status;
  }
  if (input.copy_from !== undefined) {
    if (opts.partial) return reject("copy_from");
    const id = uuidOrNull(input.copy_from);
    if (id === undefined) return reject("copy_from");
    if (id !== null) values.copyFrom = id;
  }

  if (opts.partial && Object.keys(values).length === 0) return reject("body");
  return { ok: true, values };
}

/** POST body → a new set (`code` and `name` required, `copy_from` optional). */
export function parseNewFactorSet(
  body: unknown,
): ParseResult<NewFactorSetValues> {
  const parsed = parseSetInput(body, { partial: false });
  if (!parsed.ok) return parsed;
  const values = parsed.values as NewFactorSetValues;
  if (!values.code) return { ok: false, field: "code" };
  if (!values.name) return { ok: false, field: "name" };
  return { ok: true, values };
}

/** PATCH body → the set values to change (`status`, `name`, `description`). */
export function parseFactorSetPatch(
  body: unknown,
): ParseResult<FactorSetValues> {
  return parseSetInput(body, { partial: true });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * Every factor set with its factor count, newest release first.
 *
 * NO TENANT PIN, HERE OR ANYWHERE BELOW: the factor library is reference data
 * shared by every company (`resolveFactorSet` in `@/server/periods/periods`
 * says the same from the other side, and `factor_set` has no `company_id` to
 * pin by). The capability is what gates it: `data.read` to look, `factors.custom`
 * to write.
 *
 * The count is a scalar subquery rather than a second round trip, so a set and
 * its size are read at one instant. `NULLS LAST` matters for the same reason it
 * does in `resolveFactorSet`: Postgres sorts NULLs FIRST under DESC, and an
 * unpublished draft would otherwise head the list of releases.
 */
export async function listFactorSets(db: DbClient): Promise<FactorSetDto[]> {
  const rows = await db
    .select({
      row: factorSet,
      // The correlation is written out as `factor_set.id` RATHER than
      // interpolating the Drizzle column: inside a select-list subquery Drizzle
      // renders a column UNQUALIFIED (`"id"`), which Postgres then resolves
      // against the INNER table — `emission_factor.factor_set_id = emission_factor.id`
      // is a perfectly legal predicate that is never true, so every count came
      // back 0 with no error anywhere. Qualifying it by hand is the fix and the
      // reason this is not tidied back into `${factorSet.id}`.
      factors: sql<number>`(
        SELECT count(*)::int FROM emission_factor
         WHERE emission_factor.factor_set_id = factor_set.id
      )`,
    })
    .from(factorSet)
    .orderBy(
      sql`${factorSet.publishedAt} DESC NULLS LAST`,
      asc(factorSet.code),
    );
  return rows.map((entry) => serialiseFactorSet(entry.row, entry.factors));
}

/** One factor set, or `undefined`. */
export async function getFactorSet(
  db: DbClient,
  id: string,
): Promise<FactorSetRow | undefined> {
  const [row] = await db
    .select()
    .from(factorSet)
    .where(eq(factorSet.id, id))
    .limit(1);
  return row;
}

/** How many factors a set holds (the serialiser's second argument). */
export async function countFactors(
  db: DbClient,
  setId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(emissionFactor)
    .where(eq(emissionFactor.factorSetId, setId));
  return row?.total ?? 0;
}

/** The sources and licences a set is built from (UI-4), most factors first. */
export async function listProvenance(
  db: DbClient,
  setId: string,
): Promise<FactorProvenanceDto[]> {
  const rows = await db
    .select({
      source_name: emissionFactor.sourceName,
      source_version: emissionFactor.sourceVersion,
      licence: emissionFactor.licence,
      source_url: emissionFactor.sourceUrl,
      factors: sql<number>`count(*)::int`,
    })
    .from(emissionFactor)
    .where(eq(emissionFactor.factorSetId, setId))
    .groupBy(
      emissionFactor.sourceName,
      emissionFactor.sourceVersion,
      emissionFactor.licence,
      emissionFactor.sourceUrl,
    )
    .orderBy(sql`count(*) DESC`, asc(emissionFactor.sourceName));
  return rows;
}

/** How a factor list is narrowed and paged (a released set holds 440 rows). */
export interface FactorQuery {
  /** Substring over `factor_code`, `factor_name` and `activity_type`. */
  search?: string | null;
  /** Exact `activity_type` — how the screen drills into one activity. */
  activityType?: string | null;
  limit: number;
  offset: number;
}

/** A page of factors plus the total the filter matched. */
export interface FactorPage {
  factors: EmissionFactorDto[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * One page of a set's factors, ordered so the page is stable: by activity type,
 * then geography, then year, then id (the tie-break that makes the order total
 * — without it two rows that differ only in `input_unit` could swap between
 * pages and hide one of themselves).
 */
export async function listFactors(
  db: DbClient,
  setId: string,
  query: FactorQuery,
): Promise<FactorPage> {
  const search = query.search?.trim();
  const filters = [eq(emissionFactor.factorSetId, setId)];
  if (query.activityType) {
    filters.push(eq(emissionFactor.activityType, query.activityType));
  }
  if (search) {
    const pattern = `%${search}%`;
    const match = or(
      ilike(emissionFactor.factorCode, pattern),
      ilike(emissionFactor.factorName, pattern),
      ilike(emissionFactor.activityType, pattern),
    );
    if (match) filters.push(match);
  }
  const where = and(...filters);

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(emissionFactor)
    .where(where);

  const rows = await db
    .select()
    .from(emissionFactor)
    .where(where)
    .orderBy(
      asc(emissionFactor.activityType),
      asc(emissionFactor.geography),
      sql`${emissionFactor.applicableYear} ASC NULLS FIRST`,
      asc(emissionFactor.id),
    )
    .limit(query.limit)
    .offset(query.offset);

  return {
    factors: rows.map(serialiseFactor),
    total: counted?.total ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/** One factor of one set, or `undefined` (a factor of another set reads absent). */
export async function getFactor(
  db: DbClient,
  setId: string,
  id: string,
): Promise<EmissionFactorRow | undefined> {
  const [row] = await db
    .select()
    .from(emissionFactor)
    .where(
      and(eq(emissionFactor.id, id), eq(emissionFactor.factorSetId, setId)),
    )
    .limit(1);
  return row;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** The set a refusal is talking about — enough for the screen to name it. */
interface FactorSetRef {
  id: string;
  code: string;
  status: string;
}

/**
 * Outcome of any write here.
 *
 * `VALIDATION` carries BOTH halves of API-1's refusal vocabulary: `rules` (the
 * VAL-* codes a blocking failure produced, empty when none owns the refusal) and
 * `detail`, the additive keys the route spreads into the body. See the header
 * for why "the set is released" is a `detail` and not a rule.
 */
export type FactorWrite<Row> =
  | { ok: true; row: Row }
  | { ok: false; error: "NOT_FOUND" }
  | {
      ok: false;
      error: "VALIDATION";
      rules: RuleRef[];
      detail?: Record<string, unknown>;
    };

/** The refusal token of DM-21, as the wire and the UI both spell it. */
const NEW_VERSION_ONLY = "NEW_VERSION_ONLY";

/** "That set is closed — make a new version", with the set it means. */
function refuseClosed<Row>(
  row: FactorSetRow,
  extra: Record<string, unknown> = {},
): FactorWrite<Row> {
  const set: FactorSetRef = {
    id: row.id,
    code: row.code,
    status: row.status,
  };
  return {
    ok: false,
    error: "VALIDATION",
    rules: [],
    detail: { refusal: NEW_VERSION_ONLY, factor_set: set, ...extra },
  };
}

/**
 * "A supplier factor has to say WHOSE it is" — the API's half of the CHECK
 * `emission_factor_supplier_name_check` (0007).
 *
 * The constraint alone would answer a driver error, i.e. an `UNKNOWN` 500 for a
 * mistake with a name, exactly as VAL-031's unique index would (see the header
 * of `@/server/validation/evaluators/factors`). So the same two-level
 * arrangement: the column keeps the storage guarantee for anything written by
 * psql or the seed, and this makes the ROUTE answer 422 naming the field. It is
 * not a VAL-* rule because §6.2 declares none for it — it is a shape refusal,
 * like `CODE_TAKEN`.
 */
function refuseUnnamedSupplier<Row>(): FactorWrite<Row> {
  return {
    ok: false,
    error: "VALIDATION",
    rules: [],
    detail: { refusal: "SUPPLIER_NAME_REQUIRED", field: "supplier_name" },
  };
}

/**
 * Would the written row claim supplier provenance without naming a supplier?
 *
 * Judged on the row AS IT WILL STAND: on a PATCH the two columns are merged with
 * the stored ones first, so "set `source_name` to supplier" and "clear
 * `supplier_name`" are both caught even though each mentions one column.
 */
function claimsSupplierWithoutName(
  values: FactorValues,
  existing?: EmissionFactorRow,
): boolean {
  const sourceName = values.sourceName ?? existing?.sourceName ?? "";
  const supplierName =
    values.supplierName === undefined
      ? (existing?.supplierName ?? null)
      : values.supplierName;
  return sourceName === "supplier" && (supplierName ?? "").trim() === "";
}

/** The scope every factor write validates against (VAL-031/032/033 live there). */
const SCOPE = { scope: "reference_org" } as const;

/**
 * Re-assert editability INSIDE the write transaction, with the set row locked.
 *
 * The caller has already checked it (and produced the explanatory refusal); this
 * closes the window between that read and the insert. `FOR UPDATE` makes a
 * concurrent release serialise behind this transaction rather than interleave
 * with it, so "released while I was adding factors" ends as a refusal instead of
 * as a factor that appeared in a released set. The refusal is bare — the good
 * message was the caller's job, and this branch is only reachable in the race.
 */
async function assertStillEditable(tx: DbClient, setId: string): Promise<void> {
  const rows = await tx.execute<{ status: string }>(
    sql`SELECT status FROM factor_set WHERE id = ${setId} FOR UPDATE`,
  );
  if (!rows[0] || rows[0].status !== "draft") refuseValidation();
}

/**
 * Refuse a duplicate resolution key BEFORE the unique index can 500 (О-18).
 *
 * The key is assembled from the MERGED values on a PATCH: sending only
 * `applicable_year` still has to be judged against the stored source, activity,
 * geography and unit, or a factor could be moved onto another one's key by an
 * edit that never mentions the columns it collides on.
 */
async function assertKeyFree(
  tx: DbClient,
  setId: string,
  values: FactorValues,
  existing?: EmissionFactorRow,
): Promise<void> {
  const conflict = await findKeyConflict(
    tx,
    {
      factorSetId: setId,
      sourceName: values.sourceName ?? existing?.sourceName ?? "",
      sourceVersion: values.sourceVersion ?? existing?.sourceVersion ?? "",
      activityType: values.activityType ?? existing?.activityType ?? "",
      geography: values.geography ?? existing?.geography ?? "",
      inputUnit: values.inputUnit ?? existing?.inputUnit ?? "",
      applicableYear:
        values.applicableYear === undefined
          ? (existing?.applicableYear ?? null)
          : values.applicableYear,
      supplierName:
        values.supplierName === undefined
          ? (existing?.supplierName ?? null)
          : values.supplierName,
    },
    existing?.id,
  );
  if (conflict !== undefined) refuseValidation([ruleRef("VAL-031")]);
}

/**
 * Create a factor set (DM-21). ALWAYS `draft`: a set is released by a PATCH,
 * never born released, so "new version only" cannot be side-stepped by creating
 * an active set that shadows the one a period pinned.
 *
 * `copyFrom` is UI-4's "new version" button. It copies EVERY factor of the
 * source set — all 24 DM-22 columns, `id` and `factor_set_id` excepted — so the
 * new version starts as a faithful restatement of its predecessor and the diff
 * an admin then makes is the whole of the change. The copies cannot collide on
 * VAL-031: the key leads with `factor_set_id`, and that is precisely the column
 * that differs. Set-scoped unit conversions are part of the same methodology:
 * copy them with fresh IDs in this transaction; shared conversions stay shared.
 */
export async function createFactorSet(
  db: DbClient,
  values: NewFactorSetValues,
): Promise<FactorWrite<FactorSetRow>> {
  return db.transaction(async (tx) => {
    // `factor_set_code_key` is a UNIQUE constraint, i.e. a driver error (500)
    // for a duplicate — checked here so the answer names the field instead.
    const [taken] = await tx
      .select({ id: factorSet.id })
      .from(factorSet)
      .where(eq(factorSet.code, values.code))
      .limit(1);
    if (taken) {
      return {
        ok: false,
        error: "VALIDATION",
        rules: [],
        detail: { refusal: "CODE_TAKEN", field: "code" },
      };
    }

    let source: FactorSetRow | undefined;
    if (values.copyFrom !== undefined) {
      source = await getFactorSet(tx, values.copyFrom);
      // A source that does not exist is API-1's "does not exist" — a bare 422,
      // not a rule, exactly as a foreign reference is elsewhere.
      if (!source) {
        return {
          ok: false,
          error: "VALIDATION",
          rules: [],
          detail: { refusal: "COPY_SOURCE_UNKNOWN", field: "copy_from" },
        };
      }
    }

    const [row] = await tx
      .insert(factorSet)
      .values({
        code: values.code,
        name: values.name,
        description: values.description ?? null,
        status: "draft",
      })
      .returning();

    if (source) {
      await copyFactors(tx, source.id, row.id);
      await copyConversions(tx, source.id, row.id);
    }
    return { ok: true, row };
  });
}

/** How many reference rows are inserted per statement when copying a set. */
const COPY_CHUNK = 500;

/**
 * Copy every factor of `fromSetId` into `toSetId`.
 *
 * Read-then-insert rather than `INSERT … SELECT`, because ids are APP-generated
 * (`appUuidPk`, PG-PLAN decision 2026-07-14 — no dependency on
 * `gen_random_uuid`): letting Drizzle apply the default is what keeps that
 * decision in one place. 440 rows go in one statement; the chunking is there so
 * a future set an order of magnitude larger does not build a single enormous
 * parameter list.
 */
async function copyFactors(
  tx: DbClient,
  fromSetId: string,
  toSetId: string,
): Promise<void> {
  const rows = await tx
    .select()
    .from(emissionFactor)
    .where(eq(emissionFactor.factorSetId, fromSetId));
  for (let start = 0; start < rows.length; start += COPY_CHUNK) {
    const chunk = rows.slice(start, start + COPY_CHUNK).map((row) => {
      const { id: _id, factorSetId: _setId, ...rest } = row;
      return { ...rest, factorSetId: toSetId };
    });
    if (chunk.length > 0) await tx.insert(emissionFactor).values(chunk);
  }
}

/** Copy only this set's conversions; never materialise shared fallback rows. */
async function copyConversions(
  tx: DbClient,
  fromSetId: string,
  toSetId: string,
): Promise<void> {
  const rows = await tx
    .select()
    .from(unitConversion)
    .where(eq(unitConversion.factorSetId, fromSetId));
  for (let start = 0; start < rows.length; start += COPY_CHUNK) {
    const chunk = rows.slice(start, start + COPY_CHUNK).map((row) => {
      const { id: _id, factorSetId: _setId, ...rest } = row;
      return { ...rest, factorSetId: toSetId };
    });
    if (chunk.length > 0) await tx.insert(unitConversion).values(chunk);
  }
}

/**
 * The three legal `status` moves of a set (see the header). Anything else —
 * `active → draft`, `archived → *`, a no-op onto the same value — is refused
 * under {@link NEW_VERSION_ONLY}: re-opening or reviving a set IS editing a
 * release, one step removed.
 */
const STATUS_TRANSITIONS: Readonly<Record<string, readonly FactorStatus[]>> = {
  draft: ["active", "archived"],
  active: ["archived"],
  archived: [],
};

/**
 * Update a factor set: release it, archive it, or correct its own name and
 * description WHILE IT IS STILL A DRAFT.
 *
 * The name of a released set is frozen with the rest of it. That is not
 * pedantry: `factor_set.code` is what a period's `factor_set_version` reports
 * (`@/server/periods/periods`), and the pair (code, name) is the provenance a
 * locked report prints. A "typo fix" on a released set rewrites the provenance
 * of every report that pinned it, with no version to attribute the change to.
 */
export async function updateFactorSet(
  db: DbClient,
  id: string,
  values: FactorSetValues,
): Promise<FactorWrite<FactorSetRow>> {
  const existing = await getFactorSet(db, id);
  if (!existing) return { ok: false, error: "NOT_FOUND" };

  const nextStatus = values.status;
  if (nextStatus !== undefined) {
    const allowed = STATUS_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(nextStatus)) {
      return refuseClosed(existing, { from: existing.status, to: nextStatus });
    }
  }
  const editsContent =
    values.name !== undefined || values.description !== undefined;
  if (editsContent && !isEditable(existing)) {
    return refuseClosed(existing, { fields: ["name", "description"] });
  }

  const [row] = await db
    .update(factorSet)
    .set({
      ...(values.name !== undefined ? { name: values.name } : {}),
      ...(values.description !== undefined
        ? { description: values.description }
        : {}),
      ...(nextStatus !== undefined ? { status: nextStatus } : {}),
      // The release stamp, written once and never moved: `published_at` orders
      // the library and decides the default pin of a new period, so re-stamping
      // an already published set would silently re-order both.
      ...(nextStatus === "active" && existing.publishedAt === null
        ? { publishedAt: new Date() }
        : {}),
    })
    .where(eq(factorSet.id, id))
    .returning();
  return { ok: true, row };
}

/**
 * Add one factor to a DRAFT set (DM-22).
 *
 * `companyId` is not a tenant pin on the factor — there is no such column — but
 * the owner of the `validation_result` rows the run writes (О-17: `company_id`
 * leads the DM-28 key). So "this company's administrator was refused this
 * factor" is what the screen reads back afterwards.
 */
export async function createFactor(
  db: DbClient,
  companyId: string,
  setId: string,
  values: NewFactorValues,
): Promise<FactorWrite<EmissionFactorRow>> {
  const set = await getFactorSet(db, setId);
  if (!set) return { ok: false, error: "NOT_FOUND" };
  if (!isEditable(set)) return refuseClosed(set);
  if (claimsSupplierWithoutName(values)) return refuseUnnamedSupplier();
  if (
    !isCompatibleFactorOutput(
      values.outputUnit ?? "kgCO2e",
      values.activityType,
      values.inputUnit,
    )
  )
    return {
      ok: false,
      error: "VALIDATION",
      rules: [],
      detail: { field: "output_unit" },
    };

  const written = await writeValidated(
    db,
    { companyId, ...SCOPE },
    async (tx) => {
      await assertStillEditable(tx, setId);
      await assertKeyFree(tx, setId, values);
      const [row] = await tx
        .insert(emissionFactor)
        .values({ ...values, factorSetId: setId })
        .returning();
      return row;
    },
  );
  return written.ok ? written : toFactorWrite(written);
}

/**
 * Edit one factor of a DRAFT set.
 *
 * THIS IS THE METHOD DM-21 EXISTS TO REFUSE, for every set that is not a draft:
 * the acceptance case of T2.8 is a PATCH against a factor of the ACTIVE seeded
 * set, and the answer is 422 `NEW_VERSION_ONLY` rather than a changed number.
 */
export async function updateFactor(
  db: DbClient,
  companyId: string,
  setId: string,
  id: string,
  values: FactorValues,
): Promise<FactorWrite<EmissionFactorRow>> {
  const set = await getFactorSet(db, setId);
  if (!set) return { ok: false, error: "NOT_FOUND" };
  const existing = await getFactor(db, setId, id);
  if (!existing) return { ok: false, error: "NOT_FOUND" };
  // The set's status is checked BEFORE the factor's own values: a released set
  // refuses every edit, including one that would have been valid.
  if (!isEditable(set)) return refuseClosed(set, { factor_id: id });
  if (claimsSupplierWithoutName(values, existing)) {
    return refuseUnnamedSupplier();
  }
  if (
    !isCompatibleFactorOutput(
      values.outputUnit ?? existing.outputUnit,
      values.activityType ?? existing.activityType,
      values.inputUnit ?? existing.inputUnit,
    )
  )
    return {
      ok: false,
      error: "VALIDATION",
      rules: [],
      detail: { field: "output_unit" },
    };

  const written = await writeValidated(
    db,
    { companyId, ...SCOPE },
    async (tx) => {
      await assertStillEditable(tx, setId);
      await assertKeyFree(tx, setId, values, existing);
      const [row] = await tx
        .update(emissionFactor)
        .set(values)
        .where(
          and(eq(emissionFactor.id, id), eq(emissionFactor.factorSetId, setId)),
        )
        .returning();
      return row;
    },
  );
  return written.ok ? written : toFactorWrite(written);
}

/** `WriteResult`'s refusal → this module's, so the route has ONE shape to map. */
function toFactorWrite<Row>(
  result:
    | { ok: false; error: "NOT_FOUND" }
    | { ok: false; error: "VALIDATION"; rules: RuleRef[] },
): FactorWrite<Row> {
  return result.error === "NOT_FOUND"
    ? { ok: false, error: "NOT_FOUND" }
    : { ok: false, error: "VALIDATION", rules: result.rules };
}
