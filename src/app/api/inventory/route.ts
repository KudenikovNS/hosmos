/**
 * GET /api/inventory — the cross-table inventory of input rows (DATA-MODEL
 * T3.4; DM-14, API-2, §12.2).
 *
 * ONE LIST OVER FOUR TABLES, and not a fifth table (D23): the UNION lives in
 * `@/server/inventory/inventory`, which explains why it is a query helper rather
 * than a SQL view. What this file owns is the HTTP contract — the guard order,
 * the filter's refusals, and the shape of the answer.
 *
 * WHAT COMES BACK (API-2): CURRENT versions only, tombstones excluded, this
 * company only. None of the three is a filter a caller can turn off; a listing
 * that could return every version would count each edit as a row.
 *
 * FILTERS: `revision_id`, `state`, `legal_entity_id`, `facility_id`,
 * `year_month`, and `queue` — the approval queue (`state='draft'` over those
 * invariants, DM-14/UI-3). A malformed one is 422 `{field}` rather than an empty
 * list, because "no rows" and "you asked the wrong question" look identical on a
 * screen and only one of them is the customer's fault.
 *
 * CAPABILITY (§5.4): `data.read`. Reading the inventory is reading data —
 * approving from it is `data.approve`, and that goes to the row's own approve
 * route, so there is no second gate here. NO plan gate: PG-2 counts facilities
 * and periods, never rows.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import {
  listInventory,
  parseInventoryFilter,
  serialiseInventoryRow,
} from "@/server/inventory/inventory";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const filter = parseInventoryFilter(new URL(req.url).searchParams);
  if (!filter.ok) return apiValidationDetail(req, { field: filter.field });

  const page = await listInventory(db, company.id, filter.values);
  return apiResult(req, {
    ok: true,
    data: {
      inventory: page.rows.map(serialiseInventoryRow),
      // The read stops at `MAX_INVENTORY_ROWS`; saying so is the difference
      // between "this is the inventory" and "this is as much of it as one
      // request returns".
      truncated: page.truncated,
    },
  });
});

export const OPTIONS = optionsHandler;
