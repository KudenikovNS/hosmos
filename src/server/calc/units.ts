// CALC-3 — UNIT CONVERSION (D7, DM-23).
//
// See docs/decisions/server-calc-units.md for the full account.
import type { unitConversion } from "@/server/db/schema";

import {
  UNIT_CONVERSION_BASES,
  type UnitConversionBasis,
} from "./formula-version";

/** A `unit_conversion` row as Drizzle returns it. */
type UnitConversionRow = typeof unitConversion.$inferSelect;

/**
 * What this module needs of a conversion row — a structural subset of the
 * table, so the calculation run can pass real rows and a test can build literals.
 */
export type ConversionCandidate = Pick<
  UnitConversionRow,
  | "id"
  | "fromUnit"
  | "toUnit"
  | "multiplier"
  | "activityContext"
  | "factorSetId"
>;

/**
 * The conversion that WAS applied, exactly as `calculation` records it
 * (`conversion_factor` = {@link multiplier}).
 *
 * `conversionId` is `null` for the identity: no row was read, so pointing at one
 * would be a lie in the lineage that VAL-035 checks.
 */
export interface AppliedConversion {
  readonly fromUnit: string;
  readonly toUnit: string;
  /** NUMERIC-as-string. `to = from × multiplier` (DM-23). */
  readonly multiplier: string;
  readonly basis: UnitConversionBasis;
  readonly conversionId: string | null;
}

/** CALC-3's answer: a conversion, or the refusal that fails the row. */
export type UnitConversionResult =
  | { readonly status: "ok"; readonly conversion: AppliedConversion }
  | {
      readonly status: "failed_unit";
      readonly conversion: null;
      readonly fromUnit: string;
      readonly toUnit: string;
      readonly activityType: string;
    };

/**
 * Each basis as its position in {@link UNIT_CONVERSION_BASES} — the number
 * CALC-2 puts into a candidate's rank tuple (`factors.ts`). Derived from the
 * array rather than written out, so the two can never disagree about which
 * basis outranks which.
 */
export const UNIT_CONVERSION_BASES_INDEX: Record<UnitConversionBasis, number> =
  Object.fromEntries(
    UNIT_CONVERSION_BASES.map((basis, index) => [basis, index]),
  ) as Record<UnitConversionBasis, number>;

/** `to = from × 1` when the units already agree. */
const IDENTITY_MULTIPLIER = "1";

/** The identity conversion for `unit` (no row, multiplier exactly 1). */
function identity(unit: string): AppliedConversion {
  return {
    fromUnit: unit,
    toUnit: unit,
    multiplier: IDENTITY_MULTIPLIER,
    basis: "identity",
    conversionId: null,
  };
}

/** A row seen as the conversion it would apply. */
function applied(
  row: ConversionCandidate,
  basis: UnitConversionBasis,
): AppliedConversion {
  return {
    fromUnit: row.fromUnit,
    toUnit: row.toUnit,
    multiplier: row.multiplier,
    basis,
    conversionId: row.id,
  };
}

/**
 * Which rows sit on each ROW basis of {@link UNIT_CONVERSION_BASES}, as a
 * predicate per rung. Exhaustive by type, exactly as CALC-2's `TIER_PREDICATES`
 * is: a rung added to the ordered constant without a predicate here does not
 * compile, and a rung added here without touching that constant is unreachable —
 * which is how the ORDER stays the single fact that `formula-version.ts` owns.
 *
 * `identity` is absent because it is not a row: no `unit_conversion` is read
 * when the units already agree, so there is nothing to match.
 *
 * A set-scoped row is matched by IDENTITY of the set id, never by "has one" —
 * `pinnedSetId` is the period's pin (К-24), so a conversion belonging to some
 * OTHER set is on no rung at all and can convert nothing, exactly as CALC-2
 * treats a factor of another set.
 */
const BASIS_PREDICATES: Record<
  Exclude<UnitConversionBasis, "identity">,
  (
    row: ConversionCandidate,
    activityType: string,
    pinnedSetId: string,
  ) => boolean
