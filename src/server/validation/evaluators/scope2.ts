// THE TWO SCOPE-2 `revision` RULES (spec §6.2) — VAL-022 (over-claiming) and
// VAL-024 (the market-based balance).
//
// See docs/decisions/server-validation-evaluators-scope2.md for the full account.
import { and, eq } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import {
  add,
  compare,
  multiply,
  parseDecimal,
  subtract,
  type Decimal,
} from "@/server/calc/decimal";
import { VAL_024_TOLERANCE } from "@/server/calc/formula-version";
import {
  matchInstruments,
  type Scope2Instrument,
  type Scope2Matching,
  type Scope2MatchableRow,
} from "@/server/calc/scope2";
import {
  contractualInstrument,
  purchasedEnergyActivity,
  unitConversion,
} from "@/server/db/schema";

import type { EvaluatorContext, RuleFinding } from "../types";

import { loadPeriodOfRevision } from "./activities";

/** VAL-024's tolerance as an exact {@link Decimal} — `0.005`, from the version. */
const TOLERANCE = parseDecimal(String(VAL_024_TOLERANCE));

/** |a| — the balance is judged on the size of the miss, not its direction. */
function absolute(value: Decimal): Decimal {
  return value.units < BigInt(0) ? { ...value, units: -value.units } : value;
}

/**
 * Is `left` within {@link VAL_024_TOLERANCE} RELATIVE of `right`?
 *
 * Relative to the CONSUMPTION, which is `right`: a 0.5% allowance on a figure
 * that is itself the thing being checked would let a large declared residual
 * excuse itself. A zero consumption therefore demands an exact match, which is
 * correct — an entity that bought nothing can have no residual either.
 */
function withinTolerance(
  left: Decimal,
  right: Decimal,
  scale: Decimal,
): boolean {
  return (
    compare(
      absolute(subtract(left, right)),
      absolute(multiply(scale, TOLERANCE)),
    ) <= 0
  );
}

/** The `unit_conversion` table — CALC-3's rows, as `matchInstruments` wants them. */
async function loadConversions(db: DbClient) {
  return db
    .select({
      id: unitConversion.id,
      fromUnit: unitConversion.fromUnit,
      toUnit: unitConversion.toUnit,
      multiplier: unitConversion.multiplier,
      activityContext: unitConversion.activityContext,
      factorSetId: unitConversion.factorSetId,
    })
    .from(unitConversion);
}

/**
 * The revision's energy rows and instruments, ALL VERSIONS, tenant-pinned.
 *
 * Unfiltered on purpose: CALC-1's four rejections live inside
 * {@link matchInstruments}, so the evaluators see exactly what the calculation
 * sees and cannot disagree with it about which rows are in the report. The
 * superseded and draft versions come back too, and get the pass explained in
 * the header.
 */
async function loadSubjects(
  ctx: EvaluatorContext,
  revisionId: string,
): Promise<{
  rows: Scope2MatchableRow[];
  instruments: Scope2Instrument[];
}> {
  const [rows, instruments] = await Promise.all([
    ctx.db
      .select()
      .from(purchasedEnergyActivity)
      .where(
        and(
          eq(purchasedEnergyActivity.revisionId, revisionId),
          eq(purchasedEnergyActivity.companyId, ctx.companyId),
        ),
      ),
    ctx.db
      .select()
      .from(contractualInstrument)
      .where(
        and(
          eq(contractualInstrument.revisionId, revisionId),
          eq(contractualInstrument.companyId, ctx.companyId),
        ),
      ),
  ]);
  return { rows, instruments };
}

/** Everything both rules need: the matching, plus the subjects it was run on. */
interface Scope2Context {
  readonly matching: Scope2Matching;
  readonly rows: readonly Scope2MatchableRow[];
  readonly instruments: readonly Scope2Instrument[];
}

/**
 * Run CALC-5's matching for the revision under evaluation, or `undefined` when
 * the target is not a revision of this tenant (silence, never a pass).
 */
async function scope2Context(
  ctx: EvaluatorContext,
): Promise<Scope2Context | undefined> {
  const period = await loadPeriodOfRevision(
    ctx.db,
    ctx.companyId,
    ctx.targetId,
  );
  if (!period) return undefined;

  const { rows, instruments } = await loadSubjects(ctx, ctx.targetId);
  if (rows.length === 0 && instruments.length === 0) return undefined;

  const conversions = await loadConversions(ctx.db);
  return {
    matching: matchInstruments(rows, instruments, conversions, {
      startDate: period.startDate,
      endDate: period.endDate,
      factorSetId: period.factorSetId ?? "",
    }),
    rows,
    instruments,
  };
}

// ─── VAL-022 — over-claiming ─────────────────────────────────────────────────

