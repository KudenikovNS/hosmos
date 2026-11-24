// Data-quality assessments (DQ-1…DQ-4, К-16, К-23, VAL-038, VAL-039): one
// assessment per company and row VERSION, created with the row and copied
// forward so a score never silently outlives the figure it judged. No
// `import "server-only"` here, for the reason `@/server/evidence` gives.
//
// See docs/decisions/dq-assessments.md for the full account.
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  booleanValue,
  decimalOrNull,
  integerOrNull,
  num,
  oneOfOrNull,
  textOrNull,
  type ParseResult,
} from "@/server/api/parse";
import type { DbClient } from "@/server/db/client";
import { dqAssessment } from "@/server/db/schema";
import { anyTargetLocked, resolveTarget } from "@/server/evidence/links";
import type { VersionCarryContext } from "@/server/inventory/rows";
import {
  INPUT_TABLES,
  type InputRow,
  type InputTableName,
} from "@/server/inventory/tables";
import {
  refuseValidation,
  ruleRef,
  writeValidated,
  type RuleRef,
} from "@/server/validation/write";
import {
  isCalculationMethod,
  isQualityTier,
  type CalculationMethod,
  type ObjectType,
  type QualityTier,
} from "@/shared/enums";

/** A `dq_assessment` row as the database returns it. */
export type DqAssessmentRow = typeof dqAssessment.$inferSelect;

// ─── DQ-1: the rule-driven pre-fill, as a TABLE ──────────────────────────────

/**
 * The tier a freshly entered `emission_activity` starts with, BY METHOD — the
 * one place DQ-1's "estimate-метод → `estimate`" is written down.
 *
 * TOTAL ON PURPOSE (all nine `CalculationMethod` values, §4.9): a tenth method
 * would stop compiling here rather than silently falling into a default, and
 * "which methods count as an estimate" is exactly the kind of question that gets
 * answered differently in two places if it is answered by an `if`.
 *
 * WHY ONLY TWO METHODS GET `estimate`, and why nothing gets the other two tiers:
 *   • `engineering_estimate` and `spend_based` say in their NAME that the figure
 *     was derived rather than measured — an engineering calculation and a money
 *     proxy respectively. Those are DQ-1's "estimate method".
 *   • Everything else is DQ-1's "manual entry": a person typed an activity
 *     figure that a factor will be applied to, which is what `medium_calculated`
 *     means. That includes `supplier_specific`, deliberately — supplier data is
 *     often primary, but `high_primary` is a claim about EVIDENCE nobody has
 *     looked at yet, and a machine that hands it out would be asserting quality
 *     on the strength of a dropdown.
 *   • `low_proxy` is never pre-filled either, and that one matters more: with
 *     `estimate` it is half of DQ-4's exemption (a row with no evidence at all
 *     may be approved only when its tier is `low_proxy`/`estimate` AND its
 *     `quality_comment` is non-empty). The comment is never machine-written, so
 *     no pre-fill can buy the exemption on its own — but handing out the tier
 *     half of it for `average_data` would still be the machine taking a position
 *     on a question DQ-4 asks a human to answer in prose.
 */
const TIER_BY_METHOD: Record<CalculationMethod, QualityTier> = {
  supplier_specific: "medium_calculated",
  activity_based: "medium_calculated",
  fuel_based: "medium_calculated",
  distance_based: "medium_calculated",
  average_data: "medium_calculated",
  hybrid: "medium_calculated",
  mass_balance: "medium_calculated",
  spend_based: "estimate",
  engineering_estimate: "estimate",
};

/** DQ-1's "manual entry" outcome — the tier of a row whose method says nothing. */
const MANUAL_ENTRY_TIER: QualityTier = "medium_calculated";

/**
 * The pre-fill rule of each input table (§4.9–4.12), keyed by table name.
 *
 * Only `emission_activity` carries a `method` column; the other three have no
 * field that says how the number was produced, so every row of them is a manual
 * entry until somebody assesses it. Keeping all four here — rather than
 * defaulting the missing ones — is what makes the question "what tier does a
 * contractual instrument start with" answerable by reading one table.
 */
const INITIAL_TIER_RULES: Record<
  InputTableName,
  (row: InputRow) => QualityTier
