// =============================================================================
// DATA-QUALITY EVALUATORS (spec §6.2, §7) — the two rules whose SUBJECT is a
// `dq_assessment` (`appliesTo: ["dq_assessment"]`).
//
// Both arrive with T4.3 for the reason every evaluator in this directory
// arrives with its write path: until `dq_assessment` rows were created (DQ-1)
// and editable (`PUT /api/dq/…`, DQ-2), the rules could be evaluated but never
// triggered — and a rule that can only pass is worse than no rule (R-12).
//
// WHY THEY ANSWER TO TWO KINDS OF `targetId`. DM-28 keys a stored result on
// `(rule, object_type, object_id)` and a `record` run is aimed at ONE id, but the
// two things that trigger these rules are aimed at different ids: a PUT of an
// assessment validates the ASSESSMENT it just wrote, while every row write
// (`writeValidated` in `@/server/inventory/rows`) validates the ROW. If the
// evaluators only understood the first, VAL-038 would be silent on exactly the
// event that creates the unfilled assessment it exists to report — creating a
// row. So `assessmentOf` resolves either: an assessment BY its own id, or the
// assessment OF the object named by the id. The finding is filed under the
// assessment either way, so the two paths write the same row rather than two.
//
// THE SEVERITY SPLIT IS THE POINT OF THE PAIR (§6.2, DQ-2, DQ-3):
//   • VAL-038 is a WARNING and does not block. Management's decision (DQ-3):
//     demanding a full pedigree matrix before a first report may be submitted
//     would stop every real company on its first period, so the empty scores are
//     recorded, shown in the quality section and on the dashboard, and the
//     report goes out saying so. T4.4 builds the submit gates on top of exactly
//     this severity — a Warning is what keeps them honest.
//   • VAL-039 is a blocking ERROR. An override says "ignore what the rules
//     computed, a human decided otherwise", and an unexplained one is a number
//     with no provenance in a document an auditor reads. It refuses the write
//     (VR-3), so no unexplained override is ever stored.
//
// DQ-4 (AC-7) IS NOW HERE TOO, at the foot of the file — and it is still not a
// rule of its own: §6.2 puts it INSIDE VAL-041, which is `revision` scope and
// arrived with the approval gates of T4.4. What lives here is its QUERY
// (`evidenceHoles`), because the question it asks — "what does this row's
// assessment say" — is this file's question, and `./revision` should no more
// re-implement it than it should re-implement VAL-038's list of fields.
// =============================================================================
import { and, eq, isNull, notExists, or } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import { dqAssessment, evidenceLink } from "@/server/db/schema";
import { INPUT_TABLES, type InputTableName } from "@/server/inventory/tables";
import type { QualityTier } from "@/shared/enums";

import type { EvaluatorContext, RuleFinding } from "../types";

/** Is `type` one of the four input tables — the only targets with a revision? */
function isInputTable(type: string): type is InputTableName {
  return type in INPUT_TABLES;
}

/** The assessment a run is about, plus where to file findings about it. */
interface AssessmentSubject {
  readonly id: string;
  readonly row: typeof dqAssessment.$inferSelect;
  /** The revision of the assessed row, so the finding surfaces on its report. */
  readonly revisionId: string | null;
}

/**
 * The assessment `ctx.targetId` names — either directly (its own id) or
 * indirectly (the id of the object it assesses). `undefined` means this run has
 * no assessment in view, which is silence, never a pass (see `../types`).
 *
 * ONE QUERY, both ways: `id = $1 OR object_id = $1`. The tenant pin is on the
 * same predicate, so a foreign id resolves to nothing rather than to another
 * tenant's quality scores.
 *
 * The revision is looked up only when the assessed object is an input row; the
 * three organisational object types (`legal_entity`, `facility`,
 * `emission_factor`) belong to no revision, and a finding about one of them
 * carries no `revision_id` — exactly as VAL-002 and VAL-005 do.
 */
