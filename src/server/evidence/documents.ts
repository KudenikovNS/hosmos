// DOCUMENTS — the metadata half of evidence (spec §4.16 DM-24, §8 EV-0/EV-1/EV-6).
//
// See docs/decisions/server-evidence-documents.md for the full account.
import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { isoDateOrNull, oneOfOrNull, textOrNull } from "@/server/api/parse";
import type { DbClient } from "@/server/db/client";
import { document } from "@/server/db/schema";
import {
  DocumentStorageError,
  documentStorage,
  type DocumentStorage,
  type PutResult,
} from "@/server/storage/document-storage";
import {
  ruleRef,
  writeValidated,
  type RuleRef,
} from "@/server/validation/write";
import { isConfidentiality, type FileType } from "@/shared/enums";

import { documentHasLockedLinks } from "./links";
import {
  deleteUnreferencedBlob,
  prepareBlobReference,
} from "@/server/storage/blob-references";

/** A `document` row as the database returns it. */
export type DocumentRow = typeof document.$inferSelect;

// ─── The MIME allowlist (EV-0) ───────────────────────────────────────────────

/** One accepted upload type: its canonical MIME, its `file_type` bucket, its extensions. */
interface AllowedUploadType {
  /** Stored in `document.mime` — the CANONICAL type, not whatever the client said. */
  readonly mime: string;
  /** `document.file_type` (DM-24) — the broad bucket, `FileType`. */
  readonly fileType: FileType;
  /** Lowercase filename suffixes that may carry this type. */
  readonly extensions: readonly string[];
}

/**
 * The six accepted types of EV-0, spelled out rather than pattern-matched.
 *
 * `xls` maps onto the `xlsx` BUCKET because `FileType` has five values
 * (pdf/xlsx/csv/image/other) and the legacy Excel format is a spreadsheet by
 * every use the bucket is read for; the exact type survives in `document.mime`,
 * which is what a download sends back.
 */
export const ALLOWED_UPLOAD_TYPES: readonly AllowedUploadType[] = [
  { mime: "application/pdf", fileType: "pdf", extensions: [".pdf"] },
  {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileType: "xlsx",
    extensions: [".xlsx"],
  },
  { mime: "application/vnd.ms-excel", fileType: "xlsx", extensions: [".xls"] },
  { mime: "text/csv", fileType: "csv", extensions: [".csv"] },
  { mime: "image/png", fileType: "image", extensions: [".png"] },
  { mime: "image/jpeg", fileType: "image", extensions: [".jpg", ".jpeg"] },
];

/**
 * Types a browser sends when it has no opinion. They are ACCEPTED as "no claim
 * made" and the extension decides — but they never let an extension through
 * that the allowlist does not already contain.
 */
const UNSPECIFIC_MIMES = new Set(["", "application/octet-stream"]);

/** `Content-Type: text/csv; charset=utf-8` → `text/csv`. */
function bareMime(raw: string): string {
  return raw.split(";")[0].trim().toLowerCase();
}

/**
 * Decide the upload's type from the multipart part headers, or `undefined` to
 * refuse it (422).
 *
 * BOTH HALVES MUST AGREE and neither is trusted alone. The declared
 * `Content-Type` is client-controlled, so `payload.exe` announced as
 * `application/pdf` must not pass; the extension is client-controlled too, so
 * `invoice.pdf` announced as `application/x-msdownload` must not pass either.
 * Requiring agreement means a refusal needs the client to be consistent about a
 * type that is on the list anyway — at which point what is stored and what is
 * served back are the same thing, which is all the allowlist is protecting.
 */
function resolveUploadType(
  declaredMime: string,
  fileName: string,
): AllowedUploadType | undefined {
  const mime = bareMime(declaredMime);
  const lower = fileName.toLowerCase();
  const byExtension = ALLOWED_UPLOAD_TYPES.find((t) =>
    t.extensions.some((ext) => lower.endsWith(ext)),
  );
  if (!byExtension) return undefined;
  if (UNSPECIFIC_MIMES.has(mime)) return byExtension;
  return mime === byExtension.mime ? byExtension : undefined;
}

// ─── The multipart part ──────────────────────────────────────────────────────

/**
 * The subset of `File` this module uses. Structural rather than `instanceof
 * File` because the value comes out of `FormData` typed as `FormDataEntryValue`,
 * and a structural check states exactly what is required of it.
 */
interface UploadPart {
  readonly name: string;
  readonly type: string;
  stream(): ReadableStream<Uint8Array>;
}

/** True when the `file` field of the form is an actual file part, not a text field. */
function isUploadPart(value: unknown): value is UploadPart {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UploadPart).name === "string" &&
    typeof (value as UploadPart).type === "string" &&
    typeof (value as UploadPart).stream === "function"
  );
}