> = {
  emission_activity: (row) =>
    "method" in row && isCalculationMethod(row.method)
      ? TIER_BY_METHOD[row.method]
      : MANUAL_ENTRY_TIER,
  purchased_energy_activity: () => MANUAL_ENTRY_TIER,
  contractual_instrument: () => MANUAL_ENTRY_TIER,
  disclosure_record: () => MANUAL_ENTRY_TIER,
};

/**
 * The `quality_tier` a new row of `table` starts with (DQ-1).
 *
 * Exported so the acceptance test asserts the MAPPING rather than re-deriving
 * it: a test that copied the rule would pass on the day the rule changed.
 */
export function initialQualityTier(
  table: InputTableName,
  row: InputRow,
): QualityTier {
  return INITIAL_TIER_RULES[table](row);
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** One object's assessment, tenant-pinned. `undefined` when it has none yet. */
export async function getAssessment(
  db: DbClient,
  companyId: string,
  objectType: string,
  objectId: string,
): Promise<DqAssessmentRow | undefined> {
  const [row] = await db
    .select()
    .from(dqAssessment)
    .where(
      and(
        eq(dqAssessment.companyId, companyId),
        eq(dqAssessment.objectType, objectType),
        eq(dqAssessment.objectId, objectId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Does `objectId` name an object of THIS company (К-8)?
 *
 * The route asks before it answers a GET, so a foreign id — or one that never
 * existed — reads as absent (API-1) instead of as "this object has no
 * assessment", which would confirm the id to somebody who guessed it.
 */
export async function assessmentTargetExists(
  db: DbClient,
  companyId: string,
  objectType: ObjectType,
  objectId: string,
): Promise<boolean> {
  return (
    (await resolveTarget(db, companyId, objectType, objectId)) !== undefined
  );
}

// ─── The wire contract ───────────────────────────────────────────────────────

/** `dq_assessment` as the API returns it (DM-27 field names, snake_case). */
export interface DqAssessmentDto {
  id: string;
  object_type: string;
  object_id: string;
  reliability_score: number | null;
  temporal_score: number | null;
  geographical_score: number | null;
  technology_score: number | null;
  completeness_score: number | null;
  coverage_score: number | null;
  quality_tier: string | null;
  estimate_uncertainty: number | null;
  quality_comment: string | null;
  is_overridden: boolean;
  override_reason: string | null;
  assessed_by: string | null;
  assessed_at: string | null;
}

/** Row → DTO. Every column of DM-27 is public; `company_id` is the session. */
export function serialiseAssessment(row: DqAssessmentRow): DqAssessmentDto {
  return {
    id: row.id,
    object_type: row.objectType,
    object_id: row.objectId,
    reliability_score: row.reliabilityScore,
    temporal_score: row.temporalScore,
    geographical_score: row.geographicalScore,
    technology_score: row.technologyScore,
    completeness_score: num(row.completenessScore),
    coverage_score: num(row.coverageScore),
    quality_tier: row.qualityTier,
    estimate_uncertainty: num(row.estimateUncertainty),
    quality_comment: row.qualityComment,
    is_overridden: row.isOverridden,
    override_reason: row.overrideReason,
    assessed_by: row.assessedBy,
    assessed_at: row.assessedAt ? row.assessedAt.toISOString() : null,
  };
}

/**
 * The columns a PUT may set. Every score is OPTIONAL — an absent key leaves the
 * column alone, `null`/`""` clears it — while `is_overridden` is MANDATORY.
 *
 * WHY THAT ONE FIELD IS MANDATORY. It is the field the `data.review` guard reads
 * (DQ-2), and a body that omits it would leave the request's MEANING implicit:
 * "edit the scores of an assessment that happens to be overridden" and "keep it
 * overridden" would be the same bytes, so the guard would have to guess which
 * one the caller meant. Requiring it makes every PUT state the resulting state,
 * and the guard is then exact rather than inferred.
 */
export interface DqValues {
  readonly reliabilityScore?: number | null;
  readonly temporalScore?: number | null;
  readonly geographicalScore?: number | null;
  readonly technologyScore?: number | null;
  readonly completenessScore?: string | null;
  readonly coverageScore?: string | null;
  readonly qualityTier?: QualityTier | null;
  readonly estimateUncertainty?: string | null;
  readonly qualityComment?: string | null;
  readonly isOverridden: boolean;
  readonly overrideReason: string | null;
}

/** One optional column of a PUT body: API name, Drizzle name, its parse step. */
type EditableField = readonly [
  api: string,
  column: string,
  parse: (raw: unknown) => unknown,
];

/**
 * The nine assessable columns of DM-27, with the bound each one's COLUMN can
 * hold — not a bound some rule owns (`@/server/api/parse` draws that line).
 *
 * The 1–5 and 0–100 ranges ARE the column: `dq_assessment` carries a CHECK per
 * score (§4.17), so a 6 is a value the table physically refuses. Parsing it out
 * here is what turns that refusal into a 422 naming the field instead of a
 * driver error; the CHECK stays the authority, and the acceptance test proves it
 * by writing 6 past this parser.
 */
const EDITABLE_FIELDS: readonly EditableField[] = [
  ["reliability_score", "reliabilityScore", (raw) => integerOrNull(raw, 1, 5)],
  ["temporal_score", "temporalScore", (raw) => integerOrNull(raw, 1, 5)],
  [
    "geographical_score",
    "geographicalScore",
    (raw) => integerOrNull(raw, 1, 5),
  ],
  ["technology_score", "technologyScore", (raw) => integerOrNull(raw, 1, 5)],
  [
    "completeness_score",
    "completenessScore",
    (raw) => decimalOrNull(raw, 0, 100),
  ],
  ["coverage_score", "coverageScore", (raw) => decimalOrNull(raw, 0, 100)],
  ["quality_tier", "qualityTier", (raw) => oneOfOrNull(raw, isQualityTier)],
  [
    "estimate_uncertainty",
    "estimateUncertainty",
    (raw) => decimalOrNull(raw, 0, 100),
  ],
  ["quality_comment", "qualityComment", textOrNull],
];

/**
 * Parse a PUT body (DQ-2), or name the field that was rejected.
 *
 * `override_reason` IS PARSED BUT NOT JUDGED HERE: an override with no reason is
 * VAL-039's business, and it is a blocking RULE precisely so the client sees a
 * rule code it can render beside the field rather than a bare `{field}` (the
 * VAL-006 lesson, `@/server/api/parse`). What this function does do is drop a
 * reason handed in WITHOUT an override: an explanation for something that is not
 * happening is a dangling sentence in an audit trail.
 */
export function parseAssessment(body: unknown): ParseResult<DqValues> {
  const raw = (body ?? {}) as Record<string, unknown>;

  const values: Record<string, unknown> = {};
  for (const [api, column, parse] of EDITABLE_FIELDS) {
    if (raw[api] === undefined) continue;
    const parsed = parse(raw[api]);
    if (parsed === undefined) return { ok: false, field: api };
    values[column] = parsed;
  }

  const isOverridden = booleanValue(raw.is_overridden);
  if (isOverridden === undefined) return { ok: false, field: "is_overridden" };

  // Absent means "no reason given", NOT a malformed field: an override with no
  // reason has to reach VAL-039 and be refused with a rule code the UI can
  // render, rather than being turned back here as a bad body (the VAL-006
  // lesson). Only a value of the wrong TYPE is a field refusal.
  const overrideReason =
    raw.override_reason === undefined ? null : textOrNull(raw.override_reason);
  if (overrideReason === undefined) {
    return { ok: false, field: "override_reason" };
  }

  return {
    ok: true,
    // The cast covers the loop above, which collects by NAME: the names come
    // from `EDITABLE_FIELDS`, whose columns are exactly the optional members of
    // `DqValues`, and the two mandatory members are supplied here by hand.
    values: {
      ...(values as Omit<DqValues, "isOverridden" | "overrideReason">),
      isOverridden,
      overrideReason: isOverridden ? overrideReason : null,
    },
  };
}

/**
 * Does this write need `data.review` (DQ-2)?
 *
 * BOTH DIRECTIONS COUNT, and the second is the one worth stating: SETTING
 * `is_overridden` is obviously a review act, but CLEARING it is too — it discards
 * a judgement a reviewer recorded, and letting `data.write` alone do that would
 * make the override erasable by whoever the reviewer was overriding. So the
 * capability is required whenever the assessment is overridden BEFORE or AFTER
 * the write, and a contributor editing an ordinary assessment needs nothing
 * extra.
 */
export function needsReviewCapability(
  current: DqAssessmentRow | undefined,
  values: DqValues,
): boolean {
  return values.isOverridden || current?.isOverridden === true;
}

// ─── The write (DQ-2) ────────────────────────────────────────────────────────

/** Outcome of a PUT; each refusal is one HTTP answer at the route. */
export type DqWriteResult =
  | { ok: true; row: DqAssessmentRow; warnings: RuleRef[] }
  /** No such object FOR THIS COMPANY (API-1) — a foreign id reads as absent. */
  | { ok: false; error: "NOT_FOUND" }
  /** Blocking rules refused it — VAL-039 and VAL-010 (API-1 `{rules}`). */
  | { ok: false; error: "RULES"; rules: RuleRef[] };

/**
 * Write an assessment (DQ-2) — an UPSERT on the DM-27 unique key.
 *
 * WHY UPSERT AND NOT "UPDATE THE ROW THE ROW SERVICE MADE". Four of the seven
 * object types get an assessment automatically (DQ-1); the other three —
 * `legal_entity`, `facility`, `emission_factor` — are not written by the row
 * service at all, so for them the first PUT is the create. One statement covers
 * both, and `ON CONFLICT` covers the third case too: two PUTs racing on the same
 * object must not turn a legitimate write into a driver error on the UNIQUE.
 *
 * ONLY THE COLUMNS THE BODY NAMED ARE TOUCHED (see {@link DqValues}), which is
 * what makes the editor of T4.5 able to save the pedigree scores without
 * re-sending a `quality_comment` it never showed.
 *
 * VAL-039 IS NOT PRE-CHECKED HERE. The row is written inside `writeValidated`,
 * the `record` rules judge it, and a blocking failure rolls the whole
 * transaction back (VR-3) — so an override with no reason leaves NO row and NO
 * result behind, and the refusal carries the rule code. A hand-written guard
 * would be the second implementation of a rule that already exists, i.e. the
 * exact drift R-12 exists to prevent.
 */
export async function putAssessment(
  db: DbClient,
  ctx: { companyId: string; userId: string },
  objectType: ObjectType,
  objectId: string,
  values: DqValues,
): Promise<DqWriteResult> {
  const target = await resolveTarget(db, ctx.companyId, objectType, objectId);
  if (!target) return { ok: false, error: "NOT_FOUND" };

  const written = await writeValidated(
    db,
    { companyId: ctx.companyId, scope: "record" },
    async (tx) => {
      // LC-8(2) / §5.3 — the freeze covers assessments. Inside the transaction,
      // so the refusal and its rolled-back row travel together (VR-3).
      if (await anyTargetLocked(tx, ctx.companyId, [target])) {
        refuseValidation([ruleRef("VAL-010")]);
      }

      const assessed = { assessedBy: ctx.userId, assessedAt: new Date() };
      const [row] = await tx
        .insert(dqAssessment)
        .values({
          id: randomUUID(),
          companyId: ctx.companyId,
          objectType,
          objectId,
          ...values,
          ...assessed,
        })
        .onConflictDoUpdate({
          target: [
            dqAssessment.companyId,
            dqAssessment.objectType,
            dqAssessment.objectId,
          ],
          set: { ...values, ...assessed },
        })
        .returning();
      return row;
    },
  );

  if (!written.ok) {
    // `NOT_FOUND` cannot come out of the callback — the upsert always returns a
    // row — but `writeValidated` types it, so it is answered rather than cast
    // away.
    return written.error === "VALIDATION"
      ? { ok: false, error: "RULES", rules: written.rules }
      : { ok: false, error: "NOT_FOUND" };
  }
  return { ok: true, row: written.row, warnings: written.warnings };
}

// ─── The carry hook (DQ-1, DQ-5, LC-3…LC-6, LC-9) ────────────────────────────

/** The assessable columns of one assessment, as a successor inherits them. */
function copyOf(source: DqAssessmentRow) {
  return {
    reliabilityScore: source.reliabilityScore,
    temporalScore: source.temporalScore,
    geographicalScore: source.geographicalScore,
    technologyScore: source.technologyScore,
    completenessScore: source.completenessScore,
    coverageScore: source.coverageScore,
    qualityTier: source.qualityTier,
    estimateUncertainty: source.estimateUncertainty,
    qualityComment: source.qualityComment,
    // THE OVERRIDE TRAVELS WITH THE JUDGEMENT IT DESCRIBES, both fields
    // together. An override says "these numbers are what a reviewer decided,
    // not what the rules computed", and the two ways of not copying it are both
    // worse than copying it: dropping the FLAG while keeping the scores would
    // present hand-set numbers as computed ones — a lie in the audit trail —
    // and dropping both would let an editor erase a reviewer's judgement by
    // correcting a typo somewhere else on the row. Carrying the pair keeps
    // VAL-039 satisfied by construction (a reason came with the flag), and a
    // reviewer who no longer stands behind it clears it on the new version,
    // which is an act with an actor and a timestamp.
    isOverridden: source.isOverridden,
    overrideReason: source.overrideReason,
    // WHO assessed it, copied rather than restamped with the editor — the same
    // choice `carryEvidenceLinks` makes about `created_by`, for the same reason:
    // crediting the person who fixed a note with a quality judgement they never
    // made would be a small lie. WHEN the copy came into being is `assessed_at`,
    // which is fresh (the column defaults to `now()`).
    assessedBy: source.assessedBy,
  };
}

/** The rule-driven starting point of a row that has no predecessor (DQ-1). */
async function prefillFor(ctx: VersionCarryContext) {
  const t = INPUT_TABLES[ctx.table];
  const [row] = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.id, ctx.toId), eq(t.companyId, ctx.companyId)))
    .limit(1);
  return {
    qualityTier: row ? initialQualityTier(ctx.table, row) : MANUAL_ENTRY_TIER,
    // NOBODY ASSESSED IT. `assessed_by` records the person who judged the
    // quality, and a rule-driven pre-fill is not a judgement — it is the
    // starting point VAL-038 immediately reports as unfilled. Stamping the row's
    // author here would make every created row look assessed.
    assessedBy: null,
  };
}

/**
 * `carry_dq_assessment` — the hook `VERSION_CARRY_HOOKS` (T3.1's declared seam)
 * runs inside the write transaction of every row version, INCLUDING the first.
 *
 * ITS CONTRACT IS ONE SENTENCE: the version that comes out of this write has
 * exactly one assessment. Two paths satisfy it and both are here on purpose:
 *   • NO PREDECESSOR (`reason: "create"`, `fromId: null`, LC-3) — DQ-1's
 *     rule-driven pre-fill. This is the auto-create, and it is here rather than
 *     in `createRow` so that "what does a new version get" has ONE answer in ONE
 *     place instead of two that can disagree.
 *   • A PREDECESSOR (`edit`/`approve`/`delete`/`seed`) — DQ-5's copy. It does
 *     not branch on the reason, exactly as `carryEvidenceLinks` does not:
 *     §4.17 and LC-4 say the assessment follows the row, LC-9 says the same for
 *     a seeded restatement, and a tombstone keeps its assessment because "how
 *     good was the figure we removed" is asked precisely when it is removed.
 *     A predecessor that somehow has NO assessment (a row written before this
 *     task, or straight into the table by a fixture) falls back to the pre-fill:
 *     the contract is about the successor, not about the predecessor's luck.
 *
 * `ON CONFLICT DO NOTHING` guards the UNIQUE `(company_id, object_type, object_id)`.
 * A second registration, a retry, or a future hook over the same key must not
 * turn a legitimate row write into a driver error — and the conflict can only
 * ever be "the assessment this hook was about to write is already there".
 */
export async function carryDqAssessment(
  ctx: VersionCarryContext,
): Promise<void> {
  const source =
    ctx.fromId === null
      ? undefined
      : await getAssessment(ctx.db, ctx.companyId, ctx.table, ctx.fromId);

  const values = source ? copyOf(source) : await prefillFor(ctx);

  await ctx.db
    .insert(dqAssessment)
    .values({
      id: randomUUID(),
      companyId: ctx.companyId,
      objectType: ctx.table,
      objectId: ctx.toId,
      ...values,
    })
    .onConflictDoNothing({
      target: [
        dqAssessment.companyId,
        dqAssessment.objectType,
        dqAssessment.objectId,
      ],
    });
}
