// [LOCAL-DB] F08: documents and reports are independent owners of shared bytes.
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const sessionMock = vi.fn();
vi.mock("@/server/auth/session", () => ({ getSession: () => sessionMock() }));
vi.mock("@/server/db", async () =>
  (await import("@/server/db/__tests__/harness")).testDbModule(),
);
import type { NextRequest } from "next/server";
import { GET as downloadGET } from "@/app/api/renders/[id]/download/route";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertPeriod,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupDocumentsDir,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { document, reportRender } from "@/server/db/schema";
import { calculateRevision } from "@/server/calc/run";
import { uploadDocument, deleteDocument } from "@/server/evidence/documents";
import { renderRevision } from "@/server/render/persist";
import {
  documentStorage,
  type DocumentStorage,
  type PutResult,
} from "../document-storage";
import { deleteUnreferencedBlob } from "../blob-references";

setupDocumentsDir();
const bytes = new TextEncoder().encode("%PDF-1.7 shared evidence content");
const form = (data: Uint8Array = bytes) => {
  const f = new FormData();
  f.set(
    "file",
    new File([new Uint8Array(data)], "evidence.pdf", {
      type: "application/pdf",
    }),
  );
  return f;
};
const read = async (key: string) =>
  Buffer.from(
    await new Response(await documentStorage.getStream(key)).arrayBuffer(),
  );
const storageWith = (overrides: Partial<DocumentStorage>): DocumentStorage => ({
  put: (input, meta) => documentStorage.put(input, meta),
  stat: (key) => documentStorage.stat(key),
  getStream: (key) => documentStorage.getStream(key),
  delete: (key) => documentStorage.delete(key),
  ...overrides,
});
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const db = getTestDb();
  const company = await insertCompany({ plan: "pro" });
  const { user } = await insertUserWithProfile({ companyId: company.id });
  const { period } = await insertPeriod(company.id);
  const revision = await insertRevision(company.id, {
    periodId: period.id,
    status: "approved",
  });
  const run = await calculateRevision(db, company.id, revision);
  if (!run.ok) throw new Error("fixture run failed");
  const ctx = {
    companyId: company.id,
    userId: user.id,
    maxSizeBytes: 20 * 1024 * 1024,
  };
  sessionMock.mockResolvedValue({
    userId: user.id,
    company,
    capabilities: ["data.read"],
  });
  return { db, company, user, revision, ctx };
}

