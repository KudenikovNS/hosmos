// THE CALCULATION RUN (T5.4 — CALC-6, DM-29, §5.1).
//
// See docs/decisions/server-calc-run.md for the full account.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import {
  calculation,
  calculationRunContext,
  contractualInstrument,
  emissionActivity,
  emissionFactor,
  periodScope,
  purchasedEnergyActivity,
  reportRevision,
  reportingPeriod,
  unitConversion,
} from "@/server/db/schema";
import {
  INPUT_TABLE_NAMES,
  INPUT_TABLES,
  type InputTableName,
} from "@/server/inventory/tables";
import type { FrozenScope } from "@/server/revisions/frozen";
import type { RevisionRow } from "@/server/revisions/revisions";

import {
  aggregateRun,
  type AggregateEntity,
  type AggregateFacility,
  type CalcAggregates,
} from "./aggregate";
import {
  isFactorsAmbiguousError,
  type FactorProvenance,
  type FactorYearBasis,
  type PassedOverReason,
} from "./factors";
import {
  FORMULA_VERSION,
  ROUNDING_RULE,
  type CalculationStatus,
  type FactorPriorityTier,
  type UnitConversionBasis,
  type UnitConversionDistance,
} from "./formula-version";
import { computeScope1, type Scope1Factor, type Scope1Line } from "./scope1";
import { computeScope2, type Scope2Line } from "./scope2";
import {
  captureCalculationContext,
  loadCalculationContext,
  type CalculationContext,
  type StoredCalculationContext,
} from "./context";
import type { CalcPeriod } from "./selection";
import type { ConversionCandidate } from "./units";
import { normaliseFactorOutput } from "./output-units";
import type { FactorOutputConversion } from "@/shared/factor-output-units";

/**
 * What a `numeric NOT NULL` column holds when the run has no number for it.
 *
 * See the module header for the whole argument. In one line: it satisfies the
 * constraint, it poisons every arithmetic path instead of being absorbed by one,
 * and it is deterministic. It is written by this module and read by NOTHING —
 * {@link readNumeric} turns it back into `null` before anything else sees it.
 */
export const FAILED_NUMERIC = "NaN";

/**
 * A stored `numeric` as the domain reads it: the literal, or `null` when it is
 * the {@link FAILED_NUMERIC} sentinel.
 *
 * THE ONE FUNCTION THAT STOPS THE SENTINEL FROM BECOMING A NUMBER. Every read
 * path in this file goes through it, so no caller ever holds the string `'NaN'`
 * and no caller can turn it into `0` by being careless with a `?? 0`. Postgres
 * may hand the value back in any case (`NaN`), so the comparison is
 * case-insensitive rather than an equality against one spelling.
 */
export function readNumeric(value: string | null): string | null {
  if (value === null) return null;
  return value.trim().toLowerCase() === "nan" ? null : value;
}

/** A domain figure as the column wants it: the literal, or the sentinel. */
function storeNumeric(value: string | null): string {
  return value ?? FAILED_NUMERIC;
}

// ─── `factor_snapshot` (DM-29) ───────────────────────────────────────────────

/**
 * A group of factors that would have priced the line better and never reached
 * the ladder — {@link PassedOverFactors} in the snapshot's snake_case.
 *
 * SNAKE_CASE IS NOT DECORATION. `factor_snapshot` is read years later by
 * whatever is reading the database then, alongside `factor_value`,
 * `applicable_year` and `gwp_basis`; one object with two naming conventions in
 * it is an object nobody can query without checking which half a key came from.
 */
interface PassedOverFactorSnapshot {
  readonly reason: PassedOverReason;
  readonly tier: FactorPriorityTier;
  readonly geography: string;
  readonly source_name: string;
  readonly source_version: string;
  readonly applicable_year: number | null;
  readonly input_units: readonly string[];
  readonly factor_ids: readonly string[];
}

/**
 * WHY THIS FACTOR — the resolver's account, frozen with the figure it explains.
 *
 * IT IS PART OF BEING RE-DERIVABLE, WHICH IS WHY IT IS IN THE SNAPSHOT AND NOT
 * DERIVED ON READ. Re-deriving it would mean re-running CALC-2 against the
 * factor library as it stands TODAY: a national factor added next year would
 * retro-actively turn a locked report's honest global default into a
 * substitution it never made, and a national factor deleted next year would make
 * a real substitution vanish. The snapshot already refuses that for the VALUE
 * (DM-29); "what this was taken instead of" is a claim about the same moment and
 * has to be frozen at the same moment.
 *
 * NO COLUMN WAS ADDED. `calculation.factor_snapshot` is `jsonb`.
 */
interface FactorProvenanceSnapshot {
  readonly tier: FactorPriorityTier;
  readonly year_basis: FactorYearBasis;
  /** The year the ROW asked for — not the factor's, which is `applicable_year`. */
  readonly requested_year: number | null;
  /** The unit the activity row was ENTERED in. */
  readonly entered_unit: string;
  readonly factor_unit: string;
  readonly unit_distance: UnitConversionDistance;
  readonly conversion_basis: UnitConversionBasis;
  readonly conversion_multiplier: string;
  /** EMPTY is the normal case: nothing better existed, nothing to disclose. */
  readonly passed_over: readonly PassedOverFactorSnapshot[];
}

