/**
 * DELETE /api/evidence-links/[id] — unlink a document from an object
 * (DATA-MODEL T4.2; EV-3, DM-26, §12.2).
 *
 * UNLINKING IS NOT DELETING, and the two verbs living on two different routes is
 * the whole of EV-3. This removes ONE `evidence_link` row: the `document` row
 * stays, the bytes on disk stay, and every OTHER figure the same document backs
 * keeps its link. Destroying a file is `DELETE /api/documents/[id]`, it is
 * `company.manage`, and it is the only thing in the app that touches storage.
 *
 * `data.write` (§12.2), not `company.manage`: saying "this invoice does not
 * actually back this figure" is a correction to recorded data, made by whoever
 * records it.
 *
 * 404 SEMANTICS: the lookup is tenant-pinned, so another company's link id and
 * an id that never existed are the same `NO_DATA`.
 *
 * 422 VAL-010 (LC-8(2)): a link whose target row belongs to a LOCKED revision
 * cannot be torn off — a published report's evidence is part of what it
 * published. Same code, same payload shape as every other blocking rule (API-1).
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
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
import { deleteLink } from "@/server/evidence/links";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.write");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  // A non-uuid would reach Postgres as a malformed literal → 500 (isUuid).
  if (!isUuid(id)) return apiResult(req, { ok: false, error: "NO_DATA" });

  const result = await deleteLink(db, company.id, id);
  if (!result.ok) {
    return result.error === "LOCKED"
      ? apiValidationDetail(req, { rules: result.rules })
      : apiResult(req, { ok: false, error: "NO_DATA" });
  }

  return apiResult(req, {
    ok: true,
    data: {
      id: result.row.id,
      // EV-3, stated on the wire: the file is still there. A client that just
      // removed the last link to a document must not assume it is gone.
      document_id: result.row.documentId,
    },
  });
});

export const OPTIONS = optionsHandler;
