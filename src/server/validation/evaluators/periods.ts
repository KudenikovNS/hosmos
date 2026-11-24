// =============================================================================
// Reporting-period evaluators (spec §6.2, scope `period`).
//
// WHAT IS HERE. T2.1 took the two that read the period row and nothing else —
// VAL-008 (`start < end`) and VAL-009 (overlap). T2.4 added the three the period
// ROUTE makes reachable: VAL-102 and VAL-103, the owners of AC-9 and AC-10, and
// VAL-106, DM-7a's immutability rule. T2.5 adds VAL-101, the boundary's own rule
// (D15 — an exclusion states its reason), now that `PUT /api/periods/[id]/scope`
// can write the rows it judges. T2.6 adds VAL-105 — the F1 hard gate, which only
// speaks when a revision is being LOCKED. What is left of the `period` family is
// the VAL-010 freeze family, whose subjects are the four input tables (T3.1).
//
// THE BOUNDARY IS THE SUBJECT OF THREE OF THEM. VAL-101, VAL-102 and VAL-103 all
// read `period_scope`. That the rules run in the PERIOD's scope, against its id,
// is not a mismatch: the boundary is where a period keeps its list of entities,
// and a period-scope run is exactly the moment all three are decidable together.
//
// Tenant pin as in `./org`: every query filters on `company_id`.
// =============================================================================
import { and, eq, lte, gte, ne } from "drizzle-orm";

import { legalEntity, periodScope, reportingPeriod } from "@/server/db/schema";
import {
  calculationInputsEditable,
  frozenAmong,
  loadCurrentRevision,
  REVISION_LOCK_FIELD,
} from "@/server/periods/lifecycle";
import { facilityGateVerdict } from "@/server/periods/plan-gate";

import type { EvaluatorContext, RuleFinding } from "../types";

