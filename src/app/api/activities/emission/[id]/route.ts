/**
 * GET / PATCH / DELETE /api/activities/emission/:id — one Scope-1 row of the
 * session company (LC-5, LC-6, §0.4, §12.2).
 *
 * PATCH writes a NEW VERSION and DELETE writes a TOMBSTONE — neither verb means
 * what it usually means, because the model is append-only. The factory's header
 * (`@/server/inventory/row-routes`) spells that out; this file supplies the
 * contract that makes it Scope 1.
 */
import { EMISSION_ACTIVITY_CONTRACT } from "@/server/inventory/emission-activity";
import { rowItemRoutes } from "@/server/inventory/row-routes";

const routes = rowItemRoutes(EMISSION_ACTIVITY_CONTRACT);

export const GET = routes.GET;
export const PATCH = routes.PATCH;
export const DELETE = routes.DELETE;
export const OPTIONS = routes.OPTIONS;
