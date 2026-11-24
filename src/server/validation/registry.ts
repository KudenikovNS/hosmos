// =============================================================================
// EVALUATOR REGISTRY + the R-12 guard.
//
// THE PROBLEM THIS FILE EXISTS FOR. All 42 rules are declared in T2.1;
// their evaluators arrive across S2–S5. Without a mechanism, a rule with no
// evaluator is indistinguishable from a rule that passes: the run writes no
// failure, the UI shows a clean report, and "validated" means "nobody wrote the
// check". That is risk R-12, and it is the kind of gap that is only noticed by
// an auditor.
//
// THE MECHANISM. Every code must be in exactly one of two places:
//   • `EVALUATORS`          — it is implemented, and the run executes it;
//   • `PENDING_EVALUATORS`  — it is not, and the entry names the TASK that owns
//                             it, so the gap is a scheduled piece of work
//                             rather than an accident.
// `assertEvaluatorCoverage()` runs at import outside production and THROWS,
// naming the offending codes, when a rule is in neither (or in both, or when a
// manifest entry has no task, or names a code that is not in the inventory).
// Dev and every test run therefore fail loudly; production is not taken down by
// a bookkeeping error, but no build ever reaches production without a dev run
// and a test run in front of it.
//
// THE MANIFEST SHRINKS, NEVER GROWS. Each later task removes its own codes as
// it implements them (its acceptance criteria name the remaining ones), and
// T5.4 requires `PENDING_EVALUATORS` to be EMPTY — at which point Phase-1
// validation is complete by construction rather than by belief.
// =============================================================================
import {
  evaluateVal007,
  evaluateVal010,
  evaluateVal011,
  evaluateVal012,
  evaluateVal014,
  evaluateVal015,
  evaluateVal016,
  evaluateVal018,
  evaluateVal019,
  evaluateVal104,
} from "./evaluators/activities";
import {
  evaluateVal017,
  evaluateVal034,
  evaluateVal035,
  evaluateVal042,
} from "./evaluators/calculation";
import {
  evaluateVal020,
  evaluateVal021,
  evaluateVal023,
} from "./evaluators/energy";
import { evaluateVal038, evaluateVal039 } from "./evaluators/dq";
import {
  evaluateVal013,
  evaluateVal036,
  evaluateVal037,
} from "./evaluators/evidence";
import {
  evaluateVal031,
  evaluateVal032,
  evaluateVal033,
} from "./evaluators/factors";
import {
  evaluateVal001,
  evaluateVal002,
  evaluateVal003,
  evaluateVal004,
  evaluateVal005,
  evaluateVal006,
} from "./evaluators/org";
import {
  evaluateVal008,
  evaluateVal009,
  evaluateVal101,
  evaluateVal102,
  evaluateVal103,
  evaluateVal105,
  evaluateVal106,
} from "./evaluators/periods";
import { evaluateVal040, evaluateVal041 } from "./evaluators/revision";
import { evaluateVal022, evaluateVal024 } from "./evaluators/scope2";
import { VALIDATION_RULES, type ValidationRuleCode } from "./rules";
import type { RuleEvaluator } from "./types";

/**
 * The implemented rules, keyed by code. Each rule arrived with the task that
 * built its WRITE PATH (T2.1 … T5.4, then factor provenance), because only then
 * could it be both evaluated and enforced; `PENDING_EVALUATORS` is empty and
 * the guard refuses a rule that has neither an evaluator nor a named owner.
 *
 * See docs/decisions/validation-rules-by-task.md for the full account.
 */
export const EVALUATORS: Readonly<
  Partial<Record<ValidationRuleCode, RuleEvaluator>>
