// =============================================================================
// THE LAST THREE RULES (§6.2) — VAL-017, VAL-034 and VAL-035.
//
// With this module `PENDING_EVALUATORS` is EMPTY: every Phase-1 rule has an
// implementation, and R-12 — "a rule with no evaluator is indistinguishable
// from a rule that passes" — is closed by construction rather than by belief.
//
// WHY THESE THREE WAITED FOR T5.4 AND NOTHING ELSE. Their subject is a
// `calculation` ROW. Not an input row (T3.1/T3.2 wrote those), not a document
// (T4.1), not an algorithm (T5.3's two read `matchInstruments` and needed no
// stored result) — a row that only the RUN writes. Until `POST …/calculate`
// existed there was literally nothing for them to look at.
//
// THEY READ THE LATEST RUN, AND ONLY IT. `calculation` is append-only (CALC-6),
// so a revision accumulates runs; judging all of them would fail a revision for
// a run that has already been superseded by a green one. "The latest run" is the
// greatest `calculated_at`, the same definition `runFreshness` uses — one
// definition, two readers.
//
// PASSES ARE WRITTEN, NOT ONLY FAILURES — §4.18, as everywhere: a fixed line's
// previous failure only leaves the screen when a later run OVERWRITES it.
//
// A REVISION THAT WAS NEVER CALCULATED IS SILENT, NOT FAILING. Returning `[]`
// means "this rule has nothing to say" (see `../types`), and that is the honest
// answer: the absence of a run is not a biogenic-disclosure defect, it is the
// absence of a run — and §5.1's approve gate refuses it as a PRECONDITION
// (`calculation_run_green`), which is where the missing run belongs. A blocking
// rule here would refuse a SUBMIT too, and nothing in §5.1 asks a draft to have
// been calculated.
// =============================================================================
import { and, eq, inArray } from "drizzle-orm";

import { aggregateRun, type AggregateLine } from "@/server/calc/aggregate";
import { isZero, parseDecimal } from "@/server/calc/decimal";
import {
  latestRunOf,
  readNumeric,
  type FactorSnapshot,
} from "@/server/calc/run";
import type { DbClient } from "@/server/db/client";
import { calculation, emissionActivity } from "@/server/db/schema";
import { INPUT_TABLES, type InputTableName } from "@/server/inventory/tables";

import type { EvaluatorContext, RuleFinding } from "../types";

/** The `object_type` all three rules file their findings under (§6.2). */
const OBJECT_TYPE = "calculation";

/** One row of the run under evaluation, with the two columns the rules read. */
type CalculationRow = typeof calculation.$inferSelect;

/**
 * The rows of the LATEST run of `revisionId`, tenant-pinned.
 *
 * The `run_id` is resolved first (one grouped read) and the rows are then read
 * by it — rather than a window function over the whole table — because
 * `(revision_id, run_id)` is exactly the index §4.19 declares.
 */
