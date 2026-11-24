/**
 * GET /api/activities/instruments/:id/history — every version of one contractual
 * instrument (API-2, D5, LC-10).
 *
 * A market-based claim is only as good as its paper trail, and this is the paper
 * trail of the claim itself: what volume was claimed, against which certificate,
 * when it changed and why.
 */
import { CONTRACTUAL_INSTRUMENT_CONTRACT } from "@/server/inventory/contractual-instrument";
import { rowHistoryRoute } from "@/server/inventory/row-routes";

const routes = rowHistoryRoute(CONTRACTUAL_INSTRUMENT_CONTRACT);

export const GET = routes.GET;
export const OPTIONS = routes.OPTIONS;