> = {
  "VAL-001": evaluateVal001,
  "VAL-002": evaluateVal002,
  "VAL-003": evaluateVal003,
  "VAL-004": evaluateVal004,
  "VAL-005": evaluateVal005,
  "VAL-006": evaluateVal006,
  "VAL-008": evaluateVal008,
  "VAL-009": evaluateVal009,
  "VAL-101": evaluateVal101,
  "VAL-102": evaluateVal102,
  "VAL-103": evaluateVal103,
  "VAL-105": evaluateVal105,
  "VAL-106": evaluateVal106,
  "VAL-031": evaluateVal031,
  "VAL-032": evaluateVal032,
  "VAL-033": evaluateVal033,
  "VAL-007": evaluateVal007,
  "VAL-010": evaluateVal010,
  "VAL-011": evaluateVal011,
  "VAL-012": evaluateVal012,
  "VAL-014": evaluateVal014,
  "VAL-015": evaluateVal015,
  "VAL-016": evaluateVal016,
  "VAL-018": evaluateVal018,
  "VAL-019": evaluateVal019,
  "VAL-104": evaluateVal104,
  "VAL-020": evaluateVal020,
  "VAL-021": evaluateVal021,
  "VAL-023": evaluateVal023,
  "VAL-013": evaluateVal013,
  "VAL-037": evaluateVal037,
  "VAL-038": evaluateVal038,
  "VAL-039": evaluateVal039,
  "VAL-036": evaluateVal036,
  "VAL-040": evaluateVal040,
  "VAL-041": evaluateVal041,
  "VAL-022": evaluateVal022,
  "VAL-024": evaluateVal024,
  "VAL-017": evaluateVal017,
  "VAL-034": evaluateVal034,
  "VAL-035": evaluateVal035,
  "VAL-107": evaluateVal042,
};

/** A scheduled gap: which task brings the evaluator, and what it needs first. */
export interface PendingEvaluator {
  /** Owning task id from DATA-MODEL-PHASE1-PLAN §1 (e.g. `"T3.1"`). Never empty. */
  readonly task: string;
  /** Why it cannot be written yet — the data or route it waits on. */
  readonly note: string;
}

/**
 * The codes whose evaluator is still to come, each against its owning task.
 *
 * See docs/decisions/server-validation-registry-L147.md for the full account.
 */
export const PENDING_EVALUATORS: Readonly<
  Partial<Record<ValidationRuleCode, PendingEvaluator>>
> = {};

/** How a code fails the coverage check — used to name the problem precisely. */
export interface CoverageProblem {
  readonly code: string;
  readonly reason:
    | "no evaluator and no manifest entry"
    | "both an evaluator and a manifest entry"
    | "manifest entry with an empty task reference"
    | "manifest entry for a code that is not in VALIDATION_RULES";
}

/**
 * The coverage problems of one (rules, evaluators, manifest) triple — PURE, so
 * the test can prove the guard reacts to a synthetic gap without mutating the
 * real registry.
 */
export function coverageProblems(
  rules: readonly { code: string }[] = VALIDATION_RULES,
  evaluators: Readonly<Record<string, unknown>> = EVALUATORS,
  pending: Readonly<
    Record<string, { task?: string } | undefined>
  > = PENDING_EVALUATORS,
): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  const known = new Set(rules.map((rule) => rule.code));

  for (const { code } of rules) {
    const hasEvaluator = evaluators[code] !== undefined;
    const entry = pending[code];
    if (hasEvaluator && entry) {
      problems.push({ code, reason: "both an evaluator and a manifest entry" });
      continue;
    }
    if (!hasEvaluator && !entry) {
      problems.push({ code, reason: "no evaluator and no manifest entry" });
      continue;
    }
    if (entry && !entry.task?.trim()) {
      problems.push({
        code,
        reason: "manifest entry with an empty task reference",
      });
    }
  }

  for (const code of Object.keys(pending)) {
    if (!known.has(code)) {
      problems.push({
        code,
        reason: "manifest entry for a code that is not in VALIDATION_RULES",
      });
    }
  }

  return problems;
}

/**
 * Throw when any Phase-1 rule could pass silently (R-12). The message names
 * every offending code and why, because "registry incomplete" would send the
 * next reader looking through 42 rules by hand.
 */
export function assertEvaluatorCoverage(
  rules: readonly { code: string }[] = VALIDATION_RULES,
  evaluators: Readonly<Record<string, unknown>> = EVALUATORS,
  pending: Readonly<
    Record<string, { task?: string } | undefined>
  > = PENDING_EVALUATORS,
): void {
  const problems = coverageProblems(rules, evaluators, pending);
  if (problems.length === 0) return;
  const detail = problems
    .map((problem) => `  ${problem.code}: ${problem.reason}`)
    .join("\n");
  throw new Error(
    `Validation registry is incomplete (R-12) — ${problems.length} problem(s):\n${detail}\n` +
      "Every VAL-* code needs either an evaluator in EVALUATORS or an entry in " +
      "PENDING_EVALUATORS naming the task that will write it. A rule with neither " +
      "passes silently, which is worse than a rule that fails.",
  );
}

// The startup check (R-12). Skipped in production so a bookkeeping mistake can
// never take a running deployment down — it is caught in dev and in `npm test`,
// both of which stand in front of every deploy.
if (process.env.NODE_ENV !== "production") {
  assertEvaluatorCoverage();
}
