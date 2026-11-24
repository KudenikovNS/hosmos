// =============================================================================
// THE WIRE, AS THE `/review` SCREEN SEES IT (T4.6 — UI-3 second half, §5.1,
// §5.4, API-1, §12.2).
//
// The same two rules as `organisation/_lib/api.ts`, `inventory/_lib/api.ts` and
// `evidence/_lib/api.ts`:
//
//   1. THE DTOs ARE IMPORTED, NOT RE-DECLARED. `RevisionDto`, `InventoryRowDto`
//      and `StoredValidationResult` are owned by the services that serialise
//      them; every import is `import type`, so the server modules — and the
//      drizzle runtime behind them — are erased at compile and never reach the
//      browser bundle.
//   2. A REFUSAL IS CLASSIFIED ONCE — `../../_lib/refusal`, re-exported here so
//      this screen's imports read like the other four screens'.
//
// THE ONE PLACE THIS SCREEN NEEDS MORE THAN `WriteOutcome`, and the reason it
// has its own outcome type. `classifyRefusal` answers WHICH KIND of refusal
// happened, which is all four other screens ever need. A transition refusal
// carries a second, additive payload — `transition: {action, from, allowed,
// precondition, reason, …}` (§12.2, and `TransitionDetail` in the service) — and
// that payload IS the acceptance criterion of this task: `rows_not_approved`
// says how many rows are still pending, `reject_needs_comment` says which field,
// `blocking_rules` says which scopes, `transition_not_allowed` says what would
// have been legal instead. Dropping it and rendering "the change could not be
// saved" is precisely the unactionable refusal T4.6 exists to eliminate. So
// `TransitionOutcome` is `Refusal` PLUS the server's own detail, and the KIND is
// still decided by the one shared classifier.
//
// TWO REFUSALS THIS SCREEN CARES ABOUT BY NAME:
//   • 402 `PLAN_REQUIRED` on `lock` — F1/PG-3, and the ONLY 402 the state
//     machine can produce (`plan_facility_limit` is the only precondition in
//     `TRANSITION_PRECONDITIONS` that returns `PLAN_REQUIRED`). `_lib/transitions`
//     turns it into a plan explanation with an upgrade CTA, never an error line.
//   • 422 with `{field: "change_reason", reason: "restatement_needs_reason"}` on
//     `POST /api/periods/[id]/revisions` — LC-9/§5.1's last row. That one is an
//     ORDINARY write, so it travels as `{kind: "field"}` through `useWrite` and
//     needs nothing special here.
// =============================================================================
import type { InventoryRowDto } from "@/server/inventory/inventory";
import type { InputTableName } from "@/server/inventory/tables";
import type { RevisionDto } from "@/server/revisions/revisions";
import type {
  RevisionAction,
  TransitionDetail,
  TransitionRule,
} from "@/server/revisions/transition";
import type { StoredValidationResult } from "@/server/validation/run";

import {
  classifyRefusal,
  type ApiBody,
  type Refusal,
  type RuleRef,
  type WriteOutcome,
} from "../../_lib/refusal";

export type {
  InputTableName,
  InventoryRowDto,
  RevisionAction,
  RevisionDto,
  TransitionDetail,
  TransitionRule,
};

export {
  classifyRefusal,
  type ApiBody,
  type Refusal,
  type RuleRef,
  type WriteOutcome,
};

/**
 * One `validation_result` row as `GET /api/revisions/[id]/validation` serialises
 * it — the server's own type with the one field JSON changes overridden.
 *
 * `evaluatedAt` is a `Date` on the server because that is what the driver
 * returns; what crosses the wire is a string. Re-declaring the whole record
 * would be a second spelling of DM-28, so only that field is overridden (the
 * same treatment `/evidence` gives `AuditEntryDto`).
 */
export type ValidationResultDto = Omit<
  StoredValidationResult,
  "evaluatedAt"
> & {
  evaluatedAt: string | null;
};

/**
 * `GET /api/revisions/[id]/validation` — the STORED results of one revision.
 *
 * `blocking` is `results` filtered to `blocking && !passed`; the route sends
 * both so a client never has to re-derive "blocking" from severity itself. The
 * endpoint does NOT re-run anything (VR-2 — a run is an explicit act or a side
 * effect of a save/submit/approve), which is exactly why this screen refetches
 * it after every refused transition: the precondition that refused DID re-run,
 * and the rows it wrote are the sentences the user has to act on.
 */
export interface ValidationData {
  results: ValidationResultDto[];
  blocking: ValidationResultDto[];
}

/** `POST /api/revisions/[id]/transition` — what a SUCCESSFUL transition says. */
export interface TransitionData {
  revision: string;
  from: string;
  to: string;
}

/**
 * The outcome of one transition attempt: the shared classification, PLUS the
 * server's transition detail (see the header on why both).
 *
 * `detail` is `null` whenever the server did not send one — a transport failure,
 * a 401/403, or any refusal that is not the state machine's.
 */
export type TransitionOutcome =
  | { ok: true; data: TransitionData }
  | { ok: false; refusal: Refusal; detail: TransitionDetail | null };

/**
 * WHERE ONE ROW IS APPROVED, per input table (LC-4, §12.2).
 *
 * A TOTAL record over `InputTableName`, so a fifth input table stops this file
 * compiling instead of producing a queue whose rows silently cannot be
 * approved. The two vocabularies are the ones `inventory/_lib/tabs` separates:
 * the listing labels a row with its `source_table` (К-8), while the ROUTE is
 * spelled by FAMILY — and `disclosure_record` has no family at all, it has its
 * own resource. Holding the mapping here means the queue can approve any row
 * `/api/inventory` listed without a second lookup.
 */
export const APPROVE_PATH: Record<InputTableName, (id: string) => string> = {
  emission_activity: (id) => `/api/activities/emission/${id}/approve`,
  purchased_energy_activity: (id) => `/api/activities/energy/${id}/approve`,
  contractual_instrument: (id) => `/api/activities/instruments/${id}/approve`,
  disclosure_record: (id) => `/api/disclosures/${id}/approve`,
};

/**
 * The four input tables as a VALUE, derived from the total record above rather
 * than hand-listed — so a fifth table cannot be forgotten here while being added
 * there.
 */
export const INPUT_TABLE_NAMES = Object.keys(
  APPROVE_PATH,
) as readonly InputTableName[];

/** Is `objectType` one of the four tables whose rows this screen can open? */
export function isInputTable(
  objectType: string | null,
): objectType is InputTableName {
  return (
    objectType !== null &&
    (INPUT_TABLE_NAMES as readonly string[]).includes(objectType)
  );
}
