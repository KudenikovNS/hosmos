/**
 * GET / POST /api/factor-sets/:id/factors — the factors of one set (T2.8;
 * DM-22, VAL-031/032/033, §12.2).
 *
 * GET IS PAGED, and not for elegance: `legacy-v1` holds 440 rows and a new
 * version copied from it holds 440 more, so an unpaged list would ship the
 * whole library to the browser on every screen open. `search` (code / name /
 * activity type) and `activity_type` narrow it; `total` always describes the
 * FILTER, not the page, so the screen can say "23 of 440".
 *
 * POST ADDS A FACTOR, and can be refused in three different registers, which is
 * the whole point of the route:
 *   • 403 — the role lacks `factors.custom`;
 *   • 422 `refusal: NEW_VERSION_ONLY` — the SET is released (DM-21). No VAL-*
 *     code owns this; the payload names the set so the screen can offer "new
 *     version" beside the message;
 *   • 422 with `rules` — the FACTOR is wrong: VAL-031 (a duplicate on the
 *     resolution key, checked before the unique index can turn it into a 500 —
 *     О-18), VAL-032 (an impossible validity window or year), VAL-033 (a zero
 *     with no explicit justification, §0.7).
 * The first two are decided by the service before anything is written; the third
 * is `writeValidated` rolling the insert back (VR-3).
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
  createFactor,
  getFactorSet,
  listFactors,
  parseNewFactor,
  serialiseFactor,
} from "@/server/factors/factor-sets";

type Ctx = { params: Promise<{ id: string }> };

/** Page size defaults — big enough for a screenful, capped so a client cannot
 *  ask for the whole library in one response. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** `?limit`/`?offset` → sane numbers. A malformed value falls back rather than
 *  422-ing: paging is a view concern, not a statement about the data. */
function paging(url: URL): { limit: number; offset: number } {
  const asInt = (raw: string | null, fallback: number): number => {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return {
    limit:
      Math.min(
        asInt(url.searchParams.get("limit"), DEFAULT_LIMIT),
        MAX_LIMIT,
      ) || DEFAULT_LIMIT,
    offset: asInt(url.searchParams.get("offset"), 0),
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
  if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });
  if (!(await getFactorSet(db, id)))
    return apiResult(req, { ok: false, error: "NO_DATA" });

  const url = new URL(req.url);
  const page = await listFactors(db, id, {
    search: url.searchParams.get("search"),
    activityType: url.searchParams.get("activity_type"),
    ...paging(url),
  });
  return apiResult(req, { ok: true, data: page });
});

export const POST = apiRoute<[Ctx]>(async (req, ctx) => {
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
  const parsed = parseNewFactor(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await createFactor(db, company.id, id, parsed.values);
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
