/**
 * GET /api/revisions/:id — the summary of one report revision (T2.6, §12.2:
 * "статус, счётчики, валидация, прогон").
 *
 * THE ONE READ THE REPORT SCREEN OPENS WITH. Four facts, none of them computed
 * on the fly: the revision itself (status and every actor stamp), the derived
 * `period_status` of its period (LC-2), how many current input rows it holds and
 * how many are approved (§5.1's submit precondition, visible before it refuses),
 * the stored validation counts, and the latest calculation run. Like
 * `/api/revisions/[id]/validation` it REPORTS and never re-runs: a GET that
 * silently recomputed would make opening a screen cost an unpredictable amount
 * and could flip a result under a reviewer mid-review (VR-2).
 *
 * PATTERN 3: the id is the TARGET; the company comes from `getSession()` and
 * pins the query, so a foreign revision is `NO_DATA` (404) and never another
 * tenant's report. `data.read` — every member sees it, which is the point of a
 * two-level review (D16).
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
import { db } from "@/server/db";
import { getRevision, summariseRevision } from "@/server/revisions/revisions";

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

  const row = await getRevision(db, company.id, id);
  if (!row) return apiResult(req, { ok: false, error: "NO_DATA" });

  return apiResult(req, {
    ok: true,
    data: await summariseRevision(db, company.id, row),
  });
});

export const OPTIONS = optionsHandler;