async function loadLatestRunRows(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<CalculationRow[]> {
  const latest = await latestRunOf(db, companyId, revisionId);
  if (!latest) return [];

  return db
    .select()
    .from(calculation)
    .where(
      and(
        eq(calculation.companyId, companyId),
        eq(calculation.revisionId, revisionId),
        eq(calculation.runId, latest.runId),
      ),
    );
}

/** `factor_snapshot` as a typed object; `null` when it is not the shape we wrote. */
function snapshotOf(row: CalculationRow): FactorSnapshot | null {
  const value = row.factorSnapshot;
  if (!value || typeof value !== "object") return null;
  return value as FactorSnapshot;
}

// ─── VAL-017 — biogenic carbon is disclosed on its own line ──────────────────

/**
 * VAL-017 — "биогенный CO₂ раскрывается отдельно от фоссильного".
 *
 * WHAT IT ACTUALLY CHECKS, on the STORED row, in both directions:
 *
 *   1. A line the engine treated as BIOGENIC must carry its kilograms in
 *      `biogenic_co2_result` AND a fossil `co2e_result` of exactly zero. That
 *      zero is a GENUINE zero (`scope1.ts` argues it: the fossil CO₂e of biomass
 *      combustion is nothing by the accounting convention), and it is the one
 *      place in this engine where a zero is the right answer — which is
 *      precisely why the rule has to see it rather than assume it.
 *   2. A line the engine treated as FOSSIL must carry NO biogenic figure. A
 *      non-null `biogenic_co2_result` on a fossil line would mean the split ran
 *      twice, or ran on the wrong branch.
 *
 * "TREATED AS BIOGENIC" IS RE-DERIVED, NOT READ BACK OFF THE RESULT. The rule
 * recomputes CALC-4's OR — the ROW's `biogenic_flag` or the SNAPSHOTTED factor's
 * `biogenic_treatment` — from the inputs, and compares it against what the run
 * stored. A rule that inferred "biogenic" FROM `biogenic_co2_result` being
 * non-null could only ever agree with itself: it would pass a run that put every
 * kilogram on the fossil line, which is the exact failure §6.2 names (biogenic
 * carbon hiding INSIDE the fossil total, inflating a VSME headline figure by
 * carbon the standard says to report on its own line).
 *
 * A FAILED LINE PASSES. It has no figures at all — `co2e_result` holds the
 * NOT-NULL sentinel and the run is `failed` already, blocking approve. Failing
 * it here as well would report one defect as two, and would attach the biogenic
 * rule's name to a missing-factor problem.
 *
 * Scope 2 has no biogenic component at all (`scope2.ts`), so an energy line
 * passes iff it carries no biogenic figure — clause 2, unchanged.
 */
export async function evaluateVal017(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const rows = await loadLatestRunRows(ctx.db, ctx.companyId, ctx.targetId);
  if (rows.length === 0) return [];

  // The `biogenic_flag` of the Scope-1 rows the run priced — the preparer's half
  // of CALC-4's OR. Read in one query, keyed by the row id `activity_row_id`
  // names (К-10).
  const flags = new Map<string, boolean>(
    (
      await ctx.db
        .select({
          id: emissionActivity.id,
          biogenicFlag: emissionActivity.biogenicFlag,
        })
        .from(emissionActivity)
        .where(
          and(
            eq(emissionActivity.companyId, ctx.companyId),
            eq(emissionActivity.revisionId, ctx.targetId),
          ),
        )
    ).map((row) => [row.id, row.biogenicFlag === true]),
  );

  return rows.map((row) => {
    if (row.calculationStatus !== "ok") {
      return {
        passed: true,
        objectType: OBJECT_TYPE,
        objectId: row.id,
        revisionId: ctx.targetId,
      };
    }

    const snapshot = snapshotOf(row);
    const treatment =
      snapshot && snapshot.resolved ? snapshot.biogenic_treatment : null;
    const expectedBiogenic =
      (flags.get(row.activityRowId) ?? false) || treatment === "biogenic";

    const stored = readNumeric(row.biogenicCo2Result);
    const fossil = readNumeric(row.co2eResult);
    const passed = expectedBiogenic
      ? stored !== null && fossil !== null && isZero(parseDecimal(fossil))
      : stored === null;

    return {
      passed,
      objectType: OBJECT_TYPE,
      objectId: row.id,
      revisionId: ctx.targetId,
    };
  });
}

// ─── VAL-034 — the details add up to the total ───────────────────────────────

/**
 * VAL-034 — "сверка: сумма деталей = итог; допуск 0.5%".
 *
 * IT RECONCILES TWO PARTITIONS AGAINST ONE TOTAL, and that is what keeps it from
 * being a tautology. `aggregateRun` sums the lines three ways: once into the
 * grand total, once into a bucket per LEGAL ENTITY, once into a bucket per
 * FACILITY. A line lands in an entity bucket only if its legal entity is one the
 * boundary includes — so a line whose entity dropped out of the boundary after
 * the run is IN the total and in NO bucket, and the figures separate. That is
 * the accounting gap the rule exists for: a report whose per-subsidiary table
 * does not add up to its headline, which is exactly what an auditor recomputes
 * first (AC-1's "parent/subsidiary inventory consolidates correctly").
 *
 * THE TOLERANCE IS {@link VAL_034_TOLERANCE} — 0.5% relative, the one
 * aggregation tolerance `FORMULA_VERSION` fixes, shared with VAL-024. It is
 * enormously wider than the arithmetic can produce (exact decimals, 6 stored
 * places), which is the point: a hit is a real hole, never rounding.
 *
 * ONE FINDING, ON THE REVISION, over all four figures (Scope 1 fossil, Scope 1
 * biogenic, Scope 2 LB, Scope 2 MB). Not one per figure: the DM-28 unique key is
 * (company, rule, object_type, object_id, revision_id), so four findings about
 * one revision would upsert onto ONE row and the last would silently overwrite
 * the first three — a failing Scope-1 reconciliation erased by a passing
 * Scope-2 one. And the reconciliation is a property of the RUN in any case, not
 * of any one line; blaming a line for a partition that does not close would be
 * this engine inventing a fact.
 *
 * A FAILED RUN IS NOT JUDGED HERE. Its aggregates are withheld entirely (§0.7 —
 * see `aggregate.ts`), so there is nothing to reconcile; the run is already
 * blocking approve through its own status. Reporting the withheld totals as a
 * reconciliation failure would name the wrong defect.
 */
export async function evaluateVal034(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const rows = await loadLatestRunRows(ctx.db, ctx.companyId, ctx.targetId);
  if (rows.length === 0) return [];
  if (rows.some((row) => row.calculationStatus !== "ok")) return [];

  const lines = await aggregateLinesOf(ctx.db, ctx.companyId, rows);
  const entityIds = [
    ...new Set(
      lines.map((line) => line.legalEntityId).filter((id) => id !== ""),
    ),
  ].sort();

  // The partitions are built over the entities the LINES name, not over the
  // boundary: this rule asks whether the details add up, and feeding it a
  // boundary that already dropped an entity would make the sum close by
  // dropping the same rows from both sides.
  const aggregates = aggregateRun({
    lines,
    energy: [],
    entities: entityIds.map((id) => ({
      legalEntityId: id,
      name: id,
      turnover: null,
      currency: null,
    })),
    facilities: [
      ...new Set(
        lines
          .map((line) => line.facilityId)
          .filter((id): id is string => id !== null),
      ),
    ]
      .sort()
      .map((id) => ({ facilityId: id, legalEntityId: "", name: id })),
    fx: { year: "", rates: new Map<string, number>() },
  });

  return [
    {
      passed: aggregates.reconciliation.every((entry) => entry.balanced),
      objectType: OBJECT_TYPE,
      objectId: ctx.targetId,
      revisionId: ctx.targetId,
    },
  ];
}

// ─── VAL-035 — lineage completeness ──────────────────────────────────────────

/**
 * VAL-035 — "полнота lineage (source/factor/formula version)".
 *
 * EVERY CALCULATED LINE MUST BE ABLE TO EXPLAIN ITSELF WITHOUT A JOIN. §9's
 * reproducibility (CALC-7) rests on the row carrying its own provenance, so this
 * rule reads exactly the columns a re-derivation needs:
 *
 *   • `formula_version` and `rounding_rule` — HOW the number was produced;
 *   • `factor_id` — WHICH catalogue row was used (lineage; nullable by DDL
 *     because a failed line has none);
 *   • `factor_snapshot` — the factor's VALUE, units, SOURCE and `gwp_basis` as
 *     of the calculation (DM-29). This is the load-bearing one: the snapshot is
 *     what makes a locked report survive a later correction to the factor set,
 *     and a snapshot missing its `source_name` is a figure nobody can attribute.
 *
 * WHY THE SNAPSHOT IS CHECKED FIELD BY FIELD rather than "is it non-empty".
 * `factor_snapshot` is `jsonb NOT NULL`, so `{}` satisfies the column and
 * satisfies a presence test — and `{}` is precisely the shape a bug produces.
 * The rule therefore names the four fields §4.19 names ("значение, единицы,
 * источник, gwp_basis"): value, input unit, source, and the gwp basis when the
 * factor states one.
 *
 * A FAILED LINE IS JUDGED TOO, ON WHAT IT CAN HAVE. It has no factor, so no
 * `factor_id` and an `resolved: false` snapshot — but it must still carry its
 * formula version, its rounding rule and a snapshot that names the REASON. A
 * failed line with an empty snapshot would be a row that cannot say why it
 * failed, which is the state §0.7 is written to prevent.
 */
export async function evaluateVal035(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const rows = await loadLatestRunRows(ctx.db, ctx.companyId, ctx.targetId);
  if (rows.length === 0) return [];

  return rows.map((row) => {
    const snapshot = snapshotOf(row);
    const stamped =
      row.formulaVersion.trim() !== "" && row.roundingRule.trim() !== "";

    let complete = false;
    if (snapshot === null) {
      complete = false;
    } else if (snapshot.resolved) {
      complete =
        row.factorId !== null &&
        snapshot.factor_id === row.factorId &&
        snapshot.factor_value.trim() !== "" &&
        snapshot.input_unit.trim() !== "" &&
        snapshot.output_unit.trim() !== "" &&
        snapshot.source_name.trim() !== "" &&
        snapshot.source_version.trim() !== "" &&
        snapshot.formula_version.trim() !== "";
    } else {
      // The failed half: no factor to attribute, but the reason and the
      // methodology stamps are mandatory all the same.
      complete =
        row.factorId === null &&
        typeof snapshot.reason === "string" &&
        snapshot.reason.trim() !== "" &&
        snapshot.formula_version.trim() !== "";
    }

    return {
      passed: stamped && complete,
      objectType: OBJECT_TYPE,
      objectId: row.id,
      revisionId: ctx.targetId,
    };
  });
}

// ─── VAL-107 — priced by a weaker basis than the set offers ─────────────────

/**
 * VAL-107 — "фактор слабее доступного в наборе".
 *
 * THE RULE THAT SAYS "THIS IS NOT WRONG, BUT YOU SHOULD KNOW". Every other rule
 * in this file reports a defect; this one reports a legitimate methodology
 * choice that the preparer did not make and would not otherwise see. CALC-2 took
 * the only candidate the entered data could reach — the set holds diesel
 * nationally per LITRE and internationally per GJ, so a bill entered in kWh
 * reaches the second and not the first, and the ladder correctly priced it by a
 * 2006 IPCC global default. The figure is published and re-derivable. What is
 * missing without this rule is anybody being told, and the fix — enter the row
 * in litres, or seed a conversion — is cheap and invisible until somebody says.
 *
 * IT READS THE SNAPSHOT'S OWN ACCOUNT AND JUDGES NOTHING ITSELF. `passed_over`
 * is computed by the resolver at the moment of the run, from the candidate pool
 * of the set as it then stood, and frozen into `factor_snapshot` (DM-29). A rule
 * that re-derived "was there a better factor" against the LIVE library would
 * change its verdict on a locked revision the day an administrator adds a
 * national factor — reporting a substitution the run never made. So the rule
 * asks the row, not the catalogue.
 *
 * A LINE WITH AN EMPTY ACCOUNT PASSES, AND SO DOES A LINE WITH NO ACCOUNT AT
 * ALL. The second is a row written before the account existed: "unknown" is not
 * a finding, and warning about every pre-existing line would bury the ones that
 * mean something. A FAILED line passes too — it has no factor and therefore no
 * basis to have downgraded, and its own status already says so.
 */
export async function evaluateVal042(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const rows = await loadLatestRunRows(ctx.db, ctx.companyId, ctx.targetId);
  if (rows.length === 0) return [];

  return rows.map((row) => {
    const snapshot = snapshotOf(row);
    const passedOver =
      snapshot !== null && snapshot.resolved
        ? (snapshot.provenance?.passed_over ?? [])
        : [];
    return {
      passed: passedOver.length === 0,
      objectType: OBJECT_TYPE,
      objectId: row.id,
      revisionId: ctx.targetId,
    };
  });
}

// ─── Shared: the stored rows as aggregation input ────────────────────────────

/**
 * Stored `calculation` rows → {@link AggregateLine}s, with the organisational
 * columns joined back on.
 *
 * `calculation` carries none (DM-29 lists 14 fields and no legal entity), so the
 * attribution comes from the activity row through К-10's
 * `activity_table`+`activity_row_id` pair. A line whose activity row cannot be
 * found keeps an empty `legalEntityId` and therefore lands in NO entity bucket —
 * which is a reconciliation failure, and correctly so: a result nobody can
 * attribute is a result that cannot appear in a per-subsidiary table.
 */
async function aggregateLinesOf(
  db: DbClient,
  companyId: string,
  rows: readonly CalculationRow[],
): Promise<AggregateLine[]> {
  const byTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = byTable.get(row.activityTable);
    if (set) set.add(row.activityRowId);
    else byTable.set(row.activityTable, new Set([row.activityRowId]));
  }

  const owner = new Map<
    string,
    { legalEntityId: string; facilityId: string | null }
  >();
  for (const [name, ids] of byTable) {
    // `activity_table` is written by the run from a code constant (К-10); a
    // value that is not one of the four input tables is not looked up at all,
    // so no string off a row can ever name a relation.
    if (ids.size === 0 || !(name in INPUT_TABLES)) continue;
    const table = INPUT_TABLES[name as InputTableName];
    const found = await db
      .select({
        id: table.id,
        legalEntityId: table.legalEntityId,
        facilityId: table.facilityId,
      })
      .from(table)
      .where(and(eq(table.companyId, companyId), inArray(table.id, [...ids])));
    for (const row of found) {
      owner.set(`${name}:${row.id}`, {
        legalEntityId: row.legalEntityId,
        facilityId: row.facilityId,
      });
    }
  }

  return rows.map((row) => {
    const org = owner.get(`${row.activityTable}:${row.activityRowId}`);
    return {
      legalEntityId: org?.legalEntityId ?? "",
      facilityId: org?.facilityId ?? null,
      scope: row.scope === "scope2" ? "scope2" : "scope1",
      reportingBasis:
        row.reportingBasis === "location_based" ||
        row.reportingBasis === "market_based"
          ? row.reportingBasis
          : null,
      co2eResult: readNumeric(row.co2eResult),
      biogenicCo2Result: readNumeric(row.biogenicCo2Result),
      calculationStatus:
        row.calculationStatus as AggregateLine["calculationStatus"],
    };
  });
}
