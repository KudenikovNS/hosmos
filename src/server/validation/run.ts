// =============================================================================
// THE VALIDATION RUNNER (VR-1…VR-3, DM-28).
//
// `runValidation(db, {scope, targetId, companyId})` takes every rule of the
// requested scope that HAS an evaluator, runs it against the target, and
// upserts one `validation_result` row per finding. It returns what it wrote, so
// a caller (a route, or a submit/approve/lock gate in S2–S5) can refuse on a
// blocking failure without a second query.
//
// TRIGGERS (VR-2). Saving a row (its own record-scope rules), attempting submit
// (record + revision + reference_org), attempting approve/lock (revision +
// period) and the explicit `POST /api/validation/run`. The front end may
// duplicate the simple checks for a snappy form, but the SERVER is the
// authority — this function is where "valid" is decided.
//
// UPSERT, NOT APPEND (§4.18). `validation_result` holds the LATEST result per
// (company, rule, target), so a re-run overwrites rather than accumulating: a
// fixed row flips to `passed: true` in place and the boundary/period screens can
// read the table directly. The conflict target is the expression index
// `validation_result_target_key`, whose COALESCE placeholders ('--' and the nil
// UUID) are what make NULL targets comparable at all — SQL's `NULL <> NULL`
// would otherwise let the same rule write unlimited duplicate rows for a target
// with no object or revision.
//
// The insert is written as raw SQL on purpose: the conflict target is an
// EXPRESSION index, and repeating the expressions verbatim here keeps the pair
// with `drizzle/0004_data_model.sql` legible (R-1). Getting one COALESCE wrong
// does not fail loudly — it silently creates a second row per target — so the
// integration test asserts the row COUNT after a re-run, not just the values.
// =============================================================================
import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import { validationResult } from "@/server/db/schema";

import { EVALUATORS } from "./registry";
import {
  rulesForScope,
  type Phase1Rule,
  type ValidationRule,
  type ValidationScope,
} from "./rules";
import type { RuleFinding, ValidationDb, ValidationTarget } from "./types";

/** The nil UUID — the COALESCE placeholder of the DM-28 unique key. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** One written result: the rule's metadata plus the outcome and its target. */
export interface ValidationResultRecord {
  readonly ruleCode: string;
  readonly scope: ValidationRule["scope"];
  readonly severity: ValidationRule["severity"];
  readonly blocking: boolean;
  readonly passed: boolean;
  /** Canonical RU (О-12) — the UI translates by `ruleCode` instead. */
  readonly message: string;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly revisionId: string | null;
}

/** Build the persisted record from a rule and one of its findings. */
function toRecord(
  rule: Phase1Rule,
  finding: RuleFinding,
): ValidationResultRecord {
  return {
    ruleCode: rule.code,
    scope: rule.scope,
    severity: rule.severity,
    blocking: rule.blocking,
    passed: finding.passed,
    message: rule.message,
    objectType: finding.objectType ?? null,
    objectId: finding.objectId ?? null,
    revisionId: finding.revisionId ?? null,
  };
}

/**
 * Upsert results on the DM-28 unique key. Exported because the gates of S2–S5
 * write results they computed themselves (a plan refusal, for instance: VAL-105
 * is enforced by the plan gate but still wants a row for the UI), and they must
 * land on the same key rather than inventing a second write path.
 */
export async function upsertValidationResults(
  db: ValidationDb,
  companyId: string,
  records: readonly ValidationResultRecord[],
): Promise<void> {
  for (const record of records) {
    await db.execute(sql`
      INSERT INTO validation_result
        (id, company_id, rule_code, scope, object_type, object_id, revision_id,
         passed, severity, blocking, message, evaluated_at)
      VALUES
        (${randomUUID()}, ${companyId}, ${record.ruleCode}, ${record.scope},
         ${record.objectType}, ${record.objectId}, ${record.revisionId},
         ${record.passed}, ${record.severity}, ${record.blocking},
         ${record.message}, now())
      ON CONFLICT (
        company_id,
        rule_code,
        COALESCE(object_type, '--'),
        COALESCE(object_id,   ${NIL_UUID}::uuid),
        COALESCE(revision_id, ${NIL_UUID}::uuid)
      ) DO UPDATE SET
        scope        = EXCLUDED.scope,
        passed       = EXCLUDED.passed,
        severity     = EXCLUDED.severity,
        blocking     = EXCLUDED.blocking,
        message      = EXCLUDED.message,
        evaluated_at = now()
    `);
  }
}

