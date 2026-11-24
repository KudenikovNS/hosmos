/**
 * GET /api/readiness — VSME readiness of the company's newest period (stage-1
 * §5.2). Read-only, `data.read`; every number is derived on the server from
 * the same rows the report prints.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { loadReadiness } from "@/server/readiness/readiness";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  return apiResult(req, {
    ok: true,
    data: await loadReadiness(db, company.id),
  });
});

export const OPTIONS = optionsHandler;
