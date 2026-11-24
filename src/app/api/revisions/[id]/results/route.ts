/**
 * GET /api/revisions/:id/results — the lines of the latest calculation run plus
 * the CALC-8 aggregates (T5.4, §12.2).
 *
 * A READ: `data.read`, which every member holds. Results are facts about the
 * report, and a reviewer or an auditor who cannot write still has to see them.
 *
 * IT NEVER CALCULATES. Like `GET …/validation` (T2.1) this endpoint REPORTS and
 * does not compute: a run is an explicit action (`POST …/calculate`) or it has
 * not happened. A GET that silently ran the engine would make opening a screen
 * cost an unpredictable amount and could flip a figure under a reviewer
 * mid-review — and, worse, would write a `calculation` row for a page view.
 *
 * WHAT IT DOES RE-DERIVE is the AGGREGATE, from the stored lines, on every read.
 * There is no stored total anywhere in this system (see `calc/run.ts`): a
 * persisted total is a second copy of a number the lines already contain, and
 * the day the two disagree the report has two answers. VAL-034 is the rule that
 * checks the details add up; a stored total would be the one thing it could not
 * check.
 *
 * `freshness` carries CALC-6's verdict — whether the run still describes the
 * current rows, period and boundary, and which of the three moved if not. The
 * screen shows "recalculate" from that; the approve gate refuses on the same
 * function, so the button and the refusal cannot disagree.
 *
 * 404 `NO_DATA` covers BOTH "no such revision for this company" (API-1) and "no
 * run yet": a revision that was never calculated has no results, and answering
 * 200 with empty lists would be indistinguishable from a revision whose rows all
 * fell outside the period.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import {
  apiResult,
  apiRoute,
  isUuid,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { loadLatestRun } from "@/server/calc/run";
import { db } from "@/server/db";
import { getRevision } from "@/server/revisions/revisions";

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
  if (!isUuid(id)) return apiResult(req, { ok: false, error: "VALIDATION" });

  const revision = await getRevision(db, company.id, id);
  if (!revision) return apiResult(req, { ok: false, error: "NO_DATA" });

  const result = await loadLatestRun(db, company.id, revision);
  if (!result) return apiResult(req, { ok: false, error: "NO_DATA" });

  return apiResult(req, {
    ok: true,
    data: {
      run: result.run,
      freshness: result.freshness,
      context_status: result.contextStatus,
      lines: result.lines,
      aggregates: result.aggregates,
    },
  });
});

export const OPTIONS = optionsHandler;