/**
 * VAL-022 — "`covered_volume` ≤ сопоставленное потребление".
 *
 * §9 fixes both sides: the numerator is the matched volume of the entity's
 * instruments (each PRORATED by the share of its vintage window that falls in
 * the period), the denominator is the entity's total purchased electricity for
 * the period, and the rule fails when the numerator exceeds the denominator.
 *
 * THE FINDING IS ON THE INSTRUMENTS, ALL OF THEM, AND THAT IS DELIBERATE.
 * Over-claiming is a property of the SET, not of a member: once the certificates
 * of one legal entity add up past its consumption, no individual certificate is
 * "the excess". The consumption ORDER makes one of them the one that was cut,
 * but that order is our tie-break, not a statement about which contract is
 * wrong, and blaming a certificate because it sorted last would be this engine
 * inventing a fact. So every instrument of an over-claiming entity fails, and
 * the message sends the preparer to look at the set.
 *
 * AN INSTRUMENT THAT CLAIMS NOTHING PASSES: a `supplier_product` (not a volume
 * claim), one with no `covered_volume`, one CALC-1 excluded, and — the
 * interesting case — one whose vintage window does not overlap the period at
 * all, which prorates to zero and therefore cannot push any total over.
 */
export async function evaluateVal022(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const context = await scope2Context(ctx);
  if (!context) return [];

  const overClaiming = new Set(
    context.matching.entities
      .filter((entity) => entity.overClaimed)
      .map((entity) => entity.legalEntityId),
  );
  const claiming = new Set(
    context.matching.matches.map((match) => match.instrumentId),
  );

  return context.instruments.map((instrument) => ({
    passed:
      !claiming.has(instrument.id) ||
      !overClaiming.has(instrument.legalEntityId),
    objectType: "contractual_instrument",
    objectId: instrument.id,
    revisionId: ctx.targetId,
  }));
}

// ─── VAL-024 — the market-based balance ──────────────────────────────────────

/**
 * VAL-024 — "market-based баланс: covered + residual = consumption".
 *
 * TWO CLAUSES, ONE EQUATION, AND BOTH ARE FALSIFIABLE. A rule that could only
 * pass would be R-12's disease wearing an evaluator's clothes, so it is worth
 * saying exactly what can break each side:
 *
 *   1. PER ENERGY ROW — is this row's consumption in the equation at all? The
 *      engine defines `residual := consumption − covered`, so the identity is
 *      exact for every row it could DENOMINATE. A row whose `unit` reaches no
 *      MWh through `unit_conversion` (CALC-3) cannot be denominated: it is in
 *      neither column, its market-based line fails, and the entity's covered
 *      and residual no longer add up to what the company bought. That is a real
 *      hole and this is the rule that reports it, on the row that has to be
 *      fixed.
 *   2. PER INSTRUMENT THAT DECLARES `residual_mix_volume` — §4.11 puts that
 *      column on the instrument expressly "MWh — VAL-024 balance". When a
 *      preparer states one, it is a claim about the same equation, and a claim
 *      that contradicts the calculation is exactly what a validation rule is
 *      for. Declaring nothing is not a failure: the engine's own residual
 *      stands, and warning about an untyped optional column is a warning nobody
 *      reads (VAL-023 makes the same call about an untyped vintage).
 *
 * THE TOLERANCE IS {@link VAL_024_TOLERANCE} — 0.5% of the entity's
 * consumption, the one aggregation tolerance `FORMULA_VERSION` fixes, shared
 * with VAL-034 because both ask whether the parts add to the whole. It is
 * enormously wider than anything the arithmetic can produce (the engine
 * subtracts exact decimals and stores 6 places), which is the point: a hit is a
 * real gap, never rounding.
 */
export async function evaluateVal024(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const context = await scope2Context(ctx);
  if (!context) return [];

  const balances = new Map(
    context.matching.entities.map((entity) => [entity.legalEntityId, entity]),
  );
  const volumes = new Map(
    context.matching.rows.map((row) => [row.energyRowId, row]),
  );
  const findings: RuleFinding[] = [];

  // Clause 1 — every energy row is accounted for.
  for (const row of context.rows) {
    const volume = volumes.get(row.id);
    const balanced =
      volume === undefined || // CALC-1 excluded it: it is not in the report.
      (volume.consumptionMwh !== null &&
        volume.residualMwh !== null &&
        // Written as the equation the rule's message states, not as the
        // rearrangement the engine happens to compute, so a reader checking the
        // code against §6.2 is reading the same sentence twice.
        withinTolerance(
          add(
            parseDecimal(volume.coveredMwh),
            parseDecimal(volume.residualMwh),
          ),
          parseDecimal(volume.consumptionMwh),
          parseDecimal(volume.consumptionMwh),
        ));
    findings.push({
      passed: balanced,
      objectType: "purchased_energy_activity",
      objectId: row.id,
      revisionId: ctx.targetId,
    });
  }

  // Clause 2 — a declared residual has to close the entity's balance.
  for (const instrument of context.instruments) {
    const balance = balances.get(instrument.legalEntityId);
    const declared = balance?.declaredResidualMwh;
    const agrees =
      instrument.residualMixVolume === null ||
      balance === undefined ||
      declared === null ||
      declared === undefined ||
      withinTolerance(
        parseDecimal(declared),
        parseDecimal(balance.residualMwh),
        parseDecimal(balance.consumptionMwh),
      );
    findings.push({
      passed: agrees,
      objectType: "contractual_instrument",
      objectId: instrument.id,
      revisionId: ctx.targetId,
    });
  }

  return findings;
}
