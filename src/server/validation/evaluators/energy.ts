// =============================================================================
// SCOPE-2 EVALUATORS (spec §6.2, scope `record`) — the three rules whose subject
// is a purchased-energy row or a contractual instrument.
//
// WHY THEY ARRIVE WITH T3.2 and not with the engine: until `/api/activities/
// energy` and `/api/activities/instruments` existed, no code path could write
// the row any of them judges, and a rule with no writable subject can be
// evaluated but never ENFORCED. Same reason the ten of `./activities` waited for
// T3.1.
//
// WHAT IS **NOT** HERE, and where it went instead. §6.2 lists five Scope-2 rules;
// two of them — VAL-022 (`covered_volume` ≤ matched consumption) and VAL-024
// (the market-based balance `covered + residual = consumption`) — are `revision`
// scope and both need the MATCHING, i.e. CALC-5's algorithm: prorate each
// instrument by the overlap of its vintage window with the period, consume
// facility-bound instruments first, cap the matched total by the entity's
// consumption. Writing them here would mean writing that algorithm twice, and
// the second copy would be the one the calculation does not use. They stay in
// `PENDING_EVALUATORS` against T5.3, which is where CALC-5 lands.
//
// WHERE EACH RULE STOPS:
//   • VAL-020 owns the SIGN of the consumption, and nothing else. VAL-011 says
//     the same thing about the same column in the activity domain's words; both
//     failing costs one extra `false` in the payload and lets each screen render
//     its own code (see `./activities`).
//   • VAL-021 owns the GEOGRAPHY the location-based factor is chosen by.
//   • VAL-023 owns whether an instrument's vintage window has anything to do
//     with the period it was entered into.
//
// Tenant pin as everywhere else: every query filters on `company_id`, so a
// foreign `targetId` matches nothing and the evaluator finds nothing.
// =============================================================================
import { and, eq } from "drizzle-orm";

import {
  contractualInstrument,
  facility,
  legalEntity,
  purchasedEnergyActivity,
} from "@/server/db/schema";

import type { EvaluatorContext, RuleFinding } from "../types";

import { loadPeriodOfRevision } from "./activities";

