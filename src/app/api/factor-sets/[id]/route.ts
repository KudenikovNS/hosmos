/**
 * GET / PATCH /api/factor-sets/:id — one factor set and its release lifecycle
 * (T2.8; DM-21, UI-4).
 *
 * GET adds to the list response the one thing a screen cannot derive: the
 * PROVENANCE of the set — its (source, version, licence) groups with the number
 * of factors behind each. UI-4 asks for "sources and licences", and DM-22 puts
 * both on the factor row rather than in a table, so the grouping is the answer.
 *
 * PATCH IS THE RELEASE ACTION, and the only one. `draft → active` stamps
 * `published_at` and hands the set to `resolveFactorSet` as a pinnable version;
 * `→ archived` supersedes it. Everything else — re-opening a released set,
 * reviving an archived one, renaming a set that periods have already pinned —
 * is refused 422 with `refusal: "NEW_VERSION_ONLY"`, because DM-21's release
 * model has exactly one move for "these numbers should be different": a new set.
 * §12.2 lists GET/POST for this resource; without a release action a new version
 * could never become pinnable, so the transition lives here rather than nowhere.
 *
 * GUARD ORDER (§0.2): 401 → 404 (no company) → 403 capability → 422 body.
 * A set id that does not exist is `NO_DATA` (404), as elsewhere: the library is
 * shared, so there is no tenant-shaped reason to disguise it as a 422.
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
  countFactors,
  getFactorSet,
  listProvenance,
  parseFactorSetPatch,
  serialiseFactorSet,
  updateFactorSet,
} from "@/server/factors/factor-sets";

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
  if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });

  const row = await getFactorSet(db, id);
  if (!row) return apiResult(req, { ok: false, error: "NO_DATA" });

  const [factors, provenance] = await Promise.all([
    countFactors(db, id),
    listProvenance(db, id),
  ]);
  return apiResult(req, {
    ok: true,
    data: { factor_set: serialiseFactorSet(row, factors), provenance },
  });
});

export const PATCH = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "factors.custom");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });

  const body = await req.json().catch(() => null);
  const parsed = parseFactorSetPatch(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await updateFactorSet(db, id, parsed.values);
  if (!result.ok) {
    if (result.error === "NOT_FOUND") {
      return apiResult(req, { ok: false, error: "NO_DATA" });
    }
    return apiValidationDetail(req, {
      rules: result.rules,
      ...(result.detail ?? {}),
    });
  }

  const factors = await countFactors(db, id);
  return apiResult(req, {
    ok: true,
    data: serialiseFactorSet(result.row, factors),
  });
});

export const OPTIONS = optionsHandler;
