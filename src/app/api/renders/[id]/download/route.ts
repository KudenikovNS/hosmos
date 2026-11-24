/**
 * GET /api/renders/:id/download — the bytes of one immutable render (T5.7;
 * REN-5, EV-0, О-14).
 *
 * TENANT-PINNED, SO A FOREIGN ID IS A 404. `getRender` looks the row up under
 * the session's company; an id belonging to another company answers exactly as
 * an id that never existed, because anything else turns this endpoint into a
 * confirmation oracle for other tenants' report ids.
 *
 * `data.read`, matching `GET /api/renders`: what is downloadable is what is
 * listable. There is no confidentiality axis on a render as there is on evidence
 * (EV-6) — a render is the company's own published report, assembled from data
 * every `data.read` holder can already see through `/api/revisions/:id/results`.
 *
 * MISSING BYTES ARE A 404, NOT A 500, for the reason the document download
 * gives: a row whose file is gone is a broken artefact, not a broken server.
 * It should be impossible here — the row is inserted only after the bytes are
 * stored, and nothing deletes a render — so the case exists to be answered
 * honestly rather than to be expected.
 *
 * NO PLAN GATE (PG-2 gates producing a format, not reading one already
 * produced) and no `Content-Length`: `report_render` stores the hash, not the
 * size, and inventing one from a `stat` would be a second source of truth about
 * a file that is already pinned by its digest.
 *
 * PATTERN 2 (CORS): every response, including the streamed one.
 */
import "server-only";

import {
  apiResult,
  apiRoute,
  apiStream,
  isUuid,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { contentDisposition } from "@/server/evidence/documents";
import { getRender, renderFileName, renderMime } from "@/server/render/persist";
import {
  DocumentStorageError,
  documentStorage,
} from "@/server/storage/document-storage";

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
  if (!isUuid(id)) return apiResult(req, { ok: false, error: "NO_DATA" });

  const render = await getRender(db, company.id, id);
  if (!render) return apiResult(req, { ok: false, error: "NO_DATA" });

  let stream;
  try {
    stream = await documentStorage.getStream(render.row.storageKey);
  } catch (error) {
    if (
      error instanceof DocumentStorageError &&
      (error.code === "NOT_FOUND" || error.code === "INVALID_KEY")
    ) {
      return apiResult(req, { ok: false, error: "NO_DATA" });
    }
    throw error;
  }

  return apiStream(req, stream, {
    "Content-Type": renderMime(render.row),
    "Content-Disposition": contentDisposition(renderFileName(render)),
    // A published report is never a public asset; a CDN or a shared proxy
    // caching it would hand one tenant's report to the next request that
    // guessed the id.
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
});

export const OPTIONS = optionsHandler;
