// THE REPORTING BOUNDARY (DM-8, DM-9, D10/D15) — which legal entities a period
// reports on, and WHY the ones it leaves out are out.
//
// See docs/decisions/server-periods-scope.md for the full account.
import { and, asc, eq, inArray } from "drizzle-orm";

import { oneOfOrNull, textOrNull, uuidOrNull } from "@/server/api/parse";
import type { ParseResult } from "@/server/api/parse";
import { logAudit } from "@/server/db/audit";
import type { DbClient } from "@/server/db/client";
import { legalEntity, periodScope } from "@/server/db/schema";
import {
  refuseValidation,
  writeValidated,
  type WriteResult,
} from "@/server/validation/write";
import {
  isApplicabilityStatus,
  type ApplicabilityStatus,
} from "@/shared/enums";
import type { CompanyRole } from "@/shared/roles";

import { PERIOD_SCOPE_FIELD } from "./lifecycle";
import { getPeriod, type PeriodRow } from "./periods";

/** A `period_scope` row as Drizzle returns it. */
export type PeriodScopeRow = typeof periodScope.$inferSelect;

/** One boundary decision as the wire states it (a whole row, never a patch). */
export interface PeriodScopeEntry {
  legalEntityId: string;
  status: ApplicabilityStatus;
  /** D15 — mandatory when `excluded` (VAL-101 judges it), optional otherwise. */
  exclusionReason: string | null;
}

/** Who is drawing the boundary — the LC-10 half of the write (from the session). */
export interface ScopeActor {
  userId: string;
  /** The actor's role AT THE TIME, snapshotted into the audit row (§11.1). */
  role: CompanyRole | null;
}

// ─── Wire contract (§4.6 — DD names) ─────────────────────────────────────────

/**
 * One boundary row as the API speaks it.
 *
 * NO `id`. The natural key of the boundary is `(period_id, legal_entity_id)` —
 * it is the UNIQUE constraint, it is what a PUT addresses, and it is what a
 * client renders against its entity list. Publishing the surrogate id would
 * invite a client to address rows by it and freeze an implementation detail
 * (whether a replacement updates a row in place or recreates it) into the API.
 * `period_id` is not repeated per row either: it is the URL.
 *
 * The entity's NAME is deliberately absent too — the boundary screen already
 * holds the registry (`GET /api/org/entities`), and joining it here would make
 * every boundary read pay for a projection only one client wants.
 */
export interface PeriodScopeDto {
  legal_entity_id: string;
  status: string;
  exclusion_reason: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

/** THE serialiser. Every response about a boundary row goes through it. */
function toDto(row: PeriodScopeRow): PeriodScopeDto {
  return {
    legal_entity_id: row.legalEntityId,
    status: row.status,
    exclusion_reason: row.exclusionReason,
    updated_by: row.updatedBy,
    updated_at: row.updatedAt?.toISOString() ?? null,
  };
}

/** Serialise a boundary (the whole set — a boundary is never read one row at a time). */
export function serialisePeriodScope(
  rows: readonly PeriodScopeRow[],
): PeriodScopeDto[] {
  return rows.map(toDto);
}

/**
 * Wire → entries, with per-field SHAPE validation only (see `@/server/api/parse`
 * for where the line runs).
 *
 * `entries` is REQUIRED and is the whole boundary; `[]` is a legitimate body
 * meaning "this period has no boundary rows" (the state a period is created in),
 * not a mistake to guess around. `status` is required per row — the boundary
 * decision is the point of the row and defaulting it to `included` would put
 * entities in a report because a client forgot a field. `exclusion_reason` is
 * optional and blank-as-null, and its ABSENCE is a null rather than "leave the
 * stored one": each entry is a complete row, so a reason cannot outlive the
 * exclusion that justified it.
 *
 * THE ONE STRUCTURAL RULE THAT IS NOT A VAL-*: an entity may appear at most
 * once. The database says the same thing (`period_scope_period_entity_key`), but
 * a duplicate would reach it as a driver error — a 500 for what is plainly a
 * malformed request — and the two spellings of one entity's fate are not
 * something a server should pick a winner from. Rejected as a FIELD, with the
 * index, because no rule owns it.
 */
export function parsePeriodScope(
  body: unknown,
): ParseResult<PeriodScopeEntry[]> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, field: "body" };
  }
  const raw = (body as Record<string, unknown>).entries;
  if (!Array.isArray(raw)) return { ok: false, field: "entries" };

  const entries: PeriodScopeEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const at = (field: string): ParseResult<PeriodScopeEntry[]> => ({
      ok: false,
      field: `entries[${index}].${field}`,
    });
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, field: `entries[${index}]` };
    }
    const input = item as Record<string, unknown>;

    const legalEntityId = uuidOrNull(input.legal_entity_id);
    if (legalEntityId === undefined || legalEntityId === null) {
      return at("legal_entity_id");
    }
    if (seen.has(legalEntityId)) return at("legal_entity_id");
    seen.add(legalEntityId);

    const status = oneOfOrNull(input.status, isApplicabilityStatus);
    if (status === undefined || status === null) return at("status");

    // An ABSENT key is a null, not a rejection: an included row has nothing to
    // explain, so most entries simply do not carry the field. (`textOrNull`
    // cannot make that distinction — to it, absent and malformed are both
    // `undefined` — which is why the check is here and not in the primitive.)
    const exclusionReason =
      input.exclusion_reason === undefined
        ? null
        : textOrNull(input.exclusion_reason);
    if (exclusionReason === undefined) return at("exclusion_reason");

    entries.push({ legalEntityId, status, exclusionReason });
  }
  return { ok: true, values: entries };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The boundary of one period, tenant-pinned. Ordered by entity id so two reads
 * of an unchanged boundary are byte-identical (a client diffs them; insertion
 * order would make an unchanged boundary look edited).
 */
