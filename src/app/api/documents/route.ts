/**
 * GET / POST /api/documents — the evidence library of the session company
 * (DATA-MODEL T4.1; DM-24, EV-0, EV-1, EV-6, §12.2).
 *
 * See docs/decisions/app-api-documents-route.md for the full account.
 */
import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { getEntitlements } from "@/server/billing/guard";
import { db } from "@/server/db";
import {
  listDocuments,
  serialiseDocument,
  uploadDocument,
} from "@/server/evidence/documents";

/**
 * Slack over the plan's byte cap for the multipart envelope itself — part
 * headers, boundaries and the handful of small text fields of DM-24.
 *
 * It exists so the cheap pre-check can never refuse a LEGITIMATE at-the-limit
 * upload: a real envelope for this form is a few hundred bytes, so 64 KiB is
 * three orders of magnitude of headroom. Anything inside the allowance falls
 * through to the exact streaming counter, which is where the decision belongs.
 */
const MULTIPART_ENVELOPE_ALLOWANCE = 64 * 1024;

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  // The listing is METADATA, and metadata is `data.read` even for a
  // `confidential` document: an evidence panel has to be able to say "this
  // figure is backed by three documents" to everyone who may read the figure.
  // EV-6 gates the CONTENTS, and that gate lives on the download route.
  //
  // WITH ONE FIELD EXCEPTED. `file_hash` is a function of the contents, not a
  // fact about the document, so for a `confidential` row it is withheld from a
  // caller who could not download it either — the same `data.review` test the
  // download route makes, applied to the one field that leaks the bytes it
  // protects. See `serialiseDocument` for the argument and its cost.
  const canReadConfidential =
    requireCapability(session, "data.review") === null;
  const rows = await listDocuments(db, company.id);
  return apiResult(req, {
    ok: true,
    data: {
      documents: rows.map((row) =>
        serialiseDocument(row, { canReadConfidential }),
      ),
    },
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

  const entitlements = await getEntitlements(session);
  // `writeFeatures`, not `features`: uploading is a write, and a lapsed
  // subscription must be refused against the cap that will actually apply (§9).
  const maxSizeBytes = entitlements.writeFeatures.maxUploadMb * 1024 * 1024;

  // (a) The pre-check — see the header. It can only run against a DECLARED
  // length, so a body that declares none is refused 411 rather than let through.
  //
  // WHY 411 AND NOT "FALL THROUGH TO (b)". `req.formData()` is not a stream: it
  // PARSES AND BUFFERS the whole body before it returns, and only then can the
  // streaming counter inside `put` see a single byte. So for a chunked upload
  // the exact check runs strictly AFTER the memory has already been taken, and
  // there is no bound on it other than a check that has by then lost. An
  // authenticated `data.write` caller could hold the worker's heap open with one
  // request; on a shared cPanel host that is the whole process. Requiring the
  // length puts the cheap refusal back in front of the parser, which is the only
  // place a bound can be enforced without rewriting the multipart parser.
  //
  // WHAT IT COSTS: nothing this app ships. The one upload client is the
  // `/evidence` panel, which posts a `FormData` through `fetch` — a body of
  // known size, for which every browser (and undici, and curl) computes and
  // sends `Content-Length`; a request body is only chunked when it is handed
  // over as a `ReadableStream`, which no code here does. An unparseable length
  // is refused for the same reason as a missing one: the pre-check cannot run.
  const declared = req.headers.get("content-length");
  const length = declared === null ? Number.NaN : Number(declared);
  if (!Number.isFinite(length) || length < 0) {
    return apiResult(req, { ok: false, error: "LENGTH_REQUIRED" });
  }
  if (length > maxSizeBytes + MULTIPART_ENVELOPE_ALLOWANCE) {
    return apiResult(req, { ok: false, error: "PLAN_REQUIRED" });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return apiValidationDetail(req, { field: "file" });

  const result = await uploadDocument(db, form, {
    companyId: company.id,
    userId: session.userId,
    maxSizeBytes,
  });

  // (b) The streaming counter refused: 402, exactly like the pre-check, because
  // the customer's answer is the same either way — a bigger plan, not a different
  // request. Nothing was written: `put` aborts before the object exists.
  if (!result.ok && result.error === "TOO_LARGE") {
    return apiResult(req, { ok: false, error: "PLAN_REQUIRED" });
  }
  if (!result.ok) {
    return apiValidationDetail(
      req,
      result.error === "RULES"
        ? { rules: result.rules }
        : {
            field: result.field,
            // Партия 24 — `reason` when there is one, so an API caller (and the
            // panel) can say «this type is not accepted» rather than «field».
            ...(result.reason ? { reason: result.reason } : {}),
          },
    );
  }

  return apiResult(req, {
    ok: true,
    data: {
      // The uploader supplied the bytes, so echoing their hash tells them
      // nothing they did not already know — but the answer is serialised by the
      // same rule as the listing so that ONE reading of EV-6 governs the field
      // everywhere, rather than two that have to be kept in agreement.
      document: serialiseDocument(result.row, {
        canReadConfidential: requireCapability(session, "data.review") === null,
      }),
      // EV-0: identical bytes are ONE file. The client is told, because the row
      // it just created shares its storage with another one and "uploaded" would
      // otherwise be a lie about what happened.
      deduplicated: result.deduplicated,
      // EV-1 / VAL-013: a duplicate is accepted and explained, not refused.
      warnings: result.warnings,
    },
  });
});

export const OPTIONS = optionsHandler;