> = {
  set_contextual: (row, activityType, pinnedSetId) =>
    row.factorSetId === pinnedSetId && row.activityContext === activityType,
  set_universal: (row, _activityType, pinnedSetId) =>
    row.factorSetId === pinnedSetId && row.activityContext === null,
  contextual: (row, activityType) =>
    row.factorSetId === null && row.activityContext === activityType,
  universal: (row) => row.factorSetId === null && row.activityContext === null,
};

/**
 * THE conversion from `fromUnit` to `toUnit` for an activity of `activityType`
 * under the period's pinned set, or `failed_unit`.
 *
 * The lookups are spelled as one pass PER RUNG rather than one sorted pass so
 * the precedence is visible: the first rung that offers a row wins outright and
 * the rest of the table is not even consulted. Taking the first match inside a
 * rung is safe where it would not be for factors:
 * `unit_conversion_from_to_context_key` — (from_unit, to_unit,
 * COALESCE(activity_context,'--'), COALESCE(factor_set_id, <zero uuid>)) since
 * 0010 — makes a rung of two rows unrepresentable, so there is no order to
 * depend on.
 *
 * @param pinnedSetId the period's `factor_set_id` (К-24). It is a PARAMETER
 *                    rather than a module-level lookup for the reason CALC-2
 *                    takes it in its query: the pin is what AC-8 rests on, and a
 *                    converter reading "the current set" would reproduce a
 *                    locked report differently the day an admin publishes one.
 */
export function convertUnit(
  fromUnit: string,
  toUnit: string,
  activityType: string,
  pinnedSetId: string,
  rows: readonly ConversionCandidate[],
): UnitConversionResult {
  if (fromUnit === toUnit) {
    return { status: "ok", conversion: identity(fromUnit) };
  }

  const edges = rows.filter(
    (row) => row.fromUnit === fromUnit && row.toUnit === toUnit,
  );

  for (const basis of UNIT_CONVERSION_BASES) {
    if (basis === "identity") continue;
    const row = edges.find((candidate) =>
      BASIS_PREDICATES[basis](candidate, activityType, pinnedSetId),
    );
    if (row) return { status: "ok", conversion: applied(row, basis) };
  }

  return {
    status: "failed_unit",
    conversion: null,
    fromUnit,
    toUnit,
    activityType,
  };
}

/**
 * Every unit reachable from `fromUnit` in one hop, keyed by the target unit,
 * each carrying the BEST basis that reaches it.
 *
 * This is what lets CALC-2 rank factors priced in different units without
 * knowing anything about conversions: `factors.ts` looks a candidate's
 * `input_unit` up here, and the `basis` it gets back is the rung the candidate
 * sits on. A unit reachable on SEVERAL rungs (gas from `MWh` reaches `kWh_net`
 * through a calorific row and `kWh_gross` through physics; since 0010 it may
 * reach one unit through the pinned set's own row AND through the shared table's)
 * keeps the entry of the BEST one — {@link UNIT_CONVERSION_BASES} order decides,
 * and a later basis never overwrites an earlier one.
 *
 * Insertion order is identity → the set's own rows → the shared ones, contextual
 * before universal inside each, each group sorted by target unit, so iterating
 * the map is deterministic for a caller that cares.
 *
 * @param pinnedSetId the period's `factor_set_id` — see {@link convertUnit}.
 */
export function reachableUnits(
  fromUnit: string,
  activityType: string,
  pinnedSetId: string,
  rows: readonly ConversionCandidate[],
): ReadonlyMap<string, AppliedConversion> {
  const reachable = new Map<string, AppliedConversion>([
    [fromUnit, identity(fromUnit)],
  ]);

  for (const basis of UNIT_CONVERSION_BASES) {
    if (basis === "identity") continue;
    const tier = rows
      .filter(
        (row) =>
          row.fromUnit === fromUnit &&
          BASIS_PREDICATES[basis](row, activityType, pinnedSetId),
      )
      .sort((a, b) => (a.toUnit < b.toUnit ? -1 : a.toUnit > b.toUnit ? 1 : 0));

    for (const row of tier) {
      // First basis to reach a unit keeps it — the pinned set's own row before
      // the shared one, contextual before universal inside each scope.
      if (!reachable.has(row.toUnit)) {
        reachable.set(row.toUnit, applied(row, basis));
      }
    }
  }

  return reachable;
}
