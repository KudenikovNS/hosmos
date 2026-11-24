// =============================================================================
// Shared types of the validation engine — a LEAF module (it imports only the
// rule inventory, and only as types).
//
// It exists to keep `registry.ts` (which imports the evaluator modules) and the
// evaluator modules (which need the context/finding shapes) out of an import
// cycle. `columns.ts` documents what such a cycle costs in this codebase; this
// is the cheap way not to find out again.
// =============================================================================
import type { DbClient } from "@/server/db/client";

import type { ValidationScope } from "./rules";

/**
 * The pooled singleton `db` or a transaction handle — as everywhere else.
 *
 * The engine keeps its own NAME for the handle (an evaluator reads `db`, it does
 * not care that services share the type) but no longer its own DEFINITION: T2.3
 * moved the Drizzle generics to `@/server/db/client`, where the three service
 * modules take them from too. Still a type-only import, so this stays a leaf.
 */
export type ValidationDb = DbClient;

/**
 * What one run evaluates against.
 *
 * `targetId` is read PER SCOPE, and an evaluator that does not recognise the
 * target simply finds nothing:
 *   • `reference_org` — a `legal_entity` / `facility` / `emission_factor` id;
 *   • `period`        — a `reporting_period` id;
 *   • `revision`      — a `report_revision` id;
 *   • `record`        — an input-row id.
 *
 * `companyId` comes from the session (PATTERN 3) and is the tenant pin of every
 * query an evaluator makes: a foreign `targetId` therefore matches no row and
 * produces no findings — never another tenant's data, never an error that
 * confirms the id exists.
 */
export interface ValidationTarget {
  readonly companyId: string;
  readonly scope: ValidationScope;
  readonly targetId: string;
  /**
   * The API field names THIS WRITE is changing — set only when the run is a
   * write gate (`writeValidated`), absent for a plain re-evaluation.
   *
   * WHY THE ENGINE HAS TO KNOW. Almost every rule judges a STATE and needs
   * nothing else: the row is written tentatively, the rule looks at it, a
   * blocking failure rolls the transaction back (VR-3). VAL-106 (DM-7a) is not
   * of that kind — it forbids a CHANGE to six particular fields once the
   * period's current revision has left draft, and the post-state of a period
   * whose `start_date` was just edited is indistinguishable from one that was
   * always like that. Without the list, the rule could only be enforced by a
   * hand-written guard in the service, i.e. exactly the "silently passing rule"
   * R-12 exists to prevent.
   *
   * It is a set of names, not values: a rule may only decide WHETHER a field
   * was touched, never re-judge what it was set to (that is the state's job,
   * and the state is already in the transaction).
   */
  readonly mutatedFields?: readonly string[];
}

/** Everything an evaluator gets: the target plus a database handle. */
export interface EvaluatorContext extends ValidationTarget {
  readonly db: ValidationDb;
}

/**
 * One outcome of one rule against one object.
 *
 * An evaluator returns a finding per object it examined — INCLUDING passes, so
 * a previously failing row's result is overwritten with `passed: true` on the
 * next run instead of lingering. Returning `[]` means "this rule has nothing to
 * say about this target" (wrong object type, or a target of another tenant);
 * nothing is then written and any earlier row is left alone.
 *
 * The three target columns are the ones the DM-28 unique key COALESCEs, so they
 * decide which row an upsert lands on: `objectType`+`objectId` identify the
 * object, `revisionId` scopes the result to a revision when there is one.
 */
export interface RuleFinding {
  readonly passed: boolean;
  readonly objectType?: string | null;
  readonly objectId?: string | null;
  readonly revisionId?: string | null;
}

/** A rule's implementation: everything it has to say about one target. */
export type RuleEvaluator = (
  ctx: EvaluatorContext,
) => Promise<readonly RuleFinding[]>;
