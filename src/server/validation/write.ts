// =============================================================================
// WRITE, VALIDATE, ROLL BACK (VR-3) — the one write mechanism of the Phase-1
// registries, and the refusal shapes that travel out of it.
//
// T2.2 built this inside `@/server/org/legal-entities` and said in its own
// header that the rest of S2/S3 would copy it. T2.3 is the third caller
// (facilities, assets), so it MOVED instead: three copies of a transaction that
// silently must roll back is exactly the code that drifts, and the drift would
// be invisible — a copy that forgot to re-throw would leave a row behind and
// still answer 422.
//
// WHAT IT GUARANTEES.
//   1. The row is written INSIDE a transaction, then the rules of `scope` are
//      run against it, and any BLOCKING failure aborts the transaction. So a
//      rule judges the TENTATIVE state (which is what lets VAL-003 look for a
//      cycle that momentarily exists, and VAL-005 look at the link as written).
//   2. A refused write leaves NEITHER the row NOR a `validation_result` row:
//      results only ever describe a state that exists.
//   3. The refusal comes back as DATA (`WriteResult`), never as a thrown 500 —
//      `WriteRefused` is caught here, and that is the whole of the mechanism.
//
// HOW A CALLER REFUSES BEFORE THE WRITE. References that are FOREIGN KEYS must
// be resolved BEFORE the insert, because an FK violation fires as a driver error
// (HTTP 500) before any rule could speak. Such a check throws `refuseValidation`
// from inside the `write` callback — it is already in the transaction, so the
// throw both refuses and unwinds.
// =============================================================================
import type { DbClient } from "@/server/db/client";

import { findRule, type ValidationScope } from "./rules";
import {
  blockingFailures,
  runValidation,
  type ValidationResultRecord,
} from "./run";

/** One rule in a refusal payload (API-1): code, canonical message, scope. */
export interface RuleRef {
  code: string;
  message: string;
  scope: string;
}

/** Outcome of a create/update: the row, or why it was refused. */
export type WriteResult<Row> =
  /**
   * The row, plus the NON-blocking failures the same run produced.
   *
   * `warnings` is on the SUCCESS branch on purpose: a warning is by definition a
   * rule that did not stop the write, so it can only ever travel with a row that
   * exists. T4.1 is the first caller that needs it — EV-1 requires a duplicate
   * upload to be ACCEPTED and to carry Warning VAL-013 back to the client, and
   * without this field a document service would have to open its own transaction
   * and re-implement the write/validate/roll-back mechanism this module exists to
   * keep single (see the header). Callers that only care whether the write
   * happened ignore the field; the array is empty when nothing had anything to say.
   */
  | { ok: true; row: Row; warnings: RuleRef[] }
  /** No such row FOR THIS COMPANY (the id may well exist for another one). */
  | { ok: false; error: "NOT_FOUND" }
  /** Blocking rules refused the write; `rules` is empty for a bad reference. */
  | { ok: false; error: "VALIDATION"; rules: RuleRef[] };

/**
 * Outcome of a registry delete: done, absent, or refused with the counts that
 * refused it.
 *
 * It lives beside `WriteResult` because it is the same idea in the other
 * direction — DM-4 and К-7 both put RESTRICT semantics in the app layer rather
 * than in DDL, and the counts travel with the refusal so the UI can say WHAT is
 * in the way instead of a bare "cannot delete". `Blockers` is per-table: only
 * the service knows what can point at its rows.
 */
export type DeleteResult<Blockers extends Record<string, number>> =
  | { ok: true }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "HAS_DATA"; blockers: Blockers };

/** Thrown inside the write transaction to roll it back with a reason. */
class WriteRefused extends Error {
  constructor(readonly result: Extract<WriteResult<never>, { ok: false }>) {
    super(`write refused: ${result.error}`);
    this.name = "WriteRefused";
  }
}

/**
 * Refuse the write in progress as `VALIDATION`, rolling the transaction back.
 *
 * `rules` is empty when the refusal has no rule of record — a reference to
 * another company's object, which API-1 answers as "does not exist for this
 * company". It carries a code when the refused value IS some rule's subject, so
 * that the client sees the same code whether the value was caught here (before
 * the FK could fire) or by the run afterwards.
 */
export function refuseValidation(rules: RuleRef[] = []): never {
  throw new WriteRefused({ ok: false, error: "VALIDATION", rules });
}

/**
 * The API-1 `RuleRef` of a DECLARED rule, read from the inventory.
 *
 * A pre-write refusal (see the header) has to name the same code, message and
 * scope the runner would have written afterwards, or the client sees two
 * different errors for one problem depending on which layer caught it. Copying
 * the message string into the service — as T2.2 did for VAL-002, the first case
 * of this — makes that a matter of luck the moment the wording changes.
 *
 * An unknown code throws: it can only be a typo, and a typo that produced a
 * silent bare refusal would cost an afternoon.
 */
export function ruleRef(code: string): RuleRef {
  const rule = findRule(code);
  if (!rule) throw new Error(`Unknown validation rule code: ${code}`);
  return { code: rule.code, message: rule.message, scope: rule.scope };
}

/** Blocking failures → the API-1 `{rules: [...]}` payload. */
function toRuleRefs(records: readonly ValidationResultRecord[]): RuleRef[] {
  return records.map((record) => ({
    code: record.ruleCode,
    message: record.message,
    scope: record.scope,
  }));
}

/**
 * Write inside a transaction, validate the written row, roll back on a blocking
 * failure (VR-3). THE write path of every S2/S3 registry service.
 *
 * `write` returns the row it wrote, or `undefined` when it matched nothing —
 * an UPDATE against an id of another tenant, which is `NOT_FOUND` here and a
 * `VALIDATION` at the route (API-1).
 */
export async function writeValidated<Row extends { id: string }>(
  db: DbClient,
  target: {
    companyId: string;
    scope: ValidationScope;
    /**
     * The API field names this write changes (T2.4). Only a rule about MUTATION
     * rather than about state reads it — today VAL-106 (DM-7a), tomorrow T2.5's
     * boundary PUT, which declares the `period_scope` sentinel. Leave it unset
     * for a create: creating a period is not editing a frozen one.
     */
    mutatedFields?: readonly string[];
  },
  write: (tx: DbClient) => Promise<Row | undefined>,
): Promise<WriteResult<Row>> {
  try {
    return await db.transaction(async (tx): Promise<WriteResult<Row>> => {
      const row = await write(tx);
      if (!row) throw new WriteRefused({ ok: false, error: "NOT_FOUND" });

      const results = await runValidation(tx, {
        companyId: target.companyId,
        scope: target.scope,
        targetId: row.id,
        mutatedFields: target.mutatedFields,
      });
      const blocking = blockingFailures(results);
      if (blocking.length > 0) {
        throw new WriteRefused({
          ok: false,
          error: "VALIDATION",
          rules: toRuleRefs(blocking),
        });
      }
      // Everything that failed WITHOUT blocking. The results are already
      // persisted (`runValidation` upserts them), so this is a convenience for
      // the response body, never a second source of truth.
      return {
        ok: true,
        row,
        warnings: toRuleRefs(results.filter((r) => !r.passed && !r.blocking)),
      };
    });
  } catch (error) {
    // The refusal rolled the transaction back — that is the whole mechanism, so
    // it is caught here and returned as data, never re-thrown as a 500.
    if (error instanceof WriteRefused) return error.result;
    throw error;
  }
}
