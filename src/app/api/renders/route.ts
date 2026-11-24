/**
 * GET /api/renders — the immutable renders of the session company (T5.7; DM-30,
 * REN-5, О-14).
 *
 * `?revision_id=<uuid>` narrows the list to one revision; without it the whole
 * company's renders come back, newest first. Both are tenant-pinned, so a
 * foreign `revision_id` reads as an empty list rather than as another company's
 * reports (API-1).
 *
 * `data.read`, not `data.review`. Producing a render is a review act; SEEING
 * that a report was published, in which language, from which run and under which
 * hash, is what everyone working on the period needs — and it is the same
 * capability the evidence register and the results endpoint answer to.
 *
 * NO PLAN GATE HERE. PG-2 gates producing an `xlsx`, not listing one that was
 * already produced: a company that downgrades must still be able to find the
 * reports it paid for.
 *
 * `storage_key` is not in the response — `serialiseRender` withholds it, and the
 * bytes have exactly one door (`GET /api/renders/[id]/download`).
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
import { listRenders, serialiseRender } from "@/server/render/persist";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  // A malformed filter is treated as no filter would be a silent widening, so
  // it answers an empty list instead: the caller asked about something that
  // cannot exist.
  const requested = new URL(req.url).searchParams.get("revision_id");
  if (requested !== null && !isUuid(requested)) {
    return apiResult(req, { ok: true, data: { renders: [] } });
  }

  const rows = await listRenders(db, company.id, requested ?? undefined);
  return apiResult(req, {
    ok: true,
    data: { renders: rows.map(serialiseRender) },
  });
});

export const OPTIONS = optionsHandler;
