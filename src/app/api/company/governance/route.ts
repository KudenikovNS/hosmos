/**
 * PATCH /api/company/governance — save the governance checklist (T-21, §4.2).
 *
 * Replaces the direct `updateCompany(id, {governance_data})` the governance page
 * called from the browser. The company comes ONLY from `getSession()` (PATTERN 3).
 * The body is `{governance_data}` — a `Record<string, boolean>` (the checked
 * items); anything that is not a plain object → VALIDATION (422). It is written to
 * the `governance_data` jsonb column via the Drizzle `updateCompany` service and
 * the updated row funnelled back through `toDbCompany`, so the response is the OLD
 * snake_case `DbCompany` shape (note #44). Response: `ActionResult<DbCompany>`.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { toDbCompany } from "@/server/api/normalize";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { requireFeature } from "@/server/billing/guard";
import { db } from "@/server/db";
import { logAudit } from "@/server/db/audit";
import { updateCompany } from "@/server/db/company";

export const PATCH = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) BEFORE the paid-feature check (§7.1): managing the company
  // profile is an admin capability; a non-admin is refused, never offered an upgrade.
  const forbidden = requireCapability(session, "company.manage");
  if (forbidden) return apiResult(req, forbidden);

  // Server-side entitlement gate (§7.3 #3): writing governance params requires a
  // paid plan. Bypassing the UI still hits this — deny → 402 PLAN_REQUIRED.
  const denied = await requireFeature(session, "governanceParams", {
    mutation: true,
  });
  if (denied) return apiResult(req, denied);

  const body = (await req.json().catch(() => ({}))) as {
    governance_data?: unknown;
  };
  const gov = body.governance_data;
  if (gov === null || typeof gov !== "object" || Array.isArray(gov)) {
    console.error(
      "PATCH /api/company/governance: invalid governance_data",
      gov,
    );
    return apiResult(req, { ok: false, error: "VALIDATION" });
  }

  const govData = gov as Record<string, boolean>;
  const row = await updateCompany(db, company.id, {
    governanceData: govData,
  });

  // Audit trail (§Q6, T4.1): ONE row per successful governance save; identity from
  // the session (PATTERN 3). Summary is a compact count, not the whole checklist.
  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "governance",
    entityId: company.id,
    action: "update",
    summary: {
      items: Object.keys(govData).length,
      checked: Object.values(govData).filter(Boolean).length,
    },
  });

  return apiResult(req, { ok: true, data: toDbCompany(row) });
});

export const OPTIONS = optionsHandler;
