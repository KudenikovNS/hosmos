/**
 * GET / PATCH /api/periods/:id — one reporting period of the session company
 * (DATA-MODEL T2.4; DM-7, DM-7a, К-4, К-24, VAL-102/103/106, PG-2).
 *
 * PATTERN 3 (§0.1): `:id` is the TARGET, never an identity. It is resolved
 * strictly inside `session.company.id`, so another tenant's period is simply not
 * there — which is also the answer the client gets: PATCH of a foreign id → 422
 * `VALIDATION` (API-1), GET of one → 404 `NO_DATA`. Both are indistinguishable
 * from "never existed".
 *
 * WHAT A PATCH MAY CHANGE (DM-7a). The six calculation-bearing fields
 * (`factor_set_id`, the two dates, `reporting_basis`, `methodology_version`,
 * `base_year`) are editable only while the period's current revision is
 * `draft`/`rejected` — or while it has no revisions at all. The route does not
 * check that: `updatePeriod` declares which of the six the request CHANGES and
 * VAL-106 refuses inside the transaction, so the client gets a rule code rather
 * than a hand-written message and the same rule guards T2.5's boundary PUT.
 * Labelling fields (`period_name`, `reporting_year`, `comparative_period_id`)
 * stay editable at every status: they change nothing a calculation reads.
 *
 * GUARD ORDER (§0.2): 401 → 404 (no company) → 403 capability → 402 plan → 422
 * body. The plan gate is here as well as on the POST, because switching an
 * existing period to `consolidated` buys the same paid feature (PG-2).
 *
 * NO DELETE (§12.2): a period is pointed at by its boundary, its revisions and
 * every input row beneath them.
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
import { requireFeature } from "@/server/billing/guard";
import { db } from "@/server/db";
import {
  getPeriod,
  parsePeriodPatch,
  serialisePeriod,
  updatePeriod,
  wantsConsolidatedBasis,
} from "@/server/periods/periods";

type Ctx = { params: Promise<{ id: string }> };

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

  const row = await getPeriod(db, company.id, id);
  if (!row) return apiResult(req, { ok: false, error: "NO_DATA" });
  return apiResult(req, {
    ok: true,
    data: await serialisePeriod(db, company.id, row),
  });
});

export const PATCH = apiRoute<[Ctx]>(async (req, ctx) => {
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
  if (wantsConsolidatedBasis(body)) {
    const denied = await requireFeature(session, "consolidatedReports", {
      mutation: true,
    });
    if (denied) return apiResult(req, denied);
  }

  const parsed = parsePeriodPatch(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await updatePeriod(db, company.id, id, parsed.values);
  if (!result.ok) {
    // NOT_FOUND (a foreign or unknown id) and a blocking rule set are the same
    // HTTP answer (422 VALIDATION, API-1); only the payload differs.
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