// ─── The metadata fields (DM-24) ─────────────────────────────────────────────

/** The DM-24 columns a client may set; everything else is service-owned. */
interface DocumentMeta {
  fileName: string;
  issuer: string | null;
  documentDate: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  confidentiality: string;
  retentionDate: string | null;
}

/** A filename with no path and no control characters — see `contentDisposition`. */
function safeFileName(raw: string): string {
  const flat = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "_");
  const trimmed = flat.trim();
  return trimmed === "" ? "upload" : trimmed.slice(0, 255);
}

/**
 * Parse the text fields of the multipart form. `file_name` defaults to the
 * part's own filename; `confidentiality` defaults to `internal` (DM-24 — an
 * uploaded invoice is not public until someone says so).
 */
function parseDocumentMeta(
  form: FormData,
  partName: string,
): { ok: true; values: DocumentMeta } | { ok: false; field: string } {
  const fileName = textOrNull(form.get("file_name"));
  if (fileName === undefined) return { ok: false, field: "file_name" };

  const issuer = textOrNull(form.get("issuer"));
  if (issuer === undefined) return { ok: false, field: "issuer" };

  const dates: Array<[keyof DocumentMeta, string]> = [
    ["documentDate", "document_date"],
    ["coverageStart", "coverage_start"],
    ["coverageEnd", "coverage_end"],
    ["retentionDate", "retention_date"],
  ];
  const parsedDates: Record<string, string | null> = {};
  for (const [column, field] of dates) {
    const value = isoDateOrNull(form.get(field));
    if (value === undefined) return { ok: false, field };
    parsedDates[column] = value;
  }

  const confidentiality = oneOfOrNull(
    form.get("confidentiality"),
    isConfidentiality,
  );
  if (confidentiality === undefined) {
    return { ok: false, field: "confidentiality" };
  }

  return {
    ok: true,
    values: {
      fileName: safeFileName(fileName ?? partName),
      issuer,
      documentDate: parsedDates.documentDate,
      coverageStart: parsedDates.coverageStart,
      coverageEnd: parsedDates.coverageEnd,
      confidentiality: confidentiality ?? "internal",
      retentionDate: parsedDates.retentionDate,
    },
  };
}

// ─── Upload (EV-1) ───────────────────────────────────────────────────────────

/** Outcome of an upload. Each refusal maps to exactly one HTTP answer at the route. */
export type DocumentUploadResult =
  | {
      ok: true;
      row: DocumentRow;
      /** Identical bytes were already stored: one file, a second row (EV-1). */
      deduplicated: boolean;
      /** Non-blocking failures of the same run — VAL-013 lives here. */
      warnings: RuleRef[];
    }
  /** Over the plan's `maxUploadMb` — 402 `PLAN_REQUIRED`, never 413 (§7.1). */
  | { ok: false; error: "TOO_LARGE" }
  /**
   * A malformed or unsupported field — 422 naming it (API-1). Партия 24 adds
   * `reason`: «the file field is wrong» and «this type is not on the allowlist»
   * are the same 422 to a machine and two different problems to a person.
   */
  | {
      ok: false;
      error: "VALIDATION";
      field: string;
      reason?: "unsupported_type";
    }
  /** Blocking rules refused the row — 422 carrying the codes (API-1). */
  | { ok: false; error: "RULES"; rules: RuleRef[] };

/** What the caller must resolve before an upload can be judged. */
export interface UploadContext {
  readonly companyId: string;
  /** `profiles.id` of the uploader — from the session, never from the wire (PATTERN 3). */
  readonly userId: string;
  /** `PlanFeatures.maxUploadMb × 1024²`, resolved by the route's plan gate. */
  readonly maxSizeBytes: number;
  /** Swappable for tests; defaults to the app-wide singleton. */
  readonly storage?: DocumentStorage;
}

/**
 * Store the bytes and write the metadata row (EV-1).
 *
 * The refusals happen in cost order: the form's own shape, then the type (both
 * free), then the bytes. `put` is the last thing reached and the FIRST thing
 * that touches a disk.
 */
