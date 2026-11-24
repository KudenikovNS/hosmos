// [LOCAL-DB] T4.1 — EVIDENCE UPLOAD AND DOWNLOAD (DM-24, EV-0, EV-1, EV-6,
// VAL-013) against a real Postgres and a real filesystem, through the T1.7
// harness.
//
// The properties this file exists to prove:
//
//   • NOTHING LANDS BEFORE THE REFUSAL. A 25 MB body on a 20 MB plan is 402 and
//     leaves the storage root EXACTLY as it was — no object, and no temp file
//     either. The same is asserted for a body that slips past the cheap
//     `Content-Length` pre-check and has to be stopped by the streaming counter
//     inside `DocumentStorage.put`: the two refusals take different paths and
//     both must leave the disk clean.
//   • THE ALLOWLIST IS A TYPE DECISION, NOT A NAME DECISION. `.exe` is 422, and
//     so is an `.exe` wearing `application/pdf` — the declared MIME and the
//     extension must agree, because both are client-controlled.
//   • A DUPLICATE IS A WARNING (EV-1). The same bytes twice give TWO rows, ONE
//     file, the SAME key, and the second response carries Warning VAL-013. An
//     explicit re-run of the FIRST document then flips its stored result in
//     place rather than appending a third — the DM-28 upsert key doing its job.
//   • EV-6 IS TWO DIFFERENT REFUSALS. Another tenant's document is 404;
//     a `confidential` document read by a role without `data.review` is 403.
//   • DELETING IS `company.manage` (§12.2) and is CONTENT-AWARE: the bytes go
//     only with the LAST row that points at them.
//
// FILE ISOLATION IS PART OF THE TEST, not a convenience. `setupDocumentsDir()`
// (T1.7) gives this suite its own `DOCUMENTS_DIR` under `os.tmpdir()`, every
// assertion about the disk is made inside it, and it is removed in `afterAll`.
// Nothing here writes into the repository working tree.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so the DB half
// of this file is a green no-op in a DB-less CI; the manifest assertion below is
// a plain `describe` and runs everywhere.
import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
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

import type { NextRequest } from "next/server";

