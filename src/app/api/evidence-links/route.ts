/**
 * GET / POST /api/evidence-links — the document ↔ object links of the session
 * company (DATA-MODEL T4.2; DM-25, DM-26, EV-2, EV-4, §12.2).
 *
 * PATTERN 3 (§0.1): the tenant comes ONLY from `getSession()`. The body names
 * two ENDS (`documentId`, `objectType`+`objectId`) and no tenant, and BOTH ends
 * are resolved inside the session company before anything is written — which
 * matters more here than anywhere else in the API, because `linked_object_id`
 * carries no foreign key (К-8) and so nothing in the database would object to a
 * link into another tenant's rows. `@/server/evidence/links` spells out the four
 * places the pin is applied.
 *
 * GUARD ORDER (§0.2): 401 no session → 404 no company → 403 capability → 422
 * body. Reading is `data.read`, linking is `data.write` (§12.2) — attaching an
 * invoice to a figure is recording data, not administering the company, which is
 * exactly the difference from `DELETE /api/documents/[id]` (`company.manage`):
 * that one destroys a file, this one states a relationship.
 *
 * NO PLAN GATE. PG-1 caps the SIZE of an upload and the size of the
 * organisation; nothing in the tariff counts how many figures a document backs,
 * and refusing a link would be charging for the audit trail.
 *
 * THE TWO REFUSALS ARE DIFFERENT ANSWERS (API-1): a malformed field or an end
 * that does not exist for this company is `{error:"VALIDATION", field}`, while a
 * blocking rule is `{error:"VALIDATION", rules:[…]}` — today VAL-010, the freeze
 * that covers links as well as rows (LC-8(2)).
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 *
 * Response: `ActionResult<{links}>` / `ActionResult<{link, created, warnings}>`.
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
import {
  createLink,
  listLinks,
  parseNewLink,
  serialiseEvidenceLink,
} from "@/server/evidence/links";
import { isObjectType } from "@/shared/enums";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  // The two directions of DM-25, as query parameters (snake_case, like every
  // other filter in this API): `?document_id=` answers "where is this document
  // used", `?object_type=&object_id=` answers "which documents back this row".
  // Neither is required — an unfiltered list is the company's whole link table,
  // which is what an evidence overview screen wants — but a MALFORMED filter is
  // refused rather than ignored: silently listing everything for a mistyped id
  // would look like "this row has links" to the caller.
  const url = new URL(req.url);
  const documentId = url.searchParams.get("document_id");
  if (documentId !== null && !isUuid(documentId)) {
    return apiValidationDetail(req, { field: "document_id" });
  }
  const objectId = url.searchParams.get("object_id");
  if (objectId !== null && !isUuid(objectId)) {
    return apiValidationDetail(req, { field: "object_id" });
  }
  const objectType = url.searchParams.get("object_type");
  if (objectType !== null && !isObjectType(objectType)) {
    return apiValidationDetail(req, { field: "object_type" });
  }

  const rows = await listLinks(db, company.id, {
    documentId: documentId ?? undefined,
    objectType: objectType ?? undefined,
    objectId: objectId ?? undefined,
  });
  return apiResult(req, {
    ok: true,
    data: { links: rows.map(serialiseEvidenceLink) },
  });
});

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.write");
  if (forbidden) return apiResult(req, forbidden);

  const body = await req.json().catch(() => null);
  const parsed = parseNewLink(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await createLink(
    db,
    { companyId: company.id, userId: session.userId },
    parsed.values,
  );
  if (!result.ok) {
    return apiValidationDetail(
      req,
      result.error === "RULES"
        ? { rules: result.rules }
        : { field: result.field },
    );
  }

  return apiResult(req, {
    ok: true,
    data: {
      link: serialiseEvidenceLink(result.row),
      // `false` means the pair was already linked and this request changed
      // nothing — the UNIQUE of DM-25 doing its job. The client is told, because
      // "created" would otherwise be a claim about a row that predates it.
      created: result.created,
      // EV-4 / VAL-037: a document whose coverage window misses the row's month
      // is attached anyway and explained, never refused.
      warnings: result.warnings,
    },
  });
});

export const OPTIONS = optionsHandler;
