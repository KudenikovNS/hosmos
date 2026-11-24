/**
 * GET /api/disclosures/:id/history — every version of one disclosure record
 * (API-2, D5, LC-10).
 *
 * The version chain IS the audit trail of an input row, and a narrative is the
 * case that makes it matter most: a policy statement that was reworded between
 * two submissions leaves both wordings readable, with the author, the moment and
 * the `change_reason` of the rewording (LC-5).
 */
import { DISCLOSURE_CONTRACT } from "@/server/inventory/disclosures";
import { rowHistoryRoute } from "@/server/inventory/row-routes";

const routes = rowHistoryRoute(DISCLOSURE_CONTRACT);

export const GET = routes.GET;
export const OPTIONS = routes.OPTIONS;
