// =============================================================================
// INPUT-ROW EVALUATORS (spec §6.2, scope `record` — plus VAL-010, whose scope is
// `period` because the freeze is a property of the report, not of one figure).
//
// WHAT ARRIVES HERE AND WHY NOW. T2.1–T2.8 implemented every rule whose subject
// was a registry row. The ten below all judge an INPUT ROW, and until T3.1 gave
// the four input tables a write path none of them could be ENFORCED: an
// evaluator with no path that writes its subject is a rule that has never
// refused anything. With this file `PENDING_EVALUATORS` loses its whole T3.1
// block — VAL-007, VAL-010, VAL-011, VAL-012, VAL-014, VAL-015, VAL-016,
// VAL-018, VAL-019 and VAL-104.
//
// AC-4 (part 1) IS OWNED BY TWO OF THEM. "Every applicable Scope 1 source is
// assessed" has no owner unless something refuses an incomplete source row, and
// VAL-015 (a method with no input) and VAL-016 (the method and the input do not
// agree) are that something. §6.2 words VAL-016 as a FLEET rule — "distance ⇒
// vehicle type; fuel ⇒ litres" — but the criterion is about all five categories
// of §4.9, so both rules are written as the general form of the fleet pair and
// `activities.integration` proves each of them passing AND failing on every one
// of stationary / mobile / fugitive / process / onsite.
//
// WHERE EACH RULE STOPS, because these ten overlap by design and a rule that
// answers its neighbour's question produces two refusals for one mistake:
//   • VAL-015 owns the PRESENCE of the method's input;
//   • VAL-014 owns whether a unit that IS present is one the factors can price;
//   • VAL-016 owns whether the input that is present MATCHES the method;
//   • VAL-011 owns the sign of the quantity, and nothing else.
//
// Tenant pin as everywhere else: every query filters on `company_id`, so a
// foreign `targetId` matches nothing and the evaluator finds nothing — never
// another tenant's row, never an error that confirms the id exists.
// =============================================================================
import { and, eq, isNull, or, sql } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import {
  emissionActivity,
  emissionFactor,
  facility,
  purchasedEnergyActivity,
  reportingPeriod,
  reportRevision,
  unitConversion,
} from "@/server/db/schema";
import {
  INPUT_TABLE_NAMES,
  inputTableAmong,
  type InputTableName,
} from "@/server/inventory/tables";
import {
  calculationInputsEditable,
  loadCurrentRevision,
} from "@/server/periods/lifecycle";
import { ENERGY_UNITS, isVehicleType } from "@/shared/enums";

import type { EvaluatorContext, RuleFinding } from "../types";

// ─── Shared loaders ──────────────────────────────────────────────────────────

/** The mixin half of an input row, plus which of the four tables it is in. */
export interface InputRowRef {
  readonly table: InputTableName;
  readonly id: string;
  readonly revisionId: string;
  readonly facilityId: string | null;
  readonly yearMonth: string | null;
  readonly unit: string | null;
  readonly notes: string | null;
  /**
   * `draft` or `approved` (T4.4). Read by VAL-036 in `./evidence`, the one rule
   * of the `record` scope that is about a MOMENT of the row's lifecycle rather
   * than about its content: EV-5 checks evidence integrity when a row is
   * APPROVED, not on every keystroke that saves a draft.
   */
  readonly state: string;
}

/**
 * The raw shape of the union probe below (snake_case — it is hand-written SQL).
 * Intersected with the index signature `db.execute<T>` constrains its rows to;
 * the named fields keep their types, which is what the mapper reads.
 */
type InputRowProbe = Record<string, unknown> & {
  tbl: InputTableName;
  id: string;
  revision_id: string;
  facility_id: string | null;
  year_month: string | null;
  unit: string | null;
  notes: string | null;
  state: string;
};

/**
 * Find the input row `targetId` names, in whichever of the four tables holds it.
 *
 * ONE QUERY, not four probes: a `record`-scope run evaluates several rules
 * against the same row, and four PK lookups per rule is a lot of round trips for
 * an answer that is the same every time. The union is over the MIXIN columns
 * only — that is exactly the part all four tables share (§4.8) — and a rule that
 * needs a body column loads it from its own table afterwards.
 *
 * The table names are interpolated as identifiers from `INPUT_TABLE_NAMES`, a
 * code constant, so no request value ever reaches the SQL text.
 *
 * EXPORTED FOR `./evidence` (T4.4), on the same grounds `loadPeriodOfRevision`
 * is exported for `./energy`: VAL-036 asks the identical question of the
 * identical four tables, and a second copy of a tenant-pinned UNION over them is
 * a second place to forget one of the pins.
 */