/** True for a value that is present and not blank after trimming. */
function filled(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** One `purchased_energy_activity` version, tenant-pinned, or `undefined`. */
async function loadEnergyRow(ctx: EvaluatorContext) {
  const [row] = await ctx.db
    .select()
    .from(purchasedEnergyActivity)
    .where(
      and(
        eq(purchasedEnergyActivity.id, ctx.targetId),
        eq(purchasedEnergyActivity.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  return row;
}

/** One `contractual_instrument` version, tenant-pinned, or `undefined`. */
async function loadInstrumentRow(ctx: EvaluatorContext) {
  const [row] = await ctx.db
    .select()
    .from(contractualInstrument)
    .where(
      and(
        eq(contractualInstrument.id, ctx.targetId),
        eq(contractualInstrument.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  return row;
}

// ─── VAL-020 — the consumption is not negative ───────────────────────────────

/**
 * VAL-020 — "потребление энергии ≥ 0".
 *
 * ZERO IS LEGAL and is not an omission: a month in which a closed site drew
 * nothing is a reported zero, and the difference between "0" and "no row" is
 * exactly what a completeness review looks at. Only a NEGATIVE consumption is
 * refused — it would sail through CALC-5 into a negative Scope-2 figure, twice
 * (location-based and market-based).
 *
 * A CREDIT NOTE IS NOT A NEGATIVE ROW. The temptation, when a supplier rebills a
 * month, is to enter the correction as a negative consumption; the model's
 * answer is an EDIT (LC-5) — a new version of the row with the corrected figure
 * and a `change_reason` — which keeps both numbers and says which is current.
 * That is why this rule can afford to be blocking.
 */
export async function evaluateVal020(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadEnergyRow(ctx);
  if (!row) return [];
  return [
    {
      passed: Number(row.consumption) >= 0,
      objectType: "purchased_energy_activity",
      objectId: row.id,
    },
  ];
}

// ─── VAL-021 — Scope 2 needs a country ───────────────────────────────────────

/**
 * VAL-021 — "для Scope 2 нужна страна площадки".
 *
 * WHY IT IS BLOCKING. CALC-5 gives every energy row a location-based figure
 * priced at the GRID FACTOR OF A COUNTRY (§9, CALC-2: geography is the
 * resolution key). With no country there is no grid factor, and §0.7 forbids the
 * only other move — pricing the row at zero. Refusing at data entry, where the
 * user can still fill the site's country in, is cheaper than failing the run.
 *
 * WHOSE COUNTRY, WHEN THE ROW HAS NO SITE. К-18 makes `facility_id` nullable —
 * a documented exception (VAL-104) covers the row that has none — so "the
 * facility's country" has to be read as "the country this row's location-based
 * factor will be resolved by", and that is:
 *   • the FACILITY's country when the row is attributed to a site. Not the legal
 *     entity's, even when the site has none: a Slovenian company's German plant
 *     draws German electricity, and falling back to the parent's country would
 *     silently price it at the wrong grid.
 *   • the LEGAL ENTITY's country when it is not. The row is then attributed to
 *     the entity and to nothing narrower, so the entity's registered country is
 *     the only geography the model has — and it is a real answer, not a guess,
 *     for the case К-18 is about (a leased office billed through the landlord).
 * A row whose site exists but has no `country` FAILS rather than falling through
 * to the entity, because the site IS the geography it declared.
 */
export async function evaluateVal021(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadEnergyRow(ctx);
  if (!row) return [];

  const finding = (passed: boolean): RuleFinding[] => [
    { passed, objectType: "purchased_energy_activity", objectId: row.id },
  ];

  if (row.facilityId) {
    const [site] = await ctx.db
      .select({ country: facility.country })
      .from(facility)
      .where(
        and(
          eq(facility.id, row.facilityId),
          eq(facility.companyId, ctx.companyId),
        ),
      )
      .limit(1);
    return finding(filled(site?.country));
  }

  const [entity] = await ctx.db
    .select({ country: legalEntity.country })
    .from(legalEntity)
    .where(
      and(
        eq(legalEntity.id, row.legalEntityId),
        eq(legalEntity.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  return finding(filled(entity?.country));
}

// ─── VAL-023 — the certificate's vintage fits the period (Warning) ───────────

/**
 * VAL-023 — "период сертификата совместим с периодом".
 *
 * WHAT IS COMPARED: the instrument's vintage window
 * (`generation_period_start..generation_period_end`) against the reporting
 * period's `start_date..end_date`. COMPATIBLE MEANS THEY OVERLAP — not that one
 * contains the other. CALC-5 prorates an instrument's volume by exactly that
 * overlap, so a certificate generated in the last quarter of the previous year
 * and cancelled against this one contributes a real, computable fraction; only a
 * window with NO overlap contributes nothing at all, and that is what the
 * warning is about.
 *
 * A WARNING, not a refusal (§6.2), because both honest cases exist: a
 * certificate can be entered before the period it will be claimed in is decided,
 * and a multi-year PPA legitimately spans several periods. The blocking question
 * — how much of it may actually be claimed — is VAL-022's, in T5.3.
 *
 * AN OPEN-ENDED WINDOW IS TREATED AS OPEN, not as missing: a NULL start means
 * "from before this period", a NULL end means "until after it". Both NULL is a
 * PASS — there is nothing to compare, and a warning on every instrument whose
 * vintage has not been typed in yet is a warning nobody reads.
 */
export async function evaluateVal023(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadInstrumentRow(ctx);
  if (!row) return [];

  const finding = (passed: boolean): RuleFinding[] => [
    { passed, objectType: "contractual_instrument", objectId: row.id },
  ];
  const { generationPeriodStart: from, generationPeriodEnd: to } = row;
  if (from === null && to === null) return finding(true);

  const period = await loadPeriodOfRevision(
    ctx.db,
    ctx.companyId,
    row.revisionId,
  );
  if (!period) return finding(true);

  // ISO dates compare correctly as strings — the `date` column's own ordering.
  const start = from ?? period.startDate;
  const end = to ?? period.endDate;
  return finding(start <= period.endDate && end >= period.startDate);
}
