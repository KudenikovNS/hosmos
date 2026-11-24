/**
 * `DocumentStorage` — the single blob backend for the whole app (SPEC §8, EV-0).
 *
 * See docs/decisions/server-storage-document-storage.md for the full account.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  rename,
  stat as fsStat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/** Subdirectory (inside the root) holding in-flight temp files. */
const TMP_DIR = ".tmp";

/** Filename prefix every temp file of `put` carries — the sweep's whitelist. */
const TMP_PREFIX = "put-";

/**
 * HOW STALE A TEMP FILE MUST BE BEFORE THE SWEEP MAY REMOVE IT.
 *
 * `put`'s `finally` covers every way a request ENDS — a refusal, a broken
 * stream, an over-limit body — but it cannot cover a way the process STOPS: a
 * SIGKILL, an OOM kill, a cPanel Passenger restart mid-upload. Each such death
 * strands one temp file of up to `maxUploadMb`, on a host with a disk quota and
 * nothing else that ever looks in `.tmp`. That is what this threshold makes
 * collectable.
 *
 * The age is measured from `mtime`, NOT from creation, and that is the whole
 * safety argument: an upload still in flight is WRITING, so every chunk pushes
 * its `mtime` forward. The age therefore measures how long a temp file has been
 * STALLED, not how long the upload has been running — a slow client trickling a
 * 20 MB file for two hours is never one hour stale. An hour of complete silence
 * on a file the request handler is supposedly still writing means the writer is
 * gone; no live `put` can be swept out from under itself.
 */
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * At most one sweep per instance per this interval.
 *
 * WHY THE SWEEP HANGS OFF `put` and not off process start or a cron:
 *  - A CRON would be a second thing to install. The deploy target is shared
 *    cPanel, the billing cron already had to be registered by hand, and a
 *    cleanup that silently never runs because nobody added the schedule line is
 *    exactly the failure R-3 is written against. Disk quota is the symptom, and
 *    the operator would meet it long before they met the missing crontab entry.
 *  - PROCESS START runs at the one moment there is provably nothing to collect
 *    from THIS process, and Passenger keeps a worker alive for days — so a
 *    process that leaks on day one holds the bytes until day four's restart.
 *  - `put` IS THE LEAK SITE. Sweeping there means the collector runs exactly
 *    when the resource is being consumed, needs no configuration, and is
 *    self-limiting: no uploads, no growth, nothing to collect. The first `put`
 *    after a restart sweeps, which subsumes the process-start option anyway.
 *
 * The cost is one `readdir` of a directory that is normally empty, at most once
 * an hour per worker, and it is claimed BEFORE the work so concurrent uploads
 * do not all sweep at once.
 */
const TMP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A company id is a uuid (`document.company_id uuid`, DM-24). Validating the
 * exact shape — not merely "no slashes" — is the cheapest possible traversal
 * defence: `../../etc`, `..%2f..`, absolute paths and NUL bytes all fail here.
 */
const COMPANY_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lowercase hex SHA-256, exactly 64 chars. */
const SHA256_RE = /^[0-9a-f]{64}$/;

export type DocumentStorageErrorCode =
  /** `DOCUMENTS_DIR` unset/blank, or pointing at something that is not a directory. */
  | "STORAGE_NOT_CONFIGURED"
  /** Malformed company id or object key — rejected before any filesystem access. */
  | "INVALID_KEY"
  /** No object under that key. */
  | "NOT_FOUND"
  /** The stream exceeded the caller-supplied `maxSizeBytes`. */
  | "LIMIT_EXCEEDED"
  /** The filesystem misbehaved (short write, unreadable file, …). */
  | "IO_ERROR";

/**
 * Typed storage failure. Callers switch on `.code`; no raw `ENOENT` /
 * `NodeJS.ErrnoException` ever escapes this module, so the API layer can map
 * storage failures onto `ApiResult` codes without sniffing errno strings.
 */
