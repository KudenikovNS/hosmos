// =============================================================================
// THE SHARED HALF OF AN INPUT-ROW WIRE CONTRACT (§4.8, DM-11) — the part that is
// the same for all four tables because the MIXIN is the same for all four.
//
// WHY IT EXISTS, AND WHY ONLY NOW. T3.1 wrote `./emission-activity` as "one
// protocol, four wire contracts" and left the siblings to T3.2/T3.3. Written
// literally, the second and third copies would have repeated three things that
// have nothing to do with WHICH table they serve:
//   • the 19 MIXIN fields of the DTO and their serialiser — identical by
//     construction, since `lifecycleColumns()` is one function (§4.8);
//   • the mixin half of the parser — `revision_id`, `legal_entity_id`,
//     `facility_id`, `asset_id`, `metric_key`, `year_month`, `unit`, `notes`;
//   • `change_reason` (LC-5) and the create-time re-check of the two NOT NULL
//     placements — neither of which is a body column of any table at all.
// A third copy of that is how `superseded_by_id`-style bugs get in: three
// `year_month` regexes drift, and the one that drifts is the one nobody tested.
//
// WHAT IS **NOT** HERE, deliberately: everything a table's BODY needs. The
// discriminator (`activity_category` / `energy_type`, К-6), the body columns,
// their guards and their DTO fields stay in the per-table module, because that
// is the part where the four tables genuinely differ. The split this file draws
// is exactly the §4.8 line: mixin here, body there.
//
// THE FIELD COLLECTOR is the other half of the extraction. Every parser in the
// codebase repeats two shapes — "NOT NULL column: required on create, never
// blanked on PATCH" and "nullable column: absent means leave alone, `null`/`""`
// means clear" — and repeats them once per column. Written out, the energy and
// instrument parsers would be 60 lines of that pattern between them. Collected,
// each column is one line that says which of the two it is.
//
// WHERE THE LINE IS (unchanged from `@/server/api/parse`): this refuses what a
// column physically cannot hold or what §0.8 puts in a code list. Everything
// semantic — a sign, a range, a period, a country — is a VAL-* rule, and a
// parser that pre-empted one would answer `{field: …}` where the UI wants a rule
// code (the VAL-006 lesson, `org/facilities.ts`).
// =============================================================================
import { and, eq } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import {
  oneOfOrNull,
  textOrNull,
  uuidOrNull,
  type ParseResult,
} from "@/server/api/parse";
import type { DbClient } from "@/server/db/client";
import { asset, facility, legalEntity } from "@/server/db/schema";
import type { DbCompany, DbSession } from "@/server/db/types";
import { isUnitCode } from "@/shared/enums";

import type { NewRowValues, RowValues } from "./rows";
import type { InputRow, InputTableName } from "./tables";

// ─── What one table hands to the routes ──────────────────────────────────────

/**
 * ONE TABLE'S WIRE CONTRACT — everything `./row-routes` needs in order to serve
 * a route family without knowing which of the four tables it is serving.
 *
 * It is the same idea as `InputTableName` being a PARAMETER of `./rows`: the
 * append-only PROTOCOL is identical for all four tables, and so is the HTTP
 * shape of it (list/create, read/edit/delete, approve, history). What differs is
 * the body — and the body is exactly what these four members supply.
 */
export interface RowWireContract<Dto> {
  readonly table: InputTableName;
  /** The key the collection response nests its array under (API-2). */
  readonly listKey: string;
  readonly serialise: (row: InputRow) => Dto;
  readonly parseNew: (body: unknown) => ParseResult<NewRowValues>;
  readonly parsePatch: (body: unknown) => ParseResult<RowValues>;
  /** The tenant-scoped FKs this table's body may carry (see below). */
  readonly references: readonly TenantReference[];
  /**
   * OPTIONAL SECOND PARSING STAGE — the half a `(body) => values` function
   * cannot do because it needs a database read (see {@link RowPrepare}).
   */
  readonly prepare?: RowPrepare;
}

