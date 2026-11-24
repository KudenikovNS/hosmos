/**
 * GET / POST /api/activities/instruments — the contractual instruments of the
 * session company (DM-17 §4.11, D19, LC-3, API-2, §12.2).
 *
 * WHAT AN INSTRUMENT IS FOR. A GoO, REGO, REC, PPA, green tariff or supplier
 * product is the EVIDENCE behind a market-based Scope 2 figure: without one, the
 * market-based number is the residual mix and nothing else. T5.3 matches them
 * against purchased electricity (CALC-5) — prorated by the overlap of the
 * vintage window with the reporting period, facility-bound instruments first,
 * the matched total capped by what the entity actually consumed. That algorithm
 * is T5.3's; what this route owes it is that every column it reads is writable
 * here with the type it will be read at.
 *
 * `year_month` is normally absent: an instrument covers the whole period.
 * VAL-023 warns when its `generation_period` does not overlap that period at
 * all — a Warning rather than a refusal, because a certificate can legitimately
 * be entered before the period it belongs to is chosen.
 *
 * Handlers, guard order (§0.2), CORS (PATTERN 2) and refusal payload (API-1) are
 * `@/server/inventory/row-routes`'; this file supplies the contract.
 */
import { CONTRACTUAL_INSTRUMENT_CONTRACT } from "@/server/inventory/contractual-instrument";
import { rowCollectionRoutes } from "@/server/inventory/row-routes";

const routes = rowCollectionRoutes(CONTRACTUAL_INSTRUMENT_CONTRACT);

export const GET = routes.GET;
export const POST = routes.POST;
export const OPTIONS = routes.OPTIONS;