/** The factor as it stood when the run applied it — DM-29's "воспроизводимость". */
export interface ResolvedFactorSnapshot {
  readonly resolved: true;
  readonly factor_id: string;
  readonly factor_set_id: string;
  readonly factor_code: string;
  readonly factor_name: string;
  readonly activity_type: string;
  readonly geography: string;
  /** The VALUE, verbatim — the report's number is re-derivable from this. */
  readonly factor_value: string;
  readonly input_unit: string;
  readonly output_unit: string;
  /** Absent on historical runs before 1.5.0; those rows are never rewritten. */
  readonly output_conversion?: FactorOutputConversion | null;
  readonly source_name: string;
  readonly source_version: string;
  /**
   * WHOSE factor this was, when it was a supplier's own (0007) — `null` for a
   * published average. It is in the snapshot for the same reason `source_name`
   * is: after the fact, "this line was priced by Zelena Energija's own 2025
   * disclosure" and "this line was priced by the Slovenian grid average" are
   * different claims about the same kilogram, and only the snapshot can still
   * tell them apart once the factor library has moved on.
   */
  readonly supplier_name: string | null;
  readonly publication_date: string | null;
  readonly applicable_year: number | null;
  /** AR5 / AR6 — the GWP basis AS OF the calculation (DM-29, verbatim). */
  readonly gwp_basis: string | null;
  readonly biogenic_treatment: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  /**
   * WHY this factor and not another (see {@link FactorProvenanceSnapshot}).
   *
   * `null` only for a row written before the account existed — the column is
   * `jsonb` and old runs are not rewritten, so every reader has to cope with its
   * absence rather than assume it. A missing account is "unknown", never "there
   * was nothing to disclose".
   */
  readonly provenance: FactorProvenanceSnapshot | null;
  readonly formula_version: string;
  readonly rounding_rule: string;
}

/**
 * The snapshot of a line that resolved NO factor.
 *
 * `factor_snapshot` is `NOT NULL`, so a failed line still needs an object — and
 * an empty `{}` would be indistinguishable from a bug. This one is explicitly
 * `resolved: false` and names the reason and the units that would have fixed it,
 * so the row explains itself without a join.
 */
interface UnresolvedFactorSnapshot {
  readonly resolved: false;
  readonly reason: CalculationStatus;
  readonly wanted_units: readonly string[];
  readonly formula_version: string;
  readonly rounding_rule: string;
}

/** What `calculation.factor_snapshot` holds. */
export type FactorSnapshot = ResolvedFactorSnapshot | UnresolvedFactorSnapshot;

/**
 * Copy the resolved factor whole (DM-29).
 *
 * The factor comes from the pure core's OWN result, never from a second query —
 * a re-read could return a different row (a concurrent factor-set edit) and
 * would break AC-8 in a way no test would notice until years later.
 */
export function buildFactorSnapshot(
  factor: Scope1Factor | null,
  status: CalculationStatus,
  wantedUnits: readonly string[],
  provenance: FactorProvenance | null,
): FactorSnapshot {
  if (factor === null) {
    return {
      resolved: false,
      reason: status,
      wanted_units: [...wantedUnits],
      formula_version: FORMULA_VERSION,
      rounding_rule: ROUNDING_RULE,
    };
  }
  return {
    resolved: true,
    factor_id: factor.id,
    factor_set_id: factor.factorSetId,
    factor_code: factor.factorCode,
    factor_name: factor.factorName,
    activity_type: factor.activityType,
    geography: factor.geography,
    factor_value: factor.factorValue,
    input_unit: factor.inputUnit,
    output_unit: factor.outputUnit,
    output_conversion:
      normaliseFactorOutput(factor.factorValue, factor.outputUnit)
        ?.conversion ?? null,
    source_name: factor.sourceName,
    source_version: factor.sourceVersion,
    supplier_name: factor.supplierName ?? null,
    publication_date: factor.publicationDate,
    applicable_year: factor.applicableYear,
    gwp_basis: factor.gwpBasis,
    biogenic_treatment: factor.biogenicTreatment,
    valid_from: factor.validFrom,
    valid_to: factor.validTo,
    provenance: provenance === null ? null : toProvenanceSnapshot(provenance),
    formula_version: FORMULA_VERSION,
    rounding_rule: ROUNDING_RULE,
  };
}

/** The resolver's account in the snapshot's spelling. A rename, nothing more. */
function toProvenanceSnapshot(
  provenance: FactorProvenance,
): FactorProvenanceSnapshot {
  return {
    tier: provenance.tier,
    year_basis: provenance.yearBasis,
    requested_year: provenance.requestedYear,
    entered_unit: provenance.enteredUnit,
    factor_unit: provenance.factorUnit,
    unit_distance: provenance.unitDistance,
    conversion_basis: provenance.conversionBasis,
    conversion_multiplier: provenance.conversionMultiplier,
    passed_over: provenance.passedOver.map((entry) => ({
      reason: entry.reason,
      tier: entry.tier,
      geography: entry.geography,
      source_name: entry.sourceName,
      source_version: entry.sourceVersion,
      applicable_year: entry.applicableYear,
      input_units: [...entry.inputUnits],
      factor_ids: [...entry.factorIds],
    })),
  };
}

// ─── The inputs of a run ─────────────────────────────────────────────────────

/**
 * Why a row of the revision was not calculated, beyond CALC-1's own four.
 *
 * CALC-1 (`./selection`) owns the four LIFECYCLE rejections. This one is about
 * the BOUNDARY (DM-8, D15) and lives here rather than there because the pure
 * cores know nothing of the organisation model — and because it is the reason
 * `period_scope.updated_at` is an input of CALC-6's invalidation at all: if the
 * boundary did not decide which rows are calculated, redrawing it could not
 * stale a run.
 *
 * @public
 */
export const RUN_EXCLUSION_REASONS = ["outside_boundary"] as const;

/** One value of {@link RUN_EXCLUSION_REASONS}. */
type RunExclusionReason = (typeof RUN_EXCLUSION_REASONS)[number];

/** A row the boundary kept out of the run. */
export interface RunExclusion {
  readonly activityTable: InputTableName;
  readonly activityRowId: string;
  readonly legalEntityId: string;
  readonly reason: RunExclusionReason;
}

/** The period a run reads — live, or thawed out of `frozen_scope` (CALC-7). */
export interface RunPeriod extends CalcPeriod {
  readonly periodId: string;
  /** `true` when the values came from `report_revision.frozen_scope` (D15). */
  readonly frozen: boolean;
  /** The legal entities the boundary INCLUDES, in id order. */
  readonly includedEntityIds: readonly string[];
}

