/**
 * GET /api/activities/energy/:id/history — every version of one purchased-energy
 * row (API-2, D5, LC-10).
 *
 * The version chain IS the audit trail of an input row, and a corrected meter
 * reading is the case that makes it matter: the figure that was reported, the
 * figure that replaced it, who changed it and the `change_reason` are all one
 * request away.
 */
import { PURCHASED_ENERGY_CONTRACT } from "@/server/inventory/purchased-energy";
import { rowHistoryRoute } from "@/server/inventory/row-routes";

const routes = rowHistoryRoute(PURCHASED_ENERGY_CONTRACT);

export const GET = routes.GET;
export const OPTIONS = routes.OPTIONS;
