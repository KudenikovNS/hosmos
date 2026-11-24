/**
 * POST /api/revisions/:id/calculate — run the calculation (T5.4; CALC-6, CALC-8,
 * DM-29).
 *
 * `data.write`, not `data.approve`: a run is not an approval, it is what a
 * preparer does repeatedly while getting the numbers right. §12.2 says so, and
 * the gate that DOES need approval — "a green run exists over the current rows"
 * — lives on the `approve` transition, not here.
 *
 * APPEND-ONLY (CALC-6). Every call writes a NEW `run_id` and a full set of
 * `calculation` rows; nothing is updated and nothing is deleted, so the run a
 * locked report was rendered from is still there years later. `GET …/results`
 * reads the latest.
 *
 * THIS ROUTE DECIDES NOTHING, as everywhere in this codebase (§0.2). It parses,
 * resolves the revision under the session's company, calls `calculateRevision`
 * and maps the outcome:
 *   200 — the run, its lines, its aggregates. A run that FAILED is still a 200:
 *         it happened, it is stored, and its `status: 'failed'` is the answer.
 *         A 4xx would suggest the request was wrong, when in fact the data is.
 *   404 `NO_DATA`            — no such revision FOR THIS COMPANY (API-1).
 *   409 `CONCURRENT_MODIFICATION` — a serialization conflict persisted after
 *                              one retry; no new run was committed.
 *   503 `FACTORS_AMBIGUOUS`  — §12.1: the pinned set ties and CALC-2 refuses to
 *                              pick. Nothing was written; an ADMIN must fix the
 *                              factor set, so it is not a 422 the caller could
 *                              act on. The body lists the colliding candidates.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 * PATTERN 3: the company comes from the session and pins every query.
 */
import {
  apiJson,
  apiResult,
  apiRoute,
  apiValidationDetail,
  isUuid,
  optionsHandler,
  statusForError,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { calculateRevision } from "@/server/calc/run";
import { db } from "@/server/db";
import { logAudit } from "@/server/db/audit";
import { getRevision } from "@/server/revisions/revisions";

type Ctx = { params: Promise<{ id: string }> };

export const POST = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.write");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  if (!isUuid(id)) return apiResult(req, { ok: false, error: "VALIDATION" });

  const revision = await getRevision(db, company.id, id);
  if (!revision) return apiResult(req, { ok: false, error: "NO_DATA" });

  const outcome = await calculateRevision(db, company.id, revision);

  if (!outcome.ok) {
    if (outcome.error === "NOT_FOUND") {
      return apiResult(req, { ok: false, error: "NO_DATA" });
    }
    if (outcome.error === "HISTORICAL_CONTEXT_MISSING") {
      return apiValidationDetail(req, { reason: "historical_context_missing" });
    }
    if (outcome.error === "HISTORICAL_FORMULA_UNSUPPORTED") {
      return apiValidationDetail(req, {
        reason: "historical_formula_unsupported",
        requires_restatement: true,
      });
    }
    if (outcome.error === "CONCURRENT_MODIFICATION") {
      return apiResult(req, { ok: false, error: "CONCURRENT_MODIFICATION" });
    }
    // §12.1's 503, with the colliding candidates so an admin can act.
    return apiJson(req, outcome.detail, statusForError("FACTORS_AMBIGUOUS"));
  }

  // The run is a FACT about the report and is audited like every other one
  // (LC-10). `create` because a run is appended, never amended.
  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "calculation",
    entityId: revision.id,
    action: "create",
    summary: {
      run_id: outcome.run.runId,
      status: outcome.run.status,
      lines: outcome.run.lineCount,
      failed: outcome.run.failedCount,
    },
  });

  return apiResult(req, {
    ok: true,
    data: {
      run: outcome.run,
      lines: outcome.lines,
      aggregates: outcome.aggregates,
      excluded: outcome.excluded,
    },
  });
});

export const OPTIONS = optionsHandler;