/**
 * The period and the boundary a run is calculated against.
 *
 * A LOCKED REVISION READS ITS SNAPSHOT, NOT THE LIVE TABLES (CALC-7, AC-11).
 * `frozen_scope` is taken at lock precisely because a restatement legitimately
 * unfreezes the live period afterwards, and from that moment the live rows no
 * longer describe the locked report. T5.5 proves the consequence — the boundary
 * can be moved by direct SQL between two runs of a locked revision and the
 * numbers do not budge.
 */
export async function loadRunPeriod(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
): Promise<RunPeriod | null> {
  const frozen = revision.frozenScope as FrozenScope | null;
  if (revision.status === "locked" && frozen) {
    return {
      periodId: frozen.period_id,
      startDate: String(frozen.period.start_date),
      endDate: String(frozen.period.end_date),
      factorSetId: String(frozen.period.factor_set_id),
      frozen: true,
      includedEntityIds: frozen.scope
        .filter((entry) => entry.status === "included")
        .map((entry) => entry.legal_entity_id)
        .sort(),
    };
  }

  const [period] = await db
    .select()
    .from(reportingPeriod)
    .where(
      and(
        eq(reportingPeriod.id, revision.periodId),
        eq(reportingPeriod.companyId, companyId),
      ),
    )
    .limit(1);
  if (!period) return null;

  const scope = await db
    .select({
      legalEntityId: periodScope.legalEntityId,
      status: periodScope.status,
    })
    .from(periodScope)
    .where(
      and(
        eq(periodScope.companyId, companyId),
        eq(periodScope.periodId, period.id),
      ),
    )
    .orderBy(asc(periodScope.legalEntityId));

  return {
    periodId: period.id,
    startDate: period.startDate,
    endDate: period.endDate,
    factorSetId: period.factorSetId,
    frozen: false,
    includedEntityIds: scope
      .filter((row) => row.status === "included")
      .map((row) => row.legalEntityId),
  };
}

/**
 * The country a factor is resolved by: the row's facility, else its legal
 * entity, else `GLOBAL`.
 *
 * ONE LADDER FOR BOTH SCOPES. VAL-021 already fixed it for Scope 2 (the
 * facility's country when there is one, the entity's otherwise) and refuses a
 * Scope-2 row that has neither. `scope1.ts` names `'GLOBAL'` as the value for a
 * row with no facility; consulting the ENTITY first cannot select a factor the
 * facility's country would not have selected — CALC-2's ladder has exactly
 * `site_country` and `global` — it only avoids falling to `GLOBAL` while the
 * country is in fact known, one level up (D9 makes the entity mandatory and the
 * facility optional).
 */
const GLOBAL_GEOGRAPHY = "GLOBAL";

/** `legal_entity.id → country`, `facility.id → {country, legalEntityId, name}`. */
interface OrgIndex {
  readonly entities: Map<
    string,
    {
      country: string | null;
      name: string;
      turnover: string | null;
      currency: string | null;
    }
  >;
  readonly facilities: Map<
    string,
    { country: string | null; legalEntityId: string; name: string }
  >;
}

function orgIndexOf(context: CalculationContext): OrgIndex {
  return {
    entities: new Map(
      context.entities.map(({ id, ...entity }) => [id, entity]),
    ),
    facilities: new Map(
      context.facilities.map(({ id, ...site }) => [id, site]),
    ),
  };
}

/** Feed the same saved inputs to both the initial response and later reads. */
function aggregateWithContext(
  lines: readonly RunLine[],
  snapshot: StoredCalculationContext,
): CalcAggregates {
  const org = orgIndexOf(snapshot.inputs);
  return aggregateRun({
    lines,
    energy: snapshot.energy,
    entities: entitiesOf(org, snapshot.inputs.period.includedEntityIds),
    facilities: facilitiesOf(org, snapshot.inputs.period.includedEntityIds),
    fx: {
      year: snapshot.inputs.fx.year,
      rates: new Map(Object.entries(snapshot.inputs.fx.rates)),
    },
  });
}

/** The geography ladder above, applied to one row. */
function geographyFor(
  org: OrgIndex,
  legalEntityId: string,
  facilityId: string | null,
): string {
  const site = facilityId === null ? undefined : org.facilities.get(facilityId);
  return (
    site?.country ??
    org.entities.get(legalEntityId)?.country ??
    GLOBAL_GEOGRAPHY
  );
}

// ─── The run ─────────────────────────────────────────────────────────────────

/** A line of the run as the API returns it (the persisted shape plus lineage). */
export interface RunLine {
  readonly id: string;
  readonly activityTable: string;
  readonly activityRowId: string;
  readonly legalEntityId: string;
  readonly facilityId: string | null;
  readonly scope: "scope1" | "scope2";
  readonly reportingBasis: "location_based" | "market_based" | null;
  readonly methodCode: string;
  readonly formulaVersion: string;
  readonly roundingRule: string;
  /** `null` when the run had no input value for the line — never `0`, never NaN. */
  readonly inputValue: string | null;
  readonly inputUnit: string;
  readonly conversionFactor: string;
  readonly factorId: string | null;
  readonly factorSnapshot: FactorSnapshot;
  /** kgCO2e, or `null` when the line failed (see the header). */
  readonly co2eResult: string | null;
  readonly biogenicCo2Result: string | null;
  readonly calculationStatus: CalculationStatus;
}

/** What one run is, as a summary — the shape `GET /api/revisions/[id]` shows. */
export interface CalcRun {
  readonly runId: string;
  readonly calculatedAt: string;
  readonly status: "ok" | "failed";
  readonly lineCount: number;
  readonly failedCount: number;
}

/** A run plus everything it produced. */
interface CalcRunResult {
  readonly run: CalcRun;
  readonly lines: readonly RunLine[];
  readonly aggregates: CalcAggregates;
  /** Rows the boundary or CALC-1 kept out, each with its reason. */
  readonly excluded: readonly RunExclusion[];
}

