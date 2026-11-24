/**
 * GET / POST /api/activities/energy — the purchased-energy rows of the session
 * company (DM-16 §4.10, К-6, К-7, LC-3, API-2, §12.2).
 *
 * SCOPE 2 IS TWO NUMBERS FROM ONE ROW. Each row written here becomes two
 * `calculation` rows in T5.3 (CALC-5): a location-based one priced at the grid
 * factor of the site's country, and a market-based one priced through
 * supplier-specific factors, contractual instruments and the residual mix. That
 * is why VAL-021 is BLOCKING — a row whose geography is unknown has no
 * location-based figure at all, and §0.7 forbids the alternative of substituting
 * a zero.
 *
 * `location_factor_id` and `market_factor_id` are Calculated (§4.10): readable
 * in the response, never accepted in a body. The parser has no path into them —
 * see `@/server/inventory/purchased-energy`.
 *
 * Handlers, guard order (§0.2), CORS (PATTERN 2) and refusal payload (API-1) are
 * `@/server/inventory/row-routes`'; this file supplies the contract.
 */
import { PURCHASED_ENERGY_CONTRACT } from "@/server/inventory/purchased-energy";
import { rowCollectionRoutes } from "@/server/inventory/row-routes";

const routes = rowCollectionRoutes(PURCHASED_ENERGY_CONTRACT);

export const GET = routes.GET;
export const POST = routes.POST;
export const OPTIONS = routes.OPTIONS;
