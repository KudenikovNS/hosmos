/**
 * GET /api/revisions/:id/validation — the stored validation results of one
 * report revision (T2.1, DM-28).
 *
 * A READ: `data.read`, which every member holds. Results are facts about the
 * report, and a reviewer or auditor who cannot write must still see why a
 * submit would be refused.
 *
 * PATTERN 3: the revision id is the TARGET, never the identity — the company
 * comes from `getSession()` and pins the query, so a foreign revision id is
 * `NO_DATA` (404) and never another tenant's findings.
 *
 * The endpoint reads `validation_result` and does NOT re-run anything: a run is
 * an explicit action (`POST /api/validation/run`) or a side effect of a save /
 * submit / approve (VR-2). A GET that silently recomputed would make the cost
 * of opening a screen unpredictable and could flip a result under a reviewer
 * mid-review.
 *
 * Response: `ActionResult<{results, blocking}>`, newest evaluation first.
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import { and, eq } from "drizzle-orm";

import {
  apiResult,
  apiRoute,
  isUuid,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { reportRevision } from "@/server/db/schema";
import {
  blockingFailures,
  listValidationResults,
} from "@/server/validation/run";

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

  // Tenant-pinned existence check: a foreign revision is indistinguishable from
  // a missing one (404), which is the point.
  const [revision] = await db
    .select({ id: reportRevision.id })
    .from(reportRevision)
    .where(
      and(eq(reportRevision.id, id), eq(reportRevision.companyId, company.id)),
    )
    .limit(1);
  if (!revision) return apiResult(req, { ok: false, error: "NO_DATA" });

  const results = await listValidationResults(db, company.id, id);
  return apiResult(req, {
    ok: true,
    data: { results, blocking: blockingFailures(results) },
  });
});

export const OPTIONS = optionsHandler;
