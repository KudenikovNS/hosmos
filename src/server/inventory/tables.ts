// =============================================================================
// THE FOUR INPUT TABLES, AS DATA — a LEAF module (it imports the schema, and
// otherwise nothing of ours at runtime: the `DbClient` of `currentRowIds` is a
// TYPE-only import).
//
// WHY IT IS SEPARATE FROM `./rows`. The append-only service imports
// `@/server/validation/write` → `run` → `registry` → the evaluator modules, and
// one of those evaluators (VAL-010) needs to know the names of the four input
// tables. An evaluator importing the service would close a cycle around the
// registry's import-time coverage check (R-12) and take the whole graph down —
// the same reason `validation/types.ts` and `periods/lifecycle.ts` are leaves.
// So the vocabulary lives here and both sides import it.
//
// WHAT MAKES A GENERIC SERVICE POSSIBLE AT ALL. D23 rejected a physical
// head/version spine: there is no super-table, so "an input row" is not a type
// the database knows. What the four tables share is the 20-column SHAPE of
// `lifecycleColumns()` (§4.8, DM-11) — and every operation of the append-only
// protocol (LC-3…LC-6) touches ONLY those 20 columns. The body of a row is
// carried through opaquely, as values a table's own parser produced. That is the
// whole trick: the SERVICE is generic because the PROTOCOL is, and the wire
// contract stays per table (`./emission-activity` and its T3.2/T3.3 siblings).
// =============================================================================
import { sql } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import {
  contractualInstrument,
  disclosureRecord,
  emissionActivity,
  purchasedEnergyActivity,
} from "@/server/db/schema";

/**
 * The four input tables of the D23 mixin, keyed by their SQL name.
 *
 * The key is the table name verbatim because that string is already the
 * vocabulary of three other things: `validation_result.object_type`,
 * `evidence_link.linked_object_type` (К-8) and `ValidationRule.appliesTo`. One
 * spelling, four consumers.
 */
export const INPUT_TABLES = {
  emission_activity: emissionActivity,
  purchased_energy_activity: purchasedEnergyActivity,
  contractual_instrument: contractualInstrument,
  disclosure_record: disclosureRecord,
} as const;

/** One of the four input-table names (§4.9–4.12). */
export type InputTableName = keyof typeof INPUT_TABLES;

/** The names as a list — iterated by the cross-table reads (DM-14). */
export const INPUT_TABLE_NAMES = Object.keys(INPUT_TABLES) as InputTableName[];

/** The Drizzle table objects, as a union. */
type InputTable = (typeof INPUT_TABLES)[InputTableName];

/**
 * One version of an input row, whichever table it came from.
 *
 * A union of the four `$inferSelect` types, which means the 20 mixin columns are
 * readable off it directly (they are present, identically typed, in every
 * member) while a body column is not — exactly the boundary the generic service
 * is allowed to touch.
 */
export type InputRow = InputTable["$inferSelect"];

/**
 * `state` on an input row — the two values §0.5 allows, and the pair of the
 * per-table CHECK `<table>_state_check`.
 *
 * Here rather than in `@/shared/enums` for the reason that module gives about
 * structural discriminators: this is the SHAPE of the four tables (D5's
 * row-level lifecycle), not a domain list that data may extend. A third value
 * would be a new lifecycle, not a new row.
 */
const ROW_STATES = ["draft", "approved"] as const;

/** `draft` or `approved` — nothing else is a row state (§0.5). */
export type RowState = (typeof ROW_STATES)[number];

/** Is `value` one of the two row states? */
export function isRowState(value: unknown): value is RowState {
  return (ROW_STATES as readonly unknown[]).includes(value);
}

/** Is `value` one of the four input-table names? */
export function isInputTableName(value: unknown): value is InputTableName {
  return typeof value === "string" && value in INPUT_TABLES;
}

/**
 * The input table a write DECLARES it is mutating, read out of a run's
 * `mutatedFields` — the trigger of VAL-010.
 *
 * SAME MECHANISM AS `PERIOD_SCOPE_FIELD` (T2.5), and for the same reason: the
 * thing being changed is not a COLUMN of the target, it is a whole set of rows
 * hanging off it, so the write declares the TABLE NAME as its mutated "field".
 * VAL-010 is blocking; a rule that judged the freeze on every `period`-scope run
 * would refuse every period edit made while the report is closed, including the
 * ones that are supposed to stay legal (relabelling — see DM-7a). Gating it on
 * the declaration keeps it a rule about a MOMENT: an attempt to write a row.
 *
 * Returns `undefined` when the run is not an input-row write, which is how the
 * evaluator says "not applicable" (`[]`) rather than "passed".
 */
export function inputTableAmong(
  fields: readonly string[] | undefined,
): InputTableName | undefined {
  return (fields ?? []).find(isInputTableName);
}

/** One CURRENT version of an input row: which table it lives in, and its id. */
export interface CurrentRowRef {
  readonly table: InputTableName;
  readonly id: string;
}

/**
 * Every CURRENT row of one revision, across the four tables (T4.4).
 *
 * "Current" is `superseded_by_id IS NULL AND NOT is_deleted` — the definition of
 * the partial index of §4.21, of `listCurrent` (T3.1) and of `countRevisionRows`
 * (T2.6). A superseded version is history and a tombstone is a deletion; neither
 * is a row the report CONTAINS, which is why neither may hold up a submit and
 * why neither may be judged by an approval gate.
 *
 * IT RETURNS IDS, not counts, because the two S4 gates need to WALK the set: the
 * submit precondition re-evaluates each row's `record` rules (VR-2) and VAL-041
 * decides whether a stored failure still describes something the revision holds.
 * `countRevisionRows` answers the other question — how many of them are approved
 * — and the two deliberately stay separate rather than one query with two
 * meanings.
 *
 * The table names are interpolated as identifiers from `INPUT_TABLE_NAMES`, a
 * code constant, so no request value ever reaches the SQL text. One round trip,
 * for the reason `loadInputRow` gives: four probes per gate is a lot of latency
 * for an answer that is one UNION away.
 *
 * The `DbClient` import is TYPE-ONLY, so this module stays the leaf its header
 * promises (nothing of ours is imported at runtime but the schema).
 */
export async function currentRowIds(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<CurrentRowRef[]> {
  const probes = INPUT_TABLE_NAMES.map(
    (name) => sql`
      SELECT ${name}::text AS tbl, id
        FROM ${sql.identifier(name)}
       WHERE company_id = ${companyId}
         AND revision_id = ${revisionId}
         AND superseded_by_id IS NULL
         AND is_deleted = false`,
  );
  const rows = await db.execute<{ tbl: InputTableName; id: string }>(
    sql.join(probes, sql` UNION ALL `),
  );
  return [...rows].map((row) => ({ table: row.tbl, id: row.id }));
}
