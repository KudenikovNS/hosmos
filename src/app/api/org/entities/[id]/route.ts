/**
 * GET / PATCH / DELETE /api/org/entities/:id — one legal entity of the session
 * company (DATA-MODEL T2.2; DM-2…DM-4, К-1/К-2, F4).
 *
 * PATTERN 3 (§0.1): `:id` is the TARGET, never an identity. It is resolved
 * strictly inside `session.company.id`, so another tenant's entity is simply not
 * there — which is also the answer the client gets:
 *
 *   • PATCH / DELETE of a foreign id → 422 `VALIDATION` (API-1: "ссылка на чужой
 *     объект компании → VALIDATION — объект «не существует» для этой компании").
 *     NOT a 404, and above all not a 500: the id never reaches SQL as anything
 *     but a tenant-pinned lookup that finds nothing.
 *   • GET of a foreign id → 404 `NO_DATA`, the ordinary read convention. Both
 *     answers are indistinguishable from "never existed", which is the property
 *     that matters: neither confirms another tenant's row.
 *
 * GUARD ORDER (§0.2): 401 → 404 (no company) → 403 capability → 422 body. There
 * is no plan gate here: PATCH and DELETE create nothing, and PG-2 counts rows.
 *
 * DELETE is the one deviation from the §12.2 route table (which lists GET/POST/
 * PATCH). DM-4 requires deletion of an entity WITH DATA to be refused at the app
 * layer, and a refusal that cannot be reached is not an enforcement; the entity
 * that has nothing attached — created by mistake, never used — is the only one
 * that goes. Taking a USED entity out of the group is `effective_to` (F4), which
 * is a PATCH.
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
import {
  deleteLegalEntity,
  getLegalEntity,
  parseLegalEntityPatch,
  serialiseLegalEntity,
  updateLegalEntity,
} from "@/server/org/legal-entities";

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

  const row = await getLegalEntity(db, company.id, id);
  if (!row) return apiResult(req, { ok: false, error: "NO_DATA" });
  return apiResult(req, { ok: true, data: serialiseLegalEntity(row) });
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
  const parsed = parseLegalEntityPatch(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await updateLegalEntity(db, company.id, id, parsed.values);
  if (!result.ok) {
    // NOT_FOUND (a foreign or unknown id) and a blocking rule set are the same
    // HTTP answer (422 VALIDATION, API-1); only the payload differs.
    return apiValidationDetail(req, {
      rules: result.error === "VALIDATION" ? result.rules : [],
    });
  }
  return apiResult(req, { ok: true, data: serialiseLegalEntity(result.row) });
});

export const DELETE = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "company.manage");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });

  const result = await deleteLegalEntity(db, company.id, id);
  if (!result.ok) {
    // DM-4: the counts travel with the refusal so the UI can say WHAT is in the
    // way ("3 facilities, 12 rows") instead of a bare "cannot delete".
    return apiValidationDetail(
      req,
      result.error === "HAS_DATA" ? { blockers: result.blockers } : {},
    );
  }
  return apiResult(req, { ok: true, data: { id } });
});

export const OPTIONS = optionsHandler;
