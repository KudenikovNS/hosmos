/**
 * GET / POST /api/periods — the reporting periods of the session company
 * (DATA-MODEL T2.4; DM-7, К-4, К-19, К-24, PG-2, API-3).
 *
 * PATTERN 3 (§0.1): the tenant comes ONLY from `getSession()`, and so does the
 * `created_by` stamp (DM-13). `factor_set_id` and `comparative_period_id` in the
 * body are TARGETS, not identity — one is resolved against the shared factor
 * library (and must be ACTIVE), the other inside the session's company, so
 * another tenant's period is answered as `VALIDATION` (API-1).
 *
 * GUARD ORDER (§0.2), and the plan gate here is the reason the body is READ
 * before it is parsed:
 *   401 no session → 404 no company → 403 capability → 402 plan → 422 body.
 * PG-2 gates `reporting_basis='consolidated'` on the `consolidatedReports`
 * entitlement, and whether the request wants it can only be known from the
 * body. So the raw JSON is inspected for that ONE field first (a cheap read of
 * a value that is either the literal `'consolidated'` or not), the 402 is
 * decided, and only then is the body parsed into columns. Parsing first would
 * answer 422 for a starter customer's malformed consolidated request and hide
 * the upgrade they actually need; gating on the parsed value would put 422
 * before 402 for the same request.
 *
 * API-3 — the list carries `used`. It deliberately carries NO `limit`: PG-1's
 * matrix has no per-period axis, and emitting `-1` would assert that one exists
 * and happens to be uncapped (the same reasoning as `/api/org/assets`). What it
 * carries instead is `consolidated_available`, which is the plan fact this
 * screen actually needs — it is what the POST will refuse with a 402.
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
import { getEntitlements, requireFeature } from "@/server/billing/guard";
import { db } from "@/server/db";
import {
  createPeriod,
  listPeriods,
  parseNewPeriod,
  serialisePeriod,
  serialisePeriods,
  wantsConsolidatedBasis,
} from "@/server/periods/periods";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const rows = await listPeriods(db, company.id);
  // The WRITE entitlements, matching the guard that spends them: on a lapsed
  // subscription the UI must show what the next create will actually allow.
  const entitlements = await getEntitlements(session);
  return apiResult(req, {
    ok: true,
    data: {
      periods: await serialisePeriods(db, company.id, rows),
      used: rows.length,
      consolidated_available: entitlements.writeFeatures.consolidatedReports,
    },
  });
});

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // 403 BEFORE 402 (§0.2): the role gate does not depend on the plan, and a
  // role that can never do this must not be offered an upgrade.
  const forbidden = requireCapability(session, "company.manage");
  if (forbidden) return apiResult(req, forbidden);

  const body = await req.json().catch(() => null);
  if (wantsConsolidatedBasis(body)) {
    const denied = await requireFeature(session, "consolidatedReports", {
      mutation: true,
    });
    if (denied) return apiResult(req, denied);
  }

  const parsed = parseNewPeriod(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await createPeriod(
    db,
    company.id,
    parsed.values,
    session.userId,
  );
  if (!result.ok) {
    return apiValidationDetail(req, {
      rules: result.error === "VALIDATION" ? result.rules : [],
    });
  }

  return apiResult(req, {
    ok: true,
    data: await serialisePeriod(db, company.id, result.row),
  });
});

export const OPTIONS = optionsHandler;
