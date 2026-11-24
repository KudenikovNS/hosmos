/**
 * GET / POST /api/org/assets — the asset registry of the session company
 * (DATA-MODEL T2.3; DM-6, F5, К-7).
 *
 * THERE IS NO PLAN GATE IN THIS FILE, AND THAT IS THE FEATURE. F5 makes an asset
 * a plain registry entry: not a level of the org tree and NOT an axis the
 * pricing matrix charges for (`@/shared/plans` has `maxLegalEntities` and
 * `maxFacilities`, and nothing else). So POST goes straight from the capability
 * check to the body, with no `requireWithinLimit` between them — a tenant on
 * `starter` may register its fortieth vehicle. The integration suite asserts
 * that 40th create returns 200, because a comment alone would not survive the
 * first person who copies `/api/org/facilities/route.ts` as a starting point.
 *
 * Consequently the list response carries `used` but NO `limit`. API-3 asks for
 * the counter that drives the UI's "X of Y used" badge; there is no Y here, and
 * emitting `-1` ("unlimited") would assert that a plan axis exists and happens
 * to be uncapped — which is a different, and false, statement.
 *
 * PATTERN 3 (§0.1): the tenant is the session. `legal_entity_id` / `facility_id`
 * in the body are targets resolved inside it, so a foreign one is `VALIDATION`.
 * GUARD ORDER (§0.2): 401 → 404 (no company) → 403 capability → 422 body.
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
  createAsset,
  listAssets,
  parseNewAsset,
  serialiseAsset,
} from "@/server/org/assets";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const rows = await listAssets(db, company.id);
  return apiResult(req, {
    ok: true,
    data: { assets: rows.map(serialiseAsset), used: rows.length },
  });
});

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "company.manage");
  if (forbidden) return apiResult(req, forbidden);

  // NO `requireWithinLimit` here — F5, see the header. This is the one create
  // route of `/api/org/*` that never answers 402.
  const body = await req.json().catch(() => null);
  const parsed = parseNewAsset(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await createAsset(db, company.id, parsed.values);
  if (!result.ok) {
    return apiValidationDetail(req, {
      rules: result.error === "VALIDATION" ? result.rules : [],
    });
  }

  return apiResult(req, { ok: true, data: serialiseAsset(result.row) });
});

export const OPTIONS = optionsHandler;
