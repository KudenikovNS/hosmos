// [LOCAL-DB] KT-4 — THE FOUR WAYS THE EVIDENCE PATH COULD LOSE OR LEAK SOMETHING
// (EV-0, EV-1, EV-6, R-3), against a real Postgres and a real filesystem.
//
// A separate file from `evidence-dq.integration.test.ts` for one reason: the
// rollback test below has to make `writeValidated` actually roll back, which
// takes a module mock of `@/server/validation/write`, and installing that in the
// T4.1 suite would put a mock between thirty tests and the validation they are
// about. The mock here is a PASS-THROUGH until a test arms it, and what it does
// when armed is run the REAL `writeValidated` with a refusal thrown inside the
// transaction — the production mechanism, not a simulation of it.
//
// The properties this file exists to prove:
//
//   • A MULTIPART UPLOAD MUST DECLARE ITS LENGTH (411). `req.formData()` parses
//     and buffers the WHOLE body before returning, so for a body with no
//     `Content-Length` the streaming counter inside `put` is a check that runs
//     after the memory has already been taken. Requiring the length puts the
//     cheap refusal back in front of the parser.
//   • A ROLLED-BACK UPLOAD NEVER TAKES A COMMITTED DOCUMENT'S BYTES WITH IT.
//     The rollback cleanup counts the rows that still hold the key, exactly as
//     `deleteDocument` does, instead of trusting `deduplicated` alone.
//   • A DELETE THAT COMMITTED IS A DELETE. An `unlink` that fails afterwards
//     leaks an invisible blob; it must not answer 500 for a row that is gone.
//   • `file_hash` OF A CONFIDENTIAL DOCUMENT IS NOT `data.read` (EV-6). A digest
//     of contents is a confirmation oracle for the contents, so it is withheld
//     from exactly the caller the download route answers 403.
//
// FILE ISOLATION: `setupDocumentsDir()` (T1.7) gives the suite its own
// `DOCUMENTS_DIR` under `os.tmpdir()`, removed in `afterAll`. Nothing here
// writes into the repository working tree.
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

const getSessionMock = vi.fn();
vi.mock("@/server/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/session")>(
    "@/server/auth/session",
  );
  return { ...actual, getSession: () => getSessionMock() };
});

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return harness.testDbModule();
});

/**
 * The one seam this file needs: a way to make a document write ROLL BACK.
 *
 * No rule blocks a `document` row today, so `writeValidated` cannot be made to
 * refuse one by arranging data. Rather than stub the result — which would skip
 * the transaction whose rollback is the entire subject — the mock delegates to
 * the REAL `writeValidated` and wraps the caller's `write` so that the row is
 * inserted and then `refuseValidation()` is thrown while still inside the
 * transaction. That is precisely what a blocking rule does, so what
 * `uploadDocument` observes is a real rollback and a real `{ok:false}`.
 */
const rollbackNextWrite = { armed: false };
vi.mock("@/server/validation/write", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/validation/write")>();
  return {
    ...actual,
    writeValidated: (
      db: Parameters<typeof actual.writeValidated>[0],
      target: Parameters<typeof actual.writeValidated>[1],
      write: Parameters<typeof actual.writeValidated>[2],
    ) => {
      if (!rollbackNextWrite.armed)
        return actual.writeValidated(db, target, write);
      rollbackNextWrite.armed = false;
      return actual.writeValidated(db, target, async (tx) => {
        await write(tx); // the row IS inserted…
        actual.refuseValidation([]); // …and the transaction unwinds
      });
    },
  };
});

import type { NextRequest } from "next/server";

import {
  GET as documentsGET,
  POST as documentsPOST,
} from "@/app/api/documents/route";
import { resolveSessionContext } from "@/server/auth/session";
import { resetPlanFeaturesCache } from "@/server/billing/entitlements";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertPaidCompany,
  insertUserWithProfile,
  resetAppTables,
  setupDocumentsDir,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { document, reportRender } from "@/server/db/schema";
