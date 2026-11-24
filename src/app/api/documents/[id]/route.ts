/**
 * DELETE /api/documents/[id] — remove a document and, when nothing else needs
 * them, its bytes (DATA-MODEL T4.1; EV-3, D6, §12.2).
 *
 * `company.manage`, NOT `data.write`. Deleting evidence is the one evidence
 * action that cannot be undone from inside the app — the bytes are gone, and
 * every figure that cited them loses its backing — so it sits with the role that
 * administers the company rather than with the role that records data. §12.2
 * spells this out and it is the difference the acceptance criteria check: a
 * `contributor` may upload all day and may not delete.
 *
 * 404 SEMANTICS (EV-6). Another company's id and an id that never existed are
 * the same answer, because the lookup is tenant-pinned: nothing here can be used
 * to discover that a document exists somewhere else.
 *
 * VAL-010 (EV-3, added by T4.2 with the links it needed): a document still cited
 * by a row of a LOCKED revision is not deletable, and the refusal is 422 with
 * `{rules: [VAL-010]}` — the API-1 shape every blocking rule travels in — rather
 * than a 404 or a 409. The decision is `@/server/evidence/documents`'; this route
 * only chooses the status.
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
import { deleteDocument } from "@/server/evidence/documents";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "company.manage");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  // A non-uuid would reach Postgres as a malformed literal → 500 (isUuid).
  if (!isUuid(id)) return apiResult(req, { ok: false, error: "NO_DATA" });

  const result = await deleteDocument(db, company.id, id);
  if (!result.ok) {
    return result.error === "LOCKED"
      ? apiValidationDetail(req, { rules: result.rules })
      : apiResult(req, { ok: false, error: "NO_DATA" });
  }

  return apiResult(req, {
    ok: true,
    data: {
      id: result.row.id,
      // Whether the blob went too: `false` means another `document` row of this
      // company still points at the same content-addressed key (EV-0 dedup).
      bytes_removed: result.bytesRemoved,
    },
  });
});

export const OPTIONS = optionsHandler;
