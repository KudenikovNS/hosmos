/**
 * Supply-chain / supplier-disclosure route (§Q5, D7, DATA-INTEGRITY-PLAN T2.3).
 *
 * GET /api/supply-chain — list the session company's suppliers for the form
 *   (session-scoped).
 *
 * POST /api/supply-chain — create OR update a supplier. Identity (companyId/userId)
 *   comes ONLY from `getSession()` (PATTERN 3); the body carries the supplier columns
 *   plus an optional `id` (update-in-place when present), never a company/user.
 *   Writing requires the `supplyChain` entitlement — a client that POSTs past the UI
 *   `FeatureGate` is stopped here (`requireFeature`, {mutation:true} → 402
 *   PLAN_REQUIRED). The body is validated server-side (`supplierName` non-empty;
 *   `riskLevel` against the CHECK enum; `spendEur`/`emissionsTco2e`/`esgScore`
 *   finite ≥ 0; `tier` a positive integer), upserted via the supply-chain service,
 *   and one `audit_log` row is written (`entity:'supply_chain'`, create|update).
 *
 * DELETE /api/supply-chain?id= — remove a supplier. The id is checked against the
 *   session company (`deleteSupplier` pins `company_id`), so a cross-tenant id
 *   deletes nothing and returns NO_DATA (404) — never another tenant's supplier.
 *   Logs `action:'delete'`.
 *
 * DISCLOSURE ONLY (D7): supplier rows NEVER touch the carbon formula. `spendEur`,
 * `emissionsTco2e` and `esgScore` are self-reported disclosure figures; the Scope-3
 * cat.1 spend path is the separate §Q3(b) spend editor (T2.4), NOT this table — so
 * nothing here feeds `recalculate.ts` / `scope3_results` / `scope3_spend`.
 *
 * Response: `ActionResult<Supplier>` / `ActionResult<Supplier[]>`.
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { requireFeature } from "@/server/billing/guard";
import { db } from "@/server/db";
import { logAudit } from "@/server/db/audit";
import {
  deleteSupplier,
  insertSupplier,
  listSuppliers,
  updateSupplier,
  type SupplierValues,
} from "@/server/db/supply-chain";

/** The `supply_chain_data` CHECK-enum values (must mirror `supply_chain_data_risk_level_check`). */
const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

/** Reporting year must be a bare 4-digit string (matches how the rest of the app keys years). */
function isYear(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}$/.test(v);
}

