/**
 * POST /api/validation/run — the explicit validation trigger (VR-2, T2.1).
 *
 * Body: `{ scope, targetId }`. `scope` is one of the four DM-28 levels and
 * `targetId` the object at that level (a legal entity or facility for
 * `reference_org`, a period for `period`, a revision for `revision`, an input
 * row for `record`).
 *
 * PATTERN 3 (§0.1): `companyId` comes ONLY from `getSession()` — the body never
 * carries a tenant. Every evaluator pins its queries to that company, so a
 * foreign `targetId` matches nothing, writes nothing and comes back as an empty
 * result list. It is deliberately NOT a 404: answering "no such object" for a
 * real id of another tenant is itself a disclosure.
 *
 * Guard order (§0.2): capability first. Running validation WRITES
 * `validation_result` rows, so it takes `data.write` (403 for a role without
 * it) — a reader consumes results through the revision endpoint instead. There
 * is no plan gate: validation is not a paid feature, it is the thing that keeps
 * the numbers honest.
 *
 * Response: `ActionResult<{results, blocking}>` — `blocking` repeats the subset
 * that refuses promotion at this level (VR-3), so the client does not re-derive
 * it. PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import {
  apiResult,
  apiRoute,
  isUuid,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import {
  VALIDATION_SCOPES,
  type ValidationScope,
} from "@/server/validation/rules";
import { blockingFailures, runValidation } from "@/server/validation/run";

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) before anything reads the body (§0.2).
  const forbidden = requireCapability(session, "data.write");
  if (forbidden) return apiResult(req, forbidden);

  const body = (await req.json().catch(() => null)) as {
    scope?: unknown;
    targetId?: unknown;
  } | null;
  if (!body || typeof body !== "object")
    return apiResult(req, { ok: false, error: "VALIDATION" });

  const scope = body.scope;
  if (!(VALIDATION_SCOPES as readonly unknown[]).includes(scope))
    return apiResult(req, { ok: false, error: "VALIDATION" });
  // A non-uuid targetId would reach Postgres as a malformed literal → 500.
  if (!isUuid(body.targetId))
    return apiResult(req, { ok: false, error: "VALIDATION" });

  const results = await runValidation(db, {
    companyId: company.id,
    scope: scope as ValidationScope,
    targetId: body.targetId,
  });

  return apiResult(req, {
    ok: true,
    data: { results, blocking: blockingFailures(results) },
  });
});

export const OPTIONS = optionsHandler;
