/**
 * GET / PATCH / DELETE /api/activities/energy/:id — one purchased-energy row of
 * the session company (DM-16, LC-5, LC-6, §0.4, §12.2).
 *
 * PATCH writes a NEW VERSION and DELETE writes a TOMBSTONE; the factory's header
 * (`@/server/inventory/row-routes`) says why the verbs mean that here.
 *
 * A PATCH may move the row to another meter (`meter_asset_id`, К-7) or another
 * site, and both are resolved inside the session company: another tenant's asset
 * is a `VALIDATION` naming the field, never a row that reaches across the tenant
 * boundary (the FK alone would happily allow it — see `./wire`).
 */
import { PURCHASED_ENERGY_CONTRACT } from "@/server/inventory/purchased-energy";
import { rowItemRoutes } from "@/server/inventory/row-routes";

const routes = rowItemRoutes(PURCHASED_ENERGY_CONTRACT);

export const GET = routes.GET;
export const PATCH = routes.PATCH;
export const DELETE = routes.DELETE;
export const OPTIONS = routes.OPTIONS;