/** Why a run could not be attempted at all. */
type CalcRunFailure =
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "HISTORICAL_CONTEXT_MISSING" }
  | { ok: false; error: "HISTORICAL_FORMULA_UNSUPPORTED" }
  | { ok: false; error: "CONCURRENT_MODIFICATION" }
  | { ok: false; error: "FACTORS_AMBIGUOUS"; detail: Record<string, unknown> };

/** What {@link calculateRevision} answers. */
export type CalcRunOutcome = ({ ok: true } & CalcRunResult) | CalcRunFailure;

/** A `calculation` row, as Drizzle returns it. */
type CalculationRow = typeof calculation.$inferSelect;

/** One stored row → the domain line (the sentinel dies here, see the header). */
function toRunLine(row: CalculationRow): RunLine {
  return {
    id: row.id,
    activityTable: row.activityTable,
    activityRowId: row.activityRowId,
    // `calculation` carries no organisational columns (DM-29's 14 fields), so
    // the two are filled by the caller from the activity row. See `attachOrg`.
    legalEntityId: "",
    facilityId: null,
    scope: row.scope === "scope2" ? "scope2" : "scope1",
    reportingBasis:
      row.reportingBasis === "location_based" ||
      row.reportingBasis === "market_based"
        ? row.reportingBasis
        : null,
    methodCode: row.methodCode,
    formulaVersion: row.formulaVersion,
    roundingRule: row.roundingRule,
    inputValue: readNumeric(row.inputValue),
    inputUnit: row.inputUnit,
    conversionFactor: row.conversionFactor,
    factorId: row.factorId,
    factorSnapshot: row.factorSnapshot as FactorSnapshot,
    co2eResult: readNumeric(row.co2eResult),
    biogenicCo2Result: readNumeric(row.biogenicCo2Result),
    calculationStatus: row.calculationStatus as CalculationStatus,
  };
}

/** The engine's line shape, whichever scope produced it. */
type EngineLine = Scope1Line | Scope2Line;

/** One engine line → the `calculation` insert (DM-29's 14 fields plus the pin). */
function toInsert(
  line: EngineLine,
  ctx: {
    companyId: string;
    revisionId: string;
    runId: string;
    calculatedAt: Date;
  },
): typeof calculation.$inferInsert {
  const biogenic = "biogenicCo2Result" in line ? line.biogenicCo2Result : null;
  return {
    companyId: ctx.companyId,
    revisionId: ctx.revisionId,
    runId: ctx.runId,
    activityTable: line.activityTable,
    activityRowId: line.activityRowId,
    methodCode: line.methodCode,
    formulaVersion: line.formulaVersion,
    inputValue: storeNumeric(line.inputValue),
    inputUnit: line.inputUnit,
    conversionFactor: line.conversionFactor,
    factorId: line.factorId,
    factorSnapshot: buildFactorSnapshot(
      line.factor,
      line.calculationStatus,
      line.wantedUnits,
      line.provenance,
    ),
    scope: line.scope,
    scope3Category: null, // Phase 1 — always NULL (DM-29).
    reportingBasis: line.reportingBasis,
    co2eResult: storeNumeric(line.co2eResult),
    biogenicCo2Result: biogenic,
    roundingRule: line.roundingRule,
    calculatedAt: ctx.calculatedAt,
    calculationStatus: line.calculationStatus,
  };
}

/** An engine line as the aggregation and the response read it. */
function toRunLineFromEngine(line: EngineLine, id: string): RunLine {
  return {
    id,
    activityTable: line.activityTable,
    activityRowId: line.activityRowId,
    legalEntityId: line.legalEntityId,
    facilityId: line.facilityId,
    scope: line.scope,
    reportingBasis: line.reportingBasis,
    methodCode: line.methodCode,
    formulaVersion: line.formulaVersion,
    roundingRule: line.roundingRule,
    inputValue: line.inputValue,
    inputUnit: line.inputUnit,
    conversionFactor: line.conversionFactor,
    factorId: line.factorId,
    factorSnapshot: buildFactorSnapshot(
      line.factor,
      line.calculationStatus,
      line.wantedUnits,
      line.provenance,
    ),
    co2eResult: line.co2eResult,
    biogenicCo2Result:
      "biogenicCo2Result" in line ? line.biogenicCo2Result : null,
    calculationStatus: line.calculationStatus,
  };
}

/**
 * RUN THE CALCULATION AND PERSIST IT (CALC-6).
 *
 * APPEND-ONLY, AND THE INSERT SAYS SO: nothing is deleted, nothing is updated,
 * a second run is a second `run_id` over the same revision. §4.19's
 * `(revision_id, run_id)` index is what makes reading one of them cheap, and
 * T5.5 leans on the earlier run still being there.
 *
 * The whole write is ONE transaction: a half-written run — some lines of this
 * `run_id` present, others not — would look exactly like a run whose remaining
 * rows were excluded by CALC-1, i.e. like a smaller, plausible report.
 */
export async function calculateRevision(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
): Promise<CalcRunOutcome> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(
        (tx) => calculateInTransaction(tx, companyId, revision),
        { isolationLevel: "repeatable read" },
      );
    } catch (error) {
      // Drizzle wraps PostgreSQL errors; only a serialization conflict is safe
      // to retry here. The failed transaction has rolled back before this catch.
      let serializationFailure = false;
      for (let cause = error; cause instanceof Error; cause = cause.cause) {
        if ((cause as { code?: string }).code === "40001") {
          serializationFailure = true;
          break;
        }
      }
      if (!serializationFailure) throw error;
      if (attempt === 1) return { ok: false, error: "CONCURRENT_MODIFICATION" };
      // One new transaction gets a new snapshot, run ID and calculation time.
    }
  }
}

/** Refuse to repair closed pre-1.5.0 non-kg results by appending a new run. */
async function historicalOutputNeedsRestatement(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
): Promise<boolean> {
  if (revision.status !== "locked") return false;
  const frozen = revision.frozenScope as FrozenScope | null;
  const runId =
    frozen?.render_context?.run_id ??
    (await latestRunOf(db, companyId, revision.id))?.runId;
  if (!runId) return false;
  return runNeedsOutputNormalisation(db, companyId, revision.id, runId);
}

