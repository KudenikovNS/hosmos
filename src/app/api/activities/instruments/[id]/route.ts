/**
 * GET / PATCH / DELETE /api/activities/instruments/:id — one contractual
 * instrument of the session company (DM-17, LC-5, LC-6, §0.4, §12.2).
 *
 * PATCH writes a NEW VERSION and DELETE writes a TOMBSTONE; the factory's header
 * (`@/server/inventory/row-routes`) says why the verbs mean that here. For a
 * certificate the tombstone is the point: an instrument that was claimed in a
 * submitted report and later withdrawn has to stay readable, with the reason it
 * was withdrawn attached to the version that withdrew it.
 */
import { CONTRACTUAL_INSTRUMENT_CONTRACT } from "@/server/inventory/contractual-instrument";
import { rowItemRoutes } from "@/server/inventory/row-routes";

const routes = rowItemRoutes(CONTRACTUAL_INSTRUMENT_CONTRACT);

export const GET = routes.GET;
export const PATCH = routes.PATCH;
export const DELETE = routes.DELETE;
export const OPTIONS = routes.OPTIONS;
