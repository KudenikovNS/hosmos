// =============================================================================
// WHAT A BULK APPROVE ACTUALLY SAYS AFTERWARDS — one pure function, and the only
// place `/review` decides it (T4.6; LC-4, VAL-036, §5.4).
//
// BULK APPROVE IS N REQUESTS, NOT ONE, AND THAT IS A DESIGN DECISION RATHER THAN
// A SHORTCUT. §12.2 gives approval exactly one shape — `POST
// /api/activities/<family>/[id]/approve`, per row, each answering with the NEW
// version it created (LC-4: approving is a version, so the id changes) and each
// writing its own `audit_log` row with the self-approval disclosure §11.2 wants
// on it. A `/approve-many` endpoint would have to reproduce all of that and then
// decide what an all-or-nothing transaction means for a queue where partial
// refusal is the NORMAL outcome — VAL-036 blocks approval of exactly the rows
// whose evidence is missing and no others, so a bulk call that rolled back the
// good rows because of the bad ones would punish the user for the shape of their
// own data. So the screen sends one request per row, SEQUENTIALLY (a burst of
// twenty parallel writes against one revision buys nothing and interleaves the
// audit trail), and reports per row.
//
// WHICH MAKES THE ANSWER A TALLY, NOT A BOOLEAN. "12 of 15 approved" plus the
// three that were not, each with the rule that refused it and a link to it, is
// the whole point: a bulk action that reported only "some rows failed" would
// leave the user re-approving the twelve that already went through to find out
// which three did not.
//
// The suite is `environment: "node"` and has no DOM, so the decision is data in,
// data out, the component holds ONE reference to each field, and
// `__tests__/bulk.test.ts` pins what could regress: that a partial run reports
// both halves and never rounds either one away.
// =============================================================================
import type { InventoryRowDto, Refusal, WriteOutcome } from "./api";

/** One row's attempt: which row, and what the server answered. */
export interface RowApprovalAttempt {
  readonly row: InventoryRowDto;
  readonly outcome: WriteOutcome<unknown>;
}

/** One row that was NOT approved, and why — the list the user acts on. */
interface BulkRefusal {
  readonly rowId: string;
  readonly label: string | null;
  readonly refusal: Refusal;
}

/** The result of one bulk approve, as the queue renders it. */
export interface BulkReport {
  /** How many rows were sent. `0` means the action was not run. */
  readonly attempted: number;
  /** How many came back approved. */
  readonly approved: number;
  /** The refused ones, in the order they were attempted. */
  readonly refusals: BulkRefusal[];
  /**
   * At least one row's refusal was 401/403 (R-11) — the session's rights moved
   * mid-run. The queue says so once, benignly, instead of repeating a red error
   * per row for something that is not about the data at all.
   */
  readonly accessChanged: boolean;
}

/** THE tally of one bulk run. */
export function bulkReport(
  attempts: readonly RowApprovalAttempt[],
): BulkReport {
  const refusals: BulkRefusal[] = [];
  let approved = 0;
  for (const attempt of attempts) {
    if (attempt.outcome.ok) {
      approved += 1;
      continue;
    }
    refusals.push({
      rowId: attempt.row.id,
      label: attempt.row.label,
      refusal: attempt.outcome,
    });
  }
  return {
    attempted: attempts.length,
    approved,
    refusals,
    accessChanged: refusals.some(
      (refusal) => refusal.refusal.kind === "access_changed",
    ),
  };
}

/**
 * Every rule code a bulk run was refused with, deduplicated and sorted.
 *
 * The queue prints these as sentences (`useRuleText`) beside the count, so the
 * common case — twenty rows all failing VAL-036 — reads as ONE explanation and a
 * list of twenty links, rather than as twenty copies of the same sentence.
 */
export function refusedCodes(report: BulkReport): string[] {
  const codes = new Set<string>();
  for (const refusal of report.refusals) {
    if (refusal.refusal.kind !== "rules") continue;
    for (const rule of refusal.refusal.rules) codes.add(rule.code);
  }
  return [...codes].sort();
}
