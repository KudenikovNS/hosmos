/**
 * GET /api/unit-conversions — the unit conversion table (T2.8; DM-23 §4.15,
 * D7, §12.2).
 *
 * The rows CALC-3 walks to bring an activity's unit onto its factor's, exposed
 * for the two screens that have to explain themselves: /admin/factors (a
 * factor's `input_unit` is only usable if something converts to it — T1.5's
 * acceptance is precisely that every `input_unit` is reachable) and the input
 * forms of S3, which offer the units an activity can be entered in.
 *
 * `?from_unit` / `?to_unit` narrow an edge lookup. `?activity_context` picks the
 * contextual (calorific) conversions of one activity; the empty string picks the
 * UNIVERSAL ones (`activity_context IS NULL`, e.g. kWh→MWh), which is a
 * different question and cannot be spelled as an equality.
 *
 * `data.read` and no plan gate — the same reasoning as `/api/metrics`.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { listUnitConversions } from "@/server/factors/reference";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const url = new URL(req.url);
  const conversions = await listUnitConversions(db, {
    fromUnit: url.searchParams.get("from_unit"),
    toUnit: url.searchParams.get("to_unit"),
    activityContext: url.searchParams.get("activity_context"),
  });
  return apiResult(req, {
    ok: true,
    data: { conversions, total: conversions.length },
  });
});

export const OPTIONS = optionsHandler;