// ─── The asynchronous half of a parser ───────────────────────────────────────

/**
 * A session whose company is proven — what a guarded handler holds, and the
 * shape `getEntitlements` reads a plan from.
 *
 * It is DELIBERATELY the whole session rather than `RowSession`: `RowSession`
 * (`./rows`) narrows the company down to its id because the append-only service
 * needs nothing else, while an entitlement question is asked of the COMPANY —
 * and a hook that had to re-load it would be re-deriving what the request
 * already resolved.
 */
export type CompanySession = DbSession & { company: DbCompany };

/** Everything the second stage may look at. `db` is the pool, not a transaction. */
export interface RowPrepareContext {
  readonly db: DbClient;
  readonly session: CompanySession;
  readonly companyId: string;
  /** The columns the synchronous parser produced. */
  readonly values: RowValues;
  /**
   * The version an edit supersedes, or `undefined` on a create (and on an edit
   * whose target does not exist — the service refuses that one itself).
   *
   * A PATCH is a DELTA (LC-5): the body carries the columns that CHANGE, so a
   * hook that judges the row as a whole has to read the rest off the version
   * being replaced. Without this, "exactly one value column is filled" (DM-19)
   * would be checkable on a create and unaskable on an edit.
   */
  readonly current?: InputRow;
}

/** A prepared row, or the refusal payload the route answers 422 with (API-1). */
export type RowPrepared =
  | { ok: true; values: RowValues }
  | { ok: false; detail: Record<string, unknown> };

/**
 * WHY A CONTRACT MEMBER AND NOT A LINE IN EACH ROUTE. Three of the four tables
 * are decidable from the body alone; `disclosure_record` is not. What may be
 * written there depends on the METRIC being disclosed — its `value_type`, its
 * `breakdown_dimensions` and its module (PG-6) — and all three live in
 * `metric_catalog`, a table. Doing that read in the route file means writing
 * `/api/disclosures`'s handlers by hand instead of from the factory — a fourth
 * copy of the guard order (§0.2), and the first place where one of the four
 * families stopped being the same HTTP shape as the other three.
 *
 * WHERE IT RUNS (`./row-routes`): after the synchronous parser and after the
 * tenant check, before the row service. It may add or override columns — that is
 * how `disclosure_record.value_type` is derived from the catalogue instead of
 * being accepted from a body — and the create path re-establishes the two NOT
 * NULL placements afterwards, so a hook cannot delete its way past them.
 */
type RowPrepare = (ctx: RowPrepareContext) => Promise<RowPrepared>;

// ─── The mixin, as the API speaks it ─────────────────────────────────────────

/**
 * The 19 mixin columns a DTO carries, by their DRIZZLE names — the projection
 * every read of an input row shares, whether it reads one table or all four.
 *
 * WHY A LIST AND NOT JUST THE SERIALISER. `serialiseMixin` below reads these
 * nineteen off a row; the cross-table inventory (DM-14, `./inventory`) has to
 * SELECT them out of four different tables and alias them into one shape, and it
 * cannot ask a serialiser what to put in a projection. One list, two consumers,
 * and `RowMixin` is derived from it — so a name that stops being a column of the
 * mixin stops compiling here rather than producing a NULL column downstream.
 *
 * `company_id` is deliberately absent (as it is from `RowMixinDto`): it is the
 * twentieth mixin column and the one the API never speaks — the tenant is the
 * session (PATTERN 3).
 */
export const MIXIN_COLUMN_NAMES = [
  "id",
  "revisionId",
  "legalEntityId",
  "facilityId",
  "assetId",
  "metricKey",
  "yearMonth",
  "unit",
  "state",
  "approvedBy",
  "approvedAt",
  "notes",
  "previousVersionId",
  "supersededById",
  "changeReason",
  "isDeleted",
  "actorId",
  "actorRole",
  "createdAt",
] as const;