import { DELETE as documentDELETE } from "@/app/api/documents/[id]/route";
import { GET as downloadGET } from "@/app/api/documents/[id]/download/route";
import {
  GET as documentsGET,
  OPTIONS as documentsOPTIONS,
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
import { document, validationResult } from "@/server/db/schema";
import { EVALUATORS, PENDING_EVALUATORS } from "@/server/validation/registry";
import { runValidation } from "@/server/validation/run";
import { PLAN_FEATURES } from "@/shared/plans";

// ─── Multipart plumbing ──────────────────────────────────────────────────────
//
// The body is built BY HAND rather than through `FormData`, for one reason that
// matters: `new Request(url, {body: formData})` does not expose a
// `Content-Length` header, and the route's cheap pre-check reads exactly that.
// Constructing the envelope ourselves lets a test send the header a real browser
// sends — and lets another test send a body whose length is INSIDE the
// allowance, so the streaming counter is the thing that refuses.

const BOUNDARY = "----hosmosEvidenceTestBoundary";
const enc = new TextEncoder();

interface FilePart {
  field: "file";
  fileName: string;
  mime: string;
  bytes: Uint8Array;
}
type TextPart = { field: string; value: string };
type Part = FilePart | TextPart;

const isFilePart = (p: Part): p is FilePart => "bytes" in p;

function multipartBody(parts: readonly Part[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const headers = isFilePart(part)
      ? `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${part.fileName}"\r\nContent-Type: ${part.mime}\r\n\r\n`
      : `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.field}"\r\n\r\n`;
    chunks.push(enc.encode(headers));
    chunks.push(isFilePart(part) ? part.bytes : enc.encode(part.value));
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${BOUNDARY}--\r\n`));

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function uploadRequest(parts: readonly Part[]): NextRequest {
  const body = multipartBody(parts);
  return new Request("http://api.example.com/api/documents", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      // What a browser sends, and what the pre-check reads.
      "content-length": String(body.byteLength),
    },
    // The exact bytes; `body.buffer` is sized to the message (see above).
    body: body.buffer as ArrayBuffer,
  }) as NextRequest;
}

const request = (url: string, method = "GET"): NextRequest =>
  new Request(`http://api.example.com${url}`, { method }) as NextRequest;

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

const answer = async (res: Response) => ({
  status: res.status,
  body: (await res.json()) as Record<string, unknown>,
});

// ─── Route callers ───────────────────────────────────────────────────────────

const upload = (parts: readonly Part[]) =>
  documentsPOST(uploadRequest(parts)).then(answer);

const listDocs = () => documentsGET(request("/api/documents")).then(answer);

const download = (id: string) =>
  downloadGET(request(`/api/documents/${id}/download`), ctxFor(id));

const removeDoc = (id: string) =>
  documentDELETE(request(`/api/documents/${id}`, "DELETE"), ctxFor(id)).then(
    answer,
  );

// ─── Fixtures ────────────────────────────────────────────────────────────────

const pdfBytes = (marker: string): Uint8Array =>
  enc.encode(`%PDF-1.4\n% ${marker}\n%%EOF\n`);

const pdfPart = (fileName: string, bytes: Uint8Array): FilePart => ({
  field: "file",
  fileName,
  mime: "application/pdf",
  bytes,
});

/** A body of exactly `mb` megabytes — allocated once per call, never kept. */
const megabytes = (mb: number): Uint8Array => new Uint8Array(mb * 1024 * 1024);

async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

async function signIn(userId: string): Promise<void> {
  getSessionMock.mockResolvedValue(await sessionFor(userId));
}

// ─── The manifest (no database needed) ───────────────────────────────────────

describe("the evaluator manifest after T4.1 (R-12)", () => {
  it("implements VAL-013 and drops it from the pending list", () => {
    expect(EVALUATORS["VAL-013"]).toBeTypeOf("function");
    expect(PENDING_EVALUATORS["VAL-013"]).toBeUndefined();
  });

  it("leaves exactly the codes that wait for something T4.1 does not build", () => {
    // Named one by one rather than counted (see the T3.2 suite for why). What is
    // left needs a CALCULATION (T5.3/T5.4) — never a document. VAL-037 was here
    // until T4.2 built the evidence LINK it judges, VAL-038/VAL-039 until T4.3
    // built the DQ assessment, and VAL-036/VAL-040/VAL-041 until T4.4 built the
    // approval gates; the manifest only ever shrinks.
    // T5.4 removed the last three (VAL-017, VAL-034, VAL-035) with the run
    // that writes their subject, so the list this task's successors kept
    // shrinking is now EMPTY — which is the end state, not a gap: every §6.2
    // rule has an evaluator. The assertion stays because it is the one that
    // would go red if a later phase added a rule and forgot to own it.
    expect(Object.keys(PENDING_EVALUATORS).sort()).toEqual([]);
  });
});

describe("the plan cap this suite is written against (PG-1/EV-0)", () => {
  it("is 20 MB on every Phase-1 plan", () => {
    // The 25 MB case below only means anything while this is true; if a plan
    // ever raises the ceiling, the fixture — not the assertion — must change.
    for (const plan of Object.values(PLAN_FEATURES)) {
      expect(plan.maxUploadMb).toBe(20);
    }
  });
});

describeIntegration("api/documents [LOCAL-DB]", () => {
  const documentsDir = setupDocumentsDir();

  beforeAll(async () => {
    await setupSchema();
  });

  beforeEach(async () => {
    await resetAppTables();
    getSessionMock.mockReset();
    // `resetAppTables()` truncates `document` and DELIBERATELY never touches the
    // disk (T1.7) — the two sides are cleaned by whoever owns them. Almost every
    // assertion below counts FILES, so the suite empties its own root here; the
    // root itself stays, because `DOCUMENTS_DIR` must keep pointing at an
    // existing directory for the whole run.
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

  // The suite's storage root, and everything we ever assert about the disk.
  const rootEntries = async (): Promise<string[]> => {
    return readdir(documentsDir.path);
  };

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

  /** The in-flight temp directory `put` uses — it must never keep anything. */
  async function tempFiles(): Promise<string[]> {
    try {
      return await readdir(path.join(documentsDir.path, ".tmp"));
    } catch {
      return [];
    }
  }

  interface Fixture {
    companyId: string;
    adminId: string;
    contributorId: string;
  }

  /** A paid company with an `esg_admin` and a `contributor`, admin signed in. */
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
    await signIn(admin.id);
    return {
      companyId: company.id,
      adminId: admin.id,
      contributorId: contributor.id,
    };
  }

  // ─── Size (EV-0, PG-1) ─────────────────────────────────────────────────────

  describe("the per-plan size cap", () => {
    it("refuses 25 MB on a 20 MB plan with 402 and leaves NOTHING on disk", async () => {
      await setup();
      const before = await rootEntries();

      const res = await upload([pdfPart("huge.pdf", megabytes(25))]);

      expect(res.status).toBe(402);
      expect(res.body).toEqual({ ok: false, error: "PLAN_REQUIRED" });
      // No object, and — the part that is easy to get wrong — no temp file:
      // the pre-check fired before the body was read at all, so `put` was never
      // called and the root is byte-for-byte what it was.
      expect(await rootEntries()).toEqual(before);
      expect(await tempFiles()).toEqual([]);
      expect(await storedFiles()).toEqual([]);

      const rows = await getTestDb().select().from(document);
      expect(rows).toHaveLength(0);
    });

    it("stops a body that slips past the pre-check mid-stream, still leaving no temp file", async () => {
      await setup();

      // 20 MB + 2 KiB: over the cap, but INSIDE the 64 KiB envelope allowance,
      // so the pre-check lets it through and the streaming counter inside
      // `DocumentStorage.put` is what refuses it.
      const oversize = new Uint8Array(20 * 1024 * 1024 + 2048);
      const res = await upload([pdfPart("just-over.pdf", oversize)]);

      expect(res.status).toBe(402);
      expect(res.body).toEqual({ ok: false, error: "PLAN_REQUIRED" });
      // `put` DID open a temp file this time and abandoned it; its `finally`
      // removes it, and the object under `{companyId}/{sha256}` never existed
      // because only the final `rename` creates one.
      expect(await tempFiles()).toEqual([]);
      expect(await storedFiles()).toEqual([]);
      expect(await getTestDb().select().from(document)).toHaveLength(0);
    });

    it("accepts a file comfortably inside the cap", async () => {
      const fx = await setup();
      const res = await upload([pdfPart("invoice.pdf", pdfBytes("ok"))]);

      expect(res.status).toBe(200);
      const data = res.body.data as { document: Record<string, unknown> };
      expect(data.document.file_name).toBe("invoice.pdf");
      expect(data.document.file_type).toBe("pdf");
      expect(data.document.mime).toBe("application/pdf");
      expect(data.document.confidentiality).toBe("internal");

      const hash = createHash("sha256").update(pdfBytes("ok")).digest("hex");
      expect(data.document.file_hash).toBe(hash);
      expect(await storedFiles()).toEqual([path.join(fx.companyId, hash)]);
      // The wire never carries the blob backend's addressing scheme.
      expect(data.document).not.toHaveProperty("storage_key");
    });
  });

  // ─── MIME allowlist (EV-0) ─────────────────────────────────────────────────

  describe("the MIME allowlist", () => {
    it("refuses .exe with 422 and writes nothing", async () => {
      await setup();
      const res = await upload([
        {
          field: "file",
          fileName: "payload.exe",
          mime: "application/x-msdownload",
          bytes: enc.encode("MZ  "),
        },
      ]);

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        ok: false,
        error: "VALIDATION",
        field: "file",
      });
      expect(await storedFiles()).toEqual([]);
      expect(await getTestDb().select().from(document)).toHaveLength(0);
    });

    it("refuses an .exe dressed as a pdf — the extension and the type must agree", async () => {
      await setup();
      const res = await upload([
        {
          field: "file",
          fileName: "payload.exe",
          mime: "application/pdf",
          bytes: enc.encode("MZ"),
        },
      ]);
      expect(res.status).toBe(422);
      expect(await storedFiles()).toEqual([]);
    });

    it("refuses a pdf name announced as an executable, for the same reason", async () => {
      await setup();
      const res = await upload([
        {
          field: "file",
          fileName: "invoice.pdf",
          mime: "application/x-msdownload",
          bytes: pdfBytes("dressed"),
        },
      ]);
      expect(res.status).toBe(422);
      expect(await storedFiles()).toEqual([]);
    });

    it("accepts the whole EV-0 list and buckets each into its FileType", async () => {
      await setup();
      const cases: Array<[string, string, string]> = [
        [
          "report.xlsx",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "xlsx",
        ],
        ["legacy.xls", "application/vnd.ms-excel", "xlsx"],
        ["meters.csv", "text/csv; charset=utf-8", "csv"],
        ["scan.png", "image/png", "image"],
        ["scan.jpg", "image/jpeg", "image"],
      ];
      for (const [fileName, mime, fileType] of cases) {
        const res = await upload([
          { field: "file", fileName, mime, bytes: enc.encode(fileName) },
        ]);
        expect(res.status, fileName).toBe(200);
        const data = res.body.data as { document: Record<string, unknown> };
        expect(data.document.file_type, fileName).toBe(fileType);
      }
    });
  });

  // ─── Dedup and VAL-013 (EV-1) ──────────────────────────────────────────────

  describe("the same bytes twice (EV-1, VAL-013)", () => {
    it("writes two rows, keeps one file, and warns on the second", async () => {
      const fx = await setup();
      const bytes = pdfBytes("duplicate");
      const hash = createHash("sha256").update(bytes).digest("hex");

      const first = await upload([pdfPart("january.pdf", bytes)]);
      const second = await upload([pdfPart("annual.pdf", bytes)]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const one = first.body.data as {
        document: Record<string, unknown>;
        deduplicated: boolean;
        warnings: Array<{ code: string }>;
      };
      const two = second.body.data as typeof one;

      // TWO rows: distinct ids, distinct names, the SAME content hash.
      expect(two.document.id).not.toBe(one.document.id);
      expect(two.document.file_hash).toBe(one.document.file_hash);
      expect(one.deduplicated).toBe(false);
      expect(two.deduplicated).toBe(true);

      // ONE file, and both rows address it by the same key.
      expect(await storedFiles()).toEqual([path.join(fx.companyId, hash)]);
      const rows = await getTestDb()
        .select()
        .from(document)
        .where(eq(document.companyId, fx.companyId));
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.storageKey))).toEqual(
        new Set([`${fx.companyId}/${hash}`]),
      );

      // The FIRST upload had nothing to warn about; the second carries VAL-013.
      expect(one.warnings).toEqual([]);
      expect(two.warnings).toEqual([
        expect.objectContaining({ code: "VAL-013", scope: "record" }),
      ]);
    });

    it("persists one VAL-013 result per document and upserts it in place on a re-run", async () => {
      const fx = await setup();
      const bytes = pdfBytes("persisted");
      const first = await upload([pdfPart("a.pdf", bytes)]);
      const firstId = (first.body.data as { document: { id: string } }).document
        .id;

      const stored = async () =>
        getTestDb()
          .select()
          .from(validationResult)
          .where(eq(validationResult.companyId, fx.companyId));

      // Only one document exists: the rule passes and says so (a pass is a row,
      // not a silence — otherwise a fixed state could never overwrite a failure).
      expect(await stored()).toEqual([
        expect.objectContaining({
          ruleCode: "VAL-013",
          objectType: "document",
          objectId: firstId,
          passed: true,
          blocking: false,
          severity: "warning",
        }),
      ]);

      const second = await upload([pdfPart("b.pdf", bytes)]);
      const secondId = (second.body.data as { document: { id: string } })
        .document.id;

      // A run judges the TARGET it was given, and the upload runs against the row
      // it just wrote. So the SECOND document fails and the FIRST one's stored
      // result is untouched — stale, deliberately, rather than silently rewritten
      // by a write that was never about it. The library screen re-evaluates
      // through `POST /api/validation/run`; the next assertion is that path.
      const afterSecond = await stored();
      expect(afterSecond).toHaveLength(2);
      expect(afterSecond.find((r) => r.objectId === secondId)?.passed).toBe(
        false,
      );
      expect(afterSecond.find((r) => r.objectId === firstId)?.passed).toBe(
        true,
      );

      await runValidation(getTestDb(), {
        companyId: fx.companyId,
        scope: "record",
        targetId: firstId,
      });

      // STILL two rows: the DM-28 key (company, rule, object_type, object_id,
      // revision_id) made this an UPDATE, not a third row. If a COALESCE in that
      // expression index were wrong, this count would be three.
      const afterRerun = await stored();
      expect(afterRerun).toHaveLength(2);
      expect(afterRerun.every((r) => r.ruleCode === "VAL-013")).toBe(true);
      expect(afterRerun.every((r) => r.passed === false)).toBe(true);
    });

    it("does not warn across tenants — the hash is a hint about YOUR library", async () => {
      const bytes = pdfBytes("shared-across-tenants");
      const other = await setup();
      await upload([pdfPart("theirs.pdf", bytes)]);

      const mine = await setup();
      expect(mine.companyId).not.toBe(other.companyId);
      const res = await upload([pdfPart("mine.pdf", bytes)]);

      const data = res.body.data as {
        warnings: unknown[];
        deduplicated: boolean;
      };
      expect(data.warnings).toEqual([]);
      // Different key prefix ⇒ a second file, one per company: the layout is
      // `{companyId}/{sha256}` and tenants never share bytes.
      expect(data.deduplicated).toBe(false);
      expect(await storedFiles()).toHaveLength(2);
    });
  });

  // ─── EV-6 ──────────────────────────────────────────────────────────────────

  describe("download access (EV-6)", () => {
    it("returns the bytes, the type and an attachment disposition", async () => {
      await setup();
      const bytes = pdfBytes("downloadable");
      const res = await upload([pdfPart("invoice.pdf", bytes)]);
      const id = (res.body.data as { document: { id: string } }).document.id;

      const file = await download(id);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("application/pdf");
      expect(file.headers.get("content-disposition")).toContain(
        'filename="invoice.pdf"',
      );
      expect(file.headers.get("cache-control")).toBe("private, no-store");
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    });

    it("answers 404 for another company's document", async () => {
      await setup();
      const res = await upload([pdfPart("theirs.pdf", pdfBytes("theirs"))]);
      const foreignId = (res.body.data as { document: { id: string } }).document
        .id;

      // A different tenant, with every capability inside its own company.
      await setup();
      const file = await download(foreignId);
      expect(file.status).toBe(404);
      expect(await file.json()).toEqual({ ok: false, error: "NO_DATA" });
    });

    it("answers 404 for an id that never existed", async () => {
      await setup();
      const file = await download("00000000-0000-4000-8000-000000000000");
      expect(file.status).toBe(404);
    });

    it("requires data.review for a confidential document — 403, not 404", async () => {
      const fx = await setup();
      const res = await upload([
        pdfPart("payroll.pdf", pdfBytes("secret")),
        { field: "confidentiality", value: "confidential" },
      ]);
      expect(res.status).toBe(200);
      const doc = (res.body.data as { document: Record<string, unknown> })
        .document;
      expect(doc.confidentiality).toBe("confidential");
      const id = doc.id as string;

      // `contributor` has data.read + data.write, and NOT data.review.
      await signIn(fx.contributorId);
      const refused = await download(id);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ ok: false, error: "FORBIDDEN" });

      // ... and can still SEE it in the library: EV-6 gates the contents.
      const listed = await listDocs();
      expect(listed.status).toBe(200);
      expect(
        (listed.body.data as { documents: Array<{ id: string }> }).documents,
      ).toHaveLength(1);

      // `esg_admin` carries data.review and gets the bytes.
      await signIn(fx.adminId);
      const allowed = await download(id);
      expect(allowed.status).toBe(200);
      expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(
        pdfBytes("secret"),
      );
    });

    it("lets a contributor download a non-confidential document", async () => {
      const fx = await setup();
      const res = await upload([pdfPart("public.pdf", pdfBytes("open"))]);
      const id = (res.body.data as { document: { id: string } }).document.id;

      await signIn(fx.contributorId);
      const file = await download(id);
      expect(file.status).toBe(200);
    });

    it("answers 404 when the row survives but the bytes are gone (EV-5 is T4.4's)", async () => {
      const fx = await setup();
      const bytes = pdfBytes("vanishing");
      const res = await upload([pdfPart("gone.pdf", bytes)]);
      const id = (res.body.data as { document: { id: string } }).document.id;

      const hash = createHash("sha256").update(bytes).digest("hex");
      await rm(path.join(documentsDir.path, fx.companyId, hash));

      const file = await download(id);
      expect(file.status).toBe(404);
    });
  });

  // ─── DELETE (EV-3, §12.2) ──────────────────────────────────────────────────

  describe("delete", () => {
    it("is refused 403 for a role with data.write but not company.manage", async () => {
      const fx = await setup();
      const res = await upload([pdfPart("invoice.pdf", pdfBytes("keep"))]);
      const id = (res.body.data as { document: { id: string } }).document.id;

      await signIn(fx.contributorId);
      const refused = await removeDoc(id);
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ ok: false, error: "FORBIDDEN" });

      // Neither the row nor the bytes moved.
      expect(await getTestDb().select().from(document)).toHaveLength(1);
      expect(await storedFiles()).toHaveLength(1);
    });

    it("removes the row and the bytes for company.manage", async () => {
      const fx = await setup();
      const bytes = pdfBytes("removable");
      const res = await upload([pdfPart("invoice.pdf", bytes)]);
      const id = (res.body.data as { document: { id: string } }).document.id;
      const hash = createHash("sha256").update(bytes).digest("hex");

      const removed = await removeDoc(id);
      expect(removed.status).toBe(200);
      expect(removed.body.data).toEqual({ id, bytes_removed: true });

      expect(await getTestDb().select().from(document)).toHaveLength(0);
      await expect(
        stat(path.join(documentsDir.path, fx.companyId, hash)),
      ).rejects.toThrow();
      expect(await storedFiles()).toEqual([]);
    });

    it("keeps the bytes while another row still points at them (EV-0 dedup)", async () => {
      const fx = await setup();
      const bytes = pdfBytes("shared");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const key = path.join(fx.companyId, hash);

      const first = await upload([pdfPart("january.pdf", bytes)]);
      const second = await upload([pdfPart("annual.pdf", bytes)]);
      const firstId = (first.body.data as { document: { id: string } }).document
        .id;
      const secondId = (second.body.data as { document: { id: string } })
        .document.id;

      const firstDelete = await removeDoc(firstId);
      expect(firstDelete.body.data).toEqual({
        id: firstId,
        bytes_removed: false,
      });
      // The other document must still be downloadable — this is the assertion
      // that fails if delete unlinks unconditionally.
      expect(await storedFiles()).toEqual([key]);
      expect((await download(secondId)).status).toBe(200);

      const secondDelete = await removeDoc(secondId);
      expect(secondDelete.body.data).toEqual({
        id: secondId,
        bytes_removed: true,
      });
      expect(await storedFiles()).toEqual([]);
    });

    it("answers 404 for another company's document", async () => {
      await setup();
      const res = await upload([pdfPart("theirs.pdf", pdfBytes("theirs"))]);
      const foreignId = (res.body.data as { document: { id: string } }).document
        .id;

      await setup();
      const removed = await removeDoc(foreignId);
      expect(removed.status).toBe(404);
      // Not deleted by the failed attempt.
      expect(await getTestDb().select().from(document)).toHaveLength(1);
    });
  });

  // ─── The listing and the cross-cutting contracts ───────────────────────────

  describe("the listing", () => {
    it("returns only this company's documents", async () => {
      await setup();
      await upload([pdfPart("theirs.pdf", pdfBytes("theirs"))]);

      const mine = await setup();
      await upload([pdfPart("mine.pdf", pdfBytes("mine"))]);

      const listed = await listDocs();
      const docs = (
        listed.body.data as { documents: Array<{ file_name: string }> }
      ).documents;
      expect(docs.map((d) => d.file_name)).toEqual(["mine.pdf"]);
      expect(mine.companyId).toBeTruthy();
    });

    it("refuses without a session (401) and answers the preflight (PATTERN 2)", async () => {
      getSessionMock.mockResolvedValue(null);
      const listed = await listDocs();
      expect(listed.status).toBe(401);

      const preflight = documentsOPTIONS(request("/api/documents", "OPTIONS"));
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain(
        "POST",
      );
    });
  });

  describe("the body", () => {
    it("carries the DM-24 metadata fields through", async () => {
      await setup();
      const res = await upload([
        pdfPart("bill.pdf", pdfBytes("meta")),
        { field: "issuer", value: "Elektro Ljubljana" },
        { field: "document_date", value: "2024-02-01" },
        { field: "coverage_start", value: "2024-01-01" },
        { field: "coverage_end", value: "2024-01-31" },
        { field: "retention_date", value: "2034-01-01" },
      ]);
      expect(res.status).toBe(200);
      expect(
        (res.body.data as { document: Record<string, unknown> }).document,
      ).toMatchObject({
        issuer: "Elektro Ljubljana",
        document_date: "2024-02-01",
        coverage_start: "2024-01-01",
        coverage_end: "2024-01-31",
        retention_date: "2034-01-01",
      });
    });

    it("refuses a malformed date field by NAME (API-1) without writing bytes", async () => {
      await setup();
      const res = await upload([
        pdfPart("bill.pdf", pdfBytes("bad-date")),
        { field: "coverage_start", value: "yesterday" },
      ]);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ field: "coverage_start" });
      expect(await storedFiles()).toEqual([]);
    });

    it("refuses a request with no file part", async () => {
      await setup();
      const res = await upload([{ field: "issuer", value: "nobody" }]);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ field: "file" });
    });
  });

  describe("file isolation", () => {
    it("writes only inside the suite's temporary DOCUMENTS_DIR", async () => {
      const fx = await setup();
      await upload([pdfPart("invoice.pdf", pdfBytes("isolated"))]);

      expect(process.env.DOCUMENTS_DIR).toBe(documentsDir.path);
      expect(documentsDir.path.startsWith(os.tmpdir())).toBe(true);
      const files = await storedFiles();
      expect(files).toHaveLength(1);
      expect(files[0].startsWith(fx.companyId)).toBe(true);
    });
  });
});
