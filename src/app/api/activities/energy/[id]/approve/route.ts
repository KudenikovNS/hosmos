/**
 * POST /api/activities/energy/:id/approve — approve one purchased-energy row
 * (LC-4, LC-7, §11.2, §12.2).
 *
 * NOT OPTIONAL FOR SCOPE 2, and the reason is `all_rows_approved` (§5.1): the
 * submit precondition counts the CURRENT rows of all four input tables
 * (`countRevisionRows`), so an energy row with no way to be approved would hold
 * its revision in `draft` for ever.
 */
import { PURCHASED_ENERGY_CONTRACT } from "@/server/inventory/purchased-energy";
import { rowApproveRoute } from "@/server/inventory/row-routes";

const routes = rowApproveRoute(PURCHASED_ENERGY_CONTRACT);

export const POST = routes.POST;
export const OPTIONS = routes.OPTIONS;