/**
 * The mixin half of an input row — what a serialiser actually needs.
 *
 * `Pick` over the UNION of the four `$inferSelect` types, so each field is the
 * union of what the four tables declare (`metricKey` is `string | null` because
 * three tables allow NULL and `disclosure_record` does not — DM-18). An
 * `InputRow` satisfies it, and so does the projected row of the cross-table
 * UNION, which is the point: neither has to be cast to the other.
 */
export type RowMixin = Pick<InputRow, (typeof MIXIN_COLUMN_NAMES)[number]>;

/**
 * The 19 mixin columns of §4.8 as every input-row DTO carries them: snake_case,
 * dates as ISO strings.
 *
 * THE VERSION COLUMNS ARE PART OF IT, not internal bookkeeping. A client that
 * cannot see `superseded_by_id`, `previous_version_id` and `state` cannot render
 * an append-only row: it would not know whether what it is holding is the
 * current figure, and the history link (API-2) would have nothing to point at.
 * `company_id` stays absent, as in every other DTO — the tenant is the session.
 */
export interface RowMixinDto {
  id: string;
  revision_id: string;
  legal_entity_id: string;
  facility_id: string | null;
  asset_id: string | null;
  metric_key: string | null;
  year_month: string | null;
  unit: string | null;
  state: string;
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
  previous_version_id: string | null;
  superseded_by_id: string | null;
  change_reason: string | null;
  is_deleted: boolean;
  actor_id: string;
  actor_role: string | null;
  created_at: string | null;
}

/** The mixin half of any row's DTO — the half no table may spell differently. */
export function serialiseMixin(row: RowMixin): RowMixinDto {
  return {
    id: row.id,
    revision_id: row.revisionId,
    legal_entity_id: row.legalEntityId,
    facility_id: row.facilityId,
    asset_id: row.assetId,
    metric_key: row.metricKey,
    year_month: row.yearMonth,
    unit: row.unit,
    state: row.state,
    approved_by: row.approvedBy,
    approved_at: row.approvedAt?.toISOString() ?? null,
    notes: row.notes,
    previous_version_id: row.previousVersionId,
    superseded_by_id: row.supersededById,
    change_reason: row.changeReason,
    is_deleted: row.isDeleted,
    actor_id: row.actorId,
    actor_role: row.actorRole,
    created_at: row.createdAt?.toISOString() ?? null,
  };
}

// ─── The field collector ─────────────────────────────────────────────────────

/** A body that is an object at all — anything else is `{field: "body"}`. */
export function objectBody(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  return body as Record<string, unknown>;
}

/**
 * One column's wire → value step. `undefined` REJECTS, `null` clears, anything
 * else is the value — the three-way answer every `@/server/api/parse` helper
 * already returns, so the helpers are usable here unwrapped.
 */
type FieldParse = (raw: unknown) => unknown;

/** Collects one table's columns out of a request body. See the header. */
export interface FieldCollector {
  /**
   * A NOT NULL column: required on a create, and on a PATCH it may be omitted
   * but never blanked.
   */
  required(api: string, column: string, parse: FieldParse): void;
  /** A nullable column: an absent key leaves it alone, `null`/`""` clears it. */
  optional(api: string, column: string, parse: FieldParse): void;
  /** The collected columns, or the FIRST API field that was rejected. */
  result(): ParseResult<RowValues>;
}

/**
 * A collector over `input`. `partial` is PATCH semantics: an absent key means
 * "leave it alone", and a PATCH that changes nothing is a rejection.
 *
 * A KEY THE COLLECTOR IS NEVER ASKED FOR IS SIMPLY NOT READ. That is what makes
 * the Calculated fields of §4.10 (`location_factor_id`, `market_factor_id`)
 * unreachable from the wire: they are absent from `purchased-energy.ts`'s list
 * of columns, so no request body can carry a value into them — there is no
 * deny-list to keep in sync, because there is no branch that could accept one.
 */