export class DocumentStorageError extends Error {
  readonly code: DocumentStorageErrorCode;

  constructor(
    code: DocumentStorageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DocumentStorageError";
    this.code = code;
  }
}

/** Anything a caller can hand to `put`: a buffer, a Web stream, or an async iterable. */
export type DocumentInput =
  Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

/** Per-upload metadata. `companyId` scopes the key; the rest is backend hints. */
export interface PutOptions {
  /** Tenant scope — becomes the first key segment. */
  companyId: string;
  /**
   * Content type. Ignored by the filesystem backend (the DB row carries
   * `document.mime`, DM-24); an S3 backend would send it as `Content-Type`.
   */
  mime?: string;
  /**
   * Hard byte cap. Exceeding it aborts the write and throws `LIMIT_EXCEEDED`
   * BEFORE the object becomes visible. Callers pass the per-plan limit
   * (`PlanFeatures.maxUploadMb × 1024²`); storage has no opinion on the value.
   */
  maxSizeBytes?: number;
}

/** What `put` learned about the stored object. */
export interface PutResult {
  /** `{companyId}/{sha256}` — persist as `document.storage_key` (DM-24). */
  key: string;
  /** SHA-256 of the bytes, lowercase hex — persist as `document.file_hash`. */
  sha256: string;
  /** Byte length as observed on disk after the write — `document.size_bytes`. */
  sizeBytes: number;
  /** True when identical bytes were already stored and no new file was created. */
  deduplicated: boolean;
}

/** What `stat` reports about a stored object. */
export interface StoredObject {
  key: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt: Date;
}

/**
 * The storage contract. Keep it backend-neutral: any new method must be
 * expressible over S3/R2 as well as over a local disk.
 */
export interface DocumentStorage {
  /** Store bytes; returns the content-addressed key, size and digest. */
  put(input: DocumentInput, meta: PutOptions): Promise<PutResult>;
  /** Open a stored object for reading. Throws `NOT_FOUND` for an unknown key. */
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;
  /** Metadata for a stored object, or `null` when it does not exist. */
  stat(key: string): Promise<StoredObject | null>;
  /** Remove the bytes (D6/EV-3: explicit action only). `true` if something was removed. */
  delete(key: string): Promise<boolean>;
}

/** Narrow an unknown throwable to a specific POSIX errno. */
function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function assertCompanyId(companyId: string): void {
  if (!COMPANY_ID_RE.test(companyId)) {
    throw new DocumentStorageError(
      "INVALID_KEY",
      "Invalid companyId for document storage: expected a uuid.",
    );
  }
}

/**
 * Split `{companyId}/{sha256}` and validate both halves.
 *
 * The key is NEVER url-decoded: `..%2f..` must stay a single malformed segment
 * and be rejected, not decoded into `../..`. A key has exactly one separator,
 * so anything with a different shape dies here — before the root is even read.
 */
function parseKey(key: string): { companyId: string; sha256: string } {
  const parts = key.split("/");
  if (parts.length !== 2) {
    throw new DocumentStorageError(
      "INVALID_KEY",
      "Invalid storage key: expected exactly `{companyId}/{sha256}`.",
    );
  }
  const [companyId, sha256] = parts;
  assertCompanyId(companyId);
  if (!SHA256_RE.test(sha256)) {
    throw new DocumentStorageError(
      "INVALID_KEY",
      "Invalid storage key: the object part must be a lowercase hex sha256.",
    );
  }
  return { companyId, sha256 };
}

/**
 * Belt-and-braces containment check. The regexes above already make escape
 * impossible; this re-derives the answer from the resolved path so a future
 * loosening of a regex cannot silently open a traversal hole.
 */
function resolveObjectPath(
  root: string,
  companyId: string,
  sha256: string,
): string {
  const resolved = path.resolve(root, companyId, sha256);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(prefix)) {
    throw new DocumentStorageError(
      "INVALID_KEY",
      "Refusing a storage path that resolves outside DOCUMENTS_DIR.",
    );
  }
  return resolved;
}