export async function uploadDocument(
  db: DbClient,
  form: FormData,
  ctx: UploadContext,
): Promise<DocumentUploadResult> {
  const part = form.get("file");
  if (!isUploadPart(part))
    return { ok: false, error: "VALIDATION", field: "file" };

  const meta = parseDocumentMeta(form, part.name);
  if (!meta.ok) return { ok: false, error: "VALIDATION", field: meta.field };

  // EV-0's allowlist, BEFORE any byte is handed to storage.
  const type = resolveUploadType(part.type, meta.values.fileName);
  if (!type)
    return {
      ok: false,
      error: "VALIDATION",
      field: "file",
      reason: "unsupported_type",
    };

  const storage = ctx.storage ?? documentStorage;
  let stored: PutResult;
  try {
    stored = await storage.put(part.stream(), {
      companyId: ctx.companyId,
      mime: type.mime,
      // The per-plan cap. Storage counts the chunks and throws LIMIT_EXCEEDED
      // the moment it is passed, so the object is never created.
      maxSizeBytes: ctx.maxSizeBytes,
    });
  } catch (error) {
    if (
      error instanceof DocumentStorageError &&
      error.code === "LIMIT_EXCEEDED"
    ) {
      return { ok: false, error: "TOO_LARGE" };
    }
    throw error;
  }

  const written = await writeValidated(
    db,
    { companyId: ctx.companyId, scope: "record" },
    async (tx) => {
      stored = await prepareBlobReference(
        tx,
        ctx.companyId,
        stored,
        storage,
        () =>
          storage.put(part.stream(), {
            companyId: ctx.companyId,
            mime: type.mime,
            maxSizeBytes: ctx.maxSizeBytes,
          }),
      );
      const [row] = await tx
        .insert(document)
        .values({
          companyId: ctx.companyId,
          fileName: meta.values.fileName,
          fileType: type.fileType,
          mime: type.mime,
          storageKey: stored.key,
          sizeBytes: stored.sizeBytes,
          fileHash: stored.sha256,
          issuer: meta.values.issuer,
          documentDate: meta.values.documentDate,
          coverageStart: meta.values.coverageStart,
          coverageEnd: meta.values.coverageEnd,
          confidentiality: meta.values.confidentiality,
          retentionDate: meta.values.retentionDate,
          uploadedBy: ctx.userId,
        })
        .returning();
      return row;
    },
  ).catch(async (error) => {
    // A commit acknowledgement may have been lost: count both owner tables
    // before any cleanup, and keep bytes if the DB cannot establish the result.
    await deleteUnreferencedBlob(db, ctx.companyId, stored.key, storage);
    throw error;
  });

  if (!written.ok) {
    await deleteUnreferencedBlob(db, ctx.companyId, stored.key, storage);
    return written.error === "VALIDATION"
      ? { ok: false, error: "RULES", rules: written.rules }
      : { ok: false, error: "VALIDATION", field: "file" };
  }

  return {
    ok: true,
    row: written.row,
    deduplicated: stored.deduplicated,
    warnings: written.warnings,
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** The company's documents, newest upload first. Tenant-pinned (PATTERN 3). */
export async function listDocuments(
  db: DbClient,
  companyId: string,
): Promise<DocumentRow[]> {
  return db
    .select()
    .from(document)
    .where(eq(document.companyId, companyId))
    .orderBy(desc(document.uploadedAt), desc(document.id));
}

/**
 * One document OF THIS COMPANY, or `undefined`.
 *
 * The tenant pin is the whole 404 semantics of EV-6: another company's id is
 * indistinguishable from an id that never existed, so a caller cannot use the
 * endpoint to discover that a document exists elsewhere.
 */
export async function getDocument(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<DocumentRow | undefined> {
  const [row] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), eq(document.companyId, companyId)))
    .limit(1);
  return row;
}

// ─── Delete (EV-3, D6) ───────────────────────────────────────────────────────

/** What a delete did: which row went, and whether its bytes went with it. */
export type DocumentDeleteResult =
  | { ok: true; row: DocumentRow; bytesRemoved: boolean }
  | { ok: false; error: "NOT_FOUND" }
  /** Evidence still cited by a locked revision is retained (VAL-010). */
  | { ok: false; error: "LOCKED"; rules: RuleRef[] };
/** Delete metadata first, then collect bytes only if neither owner table needs them. */
export async function deleteDocument(
  db: DbClient,
  companyId: string,
  id: string,
  storage: DocumentStorage = documentStorage,
): Promise<DocumentDeleteResult> {
  const outcome = await db.transaction(
    async (tx): Promise<DocumentDeleteResult> => {
      // Before the delete, because `evidence_link.document_id` is ON DELETE
      // CASCADE: after it there are no links left to judge. A document that does
      // not exist here has no links either, so this cannot answer LOCKED for an
      // id that would otherwise be NOT_FOUND.
      if (await documentHasLockedLinks(tx, companyId, id)) {
        return { ok: false, error: "LOCKED", rules: [ruleRef("VAL-010")] };
      }

      const [row] = await tx
        .delete(document)
        .where(and(eq(document.id, id), eq(document.companyId, companyId)))
        .returning();
      if (!row) return { ok: false, error: "NOT_FOUND" };

      return { ok: true, row, bytesRemoved: false };
    },
  );

  // Metadata has committed. Cleanup has its own read-only transaction/key lock;
  // a DB/storage failure must never turn an already committed delete into a 500.
  if (!outcome.ok) return outcome;
  return {
    ...outcome,
    bytesRemoved: await deleteUnreferencedBlob(
      db,
      companyId,
      outcome.row.storageKey,
      storage,
    ),
  };
}