/** A present-but-empty value we treat as "not set" (blank input → null column). */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/** Finite ≥ 0 number, or `null` when blank. `undefined` = invalid. */
function coerceNumber(raw: unknown): number | null | undefined {
  if (isBlank(raw)) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/** Positive integer ≥ 1, or `null` when blank. `undefined` = invalid. */
function coerceTier(raw: unknown): number | null | undefined {
  if (isBlank(raw)) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return undefined;
  return n;
}

/** Optional free-text string, trimmed; `null` when blank. `undefined` = invalid type. */
function coerceText(raw: unknown): string | null | undefined {
  if (isBlank(raw)) return null;
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t === "" ? null : t;
}

/**
 * Validate a POST body into `SupplierValues`, or `null` when invalid. `supplierName`
 * is the only required field; `riskLevel` must be one of the CHECK enums (default
 * 'medium' when blank); `spendEur`/`emissionsTco2e`/`esgScore` are finite ≥ 0; `tier`
 * a positive integer. `year` defaults to the company's reporting year.
 */
function validateSupplier(
  body: Record<string, unknown>,
  defaultYear: string,
): SupplierValues | null {
  const supplierName =
    typeof body.supplierName === "string" ? body.supplierName.trim() : "";
  if (supplierName === "") return null;

  const supplierCountry = coerceText(body.supplierCountry);
  if (supplierCountry === undefined) return null;
  const category = coerceText(body.category);
  if (category === undefined) return null;
  const certification = coerceText(body.certification);
  if (certification === undefined) return null;
  const notes = coerceText(body.notes);
  if (notes === undefined) return null;

  // riskLevel: default 'medium' when blank; otherwise a known enum value.
  const riskLevel = isBlank(body.riskLevel) ? "medium" : String(body.riskLevel);
  if (!(RISK_LEVELS as readonly string[]).includes(riskLevel)) return null;

  const spendEur = coerceNumber(body.spendEur);
  if (spendEur === undefined) return null;
  const emissionsTco2e = coerceNumber(body.emissionsTco2e);
  if (emissionsTco2e === undefined) return null;
  const esgScore = coerceNumber(body.esgScore);
  if (esgScore === undefined) return null;

  const tier = coerceTier(body.tier);
  if (tier === undefined) return null;

  const year = isYear(body.year) ? body.year : defaultYear;

  return {
    year,
    supplierName,
    supplierCountry,
    category,
    spendEur: spendEur === null ? "0" : String(spendEur),
    emissionsTco2e: emissionsTco2e === null ? "0" : String(emissionsTco2e),
    riskLevel,
    tier: tier === null ? 1 : tier,
    esgScore: esgScore === null ? null : Math.round(esgScore),
    certified: Boolean(body.certified),
    certification,
    notes,
  };
}

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) — every member has `data.read`; a future read-less role does not.
  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const rows = await listSuppliers(db, company.id);
  return apiResult(req, { ok: true, data: rows });
});

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) BEFORE the paid-feature check (§7.1).
  const forbidden = requireCapability(session, "data.write");
  if (forbidden) return apiResult(req, forbidden);

  // Server-side entitlement gate: persisting suppliers requires a paid plan.
  const denied = await requireFeature(session, "supplyChain", {
    mutation: true,
  });
  if (denied) return apiResult(req, denied);

  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body !== "object")
    return apiResult(req, { ok: false, error: "VALIDATION" });

  const values = validateSupplier(body, company.reporting_year ?? "2024");
  if (!values) return apiResult(req, { ok: false, error: "VALIDATION" });

  // An `id` in the body means "edit this supplier" — but the update is pinned to the
  // session company, so a foreign id updates nothing (→ VALIDATION, never a leak).
  const id = typeof body.id === "string" && body.id !== "" ? body.id : null;
  if (id) {
    const row = await updateSupplier(db, company.id, id, values);
    if (!row) return apiResult(req, { ok: false, error: "VALIDATION" });
    await logAudit(db, {
      companyId: company.id,
      userId: session.userId,
      actorRole: session.membership?.role ?? null,
      entity: "supply_chain",
      entityId: row.id,
      action: "update",
      summary: { supplierName: row.supplierName, riskLevel: row.riskLevel },
    });
    return apiResult(req, { ok: true, data: row });
  }

  const row = await insertSupplier(db, company.id, values);
  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "supply_chain",
    entityId: row.id,
    action: "create",
    summary: { supplierName: row.supplierName, riskLevel: row.riskLevel },
  });
  return apiResult(req, { ok: true, data: row });
});

export const DELETE = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) BEFORE the paid-feature check (§7.1).
  const forbidden = requireCapability(session, "data.write");
  if (forbidden) return apiResult(req, forbidden);

  const denied = await requireFeature(session, "supplyChain", {
    mutation: true,
  });
  if (denied) return apiResult(req, denied);

  // id from the query string (?id=) or a JSON body { id }.
  const url = new URL(req.url);
  let id = url.searchParams.get("id");
  if (!id) {
    const body = (await req.json().catch(() => null)) as {
      id?: unknown;
    } | null;
    if (body && typeof body.id === "string") id = body.id;
  }
  if (!id) return apiResult(req, { ok: false, error: "VALIDATION" });

  // Pinned to the session company: a cross-tenant id deletes nothing → NO_DATA.
  const deleted = await deleteSupplier(db, company.id, id);
  if (!deleted) return apiResult(req, { ok: false, error: "NO_DATA" });

  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "supply_chain",
    entityId: id,
    action: "delete",
    summary: { id },
  });
  return apiResult(req, { ok: true, data: { id } });
});

export const OPTIONS = optionsHandler;
