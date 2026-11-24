/**
 * GET / POST /api/disclosures — the disclosure records of the session company
 * (DM-18, DM-19 §4.12, S1, LC-3, API-2, §12.2).
 *
 * THIS IS WHERE A VSME REPORT'S NON-NUMERIC HALF IS ENTERED: the narratives, the
 * yes/no answers, the headcounts and the policies of B1…B11 and C1…C9, one row
 * per catalogue metric. It replaces `people_data` as the way social figures
 * arrive (§14.5) — those become disclosure records against catalogue metrics
 * like every other answer, which is why there is no per-topic table here.
 *
 * A BODY CARRIES `metric_key` AND ONE VALUE FIELD. Which value field is decided
 * by the metric, not by the client: `@/server/inventory/disclosures` reads the
 * catalogue and refuses a `Decimal` metric answered in `value_text`, a body with
 * two value fields filled, and a metric with `breakdown_dimensions` answered
 * anywhere but `value_json`. `value_type` is never accepted from a body — it is
 * copied from the catalogue row, so it cannot disagree with it.
 *
 * PG-6 LIVES IN THAT SAME LOOKUP: on a plan without `vsmeComprehensive`, a
 * metric with `module='comprehensive'` is refused 422 `VALIDATION` — not 402,
 * and not by counting anything the plan limits (AC-14).
 *
 * Handlers, guard order (§0.2), CORS (PATTERN 2) and refusal payload (API-1) are
 * `@/server/inventory/row-routes`'; this file supplies the contract.
 */
import { DISCLOSURE_CONTRACT } from "@/server/inventory/disclosures";
import { rowCollectionRoutes } from "@/server/inventory/row-routes";

const routes = rowCollectionRoutes(DISCLOSURE_CONTRACT);

export const GET = routes.GET;
export const POST = routes.POST;
export const OPTIONS = routes.OPTIONS;