/** Normalise every accepted input shape into a chunk stream. */
async function* toChunks(input: DocumentInput): AsyncGenerator<Uint8Array> {
  if (input instanceof Uint8Array) {
    yield input;
    return;
  }
  if (typeof (input as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (input as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of input as AsyncIterable<Uint8Array>) yield chunk;
  }
}

/**
 * Local-filesystem `DocumentStorage`.
 *
 * The root is resolved on EVERY operation rather than cached in the
 * constructor: `DOCUMENTS_DIR` is per-suite in tests (harness T1.7) and the
 * module singleton below outlives any single request. Constructing the class is
 * therefore side-effect free — a missing `DOCUMENTS_DIR` surfaces on first use.
 */
export class LocalFilesystemDocumentStorage implements DocumentStorage {
  private readonly explicitRoot?: string;

  /**
   * When this instance last started a sweep (epoch ms). `0` means "never", so
   * the first `put` of a fresh worker always sweeps — which is what makes the
   * on-`put` placement cover the process-start case too.
   */
  private lastSweepAt = 0;

  /** @param root Optional fixed root; when omitted, `DOCUMENTS_DIR` is read per call. */
  constructor(root?: string) {
    if (root !== undefined && root.trim() === "") {
      throw new DocumentStorageError(
        "STORAGE_NOT_CONFIGURED",
        "DocumentStorage was constructed with a blank root directory.",
      );
    }
    this.explicitRoot = root;
  }

  async put(input: DocumentInput, meta: PutOptions): Promise<PutResult> {
    // Validation first — nothing below this line may run for a hostile companyId.
    assertCompanyId(meta.companyId);

    const root = await this.resolveRoot();
    const tmpDir = path.join(root, TMP_DIR);
    await mkdir(tmpDir, { recursive: true });

    // Collect what earlier CRASHES stranded here. Deliberately BEFORE this
    // upload's own temp file exists, so this `put` cannot be a candidate for
    // its own sweep however long the sweep takes; concurrent uploads are
    // covered by the age threshold instead. Best-effort throughout: a cleanup
    // that cannot run must never turn a good upload into a failure.
    await this.sweepStaleTempFiles(tmpDir);

    // Atomic write, step 1: a uniquely named temp file in the same filesystem
    // as the target, so step 2 (`rename`) is a single atomic operation. A crash
    // or a mid-stream error leaves only this temp file, never a truncated
    // object under a real key.
    const tmpPath = path.join(tmpDir, `put-${randomUUID()}`);
    const hash = createHash("sha256");
    let bytes = 0;
    let renamed = false;

    try {
      const handle = await open(tmpPath, "wx", 0o600);
      try {
        for await (const chunk of toChunks(input)) {
          bytes += chunk.byteLength;
          if (meta.maxSizeBytes !== undefined && bytes > meta.maxSizeBytes) {
            throw new DocumentStorageError(
              "LIMIT_EXCEEDED",
              `Upload exceeds the allowed size of ${meta.maxSizeBytes} bytes.`,
            );
          }
          hash.update(chunk);
          await handle.write(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }

      const sha256 = hash.digest("hex");
      const key = `${meta.companyId}/${sha256}`;
      const target = resolveObjectPath(root, meta.companyId, sha256);

      // Dedup: the key is the digest, so an existing file has identical bytes.
      const existing = await this.statPath(target);
      if (existing) {
        return { key, sha256, sizeBytes: existing.size, deduplicated: true };
      }

      await mkdir(path.dirname(target), { recursive: true });
      // Atomic write, step 2. `rename` is atomic and overwrite-safe on POSIX,
      // so a concurrent put of the same content is harmless: whichever wins,
      // the resulting file holds exactly these bytes.
      await rename(tmpPath, target);
      renamed = true;

      // Size is taken from disk, not from the counter, because the counter only
      // proves what we handed to write(2). They are cross-checked so a short
      // write becomes a loud IO_ERROR instead of a silently wrong size_bytes.
      const written = await this.statPath(target);
      if (!written || written.size !== bytes) {
        throw new DocumentStorageError(
          "IO_ERROR",
          `Short write for ${key}: expected ${bytes} bytes, found ${written?.size ?? "none"}.`,
        );
      }
      return { key, sha256, sizeBytes: written.size, deduplicated: false };
    } catch (err) {
      // T5.10 FOUND THIS GAP while writing the operational note. Everything
      // above ran under a `try/finally` with no `catch`, so a raw errno from
      // `open`/`write`/`sync`/`rename` escaped the module — contradicting this
      // file's own header ("no raw ENOENT / NodeJS.ErrnoException ever escapes")
      // and reaching the API as an untyped 500.
      //
      // The case that matters is a FULL DISK. The deploy target is a cPanel host
      // with a quota, so `ENOSPC` (filesystem full) and `EDQUOT` (quota
      // exhausted) are the realistic failures here, and they are the ones an
      // operator most needs named: `LIMIT_EXCEEDED` means the plan's per-file
      // cap and must not be reused for them, or "upgrade your plan" would be
      // offered to somebody whose server is out of room. They become an
      // `IO_ERROR` — the API's 500 is right, since nothing the caller does fixes
      // it — carrying the errno in the message so the log names the cause.
      if (err instanceof DocumentStorageError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      // ONLY an errno is wrapped. A failure with no `code` did not come from the
      // filesystem — it came from the SOURCE, the caller's own stream dying
      // mid-upload — and that is not a storage fault to rename. Its message is
      // the only description of what went wrong upstream, so it propagates
      // untouched; the `finally` below still removes the partial temp file.
      if (typeof code !== "string") throw err;
      throw new DocumentStorageError(
        "IO_ERROR",
        code === "ENOSPC" || code === "EDQUOT"
          ? `Out of disk space writing the document store (${code}).`
          : `Failed to write to the document store (${code}).`,
        { cause: err },
      );
    } finally {
      if (!renamed) {
        // Failure (or dedup) path: drop the temp file. Best-effort — a leaked
        // temp file is never reachable through a key.
        await unlink(tmpPath).catch(() => undefined);
      }
    }
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const { companyId, sha256 } = parseKey(key);
    const root = await this.resolveRoot();
    const target = resolveObjectPath(root, companyId, sha256);

    let handle;
    try {
      handle = await open(target, "r");
    } catch (err) {
      if (isErrno(err, "ENOENT") || isErrno(err, "ENOTDIR")) {
        throw new DocumentStorageError(
          "NOT_FOUND",
          `No stored document for key ${key}.`,
          { cause: err },
        );
      }
      throw new DocumentStorageError(
        "IO_ERROR",
        `Cannot open the stored document for key ${key}.`,
        { cause: err },
      );
    }
    // Opened first, then streamed: no TOCTOU window between the existence
    // check and the read, and the handle is closed with the stream.
    const nodeStream = handle.createReadStream({ autoClose: true });
    return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
  }

  async stat(key: string): Promise<StoredObject | null> {
    const { companyId, sha256 } = parseKey(key);
    const root = await this.resolveRoot();
    const stats = await this.statPath(
      resolveObjectPath(root, companyId, sha256),
    );
    if (!stats) return null;
    return {
      key,
      sha256,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime,
    };
  }

  async delete(key: string): Promise<boolean> {
    const { companyId, sha256 } = parseKey(key);
    const root = await this.resolveRoot();
    const target = resolveObjectPath(root, companyId, sha256);
    try {
      await unlink(target);
      return true;
    } catch (err) {
      if (isErrno(err, "ENOENT") || isErrno(err, "ENOTDIR")) return false;
      throw new DocumentStorageError(
        "IO_ERROR",
        `Cannot delete the stored document for key ${key}.`,
        { cause: err },
      );
    }
  }

  /**
   * Remove temp files that no live `put` can still own (see `TMP_MAX_AGE_MS`
   * and `TMP_SWEEP_INTERVAL_MS` for the age rule and for why this hangs off
   * `put`). Throttled per instance, and silent about every failure.
   *
   * Three things keep it from ever touching a file it should not:
   *  - only `{root}/.tmp` is read, and only REGULAR FILES named `put-*` — the
   *    exact shape this class creates. A stored object lives one directory up
   *    under `{companyId}/{sha256}` and is not reachable from here at all;
   *  - only files whose `mtime` is older than `TMP_MAX_AGE_MS`, so an upload
   *    that is still writing keeps pushing itself out of range;
   *  - each candidate is re-`stat`ed immediately before its `unlink`, so a name
   *    that was stale at `readdir` time and has since been rewritten is
   *    re-judged rather than removed on the strength of a stale listing.
   */
  private async sweepStaleTempFiles(tmpDir: string): Promise<void> {
    const startedAt = Date.now();
    if (startedAt - this.lastSweepAt < TMP_SWEEP_INTERVAL_MS) return;
    // Claimed BEFORE the work, so concurrent puts skip instead of piling up.
    this.lastSweepAt = startedAt;

    let entries;
    try {
      entries = await readdir(tmpDir, { withFileTypes: true });
    } catch {
      return; // No `.tmp` yet, or unreadable — nothing this call can do.
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(TMP_PREFIX)) continue;
      const candidate = path.join(tmpDir, entry.name);
      try {
        const stats = await fsStat(candidate);
        if (startedAt - stats.mtimeMs < TMP_MAX_AGE_MS) continue;
        await unlink(candidate);
      } catch {
        // Vanished under us, or not ours to remove. Either way the next sweep
        // gets another chance and the upload in progress is unaffected.
      }
    }
  }

  /** `stat` a path, mapping "absent" to `null` and any other errno to `IO_ERROR`. */
  private async statPath(target: string) {
    try {
      return await fsStat(target);
    } catch (err) {
      if (isErrno(err, "ENOENT") || isErrno(err, "ENOTDIR")) return null;
      throw new DocumentStorageError(
        "IO_ERROR",
        "Cannot stat a path inside DOCUMENTS_DIR.",
        { cause: err },
      );
    }
  }

  /**
   * Resolve (and sanity-check) the storage root. A missing variable or a
   * non-existent directory is an explicit error: silently falling back to a
   * relative `./uploads` would put customer evidence inside the deployed app
   * directory, i.e. potentially under the web root.
   */
  private async resolveRoot(): Promise<string> {
    const raw = this.explicitRoot ?? process.env.DOCUMENTS_DIR;
    if (!raw || raw.trim() === "") {
      throw new DocumentStorageError(
        "STORAGE_NOT_CONFIGURED",
        "DOCUMENTS_DIR is not set — cannot store or read documents. Point it at " +
          "an existing directory OUTSIDE the web root before using DocumentStorage.",
      );
    }
    const root = path.resolve(raw);
    const stats = await this.statPath(root);
    if (!stats?.isDirectory()) {
      throw new DocumentStorageError(
        "STORAGE_NOT_CONFIGURED",
        `DOCUMENTS_DIR points at "${root}", which is not an existing directory. ` +
          "Create it (outside the web root) before using DocumentStorage.",
      );
    }
    return root;
  }
}

/**
 * The app-wide storage instance. Import THIS, not `node:fs` — see the module
 * header: replacing the Phase-1 disk backend with S3 must be a one-line change
 * here and nothing else.
 */
export const documentStorage: DocumentStorage =
  new LocalFilesystemDocumentStorage();
