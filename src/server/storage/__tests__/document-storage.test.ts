// Unit tests for the Phase-1 DocumentStorage backend (EV-0, T1.6).
//
// No database is touched; every byte is written under a per-file `fs.mkdtemp`
// directory that `afterAll` removes, so the suite writes nothing outside tmp.
//
// `node:fs/promises` is mocked with COUNTING PASS-THROUGHS (real behaviour,
// plus a call counter). That is what turns "traversal is rejected" into
// "traversal is rejected BEFORE any filesystem access": the counter is zeroed
// immediately before the hostile call and must still be 0 afterwards.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

// `document-storage.ts` starts with `import "server-only"`, which throws under
// node/vitest — neutralise it (same pattern as src/server/db/__tests__).
vi.mock("server-only", () => ({}));

const { fsCalls } = vi.hoisted(() => ({ fsCalls: { count: 0 } }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    open: (...args: Parameters<typeof actual.open>) => {
      fsCalls.count++;
      return actual.open(...args);
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      fsCalls.count++;
      return actual.stat(...args);
    },
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
      fsCalls.count++;
      return actual.mkdir(...args);
    },
    rename: (...args: Parameters<typeof actual.rename>) => {
      fsCalls.count++;
      return actual.rename(...args);
    },
    unlink: (...args: Parameters<typeof actual.unlink>) => {
      fsCalls.count++;
      return actual.unlink(...args);
    },
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      fsCalls.count++;
      return actual.readdir(...args);
    },
  };
});

import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";

import {
  DocumentStorageError,
  LocalFilesystemDocumentStorage,
  type DocumentInput,
} from "../document-storage";

const COMPANY = "11111111-2222-4333-8444-555555555555";
const OTHER_COMPANY = "99999999-8888-4777-8666-555555555555";

let root: string;
let storage: LocalFilesystemDocumentStorage;

/** SHA-256 computed independently of the code under test (the `openssl` equivalent). */
function digestOf(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every regular file under the storage root (temp scratch dir excluded). */
async function listObjects(dir = root, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listObjects(path.join(dir, entry.name), rel)));
    } else if (!rel.startsWith(".tmp/")) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** An async iterable input, so the stream path (not the Uint8Array path) is exercised. */
