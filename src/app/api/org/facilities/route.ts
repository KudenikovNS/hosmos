/**
 * GET / POST /api/org/facilities — the site registry of the session company
 * (DATA-MODEL T2.3; DM-5, PG-2, API-3).
 *
 * PATTERN 3 (§0.1): the tenant comes ONLY from `getSession()`. `legal_entity_id`
 * in the body is a TARGET, not an identity — it is resolved inside the session's
 * company by `createFacility`, so another tenant's entity is answered as
 * `VALIDATION` ("does not exist for this company", API-1) rather than accepted.
 *
 * GUARD ORDER (§0.2), and it is an order, not a set:
 *   401 no session → 404 no company → 403 capability → 402 plan limit → 422 body.
 * `company.manage` is checked BEFORE `requireWithinLimit`, so a contributor on a
 * full plan is refused as 403 and never shown an upgrade CTA that would not help
 * them: their ROLE, not the tariff, is what blocks them. GET only needs
 * `data.read` (§12.2).
 *
 * PG-2 — `maxFacilities` counts the REGISTRY: every row of the company,
 * including closed sites and sites outside the boundary (see `countFacilities`).
 *
 * API-3 — the list response carries `{used, limit}` (`-1` = unlimited) so the UI
 * renders "X of Y used" without a second call.
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
import { getEntitlements, requireWithinLimit } from "@/server/billing/guard";
import { db } from "@/server/db";
import {
  countFacilities,
  createFacility,
  listFacilities,
  parseNewFacility,
  serialiseFacility,
} from "@/server/org/facilities";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const rows = await listFacilities(db, company.id);
  // The counter reads the WRITE entitlements, matching the guard that spends it
  // (`requireWithinLimit` uses `writeFeatures`): on a lapsed subscription the UI
  // must show the limit that will actually refuse the next create.
  const entitlements = await getEntitlements(session);
  return apiResult(req, {
    ok: true,
    data: {
      facilities: rows.map(serialiseFacility),
      used: rows.length,
      limit: entitlements.writeFeatures.maxFacilities,
    },
  });
});

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // 403 BEFORE 402 (§0.2) — the role gate does not depend on the plan, and a
  // role that can never do this must not be offered an upgrade.
  const forbidden = requireCapability(session, "company.manage");
  if (forbidden) return apiResult(req, forbidden);

  // PG-2: the plan limit. Two simultaneous creates could both read the same
  // `used` and both pass; the race widens the limit by one for an instant and
  // is not worth a lock on a table with single-digit rows.
  const used = await countFacilities(db, company.id);
  const denied = await requireWithinLimit(session, "maxFacilities", used);
  if (denied) return apiResult(req, denied);

  const body = await req.json().catch(() => null);
  const parsed = parseNewFacility(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await createFacility(db, company.id, parsed.values);
  if (!result.ok) {
    return apiValidationDetail(req, {
      rules: result.error === "VALIDATION" ? result.rules : [],
    });
  }

  return apiResult(req, { ok: true, data: serialiseFacility(result.row) });
});

export const OPTIONS = optionsHandler;
