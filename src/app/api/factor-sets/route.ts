/**
 * GET / POST /api/factor-sets — the factor library (T2.8; DM-21, UI-4, §12.2).
 *
 * TWO CAPABILITIES, ONE RESOURCE (§12.2): `data.read` to LOOK at the library
 * (every role has it — a reviewer must be able to see which set a period pinned)
 * and `factors.custom` to WRITE (esg_admin and data_owner, `@/shared/roles`).
 * The acceptance case is exactly that split: a contributor gets 200 on GET and
 * 403 on POST.
 *
 * THERE IS NO PLAN GATE, and it is deliberate. `PlanFeatures` has no factor
 * axis — the matrix charges for entities, facilities, the comprehensive module,
 * consolidation, formats and upload size, and nothing here — so POST goes
 * straight from the capability check to the body. Adding a `requireFeature`
 * would invent an entitlement no plan actually sells.
 *
 * POST ALWAYS CREATES A DRAFT (DM-21, "new version only"), optionally seeded
 * with a full copy of another set's factors (`copy_from` — UI-4's "new version"
 * button). Releasing it is a separate PATCH on `/[id]`; see that file.
 *
 * The library is REFERENCE DATA and carries no `company_id`, so PATTERN 3's
 * session tenant is not a filter here — it is the owner of the
 * `validation_result` rows a factor write produces (О-17).
 * GUARD ORDER (§0.2): 401 → 404 (no company) → 403 capability → 422 body.
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import {
  countFactors,
  createFactorSet,
  listFactorSets,
  parseNewFactorSet,
  serialiseFactorSet,
} from "@/server/factors/factor-sets";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const sets = await listFactorSets(db);
  return apiResult(req, { ok: true, data: { factor_sets: sets } });
});

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "factors.custom");
  if (forbidden) return apiResult(req, forbidden);

  const body = await req.json().catch(() => null);
  const parsed = parseNewFactorSet(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await createFactorSet(db, parsed.values);
  if (!result.ok) {
    if (result.error === "NOT_FOUND") {
      return apiValidationDetail(req, { rules: [] });
    }
    return apiValidationDetail(req, {
      rules: result.rules,
      ...(result.detail ?? {}),
    });
  }

  // A brand-new set has no factors unless it was copied — count it rather than
  // assume, so the "new version" answer already reports what it inherited.
  const factors = await countFactors(db, result.row.id);
  return apiResult(req, {
    ok: true,
    data: serialiseFactorSet(result.row, factors),
  });
});

export const OPTIONS = optionsHandler;