async function* chunked(...chunks: string[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield new TextEncoder().encode(c);
}

/** Drain a Web stream into a string. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hosmos-storage-test-"));
  storage = new LocalFilesystemDocumentStorage(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  fsCalls.count = 0;
});

describe("put", () => {
  it("writes the bytes and returns an independently verifiable sha256", async () => {
    const body = "hello evidence";
    const res = await storage.put(new TextEncoder().encode(body), {
      companyId: COMPANY,
    });

    expect(res.sha256).toBe(digestOf(body));
    expect(res.key).toBe(`${COMPANY}/${digestOf(body)}`);
    expect(res.sizeBytes).toBe(Buffer.byteLength(body));
    expect(res.deduplicated).toBe(false);

    // The bytes really are on disk under the key, readable through the API.
    expect(await readAll(await storage.getStream(res.key))).toBe(body);
  });

  it("accepts a Web ReadableStream and an async iterable, hashing the whole body", async () => {
    const body = "chunk-a|chunk-b|chunk-c";
    const fromIterable = await storage.put(
      chunked("chunk-a|", "chunk-b|", "chunk-c"),
      {
        companyId: COMPANY,
      },
    );
    expect(fromIterable.sha256).toBe(digestOf(body));
    expect(fromIterable.sizeBytes).toBe(Buffer.byteLength(body));

    const web = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-a|chunk-b|"));
        controller.enqueue(new TextEncoder().encode("chunk-c"));
        controller.close();
      },
    });
    const fromWeb = await storage.put(web, { companyId: COMPANY });
    // Same content → same key regardless of how it was streamed in.
    expect(fromWeb.key).toBe(fromIterable.key);
    expect(fromWeb.deduplicated).toBe(true);
  });

  it("dedups identical bytes: same key, no extra file", async () => {
    const body = "duplicate me";
    const first = await storage.put(new TextEncoder().encode(body), {
      companyId: COMPANY,
    });
    const before = await listObjects();

    const second = await storage.put(chunked("duplicate ", "me"), {
      companyId: COMPANY,
    });

    expect(second.key).toBe(first.key);
    expect(second.sha256).toBe(first.sha256);
    expect(second.sizeBytes).toBe(first.sizeBytes);
    expect(second.deduplicated).toBe(true);
    expect(await listObjects()).toEqual(before);
  });

  it("scopes identical bytes per company (same hash, different key)", async () => {
    const body = "shared bytes";
    const a = await storage.put(new TextEncoder().encode(body), {
      companyId: COMPANY,
    });
    const b = await storage.put(new TextEncoder().encode(body), {
      companyId: OTHER_COMPANY,
    });

    expect(a.sha256).toBe(b.sha256);
    expect(a.key).not.toBe(b.key);
    expect(await storage.stat(a.key)).not.toBeNull();
    expect(await storage.stat(b.key)).not.toBeNull();
  });

  it("survives concurrent puts of the same content (one key, one file)", async () => {
    const body = "racy upload payload";
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        storage.put(new TextEncoder().encode(body), { companyId: COMPANY }),
      ),
    );

    const keys = new Set(results.map((r) => r.key));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(`${COMPANY}/${digestOf(body)}`);

    const objects = await listObjects();
    expect(objects.filter((o) => o.endsWith(digestOf(body)))).toHaveLength(1);
    expect(await readAll(await storage.getStream(results[0].key))).toBe(body);
  });

  it("leaves no visible object when the source stream fails midway", async () => {
    const body = "first half";
    async function* explodes(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode(body);
      throw new Error("upstream socket died");
    }

    const before = await listObjects();
    await expect(
      storage.put(explodes(), { companyId: COMPANY }),
    ).rejects.toThrow(/upstream socket died/);

    // Neither a partial object under a key, nor a leaked temp file.
    expect(await listObjects()).toEqual(before);
    expect(await storage.stat(`${COMPANY}/${digestOf(body)}`)).toBeNull();
    await expect(readdir(path.join(root, ".tmp"))).resolves.toEqual([]);
  });

  it("aborts over-limit uploads before the object becomes visible", async () => {
    const before = await listObjects();
    const body = "0123456789";

    await expect(
      storage.put(chunked("01234", "56789"), {
        companyId: COMPANY,
        maxSizeBytes: 6,
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });

    expect(await listObjects()).toEqual(before);
    expect(await storage.stat(`${COMPANY}/${digestOf(body)}`)).toBeNull();
    await expect(readdir(path.join(root, ".tmp"))).resolves.toEqual([]);
  });

  it("accepts an upload exactly at the limit", async () => {
    const res = await storage.put(new TextEncoder().encode("012345"), {
      companyId: COMPANY,
      maxSizeBytes: 6,
    });
    expect(res.sizeBytes).toBe(6);
  });

  it("stores empty content without failing", async () => {
    const res = await storage.put(new Uint8Array(0), { companyId: COMPANY });
    expect(res.sizeBytes).toBe(0);
    expect(res.sha256).toBe(digestOf(""));
    expect((await storage.stat(res.key))?.sizeBytes).toBe(0);
  });
});

// ─── Crash recovery in `.tmp` ────────────────────────────────────────────────
//
// `put`'s `finally` removes its temp file on every path a REQUEST can take, and
// the tests above pin that. It cannot cover a path the PROCESS takes: a SIGKILL,
// an OOM kill or a Passenger restart mid-upload strands one temp file of up to
// `maxUploadMb`, and nothing else in the app ever looks in `.tmp`. On the
// quota-bound cPanel target that is a disk that fills and stays full.
//
// So these tests never call the sweep. They PLANT the wreckage a killed process
// leaves — a real file, under the real name shape, with a backdated `mtime` —
// and then drive an ordinary successful upload, which is the only thing the
// deployed system is guaranteed to do. What must survive is planted the same
// way, differing only in age.
describe("a failing filesystem (T5.10)", () => {
  // The module header promises that no raw errno escapes it. `put` ran under a
  // `try/finally` with no `catch`, so it did — and the realistic case on the
  // quota-bound deploy target is the disk filling up mid-upload, which surfaced
  // as an untyped 500 with nothing naming the cause.
  //
  // The stream is what fails here rather than a mocked `fs`: it is the one place
  // an error can be injected *between* chunks, which is exactly where a disk
  // runs out, and it needs no module mock to do it.
  const failingBody = (code: string): DocumentInput => {
    const err: NodeJS.ErrnoException = new Error(`simulated ${code}`);
    err.code = code;
    return (async function* () {
      yield new TextEncoder().encode("first chunk lands");
      throw err;
    })();
  };

  it.each([
    ["ENOSPC", "Out of disk space"],
    ["EDQUOT", "Out of disk space"],
  ])("reports %s as a typed IO_ERROR naming the cause", async (code, said) => {
    const err = await storage
      .put(failingBody(code), { companyId: COMPANY })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DocumentStorageError);
    const typed = err as DocumentStorageError;
    // NOT `LIMIT_EXCEEDED`: that means the plan's per-file cap, and reusing it
    // would offer an upgrade to somebody whose server is simply out of room.
    expect(typed.code).toBe("IO_ERROR");
    expect(typed.message).toContain(said);
    expect(typed.message).toContain(code);
    expect((typed.cause as NodeJS.ErrnoException)?.code).toBe(code);
  });

  it("types an unexpected errno too, and leaves nothing behind", async () => {
    // A company of its own, so "nothing was published" is a claim about THIS
    // upload rather than about whatever earlier tests left in the shared root.
    const alone = "33333333-4444-4555-8666-777777777777";
    const err = await storage
      .put(failingBody("EIO"), { companyId: alone })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DocumentStorageError);
    expect((err as DocumentStorageError).code).toBe("IO_ERROR");
    // The half-written temp file is cleaned up by the `finally`, and no object
    // was published: the company's directory was never even created.
    expect(await readdir(path.join(root, ".tmp")).catch(() => [])).toEqual([]);
    expect(await readdir(root)).not.toContain(alone);
  });

  it("lets a failure from the SOURCE stream through untouched", async () => {
    // The counterpart to the three above, and the reason the guard checks for an
    // errno: an upload aborted by the client is not a storage fault, and its
    // message is the only account of what happened upstream.
    const upstream = new Error("upstream socket died");
    const err = await storage
      .put(
        (async function* () {
          yield new TextEncoder().encode("partial");
          throw upstream;
        })(),
        { companyId: COMPANY },
      )
      .catch((e: unknown) => e);

    expect(err).toBe(upstream);
    expect(await readdir(path.join(root, ".tmp")).catch(() => [])).toEqual([]);
  });

  it("still reports a size refusal as LIMIT_EXCEEDED, not as an IO error", async () => {
    // The guard above must not swallow the refusal the plan cap raises — that
    // one IS the caller's to fix, and it answers 402 rather than 500.
    const err = await storage
      .put(new TextEncoder().encode("far too many bytes"), {
        companyId: COMPANY,
        maxSizeBytes: 4,
      })
      .catch((e: unknown) => e);

    expect((err as DocumentStorageError).code).toBe("LIMIT_EXCEEDED");
  });
});

describe("the temp directory after a crash", () => {
  const HOUR_MS = 60 * 60 * 1000;

  /** A fresh root AND a fresh instance: the sweep is throttled per instance. */
  async function freshStorage(): Promise<{
    storage: LocalFilesystemDocumentStorage;
    root: string;
    tmpDir: string;
  }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hosmos-storage-tmp-"));
    const tmpDir = path.join(dir, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    return {
      storage: new LocalFilesystemDocumentStorage(dir),
      root: dir,
      tmpDir,
    };
  }

  /** Plant a temp file of `ageMs` — `0` is one that is being written right now. */
  async function plantTempFile(tmpDir: string, ageMs: number): Promise<string> {
    const name = `put-${randomUUID()}`;
    await writeFile(path.join(tmpDir, name), new Uint8Array(4096));
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      await utimes(path.join(tmpDir, name), when, when);
    }
    return name;
  }

  it("removes an orphan a killed process left, on the next successful upload", async () => {
    const { storage: local, root: dir, tmpDir } = await freshStorage();
    try {
      const orphan = await plantTempFile(tmpDir, 3 * HOUR_MS);
      // The file an upload that is STILL RUNNING holds open. Same directory,
      // same name shape, indistinguishable except by age — and it must survive,
      // or the sweep would be deleting live uploads out from under their
      // requests, which is worse than the leak it is fixing.
      const inFlight = await plantTempFile(tmpDir, 0);

      const res = await local.put(new TextEncoder().encode("after the crash"), {
        companyId: COMPANY,
      });

      const left = await readdir(tmpDir);
      expect(left).not.toContain(orphan);
      expect(left).toContain(inFlight);
      // The upload that did the sweeping is itself untouched by it.
      expect(res.deduplicated).toBe(false);
      expect(await readAll(await local.getStream(res.key))).toBe(
        "after the crash",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("touches nothing but `.tmp/put-*` — not stored objects, not foreign files", async () => {
    const { storage: local, root: dir, tmpDir } = await freshStorage();
    try {
      // A stored object, aged well past the threshold. Objects are the DATA;
      // the sweep must not be able to reach them even when they look stale.
      const stored = await local.put(new TextEncoder().encode("kept forever"), {
        companyId: COMPANY,
      });
      const objectPath = path.join(dir, ...stored.key.split("/"));
      const ancient = new Date(Date.now() - 30 * 24 * HOUR_MS);
      await utimes(objectPath, ancient, ancient);

      // Something else's file inside `.tmp`, equally old. Not ours, not swept.
      await writeFile(path.join(tmpDir, "not-ours.log"), "x");
      await utimes(path.join(tmpDir, "not-ours.log"), ancient, ancient);

      // A second instance, so the throttle does not suppress this sweep.
      const second = new LocalFilesystemDocumentStorage(dir);
      await second.put(new TextEncoder().encode("second upload"), {
        companyId: COMPANY,
      });

      expect(await second.stat(stored.key)).not.toBeNull();
      expect(await readdir(tmpDir)).toContain("not-ours.log");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sweeps at most once per interval, so it is not a cost on every upload", async () => {
    const { storage: local, root: dir, tmpDir } = await freshStorage();
    try {
      // First upload: sweeps (nothing to find), and claims the interval.
      await local.put(new TextEncoder().encode("first"), {
        companyId: COMPANY,
      });

      // An orphan appearing AFTER that claim waits for the next window rather
      // than making every subsequent upload pay for a `readdir`.
      const orphan = await plantTempFile(tmpDir, 3 * HOUR_MS);
      await local.put(new TextEncoder().encode("second"), {
        companyId: COMPANY,
      });
      expect(await readdir(tmpDir)).toContain(orphan);

      // A worker that starts later — or the same one an hour on — collects it.
      await new LocalFilesystemDocumentStorage(dir).put(
        new TextEncoder().encode("third"),
        { companyId: COMPANY },
      );
      expect(await readdir(tmpDir)).not.toContain(orphan);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("getStream / stat / delete", () => {
  it("throws a typed NOT_FOUND (no raw ENOENT) for an unknown key", async () => {
    const key = `${COMPANY}/${digestOf("never uploaded")}`;

    const err = await storage.getStream(key).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentStorageError);
    expect((err as DocumentStorageError).code).toBe("NOT_FOUND");
    // The errno must not leak to the caller as the error's own identity…
    expect((err as NodeJS.ErrnoException).code).not.toBe("ENOENT");
    // …though it is preserved as `cause` for logs.
    expect((err as DocumentStorageError).cause).toMatchObject({
      code: "ENOENT",
    });
  });

  it("stat returns null for an unknown key and metadata for a stored one", async () => {
    expect(await storage.stat(`${COMPANY}/${digestOf("absent")}`)).toBeNull();

    const body = "stat me";
    const { key, sha256 } = await storage.put(new TextEncoder().encode(body), {
      companyId: COMPANY,
    });
    expect(await storage.stat(key)).toMatchObject({
      key,
      sha256,
      sizeBytes: Buffer.byteLength(body),
    });
    expect((await storage.stat(key))?.modifiedAt).toBeInstanceOf(Date);
  });

  it("stat returns null after delete, and delete is idempotent", async () => {
    const { key } = await storage.put(new TextEncoder().encode("delete me"), {
      companyId: COMPANY,
    });
    expect(await storage.stat(key)).not.toBeNull();

    expect(await storage.delete(key)).toBe(true);
    expect(await storage.stat(key)).toBeNull();
    expect(await storage.delete(key)).toBe(false);
    await expect(storage.getStream(key)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("path traversal", () => {
  // The root here does NOT exist: had validation run after any filesystem
  // access, the failure would be STORAGE_NOT_CONFIGURED / ENOENT rather than
  // INVALID_KEY. Combined with the fs call counter, this pins the ORDER.
  const missingRoot = path.join(
    os.tmpdir(),
    "hosmos-storage-does-not-exist-xyz",
  );
  const hostile = new LocalFilesystemDocumentStorage(missingRoot);

  const badCompanyIds = [
    "../../etc",
    "..",
    ".",
    "",
    "..%2f..",
    `${COMPANY}/../..`,
    "/etc",
    "a\0b",
    "not-a-uuid",
  ];

  it.each(badCompanyIds)(
    "rejects companyId %j before touching the filesystem",
    async (companyId) => {
      fsCalls.count = 0;
      const err = await hostile
        .put(new TextEncoder().encode("x"), { companyId })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DocumentStorageError);
      expect((err as DocumentStorageError).code).toBe("INVALID_KEY");
      expect(fsCalls.count).toBe(0);
    },
  );

  const badKeys = [
    "..%2f..",
    "../../etc/passwd",
    `${COMPANY}/../../etc/passwd`,
    `../${COMPANY}/${digestOf("x")}`,
    `${COMPANY}/..`,
    `${COMPANY}/${digestOf("x")}/extra`,
    `${COMPANY}/${digestOf("x").toUpperCase()}`,
    `${COMPANY}/not-a-hash`,
    "",
    `${COMPANY}`,
  ];

  it.each(badKeys)(
    "rejects key %j before touching the filesystem",
    async (key) => {
      for (const op of [
        () => hostile.getStream(key),
        () => hostile.stat(key),
        () => hostile.delete(key),
      ]) {
        fsCalls.count = 0;
        const err = await op().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DocumentStorageError);
        expect((err as DocumentStorageError).code).toBe("INVALID_KEY");
        expect(fsCalls.count).toBe(0);
      }
    },
  );

  it("cannot read a file planted outside the root", async () => {
    const outside = path.join(root, "..", `hosmos-outside-${process.pid}.txt`);
    await writeFile(outside, "secret");
    try {
      // Every spelling that could reach it is a malformed key.
      for (const key of [
        `${COMPANY}/../../${path.basename(outside)}`,
        `..%2f${path.basename(outside)}`,
        `${COMPANY}/${path.basename(outside)}`,
      ]) {
        await expect(storage.getStream(key)).rejects.toMatchObject({
          code: "INVALID_KEY",
        });
      }
    } finally {
      await rm(outside, { force: true });
    }
  });
});

describe("DOCUMENTS_DIR configuration", () => {
  it("throws an intelligible error on first use when DOCUMENTS_DIR is unset", async () => {
    vi.stubEnv("DOCUMENTS_DIR", "");
    try {
      // Construction itself is side-effect free — the failure is on first use.
      const unconfigured = new LocalFilesystemDocumentStorage();
      const input: DocumentInput = new TextEncoder().encode("x");

      for (const op of [
        () => unconfigured.put(input, { companyId: COMPANY }),
        () => unconfigured.getStream(`${COMPANY}/${digestOf("x")}`),
        () => unconfigured.stat(`${COMPANY}/${digestOf("x")}`),
        () => unconfigured.delete(`${COMPANY}/${digestOf("x")}`),
      ]) {
        const err = await op().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DocumentStorageError);
        expect((err as DocumentStorageError).code).toBe(
          "STORAGE_NOT_CONFIGURED",
        );
        expect((err as Error).message).toMatch(/DOCUMENTS_DIR is not set/);
        expect((err as Error).message).toMatch(/web root/);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never silently falls back to a relative ./uploads directory", async () => {
    vi.stubEnv("DOCUMENTS_DIR", "");
    try {
      const unconfigured = new LocalFilesystemDocumentStorage();
      await expect(
        unconfigured.put(new TextEncoder().encode("x"), { companyId: COMPANY }),
      ).rejects.toThrow();
      // Nothing was created in the repo working directory.
      const cwdEntries = await readdir(process.cwd());
      expect(cwdEntries).not.toContain("uploads");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a DOCUMENTS_DIR that is not an existing directory", async () => {
    const missing = new LocalFilesystemDocumentStorage(
      path.join(os.tmpdir(), "hosmos-storage-absent-root"),
    );
    const err = await missing
      .put(new TextEncoder().encode("x"), { companyId: COMPANY })
      .catch((e: unknown) => e);
    expect((err as DocumentStorageError).code).toBe("STORAGE_NOT_CONFIGURED");
    expect((err as Error).message).toMatch(/not an existing directory/);
  });

  it("rejects a blank explicit root at construction", () => {
    expect(() => new LocalFilesystemDocumentStorage("  ")).toThrow(
      DocumentStorageError,
    );
  });

  it("reads DOCUMENTS_DIR per call, so a per-suite env value is honoured", async () => {
    vi.stubEnv("DOCUMENTS_DIR", root);
    try {
      const fromEnv = new LocalFilesystemDocumentStorage();
      const res = await fromEnv.put(new TextEncoder().encode("via env"), {
        companyId: COMPANY,
      });
      expect(res.key).toBe(`${COMPANY}/${digestOf("via env")}`);
      expect(await storage.stat(res.key)).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