export function fieldCollector(
  input: Record<string, unknown>,
  opts: { partial: boolean },
): FieldCollector {
  const values: Record<string, unknown> = {};
  let rejected: string | undefined;

  const take = (
    api: string,
    column: string,
    parse: FieldParse,
    required: boolean,
  ): void => {
    if (rejected !== undefined) return;
    const raw = input[api];
    if (raw === undefined && (opts.partial || !required)) return;
    const parsed = parse(raw);
    if (parsed === undefined || (required && parsed === null)) {
      rejected = api;
      return;
    }
    values[column] = parsed;
  };

  return {
    required: (api, column, parse) => take(api, column, parse, true),
    optional: (api, column, parse) => take(api, column, parse, false),
    result: () => {
      if (rejected !== undefined) return { ok: false, field: rejected };
      if (opts.partial && Object.keys(values).length === 0) {
        return { ok: false, field: "body" };
      }
      return { ok: true, values };
    },
  };
}

// ─── The mixin half of a parser ──────────────────────────────────────────────

/** `YYYY-MM` — the mixin's `year_month` CHECK, mirrored on the wire. */
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Is `value` a `year_month` the column would accept? THE one spelling of that
 * question — a body parses through it here, and the inventory's `year_month`
 * FILTER (`./inventory`) asks it of a query string. The header of this file names
 * three drifting `year_month` regexes as the failure it exists to prevent; a
 * filter with its own copy would be the third.
 */
export function isYearMonth(value: string): boolean {
  return YEAR_MONTH.test(value);
}

/** `year_month` as the column accepts it, or NULL (the row covers the period). */
function yearMonthOrNull(raw: unknown): string | null | undefined {
  const parsed = textOrNull(raw);
  if (parsed === undefined) return undefined;
  if (parsed !== null && !isYearMonth(parsed)) return undefined;
  return parsed;
}

/**
 * The eight mixin columns a CLIENT may set (§4.8). The other eleven are the
 * service's (`SERVICE_OWNED_COLUMNS`, `./rows`) and no parser produces them.
 *
 * `unit` is checked against `UNIT_CODES` — a code list, §0.8 — and NOT against
 * what the row's own domain can be priced in: that is VAL-014's, which reads the
 * pinned factor set for a Scope-1 activity type and §4.10's kWh/MWh/GJ for
 * purchased energy. Narrowing it per table here would leave VAL-014 implemented
 * and unreachable for half its subjects.
 *
 * `opts.metricKey` IS THE ONE DOCUMENTED EXCEPTION TO THE MIXIN'S UNIFORMITY
 * (DM-18): `disclosure_record.metric_key` is NOT NULL, because a disclosure that
 * names no catalogue metric discloses nothing. The column is otherwise the same
 * column, which is why the exception is a flag here rather than a metric-key
 * clause of its own in one parser — `__tests__` pins the placement against the
 * real schema (the T1.2 mixin-parity test).
 */
export function collectMixin(
  fields: FieldCollector,
  opts: { metricKey?: "required" | "optional" } = {},
): void {
  fields.required("revision_id", "revisionId", uuidOrNull);
  fields.required("legal_entity_id", "legalEntityId", uuidOrNull);
  fields.optional("facility_id", "facilityId", uuidOrNull);
  fields.optional("asset_id", "assetId", uuidOrNull);
  if (opts.metricKey === "required") {
    fields.required("metric_key", "metricKey", textOrNull);
  } else {
    fields.optional("metric_key", "metricKey", textOrNull);
  }
  fields.optional("year_month", "yearMonth", yearMonthOrNull);
  fields.optional("unit", "unit", (raw) => oneOfOrNull(raw, isUnitCode));
  fields.optional("notes", "notes", textOrNull);
}

/**
 * A parsed body → the columns of a NEW row. The re-check of the two placements
 * is what lets the TYPE promise they are there, so `createRow` needs neither a
 * cast nor a guard of its own.
 */
