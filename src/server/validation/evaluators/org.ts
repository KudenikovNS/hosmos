// =============================================================================
// Organisational-axis evaluators (spec §6.2, scope `reference_org`).
//
// WHAT IS HERE. T2.1 built the ENGINE and the three checks that need nothing
// but the row itself (VAL-001 required fields, VAL-004 effective dating,
// VAL-006 coordinates). T2.2 added the two that needed the legal-entity write
// path: VAL-002 (country / currency / NACE against their reference lists) and
// VAL-003 (no cycles in the group hierarchy, by recursive CTE — DM-3). T2.3
// adds the last one of the scope, VAL-005 (the effective-dated facility→entity
// link) — after which `reference_org` has no entry left in
// `PENDING_EVALUATORS` except the three factor rules T2.8 owns.
//
// THESE RULES ARE THE WRITE GATE, not a report. The services of
// `@/server/org/*` write inside a transaction, run the `reference_org` scope
// against the row they just wrote and ROLL BACK when any blocking rule failed
// (VR-3: a blocking reference_org rule refuses the save). So an evaluator here
// is evaluated against the TENTATIVE state — including a hierarchy that
// momentarily contains the cycle it is asked about, which is precisely why the
// CTE below is depth-capped.
//
// TENANT PIN. Every query is `AND company_id = :companyId` (PATTERN 3): a
// foreign or unknown id selects nothing and the evaluator returns `[]`, which
// writes no result at all. A validation run can therefore never confirm the
// existence of another tenant's row.
// =============================================================================
import { and, eq, sql } from "drizzle-orm";

import { currencies, facility, legalEntity } from "@/server/db/schema";
import { COUNTRY_CODES } from "@/shared/constants";
import { isNaceCode } from "@/shared/data/nace";

import type { EvaluatorContext, RuleFinding, ValidationDb } from "../types";

/**
 * The ISO-3166 alpha-2 codes the product recognises (VAL-002).
 *
 * `COUNTRY_CODES` is the single country list of the application: it drives the
 * country selects AND it is pinned to the grid-factor seed (`002`), i.e. it is
 * exactly the set of countries a Scope-2 calculation can be performed for. A
 * country outside it is not "a country we have not got round to" — it is a
 * country whose report could not be produced, so refusing it at the entity is
 * the honest place. Built once at module load; ~48 entries.
 */
const COUNTRY_ALPHA2: ReadonlySet<string> = new Set(
  COUNTRY_CODES.map((entry) => entry.code),
);

