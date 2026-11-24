// THE CROSS-TABLE INVENTORY (DM-14, API-2) — every input row of a company in one
// list, whichever of the four tables it lives in.
//
// See docs/decisions/server-inventory-inventory.md for the full account.
import { count, eq, getTableColumns, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { uuidOrNull, type ParseResult } from "@/server/api/parse";
import type { DbClient } from "@/server/db/client";
import {
  contractualInstrument,
  disclosureRecord,
  emissionActivity,
  purchasedEnergyActivity,
} from "@/server/db/schema";

import {
  INPUT_TABLES,
  INPUT_TABLE_NAMES,
  isRowState,
  type InputTableName,
  type RowState,
} from "./tables";
import {
  isYearMonth,
  MIXIN_COLUMN_NAMES,
  serialiseMixin,
  type RowMixin,
  type RowMixinDto,
} from "./wire";

// ─── The body, reduced to three columns ──────────────────────────────────────

/**
 * The three body columns every input table can answer the inventory's question
 * with: WHAT kind of thing is this, WHICH one, HOW MUCH.
 *
 * `kind` is the table's structural discriminator wherever it has one (К-6) —
 * the same string the per-table screens tab on. `label` is the row's own name.
 * `quantity` is the figure, and the mixin's `unit` already says what it is in.
 */
interface BodySummary {
  /** NOT NULL text on all four — the discriminator, or `value_type` (DM-18). */
  readonly kind: PgColumn;
  /** Free text, truncated to {@link LABEL_LIMIT}. NULL on three of the four. */
  readonly label: PgColumn;
  /** NUMERIC. NULL where the row is not a quantity (a narrative disclosure). */
  readonly quantity: PgColumn;
}

/**
 * One triple per table. FOUR literals, three columns each — the whole of what
 * this module knows about a body, and the only thing T3.5/T3.5b/T3.6 have to
 * touch if a screen wants a different column in the summary.
 */
const BODY_SUMMARY: Record<InputTableName, BodySummary> = {
  emission_activity: {
    kind: emissionActivity.activityCategory,
    label: emissionActivity.sourceName,
    quantity: emissionActivity.activityValue,
  },
  purchased_energy_activity: {
    kind: purchasedEnergyActivity.energyType,
    label: purchasedEnergyActivity.supplier,
    quantity: purchasedEnergyActivity.consumption,
  },
  contractual_instrument: {
    kind: contractualInstrument.instrumentType,
    label: contractualInstrument.certificateId,
    quantity: contractualInstrument.coveredVolume,
  },
  // DM-18: a disclosure's "kind" is the DataType it was typed as, and its label
  // is the narrative itself — `metric_key` (WHICH metric) is a mixin column and
  // is already projected, so repeating it here would spend the label on
  // something the row already carries.
  disclosure_record: {
    kind: disclosureRecord.valueType,
    label: disclosureRecord.valueText,
    quantity: disclosureRecord.valueNumeric,
  },
};

/**
 * How much of a `label` the inventory carries. A `disclosure_record.value_text`
 * is a NARRATIVE — B8…B11 answers run to paragraphs — and a cross-table listing
 * that shipped them whole would move megabytes to render a column that is
 * ellipsised at ~40 characters. The row's own route serves the full text.
 */
const LABEL_LIMIT = 120;

// ─── The filter ──────────────────────────────────────────────────────────────

/**
 * What a caller may narrow the inventory by (§12.2, the T3.4 block). Every
 * member is optional and every one of them is AND-ed; absent means "all".
 */
export interface InventoryFilter {
  readonly revisionId?: string;
  readonly state?: RowState;
  readonly legalEntityId?: string;
  readonly facilityId?: string;
  readonly yearMonth?: string;
  /**
   * THE APPROVAL QUEUE (DM-14, UI-3) — the rows waiting for `data.approve`.
   *
   * It is a NAME for a composition, not a shorthand a client could assemble
   * itself and get subtly wrong: "awaiting approval" is `state='draft'` AND
   * current AND not tombstoned, and the last two are invariants of this listing
   * (see the header). Naming it on the SERVER means the queue on the review
   * screen and the counter beside it cannot disagree about what they are
   * counting, and a later option that widened the listing (versions, tombstones)
   * would have to leave the queue alone rather than quietly enlarging it.
   */
  readonly approvalQueue?: boolean;
}

/** The query-string names of the filter, in the order they are checked. */
const UUID_PARAMS = [
  ["revision_id", "revisionId"],
  ["legal_entity_id", "legalEntityId"],
  ["facility_id", "facilityId"],
] as const;

/**
 * `?…` → an {@link InventoryFilter}, or the FIRST parameter that was rejected.
 *
 * Shape only, like every parser in the codebase (`./wire`'s header): a
 * well-formed uuid that names nothing simply matches nothing — the read is
 * tenant-pinned, so a foreign `revision_id` is an empty list rather than a
 * refusal, which is PATTERN 3's "a foreign id reads as absent" for a FILTER.
 * What is refused is a value the column could not hold: a non-uuid would reach
 * Postgres as a malformed literal (a 500), and `state=pending` or
 * `year_month=2024-13` would silently return nothing and look like an empty
 * report.
 */
export function parseInventoryFilter(
  params: URLSearchParams,
): ParseResult<InventoryFilter> {
  const filter: {
    -readonly [K in keyof InventoryFilter]: InventoryFilter[K];
  } = {};

  for (const [param, key] of UUID_PARAMS) {
    const raw = params.get(param);
    if (raw === null) continue;
    const id = uuidOrNull(raw);
    if (id === undefined || id === null) return { ok: false, field: param };
    filter[key] = id;
  }

  const state = params.get("state");
  if (state !== null) {
    if (!isRowState(state)) return { ok: false, field: "state" };
    filter.state = state;
  }

  const yearMonth = params.get("year_month");
  if (yearMonth !== null) {
    if (!isYearMonth(yearMonth)) return { ok: false, field: "year_month" };
    filter.yearMonth = yearMonth;
  }

  // A flag, so its spelling is generous on purpose — `?queue` with no value is
  // what a hand-written link looks like, and it must not mean "false".
  const queue = params.get("queue");
  if (queue !== null) {
    if (!["", "1", "true"].includes(queue)) {
      return { ok: false, field: "queue" };
    }
    filter.approvalQueue = true;
  }

  return { ok: true, values: filter };
}

/**
 * The most rows one inventory read returns.
 *
 * Same reasoning as `MAX_VERSION_CHAIN` (`./rows`): a cross-table read with no
 * `revision_id` spans every revision a company has ever had, and a screen that
 * asked for it must get a bounded answer plus the truth that it is bounded —
 * rather than a request that quietly turns into the whole database. Callers say
 * what a truncated answer means for them; the API-2 listing says `truncated`.
 */
const MAX_INVENTORY_ROWS = 2000;

// ─── The UNION ───────────────────────────────────────────────────────────────

/**
 * One row of the inventory: the mixin, WHICH table it came from, and the
 * three-column body summary.
 *
 * It extends `RowMixin` rather than repeating it, which is what makes
 * `serialiseMixin` reusable here — the projection below aliases the mixin
 * columns to their Drizzle names precisely so this type is true of the query's
 * own result.
 */
export type InventoryRow = RowMixin & {
  readonly sourceTable: InputTableName;
  readonly kind: string;
  readonly label: string | null;
  /** NUMERIC arrives as a string from the driver; `Number()` at the wire. */
  readonly quantity: string | null;
};

/** The predicates of ONE branch — the invariants plus whatever was filtered. */
function branchWhere(
  table: InputTableName,
  companyId: string,
  filter: InventoryFilter,
): SQL {
  const t = INPUT_TABLES[table];
  const where: SQL[] = [
    eq(t.companyId, companyId),
    // The partial index's own predicate (DM-12) and LC-6's tombstone rule —
    // unconditional, see the header.
    isNull(t.supersededById),
    eq(t.isDeleted, false),
  ];
  if (filter.revisionId) where.push(eq(t.revisionId, filter.revisionId));
  if (filter.legalEntityId)
    where.push(eq(t.legalEntityId, filter.legalEntityId));
  if (filter.facilityId) where.push(eq(t.facilityId, filter.facilityId));
  if (filter.yearMonth) where.push(eq(t.yearMonth, filter.yearMonth));
  // The queue IS `state='draft'` over the invariants above (see the field's
  // note). Both may be given; they agree or they intersect to nothing.
  if (filter.approvalQueue) where.push(eq(t.state, "draft"));
  if (filter.state) where.push(eq(t.state, filter.state));
  return sql.join(where, sql` and `);
}

/**
 * The SELECT for ONE of the four tables. THE projection — called four times,
 * never written twice (see the header).
 *
 * The mixin columns are aliased to their DRIZZLE names (`"legalEntityId"`, not
 * `legal_entity_id`) because the row this produces is consumed as a `RowMixin`
 * by `serialiseMixin`, which is the same function the four per-table DTOs use.
 * The alternative — snake_case out of SQL and a second serialiser to match —
 * is the drift `./wire` exists to prevent.
 */
function branch(
  table: InputTableName,
  companyId: string,
  filter: InventoryFilter,
): SQL {
  const t = INPUT_TABLES[table];
  const summary = BODY_SUMMARY[table];
  const projection = [
    ...MIXIN_COLUMN_NAMES.map(
      (name) => sql`${t[name]} as ${sql.identifier(name)}`,
    ),
    // `::text` rather than a bare parameter: in a UNION branch Postgres has to
    // resolve the column's type from the branch alone, and an untyped `$n`
    // there is "could not determine data type of parameter".
    sql`${table}::text as "sourceTable"`,
    sql`${summary.kind} as "kind"`,
    sql`left(${summary.label}, ${LABEL_LIMIT}) as "label"`,
    sql`${summary.quantity} as "quantity"`,
  ];
  // Parenthesised so the `order by`/`limit` below belongs to the UNION rather
  // than to its last branch.
  return sql`(select ${sql.join(projection, sql`, `)} from ${t} where ${branchWhere(table, companyId, filter)})`;
}

/**
 * The Drizzle decoders of the mixin columns — ONE map for all four branches.
 *
 * A raw statement has no column objects for Drizzle to decode a result through,
 * so `db.execute` hands back exactly what the driver produced: a `timestamptz`
 * arrives as a STRING, and `serialiseMixin` would call `.toISOString()` on it
 * and 500. The fix is not two hand-written `new Date(...)` — it is to run each
 * value through the column's own `mapFromDriverValue`, which is what the query
 * builder would have done. `emission_activity` supplies the map because the
 * mixin is identical on all four tables by construction (§4.8, one
 * `lifecycleColumns()`), so decoding one branch decodes them all — and a
 * twentieth mixin column with a decoder of its own needs no edit here.
 */
const MIXIN_DECODERS = getTableColumns(emissionActivity);

/** A raw UNION row → an {@link InventoryRow} with its mixin columns decoded. */
function decodeMixin(row: Record<string, unknown>): InventoryRow {
  const decoded: Record<string, unknown> = { ...row };
  for (const name of MIXIN_COLUMN_NAMES) {
    const value = decoded[name];
    decoded[name] =
      value === null || value === undefined
        ? null
        : MIXIN_DECODERS[name].mapFromDriverValue(value);
  }
  // The projection above IS this shape — the cast is the same "the caller named
  // the columns" boundary the per-table serialisers cross (`./rows`).
  return decoded as InventoryRow;
}

/** An inventory read: the rows, and whether the cap cut the answer short. */
export interface InventoryPage {
  readonly rows: InventoryRow[];
  /** The cap was reached — this is a prefix of the inventory, not all of it. */
  readonly truncated: boolean;
}

/**
 * THE cross-table read (DM-14). One statement, four branches, tenant-pinned in
 * every one of them.
 *
 * ORDERING IS THE UNION'S, NOT FOUR LISTS CONCATENATED: `created_at, id` across
 * the whole result, the same order `listCurrent` gives within one table, so an
 * inventory of one table matches that table's own listing row for row. Doing it
 * in Postgres is also the only way the cap can mean anything — a cap applied
 * after four separate queries would have already fetched everything.
 */
export async function listInventory(
  db: DbClient,
  companyId: string,
  filter: InventoryFilter = {},
): Promise<InventoryPage> {
  const branches = INPUT_TABLE_NAMES.map((table) =>
    branch(table, companyId, filter),
  );
  const rows = await db.execute<Record<string, unknown>>(sql`
    ${sql.join(branches, sql` union all `)}
    order by "createdAt" asc, "id" asc
    limit ${MAX_INVENTORY_ROWS + 1}
  `);

  const all = [...rows];
  const truncated = all.length > MAX_INVENTORY_ROWS;
  return {
    rows: (truncated ? all.slice(0, MAX_INVENTORY_ROWS) : all).map(decodeMixin),
    truncated,
  };
}

// ─── Counting the same rows the listing returns ──────────────────────────────

/** How many CURRENT rows one input table holds, split by `state` (§0.5). */
export interface InventoryCount {
  readonly total: number;
  readonly approved: number;
  /** `total - approved` — what the approval queue (`?queue`) contains. */
  readonly draft: number;
}

/**
 * The size of an inventory read, per table, WITHOUT reading it (T3.7).
 *
 * IT SHARES `branchWhere` WITH `listInventory`, and that is the whole reason it
 * lives here rather than on the screen that wants the number. A counter written
 * beside the listing but with its own predicate is the classic pair that drifts:
 * the dashboard would say "18 rows" and the inventory would show 17, and the
 * difference would be a tombstone or a superseded version that one of the two
 * forgot about. Here the invariants of API-2 are stated once and both callers
 * inherit them.
 *
 * PER TABLE, not per scope: the grouping of four tables into "Scope 1 / Scope 2
 * / disclosures" is a REPORTING decision (`@/server/dashboard/dashboard`), and
 * this module has deliberately never known which scope a table belongs to.
 *
 * Four small aggregates rather than one UNION: each is an index-only count over
 * the partial index of DM-12, and a UNION would buy nothing back that the
 * caller does not immediately re-split.
 */
export async function countInventory(
  db: DbClient,
  companyId: string,
  filter: InventoryFilter = {},
): Promise<Record<InputTableName, InventoryCount>> {
  const counts = {} as Record<InputTableName, InventoryCount>;
  for (const table of INPUT_TABLE_NAMES) {
    const t = INPUT_TABLES[table];
    const [row] = await db
      .select({
        total: count(),
        approved: sql<number>`count(*) filter (where ${t.state} = 'approved')`,
      })
      .from(t)
      .where(branchWhere(table, companyId, filter));
    const total = Number(row?.total ?? 0);
    const approved = Number(row?.approved ?? 0);
    counts[table] = { total, approved, draft: total - approved };
  }
  return counts;
}

// ─── Wire ────────────────────────────────────────────────────────────────────

/**
 * One inventory row as the API speaks it: the same 19 mixin fields every
 * per-table DTO carries, plus WHERE it came from and the body summary.
 *
 * `source_table` is the field a client dispatches on — it is the name in
 * `/api/activities/<…>` and in `evidence_link.linked_object_type` (К-8), so a
 * row of the inventory can be opened, linked and assessed without a second
 * lookup to find out what it is.
 */
export interface InventoryRowDto extends RowMixinDto {
  source_table: InputTableName;
  kind: string;
  label: string | null;
  quantity: number | null;
}

/** THE serialiser of a cross-table row. */
export function serialiseInventoryRow(row: InventoryRow): InventoryRowDto {
  return {
    ...serialiseMixin(row),
    source_table: row.sourceTable,
    kind: row.kind,
    label: row.label,
    quantity: row.quantity === null ? null : Number(row.quantity),
  };
}