async function assessmentOf(
  ctx: EvaluatorContext,
): Promise<AssessmentSubject | undefined> {
  const [row] = await ctx.db
    .select()
    .from(dqAssessment)
    .where(
      and(
        eq(dqAssessment.companyId, ctx.companyId),
        or(
          eq(dqAssessment.id, ctx.targetId),
          eq(dqAssessment.objectId, ctx.targetId),
        ),
      ),
    )
    .limit(1);
  if (!row) return undefined;

  let revisionId: string | null = null;
  if (isInputTable(row.objectType)) {
    const t = INPUT_TABLES[row.objectType];
    const [assessed] = await ctx.db
      .select({ revisionId: t.revisionId })
      .from(t)
      .where(and(eq(t.id, row.objectId), eq(t.companyId, ctx.companyId)))
      .limit(1);
    revisionId = assessed?.revisionId ?? null;
  }

  return { id: row.id, row, revisionId };
}

/** One finding about one assessment, filed under it (DM-28's key). */
function finding(subject: AssessmentSubject, passed: boolean): RuleFinding[] {
  return [
    {
      passed,
      objectType: "dq_assessment",
      objectId: subject.id,
      revisionId: subject.revisionId,
    },
  ];
}

// ─── VAL-038 — are the mandatory DQ scores filled in? ────────────────────────

/**
 * WHAT "обязательные DQ-оценки" MEANS, as a LIST rather than as a condition
 * spread over an `if`.
 *
 * The four pedigree scores are the Weidema matrix (`reliability`, `temporal`,
 * `geographical`, `technology`, 1–5 each) — the part of DM-27 that is an
 * ASSESSMENT rather than a description, and the part a quality section of a VSME
 * report is built from. `quality_tier` joins them because it is the field DQ-4
 * reads at approval: an assessment with no tier cannot answer the question the
 * approval gate asks.
 *
 * WHAT IS DELIBERATELY ABSENT. `completeness_score`, `coverage_score` and
 * `estimate_uncertainty` are optional by DM-27 and conditional by meaning — an
 * uncertainty band on a figure that is not an estimate is noise — so requiring
 * them would put a permanent warning on well-assessed rows, and a warning that
 * is always on is a warning nobody reads. `quality_comment` is not here either:
 * it is required only in DQ-4's specific case (a row with no evidence), which
 * VAL-041 owns.
 */
const REQUIRED_DQ_FIELDS = [
  "reliabilityScore",
  "temporalScore",
  "geographicalScore",
  "technologyScore",
  "qualityTier",
] as const;

/**
 * VAL-038 — "заполнены обязательные DQ-оценки" (DQ-3). A WARNING.
 *
 * A FRESHLY CREATED ROW FAILS IT, and that is the design rather than a side
 * effect: DQ-1 pre-fills `quality_tier` from the method and leaves every score
 * NULL, so the row is born with an assessment that says "nobody has judged this
 * yet" — and this rule is what says so out loud. The tier being set does not
 * satisfy it; a tier the machine chose is not an assessment (see the list
 * above), so the finding stays failed until a person fills the four scores in.
 * Because it is non-blocking, none of that stops the write, the approval or the
 * submit — it travels as a warning and lands in the quality section.
 */
export async function evaluateVal038(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const subject = await assessmentOf(ctx);
  if (!subject) return [];

  const filled = REQUIRED_DQ_FIELDS.every(
    (field) => subject.row[field] !== null,
  );
  return finding(subject, filled);
}

// ─── VAL-039 — an override states why ────────────────────────────────────────

/**
 * VAL-039 — "причина ручного оверрайда DQ обязательна" (DQ-2, К-16). BLOCKING.
 *
 * `is_overridden = false` PASSES rather than being silent: the rule has looked
 * at a real assessment and found nothing wrong with it, and a pass is what lets
 * an earlier failure be overwritten by the next run instead of lingering as a
 * stale red mark (`../types`).
 *
 * A REASON OF WHITESPACE IS NO REASON. The column is `text NULL` and the wire
 * parser already trims blanks to NULL, so the `trim()` here is about the other
 * writers — a fixture, a future importer, a hand-run UPDATE — for which " " in
 * `override_reason` would otherwise satisfy an audit requirement with a space.
 */
export async function evaluateVal039(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const subject = await assessmentOf(ctx);
  if (!subject) return [];

  const explained = (subject.row.overrideReason ?? "").trim().length > 0;
  return finding(subject, !subject.row.isOverridden || explained);
}

// ─── DQ-4 (AC-7) — the query VAL-041 asks at approve ─────────────────────────