export function asNewRowValues(values: RowValues): ParseResult<NewRowValues> {
  const revisionId = values.revisionId;
  const legalEntityId = values.legalEntityId;
  if (typeof revisionId !== "string") {
    return { ok: false, field: "revision_id" };
  }
  if (typeof legalEntityId !== "string") {
    return { ok: false, field: "legal_entity_id" };
  }
  return { ok: true, values: { ...values, revisionId, legalEntityId } };
}

/** The `change_reason` of a PATCH/DELETE (LC-5) — not a column of any body. */
export function parseChangeReason(
  body: unknown,
): ParseResult<{ changeReason: string | null }> {
  if (body === null || body === undefined) {
    return { ok: true, values: { changeReason: null } };
  }
  const input = objectBody(body);
  if (!input) return { ok: false, field: "body" };
  if (input.change_reason === undefined) {
    return { ok: true, values: { changeReason: null } };
  }
  const parsed = textOrNull(input.change_reason);
  if (parsed === undefined) return { ok: false, field: "change_reason" };
  return { ok: true, values: { changeReason: parsed } };
}

// ─── Tenant-scoped references (PATTERN 3, §0.4 rule 1) ───────────────────────

/**
 * A column of a body that names a row of ANOTHER tenant-scoped table.
 *
 * WHY A CHECK RATHER THAN A FOREIGN KEY. Every one of these FKs points at a
 * table that carries its own `company_id`, and the constraint knows nothing
 * about it: `meter_asset_id` pointing at another company's meter satisfies
 * `REFERENCES asset(id)` perfectly and writes a row that reaches across the
 * tenant boundary. §0.4 rule 1 is explicit — a foreign `legal_entity_id` /
 * `facility_id` / `revision_id` in a body is a `VALIDATION`, not a row — and
 * `revision_id` is the one the service already resolves tenant-pinned itself
 * (`loadRevision`, `./rows`). The rest are these.
 *
 * The refusal names the FIELD rather than a rule code, like every other
 * reference refusal in the codebase (API-1: "does not exist for this company").
 */
export interface TenantReference {
  /** API field name — what the refusal payload says. */
  readonly field: string;
  /** Drizzle column name in the parsed values. */
  readonly column: string;
  /** Does `id` name a row of THIS company? */
  readonly exists: (
    db: DbClient,
    companyId: string,
    id: string,
  ) => Promise<boolean>;
}

/** A table with the two columns a tenant check needs. */
type TenantTable = PgTable & { id: PgColumn; companyId: PgColumn };

/** Declare one tenant-pinned reference of a body. */
function tenantRef(
  field: string,
  column: string,
  table: TenantTable,
): TenantReference {
  return {
    field,
    column,
    exists: async (db, companyId, id) => {
      const [row] = await db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.id, id), eq(table.companyId, companyId)))
        .limit(1);
      return row !== undefined;
    },
  };
}

/** The references every input-row body can carry (§4.8). */
export const MIXIN_REFERENCES: readonly TenantReference[] = [
  tenantRef("legal_entity_id", "legalEntityId", legalEntity),
  tenantRef("facility_id", "facilityId", facility),
  tenantRef("asset_id", "assetId", asset),
];

/** An `asset` reference under another name — К-7's `meter_asset_id` (§4.10). */
export const METER_REFERENCE = tenantRef(
  "meter_asset_id",
  "meterAssetId",
  asset,
);

/**
 * The first reference in `values` that points outside `companyId`, or
 * `undefined` when every one of them resolves inside it.
 *
 * A `null` (the body is CLEARING the link) and an absent key are both skipped:
 * there is nothing to resolve.
 */
export async function foreignReference(
  db: DbClient,
  companyId: string,
  references: readonly TenantReference[],
  values: RowValues,
): Promise<string | undefined> {
  for (const reference of references) {
    const id = values[reference.column];
    if (typeof id !== "string") continue;
    if (!(await reference.exists(db, companyId, id))) return reference.field;
  }
  return undefined;
}