/** Old non-kg snapshots lack the conversion that makes their result kilograms. */
async function runNeedsOutputNormalisation(
  db: DbClient,
  companyId: string,
  revisionId: string,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: calculation.id })
    .from(calculation)
    .where(
      and(
        eq(calculation.companyId, companyId),
        eq(calculation.revisionId, revisionId),
        eq(calculation.runId, runId),
        sql`${calculation.factorSnapshot}->>'resolved' = 'true'
        AND coalesce(${calculation.factorSnapshot}->>'output_unit', '') <> 'kgCO2e'
        AND ${calculation.factorSnapshot}->>'output_conversion' IS NULL`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function calculateInTransaction(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
): Promise<CalcRunOutcome> {
  // Resolve and hold the actual revision inside this transaction. If a status
  // update commits while this first query waits, PostgreSQL raises 40001; the
  // outer retry starts a new snapshot and can then read the pinned context.
  const [current] = await db
    .select()
    .from(reportRevision)
    .where(
      and(
        eq(reportRevision.id, revision.id),
        eq(reportRevision.companyId, companyId),
      ),
    )
    .for("share")
    .limit(1);
  if (!current) return { ok: false, error: "NOT_FOUND" };
  revision = current;
  // STAMPED FIRST, BEFORE ANY INPUT IS READ (see the header). A row written
  // while this run is in flight then has `created_at > calculated_at` and stales
  // the run, instead of being silently absent from a run that looks fresh.
  const calculatedAt = new Date();
  const runId = randomUUID();

  const period = await loadRunPeriod(db, companyId, revision);
  if (!period) return { ok: false, error: "NOT_FOUND" };

  const frozen = revision.frozenScope as FrozenScope | null;
  const pinned = frozen?.calculation_context;
  // Old locked revisions cannot acquire purported historical inputs today.
  if (revision.status === "locked" && !pinned)
    return { ok: false, error: "HISTORICAL_CONTEXT_MISSING" };
  if (await historicalOutputNeedsRestatement(db, companyId, revision))
    return { ok: false, error: "HISTORICAL_FORMULA_UNSUPPORTED" };
  const context: CalculationContext =
    revision.status === "locked" && pinned
      ? { ...pinned, period }
      : await captureCalculationContext(db, companyId, period);
  const org = orgIndexOf(context);
  const included = new Set(period.includedEntityIds);

  const [scope1Rows, energyRows, instruments, factors, conversions] =
    await Promise.all([
      db
        .select()
        .from(emissionActivity)
        .where(
          and(
            eq(emissionActivity.companyId, companyId),
            eq(emissionActivity.revisionId, revision.id),
          ),
        )
        .orderBy(asc(emissionActivity.id)),
      db
        .select()
        .from(purchasedEnergyActivity)
        .where(
          and(
            eq(purchasedEnergyActivity.companyId, companyId),
            eq(purchasedEnergyActivity.revisionId, revision.id),
          ),
        )
        .orderBy(asc(purchasedEnergyActivity.id)),
      db
        .select()
        .from(contractualInstrument)
        .where(
          and(
            eq(contractualInstrument.companyId, companyId),
            eq(contractualInstrument.revisionId, revision.id),
          ),
        )
        .orderBy(asc(contractualInstrument.id)),
      db
        .select()
        .from(emissionFactor)
        .where(eq(emissionFactor.factorSetId, period.factorSetId)),
      db
        .select({
          id: unitConversion.id,
          fromUnit: unitConversion.fromUnit,
          toUnit: unitConversion.toUnit,
          multiplier: unitConversion.multiplier,
          activityContext: unitConversion.activityContext,
          factorSetId: unitConversion.factorSetId,
        })
        .from(unitConversion),
    ]);

  // ── The boundary (DM-8/D15) — the run's own filter, before CALC-1's ──────
  const excluded: RunExclusion[] = [];
  const inBoundary = <R extends { id: string; legalEntityId: string }>(
    rows: readonly R[],
    table: InputTableName,
  ): R[] =>
    rows.filter((row) => {
      if (included.has(row.legalEntityId)) return true;
      excluded.push({
        activityTable: table,
        activityRowId: row.id,
        legalEntityId: row.legalEntityId,
        reason: "outside_boundary",
      });
      return false;
    });

  const scope1Input = inBoundary(scope1Rows, "emission_activity").map(
    (row) => ({
      ...row,
      geography: geographyFor(org, row.legalEntityId, row.facilityId),
    }),
  );
  const energyInput = inBoundary(energyRows, "purchased_energy_activity").map(
    (row) => ({
      ...row,
      geography: geographyFor(org, row.legalEntityId, row.facilityId),
    }),
  );
  const instrumentInput = inBoundary(instruments, "contractual_instrument");

  const conversionCandidates: ConversionCandidate[] = conversions;
  let scope1;
  let scope2;
  try {
    scope1 = computeScope1(scope1Input, factors, conversionCandidates, period);
    scope2 = computeScope2(
      energyInput,
      instrumentInput,
      factors,
      conversionCandidates,
      period,
    );
  } catch (error) {
    // T5.1's refusal to pick between tied factors aborts the RUN, and the route
    // turns it into the 503 §12.1 reserves for it. Nothing was written.
    if (isFactorsAmbiguousError(error)) {
      return {
        ok: false,
        error: "FACTORS_AMBIGUOUS",
        detail: error.payload as unknown as Record<string, unknown>,
      };
    }
    throw error;
  }

  const engineLines: EngineLine[] = [...scope1.lines, ...scope2.lines];

  const energy = scope2.matching.rows.map((row) => ({
    energyRowId: row.energyRowId,
    legalEntityId: row.legalEntityId,
    facilityId: row.facilityId,
    energyType: row.energyType,
    consumptionMwh: row.consumptionMwh,
    renewableShare:
      energyRows.find((source) => source.id === row.energyRowId)
        ?.renewableShare ?? null,
  }));
  const snapshot: StoredCalculationContext = {
    version: 1,
    inputs: context,
    energy,
    excluded,
    owners: engineLines.map(
      ({ activityTable, activityRowId, legalEntityId, facilityId }) => ({
        activityTable,
        activityRowId,
        legalEntityId,
        facilityId,
      }),
    ),
  };
  // This handle is the outer repeatable-read transaction: context and lines
  // commit together, including a run whose boundary produces zero lines.
  await db.insert(calculationRunContext).values({
    runId,
    companyId,
    revisionId: revision.id,
    calculatedAt,
    snapshot,
  });
  const inserted =
    engineLines.length === 0
      ? []
      : await db
          .insert(calculation)
          .values(
            engineLines.map((line) =>
              toInsert(line, {
                companyId,
                revisionId: revision.id,
                runId,
                calculatedAt,
              }),
            ),
          )
          .returning({ id: calculation.id });
  const lines = engineLines.map((line, index) =>
    toRunLineFromEngine(line, inserted[index]?.id ?? ""),
  );
  const aggregates = aggregateWithContext(lines, snapshot);

  const failedCount = lines.filter(
    (line) => line.calculationStatus !== "ok",
  ).length;

  return {
    ok: true,
    run: {
      runId,
      calculatedAt: calculatedAt.toISOString(),
      status: failedCount > 0 ? "failed" : "ok",
      lineCount: lines.length,
      failedCount,
    },
    lines,
    aggregates,
    excluded,
  };
}

/** The boundary's legal entities, with the VSME B3 intensity inputs. */
function entitiesOf(
  org: OrgIndex,
  includedEntityIds: readonly string[],
): AggregateEntity[] {
  return includedEntityIds.flatMap((id) => {
    const entity = org.entities.get(id);
    if (!entity) return [];
    return [
      {
        legalEntityId: id,
        name: entity.name,
        turnover: entity.turnover,
        currency: entity.currency,
      },
    ];
  });
}

/** The facilities of the boundary's entities. */
function facilitiesOf(
  org: OrgIndex,
  includedEntityIds: readonly string[],
): AggregateFacility[] {
  const included = new Set(includedEntityIds);
  return [...org.facilities.entries()]
    .filter(([, site]) => included.has(site.legalEntityId))
    .map(([id, site]) => ({
      facilityId: id,
      legalEntityId: site.legalEntityId,
      name: site.name,
    }));
}

// ─── CALC-6's invalidation ───────────────────────────────────────────────────

/** Timestamp sources plus value-compared organisation/FX and missing history. */
export const RUN_STALENESS_SOURCES = [
  /** `max(created_at)` over the revision's input rows — §0.4's append-only. */
  "rows",
  /** `reporting_period.updated_at` — DM-7a's calculation-bearing fields. */
  "period",
  /** `period_scope.updated_at` — the boundary IS an input (see the header). */
  "period_scope",
  "organisation",
  "fx",
  "context",
  "formula",
] as const;

/** One value of {@link RUN_STALENESS_SOURCES}. */
export type RunStalenessSource = (typeof RUN_STALENESS_SOURCES)[number];

/**
 * The three input tables a CALCULATION reads (§4.9–4.11).
 *
 * `disclosure_record` is the fourth of the D23 mixin and is deliberately NOT
 * here: it is a RENDER input (B2, B8–B11 — text and enums), and no figure it
 * holds ever reaches a `calculation` row. It still counts for STALENESS below,
 * where the rule is CALC-6's literal "the revision's rows"; it does not count
 * for "is there anything to calculate", where the question is about arithmetic.
 */
const CALCULATION_INPUT_TABLES: readonly InputTableName[] = [
  "emission_activity",
  "purchased_energy_activity",
  "contractual_instrument",
];

/**
 * Does the revision hold a CURRENT row a calculation would look at?
 *
 * "Current" is `superseded_by_id IS NULL AND NOT is_deleted`, the definition of
 * §4.21's partial index and of every other gate in this codebase.
 *
 * IT EXISTS SO THE APPROVE GATE CAN BE VACUOUSLY SATISFIED, exactly as
 * `all_rows_approved` already is by a revision with no rows. A VSME Basic report
 * may legitimately carry only `disclosure_record` rows — the social and
 * governance disclosures B8–B11 — and have no emissions at all; there is then no
 * run to make and nothing a calculation could object to, and refusing the
 * approval would refuse a report for having no arithmetic in it.
 *
 * Empty runs still have a persisted input context (0026), even when none of
 * the revision's rows are selected by CALC-1 or the boundary.
 */
async function hasCalculableRows(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<boolean> {
  const probes = CALCULATION_INPUT_TABLES.map(
    (name) => sql`
      SELECT 1
        FROM ${sql.identifier(name)}
       WHERE company_id = ${companyId}
         AND revision_id = ${revisionId}
         AND superseded_by_id IS NULL
         AND is_deleted = false`,
  );
  const rows = await db.execute<{ one: number }>(
    sql`SELECT 1 AS one WHERE EXISTS (${sql.join(probes, sql` UNION ALL `)})`,
  );
  return [...rows].length > 0;
}

/** A run, plus whether it still describes the current inputs (CALC-6). */
export interface RunFreshness {
  readonly run: CalcRun | null;
  /**
   * `false` when the revision holds no row a calculation would read — see
   * {@link hasCalculableRows}. The approve gate is then satisfied without a run.
   */
  readonly calculable: boolean;
  /** `true` when inputs changed or the original context was never recorded. */
  readonly stale: boolean;
  /** WHICH sources moved after the run — empty when it is fresh. */
  readonly staleSources: readonly RunStalenessSource[];
  /** Input timestamps, ISO; value-only sources have no reliable edit time. */
  readonly inputsChangedAt: Readonly<Record<RunStalenessSource, string | null>>;
}

/** The latest run's ISO timestamp and counts, or `null` (never calculated). */
export async function latestRunOf(
  db: DbClient,
  companyId: string,
  revisionId: string,
  runId?: string,
): Promise<CalcRun | null> {
  const result = await db.execute<{
    runId: string;
    calculatedAt: string;
    lineCount: number;
    failedCount: number;
  }>(sql`
    WITH times AS (
      SELECT run_id, calculated_at FROM calculation_run_context
       WHERE company_id = ${companyId} AND revision_id = ${revisionId}
         ${runId === undefined ? sql`` : sql`AND run_id = ${runId}`}
      UNION ALL
      SELECT run_id, calculated_at FROM calculation
       WHERE company_id = ${companyId} AND revision_id = ${revisionId}
         ${runId === undefined ? sql`` : sql`AND run_id = ${runId}`}
    ), runs AS (SELECT run_id, max(calculated_at) AS calculated_at FROM times GROUP BY run_id)
    SELECT r.run_id AS "runId", max(r.calculated_at) AS "calculatedAt",
           count(c.id)::int AS "lineCount",
           count(c.id) FILTER (WHERE c.calculation_status <> 'ok')::int AS "failedCount"
      FROM runs r LEFT JOIN calculation c
        ON c.run_id = r.run_id AND c.company_id = ${companyId} AND c.revision_id = ${revisionId}
     GROUP BY r.run_id ORDER BY max(r.calculated_at) DESC, r.run_id DESC LIMIT 1`);
  const row = [...result][0];
  if (!row) return null;
  const failedCount = Number(row.failedCount ?? 0);
  return {
    runId: row.runId,
    calculatedAt: new Date(row.calculatedAt).toISOString(),
    status: failedCount > 0 ? "failed" : "ok",
    lineCount: Number(row.lineCount ?? 0),
    failedCount,
  };
}

/**
 * CALC-6's invalidation, verbatim: a run is stale when `calculated_at` is older
 * than the greatest of the revision's row `created_at`, the period's
 * `updated_at` and the boundary's `updated_at`.
 *
 * ALL THREE SOURCES ARE READ, AND THE THIRD IS THE ONE THAT SHIPS BROKEN. It is
 * easy to see that editing a FIGURE invalidates a total. It is easy to forget
 * that moving the period's `end_date` re-prices every factor and that removing a
 * subsidiary from the boundary removes its emissions — neither touches a single
 * input row, and a run that only watched the rows would stay green over a report
 * it no longer describes. So the sources are ENUMERATED
 * ({@link RUN_STALENESS_SOURCES}) and reported individually, which is also what
 * lets the acceptance test exercise them one at a time.
 *
 * The row scan covers ALL FOUR input tables of the D23 mixin, derived from
 * `INPUT_TABLES` rather than hand-listed: `disclosure_record` does not move a
 * calculated figure, but CALC-6 says "the revision's rows" and a list that has
 * to be maintained by hand is a list that will one day miss the fifth table.
 * A pointless recalculation is cheap; a stale run that thinks it is fresh is not.
 */
export async function runFreshness(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
  runId?: string,
): Promise<RunFreshness> {
  const [run, calculable] = await Promise.all([
    latestRunOf(db, companyId, revision.id, runId),
    hasCalculableRows(db, companyId, revision.id),
  ]);

  // The table names are interpolated as IDENTIFIERS from `INPUT_TABLE_NAMES`, a
  // code constant — no request value ever reaches the SQL text. One round trip
  // for the four, the same shape `currentRowIds` uses for the same reason.
  const rowTimeRows = await db.execute<{ at: string | null }>(
    sql.join(
      INPUT_TABLE_NAMES.map(
        (name) => sql`
          SELECT max(created_at) AS at
            FROM ${sql.identifier(name)}
           WHERE company_id = ${companyId}
             AND revision_id = ${revision.id}`,
      ),
      sql` UNION ALL `,
    ),
  );

  const [periodRow] = await db
    .select({ at: reportingPeriod.updatedAt })
    .from(reportingPeriod)
    .where(
      and(
        eq(reportingPeriod.id, revision.periodId),
        eq(reportingPeriod.companyId, companyId),
      ),
    )
    .limit(1);

  const [scopeRow] = await db
    .select({ at: sql<string | null>`max(${periodScope.updatedAt})` })
    .from(periodScope)
    .where(
      and(
        eq(periodScope.companyId, companyId),
        eq(periodScope.periodId, revision.periodId),
      ),
    );

  const toIso = (value: string | Date | null | undefined): string | null =>
    value === null || value === undefined
      ? null
      : new Date(value).toISOString();

  const inputsChangedAt: Record<RunStalenessSource, string | null> = {
    rows: [...rowTimeRows]
      .map((row) => toIso(row.at))
      .reduce<string | null>(
        (latest, at) =>
          at !== null && (latest === null || at > latest) ? at : latest,
        null,
      ),
    period: toIso(periodRow?.at),
    period_scope: toIso(scopeRow?.at),
    organisation: null,
    fx: null,
    context: null,
    formula: null,
  };

  if (!run) {
    return {
      run: null,
      calculable,
      // A revision with nothing to calculate is not STALE — it is complete. Any
      // other answer would make "recalculate" the permanent state of a report
      // that carries only disclosures.
      stale: calculable,
      staleSources: calculable ? [...RUN_STALENESS_SOURCES] : [],
      inputsChangedAt,
    };
  }

  const snapshot = await loadCalculationContext(
    db,
    companyId,
    revision.id,
    run.runId,
  );
  // Closed revisions are judged against their pinned inputs, never against a
  // restatement's period/boundary or today's organisation and currency rates.
  const staleSources: RunStalenessSource[] =
    revision.status === "locked"
      ? []
      : RUN_STALENESS_SOURCES.filter((source) => {
          const at = inputsChangedAt[source];
          return at !== null && at > run.calculatedAt;
        });
  if (await runNeedsOutputNormalisation(db, companyId, revision.id, run.runId))
    staleSources.push("formula");
  if (!snapshot) staleSources.push("context");
  else if (revision.status !== "locked") {
    const current = await captureCalculationContext(
      db,
      companyId,
      snapshot.inputs.period,
    );
    if (
      !isDeepStrictEqual(
        { entities: current.entities, facilities: current.facilities },
        {
          entities: snapshot.inputs.entities,
          facilities: snapshot.inputs.facilities,
        },
      )
    )
      staleSources.push("organisation");
    if (!isDeepStrictEqual(current.fx, snapshot.inputs.fx))
      staleSources.push("fx");
  }

  return {
    run,
    calculable,
    stale: staleSources.length > 0,
    staleSources,
    inputsChangedAt,
  };
}

// ─── Reading a stored run ────────────────────────────────────────────────────

/** A stored run, re-read and re-aggregated — what `GET …/results` answers. */
export interface StoredRunResult extends CalcRunResult {
  readonly contextStatus: "recorded" | "missing";
  readonly freshness: RunFreshness;
}

/**
 * The organisational columns `calculation` does not carry (DM-29 has 14 fields
 * and none of them is a legal entity), joined back from the activity rows.
 *
 * `activity_table` + `activity_row_id` is К-10's replacement for a polymorphic
 * `source_record_id`, so the join is a lookup per table rather than a UNION.
 */
async function attachOrg(
  db: DbClient,
  companyId: string,
  lines: readonly RunLine[],
): Promise<RunLine[]> {
  const idsByTable = new Map<string, string[]>();
  for (const line of lines) {
    const list = idsByTable.get(line.activityTable);
    if (list) list.push(line.activityRowId);
    else idsByTable.set(line.activityTable, [line.activityRowId]);
  }

  const owner = new Map<
    string,
    { legalEntityId: string; facilityId: string | null }
  >();
  for (const [name, ids] of idsByTable) {
    if (!(name in INPUT_TABLES)) continue;
    const table = INPUT_TABLES[name as InputTableName];
    const rows = await db
      .select({
        id: table.id,
        legalEntityId: table.legalEntityId,
        facilityId: table.facilityId,
      })
      .from(table)
      .where(and(eq(table.companyId, companyId), inArray(table.id, ids)));
    for (const row of rows) {
      owner.set(`${name}:${row.id}`, {
        legalEntityId: row.legalEntityId,
        facilityId: row.facilityId,
      });
    }
  }

  return lines.map((line) => {
    const org = owner.get(`${line.activityTable}:${line.activityRowId}`);
    return org
      ? {
          ...line,
          legalEntityId: org.legalEntityId,
          facilityId: org.facilityId,
        }
      : line;
  });
}

/**
 * Read the latest stored run of a revision and re-derive its aggregates.
 *
 * THE AGGREGATE IS RECOMPUTED FROM THE STORED LINES, not stored beside them.
 * The run context stores the inputs of aggregation, never a duplicate total.
 * Stored lines and their own context remain the single source of the figures.
 */
export function loadLatestRun(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
): Promise<StoredRunResult | null> {
  return loadRunResult(db, companyId, revision);
}

/** A historical report reads exactly its pinned run, not a later recalculation. */
export function loadStoredRun(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
  runId: string,
): Promise<StoredRunResult | null> {
  return loadRunResult(db, companyId, revision, runId);
}

async function loadRunResult(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
  runId?: string,
): Promise<StoredRunResult | null> {
  const freshness = await runFreshness(db, companyId, revision, runId);
  if (!freshness.run) return null;

  const rows = await db
    .select()
    .from(calculation)
    .where(
      and(
        eq(calculation.companyId, companyId),
        eq(calculation.revisionId, revision.id),
        eq(calculation.runId, freshness.run.runId),
      ),
    )
    .orderBy(
      asc(calculation.activityTable),
      asc(calculation.activityRowId),
      asc(calculation.reportingBasis),
    );

  const snapshot = await loadCalculationContext(
    db,
    companyId,
    revision.id,
    freshness.run.runId,
  );
  const storedLines = rows.map(toRunLine);
  if (!snapshot) {
    // Legacy rows still prove their emissions, but do not prove a denominator
    // or an energy split. Do not silently join today's organisation/FX/units.
    const lines = await attachOrg(db, companyId, storedLines);
    const entityIds = [...new Set(lines.map((line) => line.legalEntityId))];
    const aggregates = aggregateRun({
      lines,
      energy: [],
      entities: entityIds.map((id) => ({
        legalEntityId: id,
        name: null,
        turnover: null,
        currency: null,
      })),
      facilities: [],
      fx: { year: "", rates: new Map() },
    });
    const unknownEnergy = {
      totalMwh: null,
      renewableMwh: null,
      nonRenewableMwh: null,
    };
    return {
      run: freshness.run,
      lines,
      freshness,
      excluded: [],
      contextStatus: "missing",
      aggregates: {
        ...aggregates,
        energy: unknownEnergy,
        byLegalEntity: aggregates.byLegalEntity.map((entity) => ({
          ...entity,
          energy: unknownEnergy,
        })),
        byFacility: aggregates.byFacility.map((site) => ({
          ...site,
          energy: unknownEnergy,
        })),
        intensity: {
          ...aggregates.intensity,
          turnoverEur: null,
          locationBasedIntensity: null,
          marketBasedIntensity: null,
        },
        warnings: [
          ...aggregates.warnings.filter(
            (warning) =>
              ![
                "turnover_missing",
                "currency_missing",
                "fx_rate_missing",
              ].includes(warning.code),
          ),
          {
            code: "historical_context_missing",
            detail: { run_id: freshness.run.runId },
          },
        ],
      },
    };
  }
  const owners = new Map(
    snapshot.owners.map((owner) => [
      `${owner.activityTable}:${owner.activityRowId}`,
      owner,
    ]),
  );
  const lines = storedLines.map((line) => ({
    ...line,
    ...owners.get(`${line.activityTable}:${line.activityRowId}`),
  }));
  return {
    run: freshness.run,
    lines,
    freshness,
    contextStatus: "recorded",
    aggregates: aggregateWithContext(lines, snapshot),
    excluded: snapshot.excluded,
  };
}