export async function listPeriodScope(
  db: DbClient,
  companyId: string,
  periodId: string,
): Promise<PeriodScopeRow[]> {
  return db
    .select()
    .from(periodScope)
    .where(
      and(
        eq(periodScope.companyId, companyId),
        eq(periodScope.periodId, periodId),
      ),
    )
    .orderBy(asc(periodScope.legalEntityId));
}

// ─── The write ───────────────────────────────────────────────────────────────

/** Outcome of a boundary write: the PERIOD it belongs to, or why it was refused. */
export type PeriodScopeWriteResult = WriteResult<PeriodRow>;

/** The `period` scope — the boundary is validated as part of its period. */
const SCOPE = { scope: "period" } as const;

/** What one PUT changes, against the boundary as it was when the write began. */
interface BoundaryDiff {
  readonly added: readonly PeriodScopeEntry[];
  readonly changed: readonly {
    readonly before: PeriodScopeRow;
    readonly after: PeriodScopeEntry;
  }[];
  readonly removed: readonly PeriodScopeRow[];
}

/** True when the payload asks for the boundary that is already stored. */
function isUnchanged(diff: BoundaryDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.changed.length === 0 &&
    diff.removed.length === 0
  );
}

/** The diff of the stored boundary against the payload (keyed by entity, DM-8). */
function diffBoundary(
  existing: readonly PeriodScopeRow[],
  entries: readonly PeriodScopeEntry[],
): BoundaryDiff {
  const before = new Map(existing.map((row) => [row.legalEntityId, row]));
  const added: PeriodScopeEntry[] = [];
  const changed: { before: PeriodScopeRow; after: PeriodScopeEntry }[] = [];

  for (const entry of entries) {
    const row = before.get(entry.legalEntityId);
    if (!row) {
      added.push(entry);
    } else if (
      row.status !== entry.status ||
      row.exclusionReason !== entry.exclusionReason
    ) {
      changed.push({ before: row, after: entry });
    }
  }

  const wanted = new Set(entries.map((entry) => entry.legalEntityId));
  const removed = existing.filter((row) => !wanted.has(row.legalEntityId));
  return { added, changed, removed };
}

/** One boundary row in the audit summary, in the wire's own names. */
function auditedEntry(entry: PeriodScopeEntry) {
  return {
    legal_entity_id: entry.legalEntityId,
    status: entry.status,
    exclusion_reason: entry.exclusionReason,
  };
}

/** The same, for a row as it was STORED (a removal, or the "from" of a change). */
function auditedRow(row: PeriodScopeRow) {
  return {
    legal_entity_id: row.legalEntityId,
    status: row.status,
    exclusion_reason: row.exclusionReason,
  };
}

/**
 * The `audit_log.summary` of one boundary change (LC-10, DM-9).
 *
 * BEFORE AND AFTER, not the resulting set: an auditor asks what moved and on
 * what stated grounds, and "here are the eight rows that are there now" answers
 * neither. A REMOVED row is recorded with the status and reason it carried, so
 * the disclosure a removal destroys survives in the trail; a CHANGED row carries
 * both halves, so "excluded → included" and the reason that was dropped with it
 * are both legible. The counts are there because the two questions a boundary
 * screen asks first — how many entities, how many of them in the report — should
 * not require re-reading the table at the timestamp of the entry.
 */
function auditSummary(
  periodId: string,
  entries: readonly PeriodScopeEntry[],
  diff: BoundaryDiff,
): Record<string, unknown> {
  return {
    period_id: periodId,
    entities: entries.length,
    included: entries.filter((entry) => entry.status === "included").length,
    added: diff.added.map(auditedEntry),
    changed: diff.changed.map(({ before, after }) => ({
      legal_entity_id: after.legalEntityId,
      from: {
        status: before.status,
        exclusion_reason: before.exclusionReason,
      },
      to: { status: after.status, exclusion_reason: after.exclusionReason },
    })),
    removed: diff.removed.map(auditedRow),
  };
}

