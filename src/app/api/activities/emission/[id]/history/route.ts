/**
 * GET /api/activities/emission/:id/history — every version of one Scope-1 row
 * (API-2, D5, LC-10).
 *
 * LC-10 is explicit that input rows get NO per-entry audit table: the version
 * chain IS the audit trail. That only works if the chain is readable, which is
 * what this returns — every version, oldest first, with its actor, its state,
 * its `change_reason` and the two links that order it.
 */
import { EMISSION_ACTIVITY_CONTRACT } from "@/server/inventory/emission-activity";
import { rowHistoryRoute } from "@/server/inventory/row-routes";

const routes = rowHistoryRoute(EMISSION_ACTIVITY_CONTRACT);

export const GET = routes.GET;
export const OPTIONS = routes.OPTIONS;
