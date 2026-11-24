/**
 * PATCH /api/company — update the company profile (T-21, §4.2).
 *
 * Replaces the `updateCompanyProfile` server action. The company comes ONLY from
 * `getSession()` (PATTERN 3) — never a client id. The client may change EXACTLY
 * the whitelisted profile fields `{name,industry,country,nace_code,headcount}`;
 * every other column (`plan`, `status`, `monthly_price`, `stripe_customer_id`,
 * `governance_data`, …) is dropped on the floor, so a client cannot upgrade its
 * plan or write arbitrary columns through this endpoint (SEC, ARCH-review debt).
 * This mirrors the old action's whitelist verbatim.
 *
 * `headcount` must be a finite number ≥ 0 (anti-NaN, as the old action checked) —
 * otherwise VALIDATION (422). An empty (all-undefined) patch skips the UPDATE and
 * returns the current row. The row is written through the Drizzle `updateCompany`
 * service (camelCase columns) and funnelled back through `toDbCompany`, so the
 * response is the OLD snake_case `DbCompany` shape (note #44). Response:
 * `ActionResult<DbCompany>`. PATTERN 2 (CORS): every response + OPTIONS preflight.
 */
import { eq } from "drizzle-orm";

import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { toDbCompany } from "@/server/api/normalize";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { logAudit } from "@/server/db/audit";
import { updateCompany } from "@/server/db/company";
import { listCurrencies } from "@/server/db/fx";
import { companies } from "@/server/db/schema";

export const PATCH = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) — managing the company profile is an admin capability (§7.3).
  const forbidden = requireCapability(session, "company.manage");
  if (forbidden) return apiResult(req, forbidden);

  const updates = (await req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  // Whitelist EXACTLY these fields (input is snake_case → Drizzle camelCase cols).
  const patch: Partial<typeof companies.$inferInsert> = {};
  if (typeof updates.name === "string") patch.name = updates.name;
  if (typeof updates.industry === "string") patch.industry = updates.industry;
  if (typeof updates.country === "string") patch.country = updates.country;
  if (typeof updates.nace_code === "string") patch.naceCode = updates.nace_code;
  if (updates.headcount !== undefined) {
    const h = updates.headcount;
    if (typeof h !== "number" || !Number.isFinite(h) || h < 0) {
      console.error("PATCH /api/company: invalid headcount", h);
      return apiResult(req, { ok: false, error: "VALIDATION" });
    }
    patch.headcount = h;
  }
  // `currency` — the operational default for money-denominated data entry (Scope-3
  // spend, §Q3-FX/D8), NOT billing (plan_prices stays EUR). It must be one of the
  // seeded ISO-4217 `currencies`; the FK would reject a bad code as a 500, so we
  // validate against the DB set up front and return a clean 422 instead. The server
  // is the source of truth — the client can only persist a seeded code.
  if (updates.currency !== undefined) {
    const c = updates.currency;
    if (typeof c !== "string") {
      console.error("PATCH /api/company: invalid currency", c);
      return apiResult(req, { ok: false, error: "VALIDATION" });
    }
    const code = c.toUpperCase();
    const currencyRows = await listCurrencies(db);
    if (!currencyRows.some((r) => r.code === code)) {
      console.error("PATCH /api/company: unknown currency", code);
      return apiResult(req, { ok: false, error: "VALIDATION" });
    }
    patch.currency = code;
  }

  // Empty patch — nothing to update; return the current row (Drizzle rejects an
  // empty `.set({})`), mapped to the snake_case shape.
  if (Object.keys(patch).length === 0) {
    const [row] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, company.id))
      .limit(1);
    if (!row) return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });
    return apiResult(req, { ok: true, data: toDbCompany(row) });
  }

  const row = await updateCompany(db, company.id, patch);

  // One audit row per successful company-profile mutation (§Q6). Identity comes
  // from the session (PATTERN 3), never the body; `summary` records exactly which
  // whitelisted fields changed (incl. `currency`) for the Data Sources audit log.
  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "company",
    entityId: company.id,
    action: "update",
    summary: patch,
  });

  return apiResult(req, { ok: true, data: toDbCompany(row) });
});

export const OPTIONS = optionsHandler;
