/**
 * GET / PATCH /api/org/facilities/:id — one facility of the session company
 * (DATA-MODEL T2.3; DM-5, VAL-005, VAL-006).
 *
 * PATTERN 3 (§0.1): `:id` is the TARGET, never an identity. It is resolved
 * strictly inside `session.company.id`, so another tenant's facility is simply
 * not there — which is also the answer the client gets:
 *
 *   • PATCH of a foreign id → 422 `VALIDATION` (API-1: a reference to another
 *     company's object "does not exist" for this company). NOT a 404, and above
 *     all not a 500.
 *   • GET of a foreign id → 404 `NO_DATA`, the ordinary read convention.
 * Both are indistinguishable from "never existed", which is the property that
 * matters: neither confirms another tenant's row.
 *
 * NO DELETE, and that is the §12.2 route table, not an omission. A facility is
 * pointed at by input rows and counted by PG-3/F1 at lock; taking a site out of
 * service is `closing_date` + `included_in_boundary = false` (a PATCH), which
 * keeps the years it reported reproducible. Assets, which carry nothing, do get
 * a DELETE — see `/api/org/assets/[id]`.
 *
 * GUARD ORDER (§0.2): 401 → 404 (no company) → 403 capability → 422 body. No
 * plan gate: a PATCH creates nothing, and PG-2 counts rows.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  isUuid,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import {
  getFacility,
  parseFacilityPatch,
  serialiseFacility,
  updateFacility,
} from "@/server/org/facilities";

type Ctx = { params: Promise<{ id: string }> };

export const GET = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  // A non-uuid would reach Postgres as a malformed literal → 500 (isUuid, T2.1).
  if (!isUuid(id)) return apiResult(req, { ok: false, error: "NO_DATA" });

  const row = await getFacility(db, company.id, id);
  if (!row) return apiResult(req, { ok: false, error: "NO_DATA" });
  return apiResult(req, { ok: true, data: serialiseFacility(row) });
});

export const PATCH = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "company.manage");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });

  const body = await req.json().catch(() => null);
  const parsed = parseFacilityPatch(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await updateFacility(db, company.id, id, parsed.values);
  if (!result.ok) {
    // NOT_FOUND (a foreign or unknown id) and a blocking rule set are the same
    // HTTP answer (422 VALIDATION, API-1); only the payload differs.
    return apiValidationDetail(req, {
      rules: result.error === "VALIDATION" ? result.rules : [],
    });
  }
  return apiResult(req, { ok: true, data: serialiseFacility(result.row) });
});

export const OPTIONS = optionsHandler;