// ─── The wire contract ───────────────────────────────────────────────────────

/** `document` as the API returns it (§4.16 field names, snake_case on the wire). */
export interface DocumentDto {
  id: string;
  file_name: string;
  file_type: string;
  mime: string | null;
  size_bytes: number | null;
  /** `null` when EV-6 withholds it — see {@link serialiseDocument}. */
  file_hash: string | null;
  issuer: string | null;
  document_date: string | null;
  coverage_start: string | null;
  coverage_end: string | null;
  confidentiality: string;
  retention_date: string | null;
  uploaded_by: string;
  uploaded_at: string | null;
}

/** What the caller is allowed to be told about a row (see `serialiseDocument`). */
export interface DocumentSerialiseOptions {
  /**
   * True when the caller holds `data.review` — the SAME capability the download
   * route requires for a `confidential` document. Defaults to `false`, so a
   * caller that forgets to pass it under-shares rather than over-shares.
   */
  readonly canReadConfidential?: boolean;
}

/**
 * Row → DTO. `storage_key` is deliberately NOT on the wire: it is the blob
 * backend's addressing scheme (EV-0), it changes the day the backend becomes S3,
 * and a client that learned to build one would be reaching past the download
 * route that enforces EV-6.
 *
 * `file_hash` IS on the wire — it is the dedup hint VAL-013 speaks about and the
 * client needs it to explain the warning — EXCEPT for a `confidential` document
 * read by a caller without `data.review`, where it is `null`.
 *
 * WHY. The listing is `data.read` and that is right: an evidence panel must be
 * able to say "this figure is backed by three documents" to everyone who may
 * read the figure. But a SHA-256 of the contents is not a fact ABOUT the
 * document, it is a function OF the document, and evidence is drawn from a small
 * space — a standard form, a known payroll layout, a template with three
 * variable fields. Against such content a hash is a confirmation oracle: guess
 * the bytes offline, hash them, compare, and learn the contents of exactly the
 * document EV-6 refuses to send you, in silence, with no download and no audit
 * trail. The 403 on the bytes is worth only as much as the metadata beside it.
 *
 * WHY THIS LINE AND NOT A NARROWER ONE. Withholding it from EVERY caller would
 * break the dedup hint for the ordinary case it was built for; withholding it
 * only from other TENANTS is already covered (the listing is tenant-pinned).
 * `confidential` + `data.review` is exactly the pair the download route uses, so
 * the metadata now refuses in the same voice and to the same people as the
 * bytes, and nothing that could already read the contents loses anything.
 *
 * WHAT IT COSTS. A `data.read`-only caller who uploads a duplicate of a
 * CONFIDENTIAL document is still told it is a duplicate — `deduplicated` and
 * VAL-013 are both computed server-side and still travel — but the client can no
 * longer name WHICH earlier document it duplicates, because the match is made by
 * comparing hashes in the browser. `duplicateHint` handles that by design (its
 * `earlier` list is allowed to be empty and the panel says the shorter
 * sentence). Public and internal documents — the overwhelming majority, and the
 * ones a contributor actually re-uploads — are unaffected.
 */
export function serialiseDocument(
  row: DocumentRow,
  options: DocumentSerialiseOptions = {},
): DocumentDto {
  const withheld =
    row.confidentiality === "confidential" && !options.canReadConfidential;
  return {
    id: row.id,
    file_name: row.fileName,
    file_type: row.fileType,
    mime: row.mime,
    size_bytes: row.sizeBytes,
    file_hash: withheld ? null : row.fileHash,
    issuer: row.issuer,
    document_date: row.documentDate,
    coverage_start: row.coverageStart,
    coverage_end: row.coverageEnd,
    confidentiality: row.confidentiality,
    retention_date: row.retentionDate,
    uploaded_by: row.uploadedBy,
    uploaded_at: row.uploadedAt ? row.uploadedAt.toISOString() : null,
  };
}

/**
 * `Content-Disposition` for a download, both spellings (RFC 6266).
 *
 * `file_name` is user input that ends up in a RESPONSE HEADER, so the ASCII
 * fallback is stripped to characters that cannot terminate the header or the
 * quoted string, and the faithful name travels in `filename*` percent-encoded.
 * `safeFileName` already removed control bytes on the way in; this is the second
 * half of the same defence, applied where the value is actually dangerous.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const fallback = ascii.trim() === "" ? "download" : ascii;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
