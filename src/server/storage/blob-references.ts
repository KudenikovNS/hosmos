// Shared ownership protocol for document and report_render content-addressed bytes.
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "@/server/db/client";
import { document, reportRender } from "@/server/db/schema";
import {
  DocumentStorageError,
  type DocumentStorage,
  type PutResult,
} from "./document-storage";

function belongsTo(companyId: string, key: string): boolean {
  return (
    key.startsWith(`${companyId}/`) &&
    /^[0-9a-f]{64}$/.test(key.slice(companyId.length + 1))
  );
}

async function lockBlob(tx: DbClient, key: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('hosmos.blob'), hashtext(${key}))`,
  );
}

/**
 * Called inside the transaction that publishes a new owner. The initial put
 * happens outside the transaction; cleanup may remove those unowned bytes.
 * Under the shared key lock, recheck and replay the immutable input if needed,
 * then keep the lock until the document/report row commits or rolls back.
 */
export async function prepareBlobReference(
  tx: DbClient,
  companyId: string,
  stored: PutResult,
  storage: DocumentStorage,
  restore: () => Promise<PutResult>,
): Promise<PutResult> {
  if (!belongsTo(companyId, stored.key))
    throw new DocumentStorageError(
      "INVALID_KEY",
      "Blob key does not belong to this company.",
    );
  await lockBlob(tx, stored.key);
  if (await storage.stat(stored.key)) return stored;
  const restored = await restore();
  if (
    restored.key !== stored.key ||
    restored.sha256 !== stored.sha256 ||
    restored.sizeBytes !== stored.sizeBytes
  )
    throw new DocumentStorageError(
      "IO_ERROR",
      "Replayed blob differs from its prepared content.",
    );
  return restored;
}

/**
 * After the owning write committed/rolled back, remove only provably unowned
 * bytes. Publication and unlink share the key lock. Any uncertain DB result
 * keeps the blob. A failed unlink leaves an orphan, never a failed row deletion.
 * The boolean means there were no remaining owners, not proof of physical unlink.
 */
export async function deleteUnreferencedBlob(
  db: DbClient,
  companyId: string,
  key: string,
  storage: DocumentStorage,
): Promise<boolean> {
  if (!belongsTo(companyId, key)) return false;
  try {
    return await db.transaction(
      async (tx) => {
        await lockBlob(tx, key);
        const documents = await tx
          .select({ id: document.id })
          .from(document)
          .where(
            and(
              eq(document.companyId, companyId),
              eq(document.storageKey, key),
            ),
          )
          .limit(1);
        if (documents.length) return false;
        const reports = await tx
          .select({ id: reportRender.id })
          .from(reportRender)
          .where(
            and(
              eq(reportRender.companyId, companyId),
              eq(reportRender.storageKey, key),
            ),
          )
          .limit(1);
        if (reports.length) return false;
        await storage.delete(key).catch(() => undefined);
        return true;
      },
      { isolationLevel: "read committed" },
    );
  } catch {
    return false;
  }
}
