/**
 * PATCH /api/factor-sets/:id/factors/:factorId — correct one factor of a DRAFT
 * set (T2.8; DM-21, DM-22).
 *
 * THIS ROUTE EXISTS TO BE REFUSED, most of the time. A factor of an `active`
 * set is what a locked report was calculated from (К-24 pins the set on the
 * period, and AC-8 says the report reproduces); editing it in place would move
 * a number that a signed report already published, leaving nothing behind to
 * attribute the change to. So the answer is 422 with `refusal:
 * "NEW_VERSION_ONLY"` and the set it means — never a silent 200, and never a
 * 500 from some constraint further down.
 *
 * On a DRAFT set the PATCH goes through, and then it is the FACTOR that has to
 * hold up: VAL-031 (the resolution key, re-derived from the MERGED values so an
 * edit cannot move a row onto another's key), VAL-032, VAL-033.
 *
 * There is no DELETE. A draft's mistake is corrected in place and a released
 * set is immutable, so nothing here would ever legitimately remove a row —
 * §12.2 lists none either.
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
  getFactor,
  parseFactorPatch,
  serialiseFactor,
  updateFactor,
} from "@/server/factors/factor-sets";

type Ctx = { params: Promise<{ id: string; factorId: string }> };

export const GET = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const { id, factorId } = await ctx.params;
  if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });
  if (!isUuid(factorId))
    return apiValidationDetail(req, { field: "factor_id" });

  const row = await getFactor(db, id, factorId);
  if (!row) return apiResult(req, { ok: false, error: "NO_DATA" });
  return apiResult(req, { ok: true, data: serialiseFactor(row) });
});

export const PATCH = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "factors.custom");
  if (forbidden) return apiResult(req, forbidden);

  const { id, factorId } = await ctx.params;
  if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });
  if (!isUuid(factorId))
    return apiValidationDetail(req, { field: "factor_id" });

  const body = await req.json().catch(() => null);
  const parsed = parseFactorPatch(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await updateFactor(
    db,
    company.id,
    id,
    factorId,
    parsed.values,
  );
  if (!result.ok) {
    if (result.error === "NOT_FOUND") {
      return apiResult(req, { ok: false, error: "NO_DATA" });
    }
    return apiValidationDetail(req, {
      rules: result.rules,
      ...(result.detail ?? {}),
    });
  }
  return apiResult(req, { ok: true, data: serialiseFactor(result.row) });
});

export const OPTIONS = optionsHandler;
