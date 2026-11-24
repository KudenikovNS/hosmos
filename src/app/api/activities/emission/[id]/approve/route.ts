/**
 * POST /api/activities/emission/:id/approve — approve one Scope-1 row
 * (LC-4, LC-7, §11.2, §12.2).
 *
 * `data.approve`'s FIRST consumer (USERS-ROLES-PLAN §7 п.3): the capability had
 * been in the matrix and in `requireCapability` since the roles layer landed,
 * guarded by comments asking the next author not to delete it as dead code.
 *
 * A solo admin approving their own entry is not REFUSED — Phase 1 DISCLOSES
 * self-approval rather than forbidding it (LC-7) — it is recorded in the audit
 * row the service writes inside the approval's own transaction (§11.2).
 */
import { EMISSION_ACTIVITY_CONTRACT } from "@/server/inventory/emission-activity";
import { rowApproveRoute } from "@/server/inventory/row-routes";

const routes = rowApproveRoute(EMISSION_ACTIVITY_CONTRACT);

export const POST = routes.POST;
export const OPTIONS = routes.OPTIONS;
