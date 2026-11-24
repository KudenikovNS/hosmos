/**
 * GET / PUT /api/periods/:id/scope — the reporting boundary of one period
 * (DATA-MODEL T2.5; DM-8, DM-9, D10/D15, VAL-101, VAL-106, LC-10).
 *
 * PATTERN 3 (§0.1): `:id` is the TARGET, never an identity, and so is every
 * `legal_entity_id` in the body — all of them are resolved strictly inside
 * `session.company.id`. Another tenant's period is simply not there: GET → 404
 * `NO_DATA`, PUT → 422 `VALIDATION` (API-1), and an entity of another company in
 * the body is the same 422 with no rule code, because "does not exist for this
 * company" is the only thing the API may say about it.
 *
 * PUT IS A FULL REPLACEMENT. The body is `{entries:[…]}` — the same
 * representation GET returns — and it states the boundary in its entirety: an
 * entity the payload omits LEAVES the boundary, `[]` clears it. The reasoning,
 * and what makes a removal safe (the audit entry records the row it destroyed,
 * with its status and stated reason), is in `@/server/periods/scope`.
 *
 * THE TWO REFUSALS THIS ROUTE EXISTS TO CARRY, both from the validation run
 * inside the write transaction rather than from an `if` here:
 *   • VAL-101 — `excluded` with no `exclusion_reason` (D15). A boundary that
 *     cannot say why an entity is out is not a B1 disclosure.
 *   • VAL-106 — the boundary is frozen with its period (DM-9 → DM-7a) once the
 *     current revision has left `draft`/`rejected`. The write declares the
 *     `period_scope` sentinel and the rule judges it, so the same code guards
 *     the boundary and the six calculation-bearing fields of the period.
 * A refused PUT writes nothing at all — no rows, no `audit_log` entry, no
 * validation results (VR-3).
 *
 * GUARD ORDER (§0.2): 401 → 404 (no company) → 403 capability → 422 body. READ
 * is `data.read` and WRITE is `company.manage`, as on `/api/periods/[id]`: the
 * boundary is a disclosure every reviewer, approver and auditor has to be able
 * to see, while drawing it is an organisational decision. NO plan gate — PG-1
 * caps the ENTITY REGISTRY (T2.2) and F1 counts facilities at lock (T2.6);
 * neither has an axis on boundary rows, and inventing a 402 here would gate a
 * disclosure rather than a feature.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  isUuid,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { getPeriod } from "@/server/periods/periods";
import {
  listPeriodScope,
  parsePeriodScope,
  replacePeriodScope,
  serialisePeriodScope,
} from "@/server/periods/scope";

type Ctx = { params: Promise<{ id: string }> };

/** The boundary as both handlers answer it: the period it belongs to + the rows. */
async function boundaryOf(companyId: string, periodId: string) {
  return {
    period_id: periodId,
    entries: serialisePeriodScope(
      await listPeriodScope(db, companyId, periodId),
    ),
  };
}

export const GET = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  // A non-uuid would reach Postgres as a malformed literal → 500 (isUuid, T2.1).
  if (!isUuid(id)) return apiResult(req, { ok: false, error: "NO_DATA" });

  // The PERIOD is what a caller may or may not see; an empty boundary is a
  // legitimate answer for one that exists (it is the state a period is created
  // in), so the two cases are distinguished here rather than by row count.
  const period = await getPeriod(db, company.id, id);
  if (!period) return apiResult(req, { ok: false, error: "NO_DATA" });

  return apiResult(req, { ok: true, data: await boundaryOf(company.id, id) });
});

export const PUT = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "company.manage");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });

  const body = await req.json().catch(() => null);
  const parsed = parsePeriodScope(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await replacePeriodScope(
    db,
    company.id,
    id,
    parsed.values,
    // LC-10 identity, from the SESSION (PATTERN 3): the actor and the role they
    // held at the time, both snapshotted into the audit entry.
    { userId: session.userId, role: session.membership?.role ?? null },
  );
  if (!result.ok) {
    // NOT_FOUND (a foreign or unknown period) and a blocking rule set are the
    // same HTTP answer (422 VALIDATION, API-1); only the payload differs.
    return apiValidationDetail(req, {
      rules: result.error === "VALIDATION" ? result.rules : [],
    });
  }

  return apiResult(req, { ok: true, data: await boundaryOf(company.id, id) });
});

export const OPTIONS = optionsHandler;
