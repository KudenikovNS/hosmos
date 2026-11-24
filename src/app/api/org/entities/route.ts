/**
 * GET / POST /api/org/entities — the legal entities of the session company
 * (DATA-MODEL T2.2; DM-2…DM-4, К-1/К-2, PG-2, API-3).
 *
 * PATTERN 3 (§0.1): the tenant comes ONLY from `getSession()`. The body carries
 * no company, and every query in `@/server/org/legal-entities` is pinned to the
 * session's — so there is no request that reads or writes another tenant's tree.
 *
 * GUARD ORDER (§0.2), and it is an order, not a set:
 *   401 no session → 404 no company → 403 capability → 402 plan limit → 422 body.
 * `company.manage` is checked BEFORE `requireWithinLimit`, so a contributor on a
 * full plan is refused as 403 and never shown an upgrade CTA that would not help
 * them: their ROLE, not the tariff, is what blocks them. GET only needs
 * `data.read` (§12.2) — reading the structure is not managing it.
 *
 * PG-2 — THE PARENT OCCUPIES A SLOT. `used` is `count(*)` over every entity of
 * the company, the root included; the pricing PDF caps the TOTAL number of legal
 * entities, not "subsidiaries in addition to the parent".
 *
 * API-3 — the list response carries `{used, limit}` (`-1` = unlimited) so the UI
 * can render "X of Y used" without a second call and without re-deriving the
 * plan matrix client-side.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 *
 * Response: `ActionResult<{entities, used, limit}>` / `ActionResult<entity>`.
 */
import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { getEntitlements, requireWithinLimit } from "@/server/billing/guard";
import { db } from "@/server/db";
import {
  countLegalEntities,
  createLegalEntity,
  listLegalEntities,
  parseNewLegalEntity,
  serialiseLegalEntity,
} from "@/server/org/legal-entities";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const rows = await listLegalEntities(db, company.id);
  // The counter reads the WRITE entitlements, matching the guard that spends it
  // (`requireWithinLimit` uses `writeFeatures`): on a lapsed subscription the UI
  // must show the limit that will actually refuse the next create, not the one
  // the company is still allowed to read its old data under (§9).
  const entitlements = await getEntitlements(session);
  return apiResult(req, {
    ok: true,
    data: {
      entities: rows.map(serialiseLegalEntity),
      used: rows.length,
      limit: entitlements.writeFeatures.maxLegalEntities,
    },
  });
});

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // 403 BEFORE 402 (§0.2) — the role gate does not depend on the plan, and a
  // role that can never do this must not be offered an upgrade.
  const forbidden = requireCapability(session, "company.manage");
  if (forbidden) return apiResult(req, forbidden);

  // PG-2: the plan limit, counted over every existing entity (parent included).
  // Two simultaneous creates could both read the same `used` and both pass; the
  // race widens the limit by one for an instant and is not worth a lock on a
  // table with single-digit rows.
  const used = await countLegalEntities(db, company.id);
  const denied = await requireWithinLimit(session, "maxLegalEntities", used);
  if (denied) return apiResult(req, denied);

  const body = await req.json().catch(() => null);
  const parsed = parseNewLegalEntity(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await createLegalEntity(db, company.id, parsed.values);
  if (!result.ok) {
    return apiValidationDetail(req, {
      rules: result.error === "VALIDATION" ? result.rules : [],
    });
  }

  return apiResult(req, { ok: true, data: serialiseLegalEntity(result.row) });
});

export const OPTIONS = optionsHandler;
