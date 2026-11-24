/**
 * POST /api/disclosures/:id/approve — approve one disclosure record (LC-4,
 * LC-7, §11.2, §12.2).
 *
 * NOT OPTIONAL, and for the same reason the energy family's is not:
 * `all_rows_approved` (§5.1) counts the CURRENT rows of all four input tables,
 * so a disclosure with no way to be approved would hold its revision in `draft`
 * for ever — and a VSME report is mostly disclosures.
 */
import { DISCLOSURE_CONTRACT } from "@/server/inventory/disclosures";
import { rowApproveRoute } from "@/server/inventory/row-routes";

const routes = rowApproveRoute(DISCLOSURE_CONTRACT);

export const POST = routes.POST;
export const OPTIONS = routes.OPTIONS;
