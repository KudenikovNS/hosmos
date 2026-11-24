/**
 * GET /api/dashboard — the state of the report being written, and the figures of
 * the last one approved (T3.7 + T5.9, О-6, UI-6).
 *
 * REWRITTEN ONTO THE PHASE-1 LAYER. The former endpoint read the three wide
 * tables (`emission_results`, `monthly_emissions_data`, `people_data`) and
 * answered a `DashboardData` of tCO₂e. Those tables lost their last writer in
 * T3.6 and were dropped by 0005 (T3.9), so the honest answer then was not a
 * smaller number — it was a DIFFERENT question: which period, which revision,
 * how many rows, what validation said. T5.9 adds the totals back, from the one
 * place they can honestly come from: the latest Approved/Locked revision's
 * calculation run, through the SAME `loadLatestRun` that `GET
 * /api/revisions/[id]/results` answers with.
 *
 * "NO DIRECT EDITS" (UI-6) IS ENFORCED HERE BY WHAT IS NOT EXPORTED. This module
 * has a GET and an OPTIONS and will never have anything else: the dashboard is a
 * read, every figure on it belongs to a screen that owns writing it, and a hub
 * that could mutate would be a second write path for data whose only legitimate
 * one is append-only and validated (§0.4). `no-direct-edits.test.ts` asserts it
 * rather than trusting this comment.
 *
 * The assembly is the service's; this file owns the HTTP contract only.
 *
 * PATTERN 3 (session-guard): `companyId` comes ONLY from `getSession()`, never
 * from a query parameter. CAPABILITY (§5.4): `data.read` — the hub is a read of
 * the company's data and nothing on it acts, and results are facts about the
 * report that a reviewer who cannot write still has to see (the same capability
 * `…/results` asks for). NO plan gate: PG-2 counts facilities and periods, and
 * this endpoint creates neither.
 * PATTERN 2 (CORS): every response and the OPTIONS preflight.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { loadDashboard } from "@/server/dashboard/dashboard";
import { db } from "@/server/db";

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
    data: await loadDashboard(db, company.id),
  });
});

export const OPTIONS = optionsHandler;