describeIntegration("shared blob ownership [LOCAL-DB]", () => {
  beforeAll(setupSchema);
  beforeEach(resetAppTables);
  afterAll(closeTestDb);

  it("keeps a real rendered report after uploading and deleting two evidence copies", async () => {
    const f = await fixture();
    const rendered = await renderRevision(f.db, f.company.id, f.revision, {
      format: "pdf",
      language: "en",
      renderedBy: f.user.id,
    });
    if (!rendered.ok) throw new Error("fixture render failed");
    const original = await read(rendered.row.storageKey);
    for (let i = 0; i < 2; i++) {
      const uploaded = await uploadDocument(f.db, form(original), f.ctx);
      if (!uploaded.ok) throw new Error("fixture upload failed");
      expect(uploaded.row.storageKey).toBe(rendered.row.storageKey);
    }
    for (const row of await f.db.select().from(document)) {
      expect(await deleteDocument(f.db, f.company.id, row.id)).toMatchObject({
        ok: true,
        bytesRemoved: false,
      });
    }
    expect(await f.db.select().from(reportRender)).toEqual([rendered.row]);
    const response = await downloadGET(
      new Request(
        `http://localhost/api/renders/${rendered.row.id}/download`,
      ) as NextRequest,
      { params: Promise.resolve({ id: rendered.row.id }) },
    );
    expect(response.status).toBe(200);
    const downloaded = Buffer.from(await response.arrayBuffer());
    expect(downloaded).toEqual(original);
    expect(createHash("sha256").update(downloaded).digest("hex")).toBe(
      rendered.row.fileHash,
    );
  });

  it("restores an upload whose prepared blob was deleted before its metadata write", async () => {
    const f = await fixture();
    const old = await uploadDocument(f.db, form(), f.ctx);
    if (!old.ok) throw new Error("fixture upload failed");
    const prepared = signal(),
      publish = signal();
    let first = true;
    const storage = storageWith({
      async put(input, meta) {
        const result = await documentStorage.put(input, meta);
        if (first) {
          first = false;
          prepared.resolve();
          await publish.promise;
        }
        return result;
      },
    });
    const uploading = uploadDocument(f.db, form(), { ...f.ctx, storage });
    try {
      await prepared.promise;
      expect(
        await deleteDocument(f.db, f.company.id, old.row.id),
      ).toMatchObject({ ok: true, bytesRemoved: true });
      expect(await documentStorage.stat(old.row.storageKey)).toBeNull();
    } finally {
      publish.resolve();
    }
    const result = await uploading;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("upload failed");
    expect(await read(result.row.storageKey)).toEqual(Buffer.from(bytes));
  });

  it("restores a render whose prepared blob was deleted before its report row was inserted", async () => {
    const f = await fixture();
    const prepared = signal(),
      publish = signal();
    let oldId = "",
      key = "",
      first = true;
    const storage = storageWith({
      async put(input, meta) {
        const stored = await documentStorage.put(input, meta);
        if (first) {
          first = false;
          key = stored.key;
          const owner = await uploadDocument(
            f.db,
            form(await read(key)),
            f.ctx,
          );
          if (!owner.ok) throw new Error("fixture owner failed");
          oldId = owner.row.id;
          prepared.resolve();
          await publish.promise;
        }
        return stored;
      },
    });
    const rendering = renderRevision(f.db, f.company.id, f.revision, {
      format: "pdf",
      language: "en",
      renderedBy: f.user.id,
      storage,
    });
    try {
      await prepared.promise;
      expect((await deleteDocument(f.db, f.company.id, oldId)).ok).toBe(true);
      expect(await documentStorage.stat(key)).toBeNull();
    } finally {
      publish.resolve();
    }
    const result = await rendering;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("render failed");
    expect(await documentStorage.stat(result.row.storageKey)).not.toBeNull();
  });

  for (const owner of [false, true]) {
    it(`cleans an unexpected failed upload without deleting a report owner's bytes (owner=${owner})`, async () => {
      const f = await fixture();
      const stored = await documentStorage.put(bytes, {
        companyId: f.company.id,
      });
      if (owner)
        await f.db.insert(reportRender).values({
          companyId: f.company.id,
          revisionId: f.revision.id,
          format: "pdf",
          language: "en",
          storageKey: stored.key,
          fileHash: stored.sha256,
          coverageClaim: "full",
          disclaimerText: "test",
          calcRunId: randomUUID(),
          renderedBy: f.user.id,
        });
      await expect(
        uploadDocument(f.db, form(), { ...f.ctx, userId: randomUUID() }),
      ).rejects.toThrow();
      expect(await f.db.select().from(document)).toHaveLength(0);
      expect((await documentStorage.stat(stored.key)) !== null).toBe(owner);
    });

    it(`cleans a failed render row while respecting document ownership (owner=${owner})`, async () => {
      const f = await fixture();
      let stored: PutResult | undefined;
      const storage = storageWith({
        async put(input, meta) {
          stored = await documentStorage.put(input, meta);
          if (owner) {
            const uploaded = await uploadDocument(
              f.db,
              form(await read(stored.key)),
              f.ctx,
            );
            if (!uploaded.ok) throw new Error("fixture owner failed");
          }
          return stored;
        },
      });
      await expect(
        renderRevision(f.db, f.company.id, f.revision, {
          format: "pdf",
          language: "en",
          renderedBy: randomUUID(),
          storage,
        }),
      ).rejects.toThrow();
      if (!stored) throw new Error("fixture did not put bytes");
      expect(await f.db.select().from(reportRender)).toHaveLength(0);
      expect((await documentStorage.stat(stored.key)) !== null).toBe(owner);
    });
  }

  it("holds publication behind an in-flight final unlink and then restores the bytes", async () => {
    const f = await fixture();
    const old = await uploadDocument(f.db, form(), f.ctx);
    if (!old.ok) throw new Error("fixture upload failed");
    const deleting = signal(),
      finishDelete = signal(),
      prepared = signal();
    let publicationChecks = 0;
    const removing = deleteDocument(
      f.db,
      f.company.id,
      old.row.id,
      storageWith({
        async delete(key) {
          deleting.resolve();
          await finishDelete.promise;
          return documentStorage.delete(key);
        },
      }),
    );
    let uploading: ReturnType<typeof uploadDocument> | undefined;
    const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await deleting.promise;
      uploading = uploadDocument(f.db, form(), {
        ...f.ctx,
        storage: storageWith({
          async put(input, meta) {
            const result = await documentStorage.put(input, meta);
            prepared.resolve();
            return result;
          },
          async stat(key) {
            publicationChecks++;
            return documentStorage.stat(key);
          },
        }),
      });
      await prepared.promise;
      let waiting = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const [row] = await observer<
          { waiting: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted) AS waiting`;
        if (row.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(publicationChecks).toBe(0);
    } finally {
      finishDelete.resolve();
      await Promise.allSettled([removing, ...(uploading ? [uploading] : [])]);
      await observer.end({ timeout: 2 });
    }
    expect(await removing).toMatchObject({ ok: true, bytesRemoved: true });
    const result = await uploading;
    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error("upload failed");
    expect(await read(result.row.storageKey)).toEqual(Buffer.from(bytes));
  });

  it("keeps the blob if the ownership transaction cannot run", async () => {
    const f = await fixture();
    const stored = await documentStorage.put(bytes, {
      companyId: f.company.id,
    });
    const spy = vi
      .spyOn(f.db, "transaction")
      .mockRejectedValueOnce(new Error("database unavailable"));
    try {
      expect(
        await deleteUnreferencedBlob(
          f.db,
          f.company.id,
          stored.key,
          documentStorage,
        ),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(await read(stored.key)).toEqual(Buffer.from(bytes));
  });

  it("never collects another company's storage key", async () => {
    const f = await fixture();
    const stored = await documentStorage.put(bytes, {
      companyId: f.company.id,
    });
    const other = await insertCompany();
    expect(
      await deleteUnreferencedBlob(f.db, other.id, stored.key, documentStorage),
    ).toBe(false);
    expect(await read(stored.key)).toEqual(Buffer.from(bytes));
  });
});
