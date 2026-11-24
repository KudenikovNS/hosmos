/**
 * Goals / sustainability-target route (§Q5, DATA-INTEGRITY-PLAN T2.2).
 *
 * GET /api/goals — list the session company's goals for the form (session-scoped).
 *
 * POST /api/goals — create OR update a goal. Identity (companyId/userId) comes
 *   ONLY from `getSession()` (PATTERN 3); the body carries the goal columns plus
 *   an optional `id` (update-in-place when present), never a company/user. Writing
 *   requires the `goals` entitlement — a client that POSTs past the UI `FeatureGate`
 *   is stopped here (`requireFeature`, {mutation:true} → 402 PLAN_REQUIRED). The
 *   body is validated server-side (`title` non-empty; `category`/`status` against
 *   the CHECK enums; years 4-digit; numerics finite ≥ 0), upserted via the goals
 *   service, and one `audit_log` row is written (`entity:'goals'`, create|update).
 *
 * DELETE /api/goals?id= — remove a goal. The id is checked against the session
 *   company (`deleteGoal` pins `company_id`), so a cross-tenant id deletes nothing
 *   and returns NO_DATA (404) — never another tenant's goal. Logs `action:'delete'`.
 *
 * No footprint effect (goals never touch the carbon formula). `category='emissions'`
 * goals feed the ESRS E1-4 targets table in the report (T3.2).
 *
 * Response: `ActionResult<Goal>` / `ActionResult<Goal[]>`.
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { requireFeature } from "@/server/billing/guard";
import { db } from "@/server/db";
import { logAudit } from "@/server/db/audit";
import {
  deleteGoal,
  insertGoal,
  listGoals,
  updateGoal,
  type GoalValues,
} from "@/server/db/goals";

/** The `goals` CHECK-enum values (must mirror `goals_category_check`). */
const CATEGORIES = [
  "emissions",
  "energy",
  "waste",
  "social",
  "governance",
  "supply_chain",
  "water",
  "biodiversity",
] as const;

/** The `goals` CHECK-enum values (must mirror `goals_status_check`). */
const STATUSES = [
  "on_track",
  "at_risk",
  "behind",
  "completed",
  "not_started",
] as const;

/** A present-but-empty value we treat as "not set" (blank input → null column). */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/** 4-digit reporting year, or `null` when blank. `undefined` = invalid. */
function coerceYear(raw: unknown): string | null | undefined {
  if (isBlank(raw)) return null;
  const s = String(raw);
  return /^\d{4}$/.test(s) ? s : undefined;
}

/** Finite ≥ 0 number, or `null` when blank. `undefined` = invalid. */
function coerceNumber(raw: unknown): number | null | undefined {
  if (isBlank(raw)) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
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
 * Validate a POST body into `GoalValues`, or `null` when invalid. `title` is the
 * only required field; `category`/`status` must be one of the CHECK enums (defaults
 * applied when blank); numerics are finite ≥ 0; years are 4-digit.
 */
function validateGoal(body: Record<string, unknown>): GoalValues | null {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title === "") return null;

  const description = coerceText(body.description);
  if (description === undefined) return null;
  const unit = coerceText(body.unit);
  if (unit === undefined) return null;

  // category: default 'emissions' when blank; otherwise must be a known enum value.
  const category = isBlank(body.category) ? "emissions" : String(body.category);
  if (!(CATEGORIES as readonly string[]).includes(category)) return null;

  // status: default 'not_started' when blank; otherwise a known enum value.
  const status = isBlank(body.status) ? "not_started" : String(body.status);
  if (!(STATUSES as readonly string[]).includes(status)) return null;

  const targetYear = coerceYear(body.targetYear);
  if (targetYear === undefined) return null;
  const baselineYear = coerceYear(body.baselineYear);
  if (baselineYear === undefined) return null;

  const targetValue = coerceNumber(body.targetValue);
  if (targetValue === undefined) return null;
  const currentValue = coerceNumber(body.currentValue);
  if (currentValue === undefined) return null;
  const baselineValue = coerceNumber(body.baselineValue);
  if (baselineValue === undefined) return null;

  return {
    title,
    description,
    category,
    targetYear,
    targetValue: targetValue === null ? null : String(targetValue),
    currentValue: currentValue === null ? "0" : String(currentValue),
    unit,
    baselineYear,
    baselineValue: baselineValue === null ? null : String(baselineValue),
    status,
    sbtiAligned: Boolean(body.sbtiAligned),
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

  const rows = await listGoals(db, company.id);
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

  // Server-side entitlement gate: persisting goals requires a paid plan.
  const denied = await requireFeature(session, "goals", { mutation: true });
  if (denied) return apiResult(req, denied);

  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body !== "object")
    return apiResult(req, { ok: false, error: "VALIDATION" });

  const values = validateGoal(body);
  if (!values) return apiResult(req, { ok: false, error: "VALIDATION" });

  // An `id` in the body means "edit this goal" — but the update is pinned to the
  // session company, so a foreign id updates nothing (→ VALIDATION, never a leak).
  const id = typeof body.id === "string" && body.id !== "" ? body.id : null;
  if (id) {
    const row = await updateGoal(db, company.id, id, values);
    if (!row) return apiResult(req, { ok: false, error: "VALIDATION" });
    await logAudit(db, {
      companyId: company.id,
      userId: session.userId,
      actorRole: session.membership?.role ?? null,
      entity: "goals",
      entityId: row.id,
      action: "update",
      summary: { title: row.title, category: row.category },
    });
    return apiResult(req, { ok: true, data: row });
  }

  const row = await insertGoal(db, company.id, values);
  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "goals",
    entityId: row.id,
    action: "create",
    summary: { title: row.title, category: row.category },
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

  const denied = await requireFeature(session, "goals", { mutation: true });
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
  const deleted = await deleteGoal(db, company.id, id);
  if (!deleted) return apiResult(req, { ok: false, error: "NO_DATA" });

  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "goals",
    entityId: id,
    action: "delete",
    summary: { id },
  });
  return apiResult(req, { ok: true, data: { id } });
});

export const OPTIONS = optionsHandler;
