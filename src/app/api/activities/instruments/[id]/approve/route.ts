/**
 * POST /api/activities/instruments/:id/approve — approve one contractual
 * instrument (LC-4, LC-7, §11.2, §12.2).
 *
 * NOT OPTIONAL, for the same reason as the energy one: `all_rows_approved`
 * (§5.1) counts the current rows of all four input tables, so an instrument with
 * no way to be approved would hold its revision in `draft` for ever.
 */
import { CONTRACTUAL_INSTRUMENT_CONTRACT } from "@/server/inventory/contractual-instrument";
import { rowApproveRoute } from "@/server/inventory/row-routes";

const routes = rowApproveRoute(CONTRACTUAL_INSTRUMENT_CONTRACT);

export const POST = routes.POST;
export const OPTIONS = routes.OPTIONS;