/** The legal entity `targetId` points at, or `undefined` (foreign / not one). */
async function loadLegalEntity(ctx: EvaluatorContext) {
  const [row] = await ctx.db
    .select({
      id: legalEntity.id,
      name: legalEntity.name,
      country: legalEntity.country,
      registrationNumber: legalEntity.registrationNumber,
      naceCode: legalEntity.naceCode,
      reportingCurrency: legalEntity.reportingCurrency,
      parentLegalEntityId: legalEntity.parentLegalEntityId,
      effectiveFrom: legalEntity.effectiveFrom,
      effectiveTo: legalEntity.effectiveTo,
    })
    .from(legalEntity)
    .where(
      and(
        eq(legalEntity.id, ctx.targetId),
        eq(legalEntity.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  return row;
}

/** True for a value that is present and not blank after trimming. */
function filled(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * VAL-001 — an organisation carries `name`, `country` and
 * `registration_number`.
 *
 * All three are nullable in the schema (only `name` is NOT NULL) because a
 * half-filled entity must be savable while the user is typing; the RULE is what
 * makes it blocking before the entity can be used. Whitespace counts as empty:
 * `" "` in a registration number is not a registration number.
 */
export async function evaluateVal001(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadLegalEntity(ctx);
  if (!row) return [];
  return [
    {
      passed:
        filled(row.name) &&
        filled(row.country) &&
        filled(row.registrationNumber),
      objectType: "legal_entity",
      objectId: row.id,
    },
  ];
}

/**
 * VAL-002 — `country`, `reporting_currency` and `nace_code` come from the
 * current reference lists.
 *
 * THREE LISTS, THREE SOURCES, all of them real:
 *   • country  — `COUNTRY_CODES` (ISO-3166 alpha-2, the app's country list,
 *                pinned to the grid-factor seed);
 *   • currency — the SEEDED `currencies` table (ISO-4217), which is also the
 *                target of the `reporting_currency` foreign key: a code that
 *                fails here could not have been stored in the first place, so
 *                this branch is the rule's statement of a constraint the
 *                database already enforces — see the write path, which checks
 *                the same list BEFORE the insert so a bad currency is a 422
 *                with this code rather than an FK driver error (500);
 *   • NACE     — `isNaceCode` (NACE Rev. 2 sections + divisions).
 *
 * A NULL field PASSES: "which values are legal" is this rule, "which fields
 * must be filled" is VAL-001. Splitting them keeps a half-filled entity's
 * failure list honest — one code per problem, not two for the same blank.
 */
export async function evaluateVal002(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadLegalEntity(ctx);
  if (!row) return [];

  const countryOk = row.country === null || COUNTRY_ALPHA2.has(row.country);
  const naceOk = row.naceCode === null || isNaceCode(row.naceCode);

  let currencyOk = true;
  if (row.reportingCurrency !== null) {
    const [known] = await ctx.db
      .select({ code: currencies.code })
      .from(currencies)
      .where(eq(currencies.code, row.reportingCurrency))
      .limit(1);
    currencyOk = known !== undefined;
  }

  return [
    {
      passed: countryOk && currencyOk && naceOk,
      objectType: "legal_entity",
      objectId: row.id,
    },
  ];
}

/**
 * How many parents the cycle walk follows before it gives up.
 *
 * NOT a safety belt — load-bearing. The walk runs INSIDE the write transaction,
 * against a hierarchy that may already contain the cycle it is looking for
 * (A→B→A is written first and judged second, §above); a `UNION ALL` recursion
 * over a cyclic graph does not terminate. The cap makes it terminate in every
 * case, and 64 levels is far past any real group structure — a tenant that
 * genuinely nests deeper would be refused a parent link, which is a better
 * failure than a hung connection.
 */
const MAX_HIERARCHY_DEPTH = 64;

/**
 * Does the ancestor chain of `startId` contain `targetId` (DM-3)?
 *
 * The recursive CTE walks PARENT links only — one row per level, each found by
 * primary key inside the tenant — so the cost is O(depth) index lookups, not a
 * scan of the tree. It stays private: the write path does not ask the question
 * itself, it writes the link and then runs this rule, so the codebase holds
 * exactly ONE implementation of "is this a cycle".
 */
async function hasAncestor(
  db: ValidationDb,
  companyId: string,
  startId: string,
  targetId: string,
): Promise<boolean> {
  const rows = await db.execute<{ hit: number }>(sql`
    WITH RECURSIVE ancestor AS (
      SELECT id, parent_legal_entity_id, 1 AS depth
        FROM legal_entity
       WHERE id = ${startId} AND company_id = ${companyId}
      UNION ALL
      SELECT parent.id, parent.parent_legal_entity_id, child.depth + 1
        FROM ancestor child
        JOIN legal_entity parent
          ON parent.id = child.parent_legal_entity_id
         AND parent.company_id = ${companyId}
       WHERE child.depth < ${MAX_HIERARCHY_DEPTH}
    )
    SELECT 1 AS hit FROM ancestor WHERE id = ${targetId} LIMIT 1
  `);
  return rows.length > 0;
}

/**
 * VAL-003 — the group hierarchy has no cycles (DM-3).
 *
 * An entity with no parent trivially passes. Otherwise the walk starts at the
 * PARENT and looks for the entity itself: reaching it means following
 * `parent_legal_entity_id` from the entity leads back to the entity, which is
 * the definition of the cycle. A self-reference (A→A) is the degenerate case —
 * the walk's first row IS the target — and needs no separate branch.
 *
 * The walk is tenant-pinned at every level, so a parent id belonging to another
 * company simply ends the chain; the write path refuses such a reference
 * outright (API-1), and a row that acquired one some other way is at worst
 * reported as cycle-free, never as another tenant's structure.
 */
export async function evaluateVal003(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadLegalEntity(ctx);
  if (!row) return [];

  const parentId = row.parentLegalEntityId;
  const cyclic =
    parentId !== null &&
    (await hasAncestor(ctx.db, ctx.companyId, parentId, row.id));

  return [{ passed: !cyclic, objectType: "legal_entity", objectId: row.id }];
}

/**
 * VAL-004 — `effective_from ≤ effective_to`.
 *
 * Both columns are `date` and Drizzle hands them back as ISO `YYYY-MM-DD`
 * strings, which compare correctly lexicographically. An open interval (either
 * end NULL) is valid: an entity with no `effective_to` is simply still in the
 * group, and one with no `effective_from` has always been.
 */
export async function evaluateVal004(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadLegalEntity(ctx);
  if (!row) return [];
  const { effectiveFrom: from, effectiveTo: to } = row;
  return [
    {
      passed: from === null || to === null || from <= to,
      objectType: "legal_entity",
      objectId: row.id,
    },
  ];
}

/**
 * Today, as the `YYYY-MM-DD` string a `date` column compares against.
 *
 * UTC rather than the server's local zone, so the answer does not depend on
 * which machine ran the validation — a boundary that moves with `TZ` would make
 * the same facility valid on one host and invalid on another for a few hours a
 * day. `date` columns carry no zone, and Drizzle hands them back in exactly this
 * form, so the comparison is a lexicographic string compare that is also a
 * chronological one.
 */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * VAL-005 — a facility hangs off a legal entity that is IN FORCE (DM-5, F4).
 *
 * WHAT "IN FORCE" MEANS HERE. The entity's `effective_from`/`effective_to` pair
 * is a half-open-ended interval (F4), and the rule asks one question: does that
 * interval CONTAIN the reference date?
 *   • `effective_from IS NULL` — the entity has always been in the group, so no
 *     lower bound;
 *   • `effective_to IS NULL`   — it has not left, so no upper bound;
 *   • BOTH NULL — the interval is unbounded in both directions and the rule
 *     PASSES for any facility. That is the common case and it is deliberate:
 *     dating is optional (VAL-001 does not require it), and a rule that failed
 *     on an undated entity would make every single-company tenant unable to
 *     save a site until they had filled in a field they have no use for.
 *
 * WHICH DATE IT IS COMPARED AGAINST, which is the other half of the rule:
 *   • a CLOSED facility (`closing_date` set) is judged at its closing date. A
 *     site that shut in 2021 under a subsidiary divested in 2023 is a correct
 *     piece of history, and the years it reported must stay reportable; judging
 *     it against today would turn a settled record into a permanent blocking
 *     failure with no legal edit that could clear it;
 *   • an OPEN facility is judged TODAY. The claim such a row makes is present
 *     tense — "this site belongs to that entity" — so the entity has to be in
 *     the group now. This is the branch the acceptance case exercises: an
 *     entity whose `effective_to` has passed cannot own an operating site.
 * `opening_date` is deliberately not consulted: it is VAL-007's subject (an
 * ACTIVITY outside a facility's operating dates), and folding it in here would
 * give two rules the same failure.
 *
 * A facility whose entity does not resolve INSIDE the tenant fails rather than
 * returning `[]`: the row exists (it was found by the query above), and "this
 * facility is attached to no legal entity of this company" is exactly what the
 * rule is for. Only a target that is not a facility of this company at all is
 * silent.
 */
export async function evaluateVal005(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const [row] = await ctx.db
    .select({
      id: facility.id,
      legalEntityId: facility.legalEntityId,
      closingDate: facility.closingDate,
    })
    .from(facility)
    .where(
      and(eq(facility.id, ctx.targetId), eq(facility.companyId, ctx.companyId)),
    )
    .limit(1);
  if (!row) return [];

  const [entity] = await ctx.db
    .select({
      effectiveFrom: legalEntity.effectiveFrom,
      effectiveTo: legalEntity.effectiveTo,
    })
    .from(legalEntity)
    .where(
      and(
        eq(legalEntity.id, row.legalEntityId),
        eq(legalEntity.companyId, ctx.companyId),
      ),
    )
    .limit(1);

  const asOf = row.closingDate ?? todayIso();
  const inForce =
    entity !== undefined &&
    (entity.effectiveFrom === null || entity.effectiveFrom <= asOf) &&
    (entity.effectiveTo === null || entity.effectiveTo >= asOf);

  return [{ passed: inForce, objectType: "facility", objectId: row.id }];
}

/**
 * VAL-006 — latitude in −90…90, longitude in −180…180.
 *
 * The columns are `numeric` (returned as strings), so the bound check goes
 * through `Number`. Coordinates are optional — a site with neither is valid;
 * one with a value that is not a finite number, or out of range, is not. A
 * facility that names only ONE coordinate still passes on the named one: the
 * rule is about ranges, and "half a coordinate pair" belongs to the facility
 * form, not here.
 */
export async function evaluateVal006(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const [row] = await ctx.db
    .select({
      id: facility.id,
      latitude: facility.latitude,
      longitude: facility.longitude,
    })
    .from(facility)
    .where(
      and(eq(facility.id, ctx.targetId), eq(facility.companyId, ctx.companyId)),
    )
    .limit(1);
  if (!row) return [];

  const inRange = (raw: string | null, limit: number): boolean => {
    if (raw === null) return true;
    const n = Number(raw);
    return Number.isFinite(n) && n >= -limit && n <= limit;
  };

  return [
    {
      passed: inRange(row.latitude, 90) && inRange(row.longitude, 180),
      objectType: "facility",
      objectId: row.id,
    },
  ];
}