export async function loadInputRow(
  ctx: EvaluatorContext,
): Promise<InputRowRef | undefined> {
  const probes = INPUT_TABLE_NAMES.map(
    (name) => sql`
      SELECT ${name}::text AS tbl, id, revision_id, facility_id,
             year_month, unit, notes, state
        FROM ${sql.identifier(name)}
       WHERE id = ${ctx.targetId} AND company_id = ${ctx.companyId}`,
  );
  const rows = await ctx.db.execute<InputRowProbe>(
    sql.join(probes, sql` UNION ALL `),
  );
  const [row] = [...rows];
  if (!row) return undefined;
  return {
    table: row.tbl,
    id: row.id,
    revisionId: row.revision_id,
    facilityId: row.facility_id,
    yearMonth: row.year_month,
    unit: row.unit,
    notes: row.notes,
    state: row.state,
  };
}

/**
 * The reporting window and the pinned factor set a row is judged against.
 *
 * Exported with its loader for `./energy` (T3.2): VAL-012 and VAL-023 ask the
 * same question of the same join, and a second copy of a two-table tenant-pinned
 * query is a second place to forget one of the two pins.
 */
export interface PeriodWindow {
  readonly periodId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly factorSetId: string;
}

/** The period behind a revision (DM-7 → DM-10), tenant-pinned on both. */
export async function loadPeriodOfRevision(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<PeriodWindow | undefined> {
  const [row] = await db
    .select({
      periodId: reportingPeriod.id,
      startDate: reportingPeriod.startDate,
      endDate: reportingPeriod.endDate,
      factorSetId: reportingPeriod.factorSetId,
    })
    .from(reportRevision)
    .innerJoin(reportingPeriod, eq(reportingPeriod.id, reportRevision.periodId))
    .where(
      and(
        eq(reportRevision.id, revisionId),
        eq(reportRevision.companyId, companyId),
        eq(reportingPeriod.companyId, companyId),
      ),
    )
    .limit(1);
  return row;
}

/** One `emission_activity` version, tenant-pinned, or `undefined`. */
async function loadEmissionRow(ctx: EvaluatorContext) {
  const [row] = await ctx.db
    .select()
    .from(emissionActivity)
    .where(
      and(
        eq(emissionActivity.id, ctx.targetId),
        eq(emissionActivity.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  return row;
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

/** The tables VAL-007/011/014/104 are declared against (§6.2 `appliesTo`). */
const ACTIVITY_TABLES: readonly InputTableName[] = [
  "emission_activity",
  "purchased_energy_activity",
];

/** True for a value that is present and not blank after trimming. */
function filled(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** NUMERIC-as-string → number, or `null` — every body column comes back so. */
function numeric(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/** `YYYY-MM` → the ISO dates of its first and last day. */
function monthWindow(yearMonth: string): { start: string; end: string } {
  const [year, month] = yearMonth.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${yearMonth}-01`,
    end: `${yearMonth}-${String(last).padStart(2, "0")}`,
  };
}

// ─── VAL-010 — the freeze (LC-8(2), scope `period`) ──────────────────────────

/**
 * VAL-010 — "Locked неизменяем (любая мутация против locked)".
 *
 * GATED ON `mutatedFields` LIKE VAL-105 AND VAL-106, and for the same reason:
 * the rule judges a MOMENT (an attempt to write an input row), not a state. A
 * blocking rule that fired on every `period`-scope run would refuse the period
 * screen's own reads and writes for a report that is merely submitted. The write
 * declares the TABLE it is mutating (`inputTableAmong`), which is both the
 * trigger and the `object_type` the finding is stored under — matching the
 * rule's `appliesTo`, which names all four input tables ("все факты", §6.2).
 *
 * WHOSE STATUS DECIDES. The period's CURRENT revision, through the same
 * `calculationInputsEditable` that DM-7a uses for the period's own fields. That
 * is what makes the freeze one fact rather than two: the boundary, the
 * calculation-bearing period fields and the input rows all thaw and freeze
 * together, on `draft`/`rejected` versus everything else.
 */
export async function evaluateVal010(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const table = inputTableAmong(ctx.mutatedFields);
  if (!table) return [];

  const [period] = await ctx.db
    .select({ id: reportingPeriod.id })
    .from(reportingPeriod)
    .where(
      and(
        eq(reportingPeriod.id, ctx.targetId),
        eq(reportingPeriod.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  if (!period) return [];

  const current = await loadCurrentRevision(ctx.db, ctx.companyId, period.id);
  return [
    {
      passed: calculationInputsEditable(current),
      objectType: table,
      objectId: null,
      revisionId: current?.id ?? null,
    },
  ];
}

// ─── VAL-007 — the activity is dated inside the site's life (Warning) ────────

/**
 * VAL-007 — an activity dated outside the facility's operating dates.
 *
 * A WARNING (§6.2), so it reports and never refuses: a site can legitimately
 * report a final meter reading after its closing date, and a hard refusal would
 * make the honest entry impossible.
 *
 * IT FIRES ON NO OVERLAP AT ALL, not on "partly outside". A facility that opened
 * on the 14th reports its first month from the 1st — flagging that would put a
 * warning on almost every first and last month a site ever has, and a warning
 * that is usually noise is a warning nobody reads. A row whose whole window
 * falls before the opening or after the closing date is the mistake this rule is
 * for.
 *
 * A row with NO facility passes: attribution to a site is optional (К-18), and
 * the rule that cares about its absence is VAL-104.
 */
export async function evaluateVal007(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadInputRow(ctx);
  if (!row || !ACTIVITY_TABLES.includes(row.table)) return [];

  const finding = (passed: boolean): RuleFinding[] => [
    { passed, objectType: row.table, objectId: row.id },
  ];
  if (!row.facilityId) return finding(true);

  const [site] = await ctx.db
    .select({
      openingDate: facility.openingDate,
      closingDate: facility.closingDate,
    })
    .from(facility)
    .where(
      and(
        eq(facility.id, row.facilityId),
        eq(facility.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  if (!site || (!site.openingDate && !site.closingDate)) return finding(true);

  const period = await loadPeriodOfRevision(
    ctx.db,
    ctx.companyId,
    row.revisionId,
  );
  if (!period) return finding(true);
  const window = row.yearMonth
    ? monthWindow(row.yearMonth)
    : { start: period.startDate, end: period.endDate };

  const before = site.openingDate !== null && window.end < site.openingDate;
  const after = site.closingDate !== null && window.start > site.closingDate;
  return finding(!before && !after);
}

// ─── VAL-011 — the quantity is not negative ──────────────────────────────────

/**
 * VAL-011 — the activity value is ≥ 0.
 *
 * ZERO IS LEGAL and is not an omission: a month in which a boiler burned nothing
 * is a reported zero, and the difference between "0" and "no row" is exactly
 * what a completeness review looks at. Only a NEGATIVE quantity is refused —
 * there is no such thing as burning minus 40 litres, and the value would sail
 * through the calculation into a negative emission.
 *
 * It covers both activity tables it is declared against: `activity_value` on
 * `emission_activity`, `consumption` on `purchased_energy_activity`. VAL-020
 * (T3.2) says the same thing about energy in the energy domain's words; both
 * being true of one row costs one extra `false` in the payload and keeps each
 * screen's own rule code renderable.
 */
export async function evaluateVal011(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadInputRow(ctx);
  if (!row) return [];

  if (row.table === "emission_activity") {
    const activity = await loadEmissionRow(ctx);
    if (!activity) return [];
    return [
      {
        passed: Number(activity.activityValue) >= 0,
        objectType: row.table,
        objectId: row.id,
      },
    ];
  }
  if (row.table === "purchased_energy_activity") {
    const energy = await loadEnergyRow(ctx);
    if (!energy) return [];
    return [
      {
        passed: Number(energy.consumption) >= 0,
        objectType: row.table,
        objectId: row.id,
      },
    ];
  }
  return [];
}

// ─── VAL-012 — the row is dated inside the reporting period (Warning) ────────

/**
 * VAL-012 — the row's data dates fall inside the reporting period.
 *
 * ALL FOUR input tables (§6.2's "строки ввода"), judged on the mixin's
 * `year_month`: a NULL means the row covers the whole period by construction
 * (a certificate, an annual disclosure — §4.8), so it passes rather than being
 * skipped. Containment, not overlap: a month that sticks out of a period is what
 * the warning is about, and a period with non-calendar bounds legitimately
 * produces one at each end.
 */
export async function evaluateVal012(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadInputRow(ctx);
  if (!row) return [];

  const finding = (passed: boolean): RuleFinding[] => [
    { passed, objectType: row.table, objectId: row.id },
  ];
  if (!row.yearMonth) return finding(true);

  const period = await loadPeriodOfRevision(
    ctx.db,
    ctx.companyId,
    row.revisionId,
  );
  if (!period) return finding(true);

  const window = monthWindow(row.yearMonth);
  return finding(
    window.start >= period.startDate && window.end <= period.endDate,
  );
}

// ─── VAL-014 — the unit is one the factors can price ─────────────────────────

/**
 * The units an `emission_activity` of `activityType` may be entered in, under
 * the factor set the period pins (К-24).
 *
 * TWO SOURCES, because CALC-2 and CALC-3 are two steps. A factor resolves on
 * `input_unit` EQUALITY, so every `input_unit` the set prices for this activity
 * type is supported outright; and CALC-3 converts before resolving, so any unit
 * with a `unit_conversion` edge INTO one of those is supported too — contextual
 * edges (`activity_context = activityType`, the calorific ones) and universal
 * edges alike, exactly the precedence CALC-3 uses.
 *
 * NO MULTI-HOP, matching `seed-data/unit-conversions.ts`: CALC-3 looks a pair
 * up, it does not search a path, so a rule that accepted a two-hop route would
 * pass a row the calculation then fails with `failed_unit`.
 */
async function supportedUnits(
  db: DbClient,
  factorSetId: string,
  activityType: string,
): Promise<Set<string>> {
  const priced = await db
    .select({ inputUnit: emissionFactor.inputUnit })
    .from(emissionFactor)
    .where(
      and(
        eq(emissionFactor.factorSetId, factorSetId),
        eq(emissionFactor.activityType, activityType),
      ),
    );
  const units = new Set(priced.map((row) => row.inputUnit));
  if (units.size === 0) return units;

  // The SET's own conversions and the shared ones, and nothing else: since 0010
  // a `unit_conversion` row may belong to a factor set, and another set's
  // calorific value is a multiplier CALC-3 will not apply here — counting it
  // would report a unit as supported that the calculation then refuses with
  // `failed_unit`, which is the drift this rule exists to prevent.
  const edges = await db
    .select({
      fromUnit: unitConversion.fromUnit,
      toUnit: unitConversion.toUnit,
      activityContext: unitConversion.activityContext,
      factorSetId: unitConversion.factorSetId,
    })
    .from(unitConversion)
    .where(
      or(
        isNull(unitConversion.factorSetId),
        eq(unitConversion.factorSetId, factorSetId),
      ),
    );
  for (const edge of edges) {
    if (
      edge.activityContext !== null &&
      edge.activityContext !== activityType
    ) {
      continue;
    }
    if (units.has(edge.toUnit)) units.add(edge.fromUnit);
  }
  return units;
}

/**
 * VAL-014 — the unit is supported for the activity type.
 *
 * WHAT "SUPPORTED" MEANS is not a hand-written list: it is `unit_conversion`
 * plus the `input_unit`s of the factors the period is pinned to (see
 * `supportedUnits`). A list in code would be a third source of truth that drifts
 * away from the factor set the moment a new one is activated, and the failure it
 * would cause — a row accepted here and refused by CALC-2 — is the one §0.7
 * forbids papering over.
 *
 * TWO SILENCES, both deliberate:
 *   • a row with NO unit passes — its absence is VAL-015's subject, and two
 *     blocking refusals for one empty field help nobody;
 *   • an activity type the pinned set prices NOTHING for passes — there is no
 *     supported-unit list to compare against, so the honest answer is that this
 *     rule cannot speak. The missing factor is the calculation's refusal (§0.7)
 *     and, for refrigerants, VAL-019's.
 *
 * Purchased energy is judged against §4.10's own list (kWh/MWh/GJ) rather than
 * against a factor set: its factor is resolved by geography and `energy_type`,
 * not by an activity type, so there is no per-type `input_unit` to read.
 */
export async function evaluateVal014(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadInputRow(ctx);
  if (!row || !ACTIVITY_TABLES.includes(row.table)) return [];

  const finding = (passed: boolean): RuleFinding[] => [
    { passed, objectType: row.table, objectId: row.id },
  ];
  if (!filled(row.unit)) return finding(true);
  const unit = row.unit as string;

  if (row.table === "purchased_energy_activity") {
    return finding((ENERGY_UNITS as readonly string[]).includes(unit));
  }

  const activity = await loadEmissionRow(ctx);
  if (!activity) return [];
  const period = await loadPeriodOfRevision(
    ctx.db,
    ctx.companyId,
    row.revisionId,
  );
  if (!period) return finding(true);

  const supported = await supportedUnits(
    ctx.db,
    period.factorSetId,
    activity.activityType,
  );
  if (supported.size === 0) return finding(true);
  return finding(supported.has(unit));
}

// ─── VAL-015 / VAL-016 — the method and its input (AC-4, part 1) ─────────────

/** The six К-5 refrigerant columns — the input of a `mass_balance` method. */
function massBalanceFigures(row: typeof emissionActivity.$inferSelect) {
  return [
    row.refrigerantAdded,
    row.refrigerantRecovered,
    row.equipmentCapacity,
    row.openingStock,
    row.closingStock,
    row.leakageRate,
  ];
}

/**
 * VAL-015 — a method is selected but its input is missing.
 *
 * WHAT COUNTS AS "THE INPUT", given that the schema already makes
 * `activity_type`, `activity_value` and `method` NOT NULL (§4.9). Two things are
 * left nullable and both are genuinely the method's input:
 *   • `unit` — a quantity with no unit is not a quantity. It is the input of
 *     every method that prices an amount of something (fuel, distance, mass,
 *     energy), which is eight of the nine CalculationMethod values;
 *   • the К-5 refrigerant column group — the input of `mass_balance`, whose
 *     `activity_value` is a summary rather than the measurement. A mass-balance
 *     row with an empty column group has declared a method it has no numbers
 *     for, which is precisely "выбран метод, но нет входа".
 *
 * IT IS NOT A STATIONARY-ONLY RULE. §4.9 puts all five categories in one table
 * and every one of them selects a method, so a fugitive or process row with no
 * unit is the same defect as a stationary one — which is what makes this half of
 * AC-4 real rather than a check on the one category that happened to be tested.
 */
export async function evaluateVal015(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadEmissionRow(ctx);
  if (!row) return [];

  const passed =
    row.method === "mass_balance"
      ? massBalanceFigures(row).some((value) => value !== null)
      : filled(row.unit);
  return [{ passed, objectType: "emission_activity", objectId: row.id }];
}

/**
 * The units that measure an AMOUNT OF FUEL (or of anything else burned, leaked
 * or processed) rather than a distance travelled — `fuel_based`'s half of §6.2's
 * "distance ⇒ vehicle type; fuel ⇒ litres".
 *
 * "Litres" is the workbook's example, not the list: the Phase-1 factor set
 * prices fuels in litres, cubic metres, kilograms, tonnes and kilowatt-hours,
 * and refusing a tonne of wood pellets because the wording said litres would
 * make the rule a typo detector.
 */
const FUEL_QUANTITY_UNITS: readonly string[] = [
  "L",
  "m3",
  "kg",
  "t",
  "kWh",
  "kWh_gross",
  "kWh_net",
  "MWh",
  "GJ",
];

/** The unit a `distance_based` method measures in (`UNIT_CODES` has one). */
const DISTANCE_UNIT = "km";

/**
 * VAL-016 — the method and the input that is present do not agree.
 *
 * §6.2 states the fleet pair; this is its general form, because §4.9 gives all
 * five categories the same nine methods and the mistake is the same in each:
 *   • `distance_based` — the quantity must be a DISTANCE (`km`) and the
 *     `activity_type` must be a vehicle. That is the "distance ⇒ vehicle type"
 *     half literally: a stationary boiler entered as `distance_based` has picked
 *     a method for a fleet, and the factor set prices distances for vehicles
 *     only.
 *   • `fuel_based` — the quantity must be an AMOUNT of fuel, never a distance.
 *     A van entered as `fuel_based` in `km` has the fleet mistake the other way
 *     round, and would resolve a per-km factor against a litre figure.
 *   • every other method — nothing to say, and a PASS is written rather than
 *     silence so that switching a row off `distance_based` clears the earlier
 *     failure (§4.18: only a written row supersedes one).
 *
 * A row with no unit fails the two methods that need one. That is a second
 * refusal beside VAL-015's, and it is the honest answer: the row is both missing
 * its input and using a method that cannot work without it.
 */
export async function evaluateVal016(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadEmissionRow(ctx);
  if (!row) return [];

  const unit = row.unit ?? "";
  let passed = true;
  if (row.method === "distance_based") {
    passed = unit === DISTANCE_UNIT && isVehicleType(row.activityType);
  } else if (row.method === "fuel_based") {
    passed = FUEL_QUANTITY_UNITS.includes(unit);
  }
  return [{ passed, objectType: "emission_activity", objectId: row.id }];
}

// ─── VAL-018 / VAL-019 — the refrigerant column group (К-5) ──────────────────

/**
 * VAL-018 — the refrigerant mass balance is not negative (Warning).
 *
 * The balance is `(opening_stock + added) − (recovered + closing_stock)`: what
 * went into the equipment and was not taken back out is what leaked. A NEGATIVE
 * balance means more refrigerant came out than ever went in, which is a
 * bookkeeping error rather than an impossible physical claim — hence a warning:
 * the four figures come from different maintenance records and reconciling them
 * is the user's job, not the server's.
 *
 * Judged only when all four figures are present; an incomplete group PASSES
 * here (whether it is complete enough to be a mass balance at all is VAL-015's)
 * and a row that is not fugitive is not its subject.
 */
export async function evaluateVal018(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadEmissionRow(ctx);
  if (!row || row.activityCategory !== "fugitive_emissions") return [];

  const opening = numeric(row.openingStock);
  const closing = numeric(row.closingStock);
  const added = numeric(row.refrigerantAdded);
  const recovered = numeric(row.refrigerantRecovered);
  const complete = [opening, closing, added, recovered].every(
    (value) => value !== null,
  );
  const passed = complete
    ? (opening ?? 0) + (added ?? 0) - (recovered ?? 0) - (closing ?? 0) >= 0
    : true;
  return [{ passed, objectType: "emission_activity", objectId: row.id }];
}

/**
 * VAL-019 — the refrigerant has a factor (a GWP) in the pinned set.
 *
 * A fugitive row whose gas the period's factor set does not price cannot be
 * calculated at all, and §0.7 forbids the alternative — substituting a zero —
 * absolutely. So the refusal happens at DATA ENTRY, where the user can still
 * pick the gas they actually have, rather than at the calculation, where the
 * only remaining move is to fail the run.
 *
 * The lookup is by `activity_type` against `emission_factor` of the period's
 * pinned set (К-24). It deliberately does not look at `input_unit` or
 * geography: those are VAL-014's and CALC-2's, and a refrigerant priced in the
 * set but entered in the wrong unit is a different mistake with a different fix.
 */
export async function evaluateVal019(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadEmissionRow(ctx);
  if (!row || row.activityCategory !== "fugitive_emissions") return [];

  const period = await loadPeriodOfRevision(
    ctx.db,
    ctx.companyId,
    row.revisionId,
  );
  if (!period) return [];

  const [priced] = await ctx.db
    .select({ id: emissionFactor.id })
    .from(emissionFactor)
    .where(
      and(
        eq(emissionFactor.factorSetId, period.factorSetId),
        eq(emissionFactor.activityType, row.activityType),
      ),
    )
    .limit(1);
  return [
    {
      passed: priced !== undefined,
      objectType: "emission_activity",
      objectId: row.id,
    },
  ];
}

// ─── VAL-104 — a row with no site says why (AC-2) ────────────────────────────

/**
 * VAL-104 — an emission/energy row without `facility_id` carries a non-empty
 * `notes`.
 *
 * THIS IS AC-2's OWNER: "every activity linked to a valid site or a documented
 * exception". К-18 settled the first half — the Data Dictionary marks
 * `*_facility_id` Required while D9 makes site attribution optional, and the
 * model follows D9 — so the column is nullable and this rule is the second half:
 * an unattributed row must SAY WHY. `notes` is the documented exception, and a
 * blank one is not an exception, it is a gap.
 *
 * BLOCKING, unlike most of the record family, because the alternative is a
 * report whose figures cannot be traced to anything. The cost of complying is
 * one sentence.
 */
export async function evaluateVal104(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadInputRow(ctx);
  if (!row || !ACTIVITY_TABLES.includes(row.table)) return [];
  return [
    {
      passed: row.facilityId !== null || filled(row.notes),
      objectType: row.table,
      objectId: row.id,
    },
  ];
}