/**
 * Run every implemented rule of `scope` against `targetId` and persist the
 * results. Returns the records written, in rule order.
 *
 * Rules of the scope that are still in `PENDING_EVALUATORS` are skipped —
 * loudly, in the sense that the registry guard already refuses to let a code be
 * skipped without a manifest entry naming its task (R-12).
 *
 * An evaluator that returns `[]` (the target is not its object type, or belongs
 * to another tenant) writes nothing: silence means "not applicable", never
 * "passed".
 */
export async function runValidation(
  db: ValidationDb,
  target: ValidationTarget,
): Promise<ValidationResultRecord[]> {
  const ctx = { db, ...target };
  const records: ValidationResultRecord[] = [];

  for (const rule of rulesForScope(target.scope)) {
    const evaluate = EVALUATORS[rule.code];
    if (!evaluate) continue;
    for (const finding of await evaluate(ctx)) {
      records.push(toRecord(rule, finding));
    }
  }

  await upsertValidationResults(db, target.companyId, records);
  return records;
}

/** The blocking failures among `records` — non-empty means "refuse" (VR-3). */
export function blockingFailures(
  records: readonly ValidationResultRecord[],
): ValidationResultRecord[] {
  return records.filter((record) => record.blocking && !record.passed);
}

/** A stored result as the read API returns it (newest evaluation first). */
export interface StoredValidationResult extends ValidationResultRecord {
  readonly id: string;
  readonly evaluatedAt: Date | null;
}

/** One `validation_result` row → the typed record the API and the gates read. */
function toStored(
  row: typeof validationResult.$inferSelect,
): StoredValidationResult {
  return {
    id: row.id,
    ruleCode: row.ruleCode,
    scope: row.scope as ValidationRule["scope"],
    severity: row.severity as ValidationRule["severity"],
    blocking: row.blocking,
    passed: row.passed,
    message: row.message,
    objectType: row.objectType,
    objectId: row.objectId,
    revisionId: row.revisionId,
    evaluatedAt: row.evaluatedAt,
  };
}

/**
 * The BLOCKING failures stored for one company at one scope, whatever object
 * they are about — the `reference_org` half of the submit gate (§5.1, T4.4).
 *
 * WHY THAT HALF IS READ RATHER THAN RE-RUN, while the submit gate re-evaluates
 * every row of the revision. The subjects of `reference_org` are the registries:
 * legal entities, facilities and the EMISSION FACTORS of the pinned set — and
 * that last one is a global catalogue of thousands of rows (`factor_set` has no
 * `company_id`). Re-running the scope would mean walking it on every submit to
 * re-derive verdicts the write gate already refused to store: `writeValidated`
 * rolls a registry write back on a blocking failure, so the only way one gets
 * into this table is `POST /api/validation/run` — the explicit "re-check my
 * data" the product offers. Reading what that wrote is exactly right; scanning
 * the catalogue to find out what it would say is not.
 */
export async function storedBlockingFailures(
  db: ValidationDb,
  companyId: string,
  scope: ValidationScope,
): Promise<StoredValidationResult[]> {
  const rows = await db
    .select()
    .from(validationResult)
    .where(
      and(
        eq(validationResult.companyId, companyId),
        eq(validationResult.scope, scope),
        eq(validationResult.blocking, true),
        eq(validationResult.passed, false),
      ),
    )
    .orderBy(validationResult.ruleCode);

  return rows.map(toStored);
}

/**
 * Every stored result for one revision, newest first. Pinned to `companyId`, so
 * a foreign `revisionId` reads as an empty list rather than another tenant's
 * findings.
 */
export async function listValidationResults(
  db: ValidationDb,
  companyId: string,
  revisionId: string,
): Promise<StoredValidationResult[]> {
  const rows = await db
    .select()
    .from(validationResult)
    .where(
      and(
        eq(validationResult.companyId, companyId),
        eq(validationResult.revisionId, revisionId),
      ),
    )
    .orderBy(desc(validationResult.evaluatedAt), validationResult.ruleCode);

  return rows.map(toStored);
}