import { randomUUID } from "node:crypto";
import { insertRevision } from "@/server/db/__tests__/harness";
import {
  deleteDocument,
  serialiseDocument,
  uploadDocument,
  type DocumentRow,
} from "@/server/evidence/documents";
import {
  documentStorage,
  DocumentStorageError,
  type DocumentInput,
  type DocumentStorage,
  type PutOptions,
  type PutResult,
} from "@/server/storage/document-storage";

// ─── Multipart plumbing ──────────────────────────────────────────────────────
//
// Built by hand, as in the T4.1 suite: `new Request(url, {body: formData})`
// exposes NO `Content-Length` header, and the header is the subject of half the
// tests below. Constructing the envelope ourselves lets one request carry the
// header a browser sends and another deliberately omit it.

const BOUNDARY = "----hosmosStorageSafetyBoundary";
const enc = new TextEncoder();

function multipartBody(fileName: string, bytes: Uint8Array): Uint8Array {
  const head = enc.encode(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${BOUNDARY}--\r\n`);
  const body = new Uint8Array(
    head.byteLength + bytes.byteLength + tail.byteLength,
  );
  body.set(head, 0);
  body.set(bytes, head.byteLength);
  body.set(tail, head.byteLength + bytes.byteLength);
  return body;
}

/** An upload request; `declareLength: false` is the chunked case (no header). */
function uploadRequest(
  fileName: string,
  bytes: Uint8Array,
  declareLength = true,
): NextRequest {
  const body = multipartBody(fileName, bytes);
  const headers: Record<string, string> = {
    "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
  };
  if (declareLength) headers["content-length"] = String(body.byteLength);
  return new Request("http://api.example.com/api/documents", {
    method: "POST",
    headers,
    body: body.buffer as ArrayBuffer,
  }) as NextRequest;
}

const request = (url: string): NextRequest =>
  new Request(`http://api.example.com${url}`) as NextRequest;

const answer = async (res: Response) => ({
  status: res.status,
  body: (await res.json()) as Record<string, unknown>,
});

const pdfBytes = (marker: string): Uint8Array =>
  enc.encode(`%PDF-1.4\n% ${marker}\n%%EOF\n`);

async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

// ─── The serialiser, with no database in sight ───────────────────────────────

describe("serialiseDocument and the confidential hash (EV-6)", () => {
  const COMPANY = "33333333-2222-4333-8444-555555555555";
  const HASH = "a".repeat(64);

  const rowWith = (confidentiality: string): DocumentRow => ({
    id: "11111111-2222-4333-8444-555555555555",
    companyId: COMPANY,
    fileName: "payroll.pdf",
    fileType: "pdf",
    mime: "application/pdf",
    storageKey: `${COMPANY}/${HASH}`,
    sizeBytes: 10,
    fileHash: HASH,
    issuer: null,
    documentDate: null,
    coverageStart: null,
    coverageEnd: null,
    confidentiality,
    retentionDate: null,
    uploadedBy: "22222222-2222-4333-8444-555555555555",
    uploadedAt: new Date("2026-01-01T00:00:00Z"),
  });

  it("withholds it by DEFAULT, so a caller that forgets the option under-shares", () => {
    const dto = serialiseDocument(rowWith("confidential"));
    expect(dto.file_hash).toBeNull();
    // Everything else about the document is still metadata, still `data.read`.
    expect(dto.file_name).toBe("payroll.pdf");
    expect(dto.confidentiality).toBe("confidential");
  });

  it("reveals it to a caller holding data.review", () => {
    const dto = serialiseDocument(rowWith("confidential"), {
      canReadConfidential: true,
    });
    expect(dto.file_hash).toBe(HASH);
  });

  it("keeps it for public and internal documents whatever the caller holds", () => {
    for (const confidentiality of ["public", "internal"]) {
      expect(serialiseDocument(rowWith(confidentiality)).file_hash).toBe(HASH);
    }
  });
});

describeIntegration("api/documents storage safety [LOCAL-DB]", () => {
  const documentsDir = setupDocumentsDir();

  beforeAll(async () => {
    await setupSchema();
  });

  beforeEach(async () => {
    await resetAppTables();
    getSessionMock.mockReset();
    rollbackNextWrite.armed = false;
    for (const entry of await readdir(documentsDir.path)) {
      await rm(path.join(documentsDir.path, entry), {
        recursive: true,
        force: true,
      });
    }
  });

  afterAll(async () => {
    await closeTestDb();
    resetPlanFeaturesCache();
  });

  interface Fixture {
    companyId: string;
    adminId: string;
    contributorId: string;
  }

  async function setup(): Promise<Fixture> {
    const company = await insertPaidCompany();
    const { user: admin } = await insertUserWithProfile({
      companyId: company.id,
      role: "esg_admin",
    });
    const { user: contributor } = await insertUserWithProfile({
      companyId: company.id,
      role: "contributor",
    });
    getSessionMock.mockResolvedValue(await sessionFor(admin.id));
    return {
      companyId: company.id,
      adminId: admin.id,
      contributorId: contributor.id,
    };
  }

  async function signIn(userId: string): Promise<void> {
    getSessionMock.mockResolvedValue(await sessionFor(userId));
  }

  // ─── 411 (defect 2) ────────────────────────────────────────────────────────

  describe("a multipart upload with no declared length", () => {
    it("is refused 411 before the body is parsed", async () => {
      await setup();

      const res = await documentsPOST(
        uploadRequest("chunked.pdf", pdfBytes("chunked"), false),
      ).then(answer);

      expect(res.status).toBe(411);
      expect(res.body).toEqual({ ok: false, error: "LENGTH_REQUIRED" });
      // Nothing was parsed, so nothing was stored and no row was written.
      expect(await getTestDb().select().from(document)).toHaveLength(0);
      expect(await readdir(documentsDir.path)).toEqual([]);
    });

    it("carries CORS like every other answer (PATTERN 2)", async () => {
      await setup();
      const origin = "http://front.example.com";
      const previous = process.env.ALLOWED_ORIGINS;
      process.env.ALLOWED_ORIGINS = origin;
      try {
        const req = uploadRequest("chunked.pdf", pdfBytes("cors"), false);
        req.headers.set("origin", origin);

        const res = await documentsPOST(req);

        expect(res.status).toBe(411);
        // A refusal invented for this route must still go out through
        // `apiResult` rather than as a bare `new Response`, or it is the one
        // answer in the app a cross-origin client cannot read.
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
        expect(res.headers.get("Vary")).toContain("Origin");
      } finally {
        if (previous === undefined) delete process.env.ALLOWED_ORIGINS;
        else process.env.ALLOWED_ORIGINS = previous;
      }
    });

    it("still accepts the very same upload once the length is declared", async () => {
      // The point of the judgement: 411 is a refusal of the FRAMING, not of the
      // upload. The shipped `/evidence` panel posts a `FormData` through
      // `fetch`, which always declares a length, so this is the path it takes.
      await setup();

      const res = await documentsPOST(
        uploadRequest("declared.pdf", pdfBytes("declared"), true),
      ).then(answer);

      expect(res.status).toBe(200);
      expect(await getTestDb().select().from(document)).toHaveLength(1);
    });
  });

  // ─── The rollback / dedup race (defect 3) ──────────────────────────────────

  describe("an upload that rolls back while another dedups the same bytes", () => {
    it("keeps a report's bytes when the duplicate evidence row is rolled back", async () => {
      const fx = await setup();
      const content = pdfBytes("report-owner");
      const stored = await documentStorage.put(content, {
        companyId: fx.companyId,
      });
      const revision = await insertRevision(fx.companyId);
      const [report] = await getTestDb()
        .insert(reportRender)
        .values({
          companyId: fx.companyId,
          revisionId: revision.id,
          format: "pdf",
          language: "en",
          storageKey: stored.key,
          fileHash: stored.sha256,
          coverageClaim: "full",
          disclaimerText: "test",
          calcRunId: randomUUID(),
          renderedBy: fx.adminId,
        })
        .returning();
      rollbackNextWrite.armed = true;
      const result = await uploadDocument(
        getTestDb(),
        formWith("report.pdf", content),
        {
          companyId: fx.companyId,
          userId: fx.adminId,
          maxSizeBytes: 20 * 1024 * 1024,
        },
      );
      expect(result.ok).toBe(false);
      expect(await getTestDb().select().from(document)).toHaveLength(0);
      expect(await getTestDb().select().from(reportRender)).toEqual([report]);
      const stream = await documentStorage.getStream(stored.key);
      expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(
        Buffer.from(content),
      );
    });

    it("leaves the committed document's bytes on disk", async () => {
      const fx = await setup();
      const bytes = pdfBytes("contested");

      // The race, made deterministic. `uploadDocument` does `put` then the row
      // write, so the second request is run from INSIDE the first one's `put` —
      // the exact interleaving the verifier hit: request A stores the bytes
      // (`deduplicated: false`), request B finds them already there
      // (`deduplicated: true`) and COMMITS its row, and only then does A's
      // transaction roll back and A reach its cleanup.
      let second: Awaited<ReturnType<typeof uploadDocument>> | undefined;
      const racingStorage: DocumentStorage = {
        async put(input: DocumentInput, meta: PutOptions): Promise<PutResult> {
          const result = await documentStorage.put(input, meta);
          second = await uploadDocument(
            getTestDb(),
            formWith("second.pdf", bytes),
            {
              companyId: fx.companyId,
              userId: fx.adminId,
              maxSizeBytes: 20 * 1024 * 1024,
            },
          );
          // Armed only NOW, so it is A's row write that unwinds and not B's:
          // B ran to completion above, inside A's `put`, and committed.
          rollbackNextWrite.armed = true;
          return result;
        },
        getStream: (key) => documentStorage.getStream(key),
        stat: (key) => documentStorage.stat(key),
        delete: (key) => documentStorage.delete(key),
      };

      const first = await uploadDocument(
        getTestDb(),
        formWith("first.pdf", bytes),
        {
          companyId: fx.companyId,
          userId: fx.adminId,
          maxSizeBytes: 20 * 1024 * 1024,
          storage: racingStorage,
        },
      );

      // A really did roll back, and B really did dedup onto A's bytes.
      expect(first.ok).toBe(false);
      expect(second?.ok).toBe(true);
      expect(second?.ok === true && second.deduplicated).toBe(true);

      const rows = await getTestDb().select().from(document);
      expect(rows).toHaveLength(1);

      // THE ASSERTION. B's row is committed and points at a key; the bytes must
      // still be behind it. Without the row count in the rollback path, A's
      // cleanup unlinks them and this row becomes a broken download.
      const survivor = rows[0];
      expect(await documentStorage.stat(survivor.storageKey)).not.toBeNull();
      const streamed = await documentStorage.getStream(survivor.storageKey);
      expect(
        new Uint8Array(await new Response(streamed).arrayBuffer()),
      ).toEqual(bytes);
    });

    it("still drops the bytes when the rollback really did orphan them", async () => {
      // The other half of the same rule: with no surviving row, keeping the
      // blob would be the leak the cleanup exists to prevent.
      const fx = await setup();

      rollbackNextWrite.armed = true;
      const only = await uploadDocument(
        getTestDb(),
        formWith("lonely.pdf", pdfBytes("lonely")),
        {
          companyId: fx.companyId,
          userId: fx.adminId,
          maxSizeBytes: 20 * 1024 * 1024,
        },
      );

      expect(only.ok).toBe(false);
      expect(await getTestDb().select().from(document)).toHaveLength(0);
      expect(await storedFiles()).toEqual([]);
    });
  });

  // ─── The post-commit unlink (defect 4) ─────────────────────────────────────

  describe("a delete whose blob unlink fails afterwards", () => {
    it("is still a completed delete, not a 500", async () => {
      const fx = await setup();
      const uploaded = await uploadDocument(
        getTestDb(),
        formWith("doomed.pdf", pdfBytes("doomed")),
        {
          companyId: fx.companyId,
          userId: fx.adminId,
          maxSizeBytes: 20 * 1024 * 1024,
        },
      );
      expect(uploaded.ok).toBe(true);
      const id = uploaded.ok ? uploaded.row.id : "";

      // A disk that refuses the unlink AFTER the row is already committed —
      // EACCES on the object, a read-only remount, an S3 backend timing out.
      const brokenStorage: DocumentStorage = {
        put: (input, meta) => documentStorage.put(input, meta),
        getStream: (key) => documentStorage.getStream(key),
        stat: (key) => documentStorage.stat(key),
        delete: () =>
          Promise.reject(
            new DocumentStorageError("IO_ERROR", "cannot delete the object"),
          ),
      };

      // The row is gone and the transaction is closed, so there is no outcome
      // left to report but success. Throwing here would tell the caller the
      // delete failed while the metadata is already unrecoverable.
      const result = await deleteDocument(
        getTestDb(),
        fx.companyId,
        id,
        brokenStorage,
      );

      expect(result).toMatchObject({ ok: true, bytesRemoved: true });
      expect(await getTestDb().select().from(document)).toHaveLength(0);
    });
  });

  // ─── The confidential hash on the wire (defect 5) ──────────────────────────

  describe("the listing of a confidential document (EV-6)", () => {
    it("withholds file_hash from data.read and shows it to data.review", async () => {
      const fx = await setup(); // admin signed in — esg_admin has data.review
      const uploaded = await uploadDocument(
        getTestDb(),
        formWith("payroll.pdf", pdfBytes("secret"), "confidential"),
        {
          companyId: fx.companyId,
          userId: fx.adminId,
          maxSizeBytes: 20 * 1024 * 1024,
        },
      );
      expect(uploaded.ok).toBe(true);
      const storedHash = uploaded.ok ? uploaded.row.fileHash : "";

      const asAdmin = await documentsGET(request("/api/documents")).then(
        answer,
      );
      const adminDocs = (
        asAdmin.body.data as { documents: Array<{ file_hash: string | null }> }
      ).documents;
      expect(adminDocs[0].file_hash).toBe(storedHash);

      // A contributor may read the METADATA (the panel has to be able to say a
      // figure is backed by this document) but is 403 on the bytes — so the
      // digest of the bytes goes the same way, or the 403 is only a formality.
      await signIn(fx.contributorId);
      const asContributor = await documentsGET(request("/api/documents")).then(
        answer,
      );
      const contributorDocs = (
        asContributor.body.data as {
          documents: Array<{ file_hash: string | null; file_name: string }>;
        }
      ).documents;
      expect(contributorDocs).toHaveLength(1);
      expect(contributorDocs[0].file_name).toBe("payroll.pdf");
      expect(contributorDocs[0].file_hash).toBeNull();
    });

    it("leaves an internal document's hash alone for the same caller", async () => {
      const fx = await setup();
      const uploaded = await uploadDocument(
        getTestDb(),
        formWith("invoice.pdf", pdfBytes("ordinary")),
        {
          companyId: fx.companyId,
          userId: fx.adminId,
          maxSizeBytes: 20 * 1024 * 1024,
        },
      );
      const storedHash = uploaded.ok ? uploaded.row.fileHash : "";

      await signIn(fx.contributorId);
      const listed = await documentsGET(request("/api/documents")).then(answer);
      const docs = (
        listed.body.data as { documents: Array<{ file_hash: string | null }> }
      ).documents;
      // The dedup hint VAL-013 explains keeps working for the ordinary case.
      expect(docs[0].file_hash).toBe(storedHash);
    });
  });

  // ─── Helpers that need the suite's root ────────────────────────────────────

  /** Every file under the suite's root, as paths relative to it. */
  async function storedFiles(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else found.push(path.relative(documentsDir.path, full));
      }
    };
    await walk(documentsDir.path);
    return found.sort();
  }
});

/** A `FormData` shaped exactly as the route hands one to `uploadDocument`. */
function formWith(
  fileName: string,
  bytes: Uint8Array,
  confidentiality?: string,
): FormData {
  const form = new FormData();
  form.append(
    "file",
    new File([bytes as BlobPart], fileName, { type: "application/pdf" }),
  );
  if (confidentiality) form.append("confidentiality", confidentiality);
  return form;
}
