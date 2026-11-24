// THE APPEND-ONLY CHANGE TIMELINE OF ONE ROW (T4.5 — UI-3, LC-10, D5).
//
// See docs/decisions/app-evidence-_lib-timeline.md for the full account.
import type { AuditEntryDto, RowMixinDto } from "./api";

/** One row of the merged timeline. The `kind` says which source it came from. */
export type TimelineEntry =
  | {
      kind: "version";
      /** Stable across renders: the version's own id. */
      key: string;
      /** 1-based position in the chain, oldest first — what the chain reads as. */
      no: number;
      at: string | null;
      version: RowMixinDto;
      /** The live head: not superseded and not a tombstone. */
      head: boolean;
    }
  | {
      kind: "audit";
      key: string;
      at: string | null;
      entry: AuditEntryDto;
    };

/** The sortable instant of an entry. A missing timestamp keeps chain order. */
function instant(at: string | null): number {
  if (at === null) return 0;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * THE merged timeline of one row: its versions, oldest first, with the audit
 * rows about those versions interleaved by time.
 *
 * `versions` arrives oldest first (`GET …/history`) and `audit` newest first
 * (`GET /api/audit`); the result is oldest first, because a change timeline is
 * read as a story and a story starts at the beginning.
 *
 * TIES ARE BROKEN BY SOURCE ORDER, and the tie is real: an approval writes the
 * new version and its `audit_log` row inside one request, so the two can share a
 * timestamp to the millisecond. The version is emitted first — the act came
 * before the note about it — and the `seq` below is what makes that ordering
 * deterministic across reloads instead of dependent on sort stability.
 */
export function buildTimeline(
  versions: readonly RowMixinDto[],
  audit: readonly AuditEntryDto[],
): TimelineEntry[] {
  const versionIds = new Set(versions.map((version) => version.id));

  const entries: { seq: number; entry: TimelineEntry }[] = versions.map(
    (version, index) => ({
      // Versions get the EVEN slots, audit rows the odd one just after the
      // version they are about — see the tie rule above.
      seq: index * 2,
      entry: {
        kind: "version",
        key: version.id,
        no: index + 1,
        at: version.created_at,
        version,
        head: version.superseded_by_id === null && !version.is_deleted,
      },
    }),
  );

  for (const row of audit) {
    if (row.entityId === null || !versionIds.has(row.entityId)) continue;
    const about = versions.findIndex((version) => version.id === row.entityId);
    entries.push({
      seq: about * 2 + 1,
      entry: {
        kind: "audit",
        key: `audit:${row.id}`,
        at: row.createdAt,
        entry: row,
      },
    });
  }

  return entries
    .sort((a, b) => instant(a.entry.at) - instant(b.entry.at) || a.seq - b.seq)
    .map((wrapped) => wrapped.entry);
}

/**
 * Did the audit read cover the whole chain, or is its window shorter than the
 * row's life?
 *
 * `/api/audit` returns the company's most recent `limit` rows and nothing older.
 * If the OLDEST row we received is younger than the oldest version of the chain,
 * an approval of that version could exist and be outside what we read — so the
 * timeline says so. When fewer rows came back than the limit, the response IS
 * the whole trail and there is nothing to disclose.
 */
export function auditWindowIncomplete(
  versions: readonly RowMixinDto[],
  audit: readonly AuditEntryDto[],
  limit: number,
): boolean {
  if (audit.length < limit) return false;
  const oldestAudit = audit.reduce(
    (oldest, row) => Math.min(oldest, instant(row.createdAt)),
    Number.POSITIVE_INFINITY,
  );
  const oldestVersion = versions.reduce(
    (oldest, version) => Math.min(oldest, instant(version.created_at)),
    Number.POSITIVE_INFINITY,
  );
  return oldestVersion < oldestAudit;
}
