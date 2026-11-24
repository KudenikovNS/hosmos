/**
 * GET / PATCH / DELETE /api/disclosures/:id — one disclosure record of the
 * session company (DM-18, DM-19, LC-5, LC-6, §0.4, §12.2).
 *
 * PATCH writes a NEW VERSION and DELETE writes a TOMBSTONE; the factory's header
 * (`@/server/inventory/row-routes`) says why the verbs mean that here.
 *
 * A PATCH IS A DELTA, AND DM-19 IS ABOUT THE WHOLE ROW. Sending only
 * `{value_text}` still has to leave the row with exactly one non-empty value
 * field, so the check is made against the version being superseded merged with
 * the body — not against the body alone. Answering a metric in a second field
 * therefore fails whether it is done in one request or two.
 */
import { DISCLOSURE_CONTRACT } from "@/server/inventory/disclosures";
import { rowItemRoutes } from "@/server/inventory/row-routes";

const routes = rowItemRoutes(DISCLOSURE_CONTRACT);

export const GET = routes.GET;
export const PATCH = routes.PATCH;
export const DELETE = routes.DELETE;
export const OPTIONS = routes.OPTIONS;
