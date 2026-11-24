/**
 * GET / PATCH / DELETE /api/org/assets/:id — one asset of the session company
 * (DATA-MODEL T2.3; DM-6, F5, К-7).
 *
 * DELETE IS FIRST-CLASS HERE, unlike on the other two registries, and §12.2 says
 * so explicitly. An asset carries no data of its own — no dates that a report
 * depends on, nothing hanging off it (F5) — so removing one destroys no history.
 * What it CAN destroy is a reference: `purchased_energy_activity.meter_asset_id`
 * (К-7) plus the four `asset_id` columns of the input tables. Those FKs were
 * declared without `ON DELETE RESTRICT` in 0004, deliberately, because the
 * refusal has to be able to EXPLAIN itself; `deleteAsset` counts them and the
 * counts travel with the 422, so the UI can say "used by 3 meter readings"
 * instead of a bare "cannot delete".
 *
 * PATTERN 3 (§0.1): `:id` is the TARGET, never an identity — resolved strictly
 * inside `session.company.id`. PATCH/DELETE of a foreign id → 422 `VALIDATION`
 * (API-1), GET of one → 404 `NO_DATA`; both indistinguishable from "never
 * existed", so neither confirms another tenant's row.
 *
 * GUARD ORDER (§0.2): 401 → 404 (no company) → 403 capability → 422 body. No
 * plan gate anywhere on this route (F5).
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
  deleteAsset,
  getAsset,
  parseAssetPatch,
  serialiseAsset,
  updateAsset,
} from "@/server/org/assets";

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

  const row = await getAsset(db, company.id, id);
  if (!row) return apiResult(req, { ok: false, error: "NO_DATA" });
  return apiResult(req, { ok: true, data: serialiseAsset(row) });
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
  const parsed = parseAssetPatch(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await updateAsset(db, company.id, id, parsed.values);
  if (!result.ok) {
    return apiValidationDetail(req, {
      rules: result.error === "VALIDATION" ? result.rules : [],
    });
  }
  return apiResult(req, { ok: true, data: serialiseAsset(result.row) });
});

export const DELETE = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "company.manage");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });

  const result = await deleteAsset(db, company.id, id);
  if (!result.ok) {
    // К-7: the counts travel with the refusal so the UI can say WHAT is in the
    // way — `meters` is the `meter_asset_id` reference specifically.
    return apiValidationDetail(
      req,
      result.error === "HAS_DATA" ? { blockers: result.blockers } : {},
    );
  }
  return apiResult(req, { ok: true, data: { id } });
});

export const OPTIONS = optionsHandler;
