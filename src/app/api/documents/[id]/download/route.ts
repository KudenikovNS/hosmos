/**
 * GET /api/documents/[id]/download — the bytes of one document (DATA-MODEL
 * T4.1; EV-0, EV-6, §12.2).
 *
 * EV-6 IS TWO CHECKS, NOT ONE, and they answer differently on purpose:
 *
 *   • `company_id` + `data.read` — who may read this company's evidence at all.
 *     A document of ANOTHER company is 404 (`NO_DATA`), the same answer as an id
 *     that never existed, because the lookup is tenant-pinned: the endpoint
 *     cannot be used to confirm that some other tenant holds a given document.
 *   • `confidentiality = 'confidential'` additionally requires `data.review`,
 *     and a caller without it gets 403, NOT 404. The difference is deliberate.
 *     404 is for "there is nothing here for you"; this document IS here, the
 *     caller can already see it in `GET /api/documents` (metadata is `data.read`),
 *     and what is being refused is the CONTENT. Answering 404 would tell a
 *     contributor that the reviewer's document does not exist — which is both
 *     false and a worse user experience than being told they need review rights.
 *
 * MISSING BYTES ARE 404, NOT 500. A row whose file is gone is a broken document,
 * not a broken server; the blocking integrity rule for it is VAL-036, evaluated
 * at approve/lock by T4.4 (EV-5). A download just says there is nothing to send.
 *
 * PATTERN 2 (CORS): every response, including the streamed one (`apiStream`),
 * plus the OPTIONS preflight.
 */
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
import { contentDisposition, getDocument } from "@/server/evidence/documents";
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

  const row = await getDocument(db, company.id, id);
  if (!row) return apiResult(req, { ok: false, error: "NO_DATA" });

  // EV-6, second half — decided from the ROW, after the tenant check, so the
  // confidentiality of another company's document is never even consulted.
  if (row.confidentiality === "confidential") {
    const unreviewed = requireCapability(session, "data.review");
    if (unreviewed) return apiResult(req, unreviewed);
  }

  let stream;
  try {
    stream = await documentStorage.getStream(row.storageKey);
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
    "Content-Type": row.mime ?? "application/octet-stream",
    "Content-Disposition": contentDisposition(row.fileName),
    // Evidence is never a public asset, and a CDN or a shared proxy caching a
    // `confidential` document would undo EV-6 one hop past the guard.
    "Cache-Control": "private, no-store",
    // Belt and braces for an image or a PDF served from the API origin: the
    // bytes are user-supplied and must never be sniffed into something active.
    "X-Content-Type-Options": "nosniff",
    ...(row.sizeBytes === null
      ? {}
      : { "Content-Length": String(row.sizeBytes) }),
  });
});

export const OPTIONS = optionsHandler;