/**
 * The tiers DQ-4 accepts on a row that carries NO evidence at all.
 *
 * The acceptance criterion is "every report fact has evidence OR ASSUMPTION"
 * (AC-7), and these two tiers are how the model spells "assumption": `low_proxy`
 * says the figure stands on something adjacent, `estimate` says it was derived.
 * `high_primary` and `medium_calculated` both CLAIM a source — the first a
 * primary document, the second a calculation over supplied data — and a claim
 * with no document behind it is precisely the hole an auditor opens the report
 * looking for. Hence a LIST rather than a `!==` on the two that are refused: a
 * fifth tier would have to be classified here, deliberately, rather than
 * defaulting into whichever branch an inequality happened to put it in.
 */
const ASSUMPTION_TIERS: readonly QualityTier[] = ["low_proxy", "estimate"];

/** One row that DQ-4 refuses: no evidence, and no admissible assumption either. */
export interface EvidenceHole {
  readonly table: InputTableName;
  readonly rowId: string;
  /** What the assessment says instead — `null` when the row has no assessment. */
  readonly qualityTier: string | null;
  readonly hasComment: boolean;
}

/**
 * DQ-4 — the CURRENT rows of a revision that have no evidence link and no
 * admissible assumption behind them (AC-7). Exported for VAL-041 in
 * `./revision`, which is the rule §6.2 puts this check inside.
 *
 * THE TEST IS A PAIR, and both halves are load-bearing. A tier of `low_proxy` or
 * `estimate` with an EMPTY comment says "this is a guess" and stops there; the
 * report would print a number whose provenance is the word "estimate". The
 * comment is what a reader gets instead of the document — how the figure was
 * arrived at — so DQ-4 demands the tier AND the sentence, and this function
 * refuses a row that carries only one of them.
 *
 * A ROW WITH NO ASSESSMENT AT ALL IS A HOLE TOO, which is why the join is a LEFT
 * one. DQ-1 gives every row an assessment inside the write transaction, so this
 * can only be a row written before that guarantee existed or straight into the
 * table — and treating "no assessment" as satisfying an approval gate would let
 * exactly the rows nobody assessed through it.
 *
 * WHITESPACE IS NOT A COMMENT, for the reason VAL-039 gives about
 * `override_reason`: the wire parser trims blanks to NULL, but a fixture, an
 * importer or a hand-run UPDATE can put a space there, and a space must not
 * satisfy an audit requirement.
 *
 * Current versions only (`superseded_by_id IS NULL AND NOT is_deleted`): a
 * superseded version is history and a tombstone is a deletion — neither is a
 * fact the report states, so neither needs evidence for it.
 */
export async function evidenceHoles(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<EvidenceHole[]> {
  const holes: EvidenceHole[] = [];

  for (const [name, table] of Object.entries(INPUT_TABLES) as [
    InputTableName,
    (typeof INPUT_TABLES)[InputTableName],
  ][]) {
    const rows = await db
      .select({
        id: table.id,
        qualityTier: dqAssessment.qualityTier,
        qualityComment: dqAssessment.qualityComment,
      })
      .from(table)
      .leftJoin(
        dqAssessment,
        and(
          eq(dqAssessment.companyId, companyId),
          eq(dqAssessment.objectType, name),
          eq(dqAssessment.objectId, table.id),
        ),
      )
      .where(
        and(
          eq(table.companyId, companyId),
          eq(table.revisionId, revisionId),
          isNull(table.supersededById),
          eq(table.isDeleted, false),
          // No evidence ANYWHERE on this version (EV-2's M:N, DM-25).
          notExists(
            db
              .select({ one: evidenceLink.id })
              .from(evidenceLink)
              .where(
                and(
                  eq(evidenceLink.companyId, companyId),
                  eq(evidenceLink.linkedObjectType, name),
                  eq(evidenceLink.linkedObjectId, table.id),
                ),
              ),
          ),
        ),
      );

    for (const row of rows) {
      const tier = row.qualityTier;
      const hasComment = (row.qualityComment ?? "").trim().length > 0;
      const justified =
        tier !== null &&
        (ASSUMPTION_TIERS as readonly string[]).includes(tier) &&
        hasComment;
      if (!justified) {
        holes.push({
          table: name,
          rowId: row.id,
          qualityTier: tier,
          hasComment,
        });
      }
    }
  }

  return holes;
}