/**
 * Every entity the payload names must exist IN THIS COMPANY (API-1: another
 * tenant's entity and a made-up uuid are the same answer). One query, before any
 * write: `period_scope.legal_entity_id` is an FK, and an FK violation is a 500
 * that no rule could turn into a refusal.
 */
async function assertEntities(
  tx: DbClient,
  companyId: string,
  entries: readonly PeriodScopeEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const ids = entries.map((entry) => entry.legalEntityId);
  const rows = await tx
    .select({ id: legalEntity.id })
    .from(legalEntity)
    .where(
      and(eq(legalEntity.companyId, companyId), inArray(legalEntity.id, ids)),
    );
  // `ids` is duplicate-free (the parser refuses a repeated entity), so a count
  // that does not match names an id this company cannot see.
  if (rows.length !== ids.length) refuseValidation();
}

/** Apply the diff. Rows the payload repeats unchanged are not touched at all —
 *  their `updated_by`/`updated_at` keep pointing at who last really changed them. */
async function applyDiff(
  tx: DbClient,
  companyId: string,
  periodId: string,
  diff: BoundaryDiff,
  updatedBy: string,
): Promise<void> {
  if (diff.removed.length > 0) {
    await tx.delete(periodScope).where(
      and(
        eq(periodScope.companyId, companyId),
        eq(periodScope.periodId, periodId),
        inArray(
          periodScope.legalEntityId,
          diff.removed.map((row) => row.legalEntityId),
        ),
      ),
    );
  }

  for (const entry of diff.added) {
    await tx.insert(periodScope).values({
      companyId,
      periodId,
      legalEntityId: entry.legalEntityId,
      status: entry.status,
      exclusionReason: entry.exclusionReason,
      updatedBy,
      updatedAt: new Date(),
    });
  }

  for (const { after } of diff.changed) {
    await tx
      .update(periodScope)
      .set({
        status: after.status,
        exclusionReason: after.exclusionReason,
        updatedBy,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(periodScope.companyId, companyId),
          eq(periodScope.periodId, periodId),
          eq(periodScope.legalEntityId, after.legalEntityId),
        ),
      );
  }
}

/**
 * Replace the boundary of one period (DM-8/DM-9) — the ONE write path of
 * `period_scope`.
 *
 * SHAPE OF THE TRANSACTION, because every acceptance criterion of this task is a
 * statement about it. `writeValidated` opens it, and inside it, in this order:
 * the entities are resolved, the stored boundary is read (the pre-image — read
 * HERE, not before, so no concurrent write can make the diff and the DELETE
 * disagree), the diff is applied, and the audit entry is written. Then the
 * `period` scope runs against the period and a blocking failure — VAL-101 on a
 * reason-less exclusion, VAL-106 on a frozen period, VAL-102/103 on a boundary
 * the report could not print — throws, which unwinds the whole of it: no rows,
 * no audit entry, no validation results. Atomicity is not an extra guarantee
 * here, it is the same `throw` that produces the 422.
 *
 * THE SENTINEL IS DECLARED UNCONDITIONALLY, unlike `updatePeriod`'s diff of the
 * six fields. A period PATCH mixes frozen and unfrozen fields, so re-sending an
 * unchanged `start_date` must not be read as an edit; a boundary PUT has no such
 * mixture — the entire payload IS the frozen surface, and "you may not put the
 * boundary of a period whose revision has left draft" is the rule, not "you may,
 * as long as nothing moves". What an unchanged payload does buy is silence in
 * the trail: with an empty diff nothing is written and no audit row is made, so
 * a screen that saves without edits does not fill the log with non-events.
 *
 * A foreign or unknown `periodId` is `NOT_FOUND` (the route answers `VALIDATION`
 * — API-1); the period row is returned so the run judges the PERIOD, which is
 * what `period`-scope rules take as their target.
 */
export async function replacePeriodScope(
  db: DbClient,
  companyId: string,
  periodId: string,
  entries: readonly PeriodScopeEntry[],
  actor: ScopeActor,
): Promise<PeriodScopeWriteResult> {
  const period = await getPeriod(db, companyId, periodId);
  if (!period) return { ok: false, error: "NOT_FOUND" };

  return writeValidated(
    db,
    { companyId, ...SCOPE, mutatedFields: [PERIOD_SCOPE_FIELD] },
    async (tx) => {
      await assertEntities(tx, companyId, entries);

      const existing = await listPeriodScope(tx, companyId, periodId);
      const diff = diffBoundary(existing, entries);
      if (isUnchanged(diff)) return period;

      await applyDiff(tx, companyId, periodId, diff, actor.userId);
      await logAudit(tx, {
        companyId,
        userId: actor.userId,
        actorRole: actor.role,
        entity: "period_scope",
        // The boundary belongs to the PERIOD and is written as one set, so the
        // period is what the entry points at — a single row's id would name an
        // arbitrary member of the change (and, for a removal, a deleted one).
        entityId: periodId,
        action: existing.length === 0 ? "create" : "update",
        summary: auditSummary(periodId, entries, diff),
      });
      return period;
    },
  );
}
