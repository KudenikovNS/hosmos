/**
 * GET / POST /api/activities/emission — the Scope-1 rows of the session company
 * (DM-15 §4.9, LC-3, LC-5, API-2, §12.2).
 *
 * The handlers are `@/server/inventory/row-routes`' — the guard order (§0.2),
 * the CORS contract (PATTERN 2), the tenant pin (PATTERN 3) and the refusal
 * payload (API-1) are written once for all three input-row route families
 * rather than copied per table. What makes this one Scope 1 is the CONTRACT it
 * is built from: `emission_activity`, its parsers and its serialiser.
 *
 * T3.1 shipped these four files with a `const TABLE` and a note that T3.2 would
 * copy them; T3.2 needed eight more, so the shape moved into the factory and
 * these became its first caller. The Scope-1 integration suite passes unchanged,
 * which is what says the move changed no behaviour.
 */
import { EMISSION_ACTIVITY_CONTRACT } from "@/server/inventory/emission-activity";
import { rowCollectionRoutes } from "@/server/inventory/row-routes";

const routes = rowCollectionRoutes(EMISSION_ACTIVITY_CONTRACT);

export const GET = routes.GET;
export const POST = routes.POST;
export const OPTIONS = routes.OPTIONS;
