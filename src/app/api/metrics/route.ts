/**
 * GET /api/metrics — the VSME disclosure catalogue (T2.8; DM-20 §4.13, §12.2).
 *
 * 141 rows, seeded by migration `0004` (О-13), filterable by `module`
 * (`basic` → 70, `comprehensive` → 71), by `pillar` and by `standard` — the two
 * columns К-26 put on the table so the ESRS/GRI rows of Phase 4 need no DDL.
 * `data.read`, and nothing else: the catalogue is what the product measures, not
 * what a tenant owns, and every role that can see a report can see it.
 *
 * NO PLAN GATE HERE EITHER, deliberately. PG-6 gates the comprehensive MODULE —
 * a `comprehensive` metric refuses to accept a VALUE on a plan without
 * `vsmeComprehensive` (T3.3) — but hiding the metrics themselves would leave the
 * upgrade screen unable to say what the upgrade contains. Reading the catalogue
 * is reading the standard.
 *
 * An unrecognised filter value returns an empty list rather than 422: `module`
 * has no closed domain (see `listMetrics`).
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { listMetrics } from "@/server/factors/reference";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const url = new URL(req.url);
  const metrics = await listMetrics(db, {
    module: url.searchParams.get("module"),
    pillar: url.searchParams.get("pillar"),
    standard: url.searchParams.get("standard"),
    locale: url.searchParams.get("locale"),
  });
  return apiResult(req, {
    ok: true,
    data: { metrics, total: metrics.length },
  });
});

export const OPTIONS = optionsHandler;