/** The reporting period `targetId` points at, or `undefined`. */
async function loadPeriod(ctx: EvaluatorContext) {
  const [row] = await ctx.db
    .select({
      id: reportingPeriod.id,
      startDate: reportingPeriod.startDate,
      endDate: reportingPeriod.endDate,
      reportingBasis: reportingPeriod.reportingBasis,
    })
    .from(reportingPeriod)
    .where(
      and(
        eq(reportingPeriod.id, ctx.targetId),
        eq(reportingPeriod.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The period's boundary (DM-8) joined to the entities it names — one row per
 * `period_scope` row, tenant-pinned on BOTH tables. THE boundary reader: all
 * three rules that judge the boundary take it from here, so "which rows are in
 * this period's boundary" is answered in one place and one way.
 *
 * An empty result means the boundary has not been drawn yet, which is a
 * different thing from "the boundary is empty on purpose" and all three rules
 * treat it as "nothing to judge" rather than as a failure. It is the normal
 * state of a period between `POST /api/periods` and the first
 * `PUT /api/periods/[id]/scope`, and refusing it would make creating a
 * consolidated period impossible: its boundary can only be drawn afterwards.
 */
async function loadBoundary(ctx: EvaluatorContext, periodId: string) {
  return ctx.db
    .select({
      scopeId: periodScope.id,
      entityId: legalEntity.id,
      status: periodScope.status,
      exclusionReason: periodScope.exclusionReason,
      registeredAddress: legalEntity.registeredAddress,
      groupStructureType: legalEntity.groupStructureType,
      parentLegalEntityId: legalEntity.parentLegalEntityId,
    })
    .from(periodScope)
    .innerJoin(legalEntity, eq(legalEntity.id, periodScope.legalEntityId))
    .where(
      and(
        eq(periodScope.periodId, periodId),
        eq(periodScope.companyId, ctx.companyId),
        eq(legalEntity.companyId, ctx.companyId),
      ),
    );
}

/**
 * VAL-008 — `start_date < end_date`.
 *
 * DELIBERATELY DUPLICATED by the `reporting_period_dates_check` CHECK (T1.2, and
 * the plan says so at T2.4): the CHECK is what makes an inverted period
 * impossible to store, the rule is what lets the API answer with a rule code and
 * a message instead of a driver error. A row that reaches this evaluator has
 * therefore already passed the CHECK — the value of the rule is the RESULT ROW,
 * which the period screen reads alongside every other check.
 */
export async function evaluateVal008(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadPeriod(ctx);
  if (!row) return [];
  return [
    {
      passed: row.startDate < row.endDate,
      objectType: "reporting_period",
      objectId: row.id,
    },
  ];
}

/**
 * VAL-009 — the period does not overlap another period of the same company.
 *
 * A WARNING, not an error (§6.2): overlapping periods are a legitimate, if
 * unusual, configuration — a transition year, a stub period for a part-year
 * acquisition — so the run reports and does not refuse.
 *
 * Both bounds are INCLUSIVE (`start_date`…`end_date` is the reported window),
 * so two periods overlap when `a.start ≤ b.end AND b.start ≤ a.end`; adjacent
 * periods (2024-12-31 / 2025-01-01) do not. Date columns come back as ISO
 * strings and are compared by the database, not in JS.
 */
export async function evaluateVal009(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadPeriod(ctx);
  if (!row) return [];

  const [overlapping] = await ctx.db
    .select({ id: reportingPeriod.id })
    .from(reportingPeriod)
    .where(
      and(
        eq(reportingPeriod.companyId, ctx.companyId),
        ne(reportingPeriod.id, row.id),
        lte(reportingPeriod.startDate, row.endDate),
        gte(reportingPeriod.endDate, row.startDate),
      ),
    )
    .limit(1);

  return [
    {
      passed: overlapping === undefined,
      objectType: "reporting_period",
      objectId: row.id,
    },
  ];
}

/** True for a value that is present and not blank after trimming. */
function filled(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * VAL-101 — D15. An entity the boundary EXCLUDES states why.
 *
 * ONE FINDING PER BOUNDARY ROW, against the row (`object_type='period_scope'`,
 * matching the rule's `appliesTo`): the boundary screen renders a reason field
 * per line, so a failure has to point at the line, not at the period.
 *
 * WHY IT IS BLOCKING AND WHY THAT IS NOT PEDANTRY: `exclusion_reason` is printed
 * (VSME B1 names the entities in the report AND the grounds for every exclusion,
 * REN-2), it is frozen into the submission with the rest of the boundary
 * (`frozen_scope`, D15), and it is the one field that distinguishes a scoped
 * report from an incomplete one. A blank reason is not a formatting problem, it
 * is a disclosure that does not exist.
 *
 * THE OTHER THREE STATUSES PASS, and they pass for the same reason VAL-103
 * writes explicit passes rather than staying silent (§4.18 — only a written row
 * supersedes an earlier one): switching a row from `excluded` back to
 * `included` must CLEAR its failure, and returning `[]` for it would leave the
 * stale blocking row on the screen. A reason on a `not_applicable` row is
 * allowed and left alone — D15 only makes it mandatory for `excluded`.
 *
 * A stored result of this rule is therefore always a pass: the rule is blocking
 * and the only write path of `period_scope` runs it in the transaction, so a
 * failing row is rolled back with the finding that judged it. The refusal
 * travels in the response payload (as with every blocking rule on a write path).
 */
export async function evaluateVal101(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const period = await loadPeriod(ctx);
  if (!period) return [];

  const boundary = await loadBoundary(ctx, period.id);
  return boundary.map((row) => ({
    passed: row.status !== "excluded" || filled(row.exclusionReason),
    objectType: "period_scope",
    objectId: row.scopeId,
  }));
}

/**
 * VAL-102 — AC-9. A CONSOLIDATED period needs at least two included legal
 * entities and a designated parent among them.
 *
 * THE TWO HALVES, spelled out because "designated parent" is the kind of phrase
 * that gets re-invented differently by the next reader:
 *
 *   1. INCLUDED means `period_scope.status = 'included'` for THIS period — the
 *      per-period decision (D10/D15), never the registry-level
 *      `facility.included_in_boundary` and never "every entity of the tenant".
 *      Two of them, because a consolidation of one company is an individual
 *      report wearing a different label, which is precisely what AC-9 refuses
 *      to let a customer print.
 *   2. A DESIGNATED PARENT is an included entity that (a) is marked as one —
 *      `group_structure_type = 'parent'`, the field whose only purpose is to say
 *      so — and (b) is not itself a subsidiary of another INCLUDED entity, i.e.
 *      it is the top of the consolidated set. Exactly one must qualify. The
 *      second clause is what makes an intermediate holding company legal: a
 *      sub-group marked `parent` inside a bigger included group does not count
 *      as a second top, because its own parent is included too. Two unrelated
 *      tops, on the other hand, are two groups in one report, and the rule says
 *      no — a consolidated report has one reporting entity at its head.
 *
 * WHEN IT IS SILENT. An `individual` period is not its subject at all, and a
 * period whose boundary has not been drawn yet has nothing to count: both
 * return `[]` (no finding, no stored row) rather than a pass. This is what lets
 * `POST /api/periods {reporting_basis:'consolidated'}` succeed — the boundary
 * arrives afterwards, through T2.5 — while the same period is refused the
 * moment its boundary says one entity. The hard gate at the other end (a report
 * cannot be locked with no boundary at all) is T2.6's lock precondition, not a
 * job this rule can do without refusing every consolidated period at birth.
 */
export async function evaluateVal102(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const period = await loadPeriod(ctx);
  if (!period || period.reportingBasis !== "consolidated") return [];

  const boundary = await loadBoundary(ctx, period.id);
  if (boundary.length === 0) return [];

  const included = boundary.filter((row) => row.status === "included");
  const includedIds = new Set(included.map((row) => row.entityId));
  const tops = included.filter(
    (row) =>
      row.groupStructureType === "parent" &&
      (row.parentLegalEntityId === null ||
        !includedIds.has(row.parentLegalEntityId)),
  );

  return [
    {
      passed: included.length >= 2 && tops.length === 1,
      objectType: "reporting_period",
      objectId: period.id,
    },
  ];
}

/**
 * VAL-103 — AC-10. Every INCLUDED legal entity carries a `registered_address`.
 *
 * ONE FINDING PER BOUNDARY ROW, against the ENTITY (`object_type =
 * 'legal_entity'`, matching the rule's `appliesTo`): the report names each
 * included company by address, so a failure has to point at WHICH subsidiary is
 * missing one, not at the period.
 *
 * EXCLUDED ENTITIES GET A PASS, NOT SILENCE, and the difference matters. The
 * rule does not fire on them — an entity outside the boundary is not printed
 * and needs no address — but writing the pass is what makes the earlier failure
 * DISAPPEAR when a user resolves the problem by excluding the entity instead of
 * by finding its address. Returning `[]` for it would upsert nothing and leave
 * the stale blocking failure on the screen for ever (§4.18: the table holds the
 * latest result per (rule, target), so only a written row can supersede one).
 *
 * `not_applicable` and `not_assessed` are treated as "not included": neither
 * puts the entity in the report.
 */
export async function evaluateVal103(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const period = await loadPeriod(ctx);
  if (!period) return [];

  const boundary = await loadBoundary(ctx, period.id);
  return boundary.map((row) => ({
    passed: row.status !== "included" || filled(row.registeredAddress),
    objectType: "legal_entity",
    objectId: row.entityId,
  }));
}

/**
 * VAL-105 — F1, the Starter hard gate (PG-3), evaluated at the ONE moment it is
 * about: the attempt to lock.
 *
 * WHY IT IS GATED ON `mutatedFields` LIKE VAL-106, and not evaluated on every
 * `period` run. The rule is blocking. A Starter company with four includable
 * sites that failed it unconditionally could not save its period, could not
 * redraw its boundary (both are `period`-scope writes) and therefore could not
 * even remove the fourth site — the gate would lock the customer out of the
 * only fix. F1 does not say "you may not work", it says "you may not CLOSE the
 * report": `report_revision.locked_at` is the field that closes it, and the
 * transition declares it (`REVISION_LOCK_FIELD`).
 *
 * WHO REFUSES. Not this rule, and that is deliberate — a plan limit is a 402
 * `PLAN_REQUIRED` with an upgrade path, never a 422 (§0.2, §7.1). The lock
 * transition runs the `period` scope, sees THIS record fail and answers 402; the
 * stored row is what lets the UI say WHY ("4 sites, Starter allows 3") instead
 * of showing a bare payment wall. So the rule is written for the screen and the
 * gate is written for the answer, from one computation (`../../periods/plan-gate`).
 *
 * A PASS IS ALSO WRITTEN, for the reason VAL-103 states: only a written row can
 * supersede the earlier failure once the customer upgrades or drops a site.
 * `revision_id` is filled from the period's current revision so the result shows
 * up in `GET /api/revisions/[id]/validation`, which is the screen that asks.
 */
export async function evaluateVal105(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  if (!(ctx.mutatedFields ?? []).includes(REVISION_LOCK_FIELD)) return [];

  const period = await loadPeriod(ctx);
  if (!period) return [];

  const verdict = await facilityGateVerdict(ctx.db, ctx.companyId, period.id);
  const current = await loadCurrentRevision(ctx.db, ctx.companyId, period.id);
  return [
    {
      passed: verdict.passed,
      objectType: "reporting_period",
      objectId: period.id,
      revisionId: current?.id ?? null,
    },
  ];
}

/**
 * VAL-106 — DM-7a. The calculation-bearing fields of a period, and its
 * boundary, are immutable while the current revision is not `draft`/`rejected`.
 *
 * THE ONE RULE OF THE FAMILY THAT JUDGES A CHANGE RATHER THAN A STATE, which is
 * why it reads `ctx.mutatedFields` (see `../types`). A run that is not a write
 * gate, or a write that touched only labelling fields (`period_name`,
 * `reporting_year`, `comparative_period_id`), leaves nothing for it to say and
 * it returns `[]` — silence meaning "not applicable", as everywhere else. When
 * a frozen field IS touched the verdict is the period's current revision:
 * `draft`/`rejected`, or none at all, allow it; anything else refuses, the
 * transaction rolls back (VR-3) and the caller gets the code.
 *
 * The result of a REFUSED write never reaches the table — it is rolled back
 * with the row it was judging — so the stored VAL-106 rows are the passes. That
 * is the same behaviour as every other blocking rule on a write path (VAL-006
 * on a facility, say); the refusal travels in the response payload.
 */
export async function evaluateVal106(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  if (frozenAmong(ctx.mutatedFields).length === 0) return [];

  const period = await loadPeriod(ctx);
  if (!period) return [];

  const current = await loadCurrentRevision(ctx.db, ctx.companyId, period.id);
  return [
    {
      passed: calculationInputsEditable(current),
      objectType: "reporting_period",
      objectId: period.id,
    },
  ];
}
