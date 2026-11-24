// EVIDENCE LINKS — the polymorphic M:N join between a `document` and whatever
// it stands behind (spec §4.17 DM-25/DM-26, §8 EV-2/EV-3/EV-4, К-8).
//
// See docs/decisions/server-evidence-links.md for the full account.
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, type SQL } from "drizzle-orm";

import { uuidOrNull } from "@/server/api/parse";
import type { DbClient } from "@/server/db/client";
import {
  document,
  emissionFactor,
  evidenceLink,
  facility,
  legalEntity,
  reportRevision,
} from "@/server/db/schema";
import type { VersionCarryContext } from "@/server/inventory/rows";
import { INPUT_TABLES, type InputTableName } from "@/server/inventory/tables";
import {
  refuseValidation,
  ruleRef,
  writeValidated,
  type RuleRef,
} from "@/server/validation/write";
import { isObjectType, type ObjectType } from "@/shared/enums";

/** An `evidence_link` row as the database returns it. */
export type EvidenceLinkRow = typeof evidenceLink.$inferSelect;

// ─── The seven linkable object types (DM-25) ─────────────────────────────────

/** Is `type` one of the four append-only input tables? */
function isInputTable(type: string): type is InputTableName {
  return type in INPUT_TABLES;
}

/**
 * A resolved link target: it exists, it belongs to this tenant, and — when it is
 * an input row — the revision whose status decides whether it is frozen.
 */
interface LinkTarget {
  readonly type: ObjectType;
  readonly id: string;
  /**
   * The revision the target version belongs to, or `null` for the three types
   * that have none (`legal_entity`, `facility`, `emission_factor`). A target
   * with no revision can never be frozen: VAL-010's subject is a report, and
   * those three outlive every report that cites them.
   */
  readonly revisionId: string | null;
}

/**
 * Resolve a link target, or `undefined` when it does not exist FOR THIS COMPANY.
 *
 * One query per call, always against the target's own primary key, so the
 * polymorphism costs a lookup rather than a scan of seven tables.
 *
 * EXPORTED FOR `@/server/dq/assessments` (T4.3), which is the second table with
 * a polymorphic `object_id` and no foreign key behind it (DM-27 uses DM-25's
 * vocabulary verbatim, К-8). The pin has to be applied there too, and a second
 * copy of these seven lookups would be the one that forgets `emission_factor` is
 * the global catalogue — or worse, the one that forgets `company_id`.
 */
export async function resolveTarget(
  db: DbClient,
  companyId: string,
  type: ObjectType,
  id: string,
): Promise<LinkTarget | undefined> {
  if (isInputTable(type)) {
    const t = INPUT_TABLES[type];
    const [row] = await db
      .select({ id: t.id, revisionId: t.revisionId })
      .from(t)
      .where(and(eq(t.id, id), eq(t.companyId, companyId)))
      .limit(1);
    return row ? { type, id: row.id, revisionId: row.revisionId } : undefined;
  }

  if (type === "legal_entity" || type === "facility") {
    const t = type === "legal_entity" ? legalEntity : facility;
    const [row] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, id), eq(t.companyId, companyId)))
      .limit(1);
    return row ? { type, id: row.id, revisionId: null } : undefined;
  }

  // `emission_factor` — the global catalogue (see the header): existence only.
  const [row] = await db
    .select({ id: emissionFactor.id })
    .from(emissionFactor)
    .where(eq(emissionFactor.id, id))
    .limit(1);
  return row ? { type, id: row.id, revisionId: null } : undefined;
}

// ─── The freeze probe (VAL-010, LC-8(2)) ─────────────────────────────────────

/** A link's target, as the probe below reads it off `evidence_link`. */
interface TargetRef {
  readonly type: string;
  readonly id: string;
}

/**
 * Do ANY of `targets` belong to a `locked` revision?
 *
 * WHY IT DOES NOT SCAN. The three non-row types are dropped first (they have no
 * revision), the rest are grouped by TABLE, and each group is one query that
 * looks its ids up BY PRIMARY KEY (`id = ANY(…)`) and joins the revision by ITS
 * primary key. So the cost is bounded by the number of links handed in — never
 * by the size of a table — and the loop stops at the first locked hit rather
 * than counting them: the answer is a yes/no refusal, not a report.
 *
 * ANY VERSION COUNTS, superseded and tombstoned ones included. A locked report
 * is the whole chain it contains, not just the versions still listed: pulling
 * the invoice out from under a superseded version would rewrite what the locked
 * revision recorded at the time, which is exactly what LC-8 forbids.
 *
 * EXPORTED FOR `@/server/dq/assessments` (T4.3) — §5.3 puts rows, DQ assessments
 * and evidence links behind ONE freeze, so the probe that answers "is this
 * target part of a published report" is one function rather than two that could
 * disagree about what "locked" means.
 */
export async function anyTargetLocked(
  db: DbClient,
  companyId: string,
  targets: readonly TargetRef[],
): Promise<boolean> {
  const byTable = new Map<InputTableName, string[]>();
  for (const target of targets) {
    if (!isInputTable(target.type)) continue;
    const ids = byTable.get(target.type);
    if (ids) ids.push(target.id);
    else byTable.set(target.type, [target.id]);
  }

  for (const [table, ids] of byTable) {
    const t = INPUT_TABLES[table];
    const [hit] = await db
      .select({ id: t.id })
      .from(t)
      .innerJoin(reportRevision, eq(reportRevision.id, t.revisionId))
      .where(
        and(
          eq(t.companyId, companyId),
          inArray(t.id, ids),
          eq(reportRevision.status, "locked"),
        ),
      )
      .limit(1);
    if (hit) return true;
  }
  return false;
}

/**
 * EV-3 — is this document still cited by a row of a Locked revision?
 *
 * The links are fetched by `(company_id, document_id)`, which is the leading
 * column of the UNIQUE `evidence_link_target_key`, so the starting set is an
 * index range over one document's links (a handful, not a table). Everything
 * after that is `anyTargetLocked` above.
 *
 * Exported for `./documents`, whose delete is the caller EV-3 names.
 */
export async function documentHasLockedLinks(
  db: DbClient,
  companyId: string,
  documentId: string,
): Promise<boolean> {
  const links = await db
    .select({
      type: evidenceLink.linkedObjectType,
      id: evidenceLink.linkedObjectId,
    })
    .from(evidenceLink)
    .where(
      and(
        eq(evidenceLink.companyId, companyId),
        eq(evidenceLink.documentId, documentId),
      ),
    );
  return anyTargetLocked(db, companyId, links);
}

// ─── The wire contract ───────────────────────────────────────────────────────

/** `evidence_link` as the API returns it (DM-25 field names, snake_case). */
export interface EvidenceLinkDto {
  id: string;
  document_id: string;
  linked_object_type: string;
  linked_object_id: string;
  created_by: string | null;
  created_at: string | null;
}

/** Row → DTO. Every column of DM-25 is public; a link holds no secrets. */
export function serialiseEvidenceLink(row: EvidenceLinkRow): EvidenceLinkDto {
  return {
    id: row.id,
    document_id: row.documentId,
    linked_object_type: row.linkedObjectType,
    linked_object_id: row.linkedObjectId,
    created_by: row.createdBy,
    created_at: row.createdAt ? row.createdAt.toISOString() : null,
  };
}

/** The body of `POST /api/evidence-links` (EV-2), parsed. */
export interface NewLinkValues {
  readonly documentId: string;
  readonly objectType: ObjectType;
  readonly objectId: string;
}

/**
 * Parse the three fields EV-2 names, or the field that was rejected.
 *
 * All three are REQUIRED — a link with a missing end is not a link — so unlike
 * the registry parsers there is no blank-as-null branch here.
 */
export function parseNewLink(
  body: unknown,
): { ok: true; values: NewLinkValues } | { ok: false; field: string } {
  const raw = (body ?? {}) as Record<string, unknown>;

  const documentId = uuidOrNull(raw.documentId);
  if (!documentId) return { ok: false, field: "documentId" };

  const objectType = raw.objectType;
  if (typeof objectType !== "string" || !isObjectType(objectType)) {
    return { ok: false, field: "objectType" };
  }

  const objectId = uuidOrNull(raw.objectId);
  if (!objectId) return { ok: false, field: "objectId" };

  return { ok: true, values: { documentId, objectType, objectId } };
}

// ─── Reads (EV-2) ────────────────────────────────────────────────────────────

/** The two directions a link list is ever asked for. */
export interface LinkFilter {
  /** "Where is this document used" — the UNIQUE index's own leading column. */
  readonly documentId?: string;
  /** "Which documents back THIS object" — `evidence_link_object_idx`. */
  readonly objectType?: string;
  readonly objectId?: string;
}

/**
 * Links of the company, filtered, oldest first.
 *
 * Tenant-pinned like everything else, so a foreign `documentId` or a foreign row
 * id lists nothing rather than another tenant's evidence.
 */
export async function listLinks(
  db: DbClient,
  companyId: string,
  filter: LinkFilter = {},
): Promise<EvidenceLinkRow[]> {
  const where: SQL[] = [eq(evidenceLink.companyId, companyId)];
  if (filter.documentId)
    where.push(eq(evidenceLink.documentId, filter.documentId));
  if (filter.objectType)
    where.push(eq(evidenceLink.linkedObjectType, filter.objectType));
  if (filter.objectId)
    where.push(eq(evidenceLink.linkedObjectId, filter.objectId));

  return db
    .select()
    .from(evidenceLink)
    .where(and(...where))
    .orderBy(asc(evidenceLink.createdAt), asc(evidenceLink.id));
}

// ─── Create (EV-2) ───────────────────────────────────────────────────────────

/** Outcome of a link attempt; each refusal is one HTTP answer at the route. */
export type LinkWriteResult =
  | {
      ok: true;
      row: EvidenceLinkRow;
      /** `false` when the link already existed — see `createLink`. */
      created: boolean;
      /** Non-blocking findings of the same run; VAL-037 lives here. */
      warnings: RuleRef[];
    }
  /** A field the body got wrong, or an end that does not exist here (API-1). */
  | { ok: false; error: "VALIDATION"; field: string }
  /** Blocking rules refused it — VAL-010 today (API-1 `{rules}`). */
  | { ok: false; error: "RULES"; rules: RuleRef[] };

/**
 * Link a document to an object (EV-2).
 *
 * A REPEATED LINK IS THE SAME LINK, not an error. The UNIQUE
 * `(document_id, linked_object_type, linked_object_id)` says a pair can only be
 * related once, and `ApiErrorCode` has no CONFLICT (§12.1) — inventing one to
 * describe "the state you asked for is already the state" would make an
 * idempotent action look like a failure to every client that retries. So the
 * existing row comes back with `created: false`, and the UNIQUE stays what
 * guarantees there is only ever one.
 *
 * BOTH ENDS ARE RESOLVED BEFORE THE INSERT, and both for the reason the header
 * gives: `document_id` HAS an FK, so a foreign id would fire as a driver error
 * (a 500) rather than as an answer; `linked_object_id` has NONE, so nothing but
 * this lookup stands between a body and a link into another tenant's data.
 */
export async function createLink(
  db: DbClient,
  ctx: { companyId: string; userId: string },
  values: NewLinkValues,
): Promise<LinkWriteResult> {
  const [doc] = await db
    .select({ id: document.id })
    .from(document)
    .where(
      and(
        eq(document.id, values.documentId),
        eq(document.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  if (!doc) return { ok: false, error: "VALIDATION", field: "documentId" };

  const target = await resolveTarget(
    db,
    ctx.companyId,
    values.objectType,
    values.objectId,
  );
  if (!target) return { ok: false, error: "VALIDATION", field: "objectId" };

  let created = true;
  const written = await writeValidated(
    db,
    { companyId: ctx.companyId, scope: "record" },
    async (tx) => {
      // LC-8(2) — the freeze covers links, not only rows. Inside the
      // transaction, so the refusal and its rolled-back result row travel
      // together exactly as they do on a row write (VR-3).
      if (await anyTargetLocked(tx, ctx.companyId, [target])) {
        refuseValidation([ruleRef("VAL-010")]);
      }

      const [inserted] = await tx
        .insert(evidenceLink)
        .values({
          id: randomUUID(),
          companyId: ctx.companyId,
          documentId: values.documentId,
          linkedObjectType: values.objectType,
          linkedObjectId: values.objectId,
          createdBy: ctx.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) return inserted;

      created = false;
      const [existing] = await tx
        .select()
        .from(evidenceLink)
        .where(
          and(
            eq(evidenceLink.companyId, ctx.companyId),
            eq(evidenceLink.documentId, values.documentId),
            eq(evidenceLink.linkedObjectType, values.objectType),
            eq(evidenceLink.linkedObjectId, values.objectId),
          ),
        )
        .limit(1);
      return existing;
    },
  );

  if (!written.ok) {
    // `NOT_FOUND` cannot happen here — the conflicting row the re-select looks
    // for is the one the insert just collided with, inside the same transaction
    // — but `writeValidated` types it, so it is answered rather than cast away.
    return written.error === "VALIDATION"
      ? { ok: false, error: "RULES", rules: written.rules }
      : { ok: false, error: "VALIDATION", field: "documentId" };
  }
  return {
    ok: true,
    row: written.row,
    created,
    warnings: written.warnings,
  };
}

// ─── Delete (EV-3) ───────────────────────────────────────────────────────────

/** Outcome of an unlink. `LOCKED` carries VAL-010 for the 422 payload. */
export type LinkDeleteResult =
  | { ok: true; row: EvidenceLinkRow }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "LOCKED"; rules: RuleRef[] };

/**
 * Unlink (EV-3) — remove ONE `evidence_link` row and nothing else.
 *
 * THE FILE SURVIVES, and so does the `document` row. That is the entire point of
 * EV-3: unlinking says "this figure is not backed by that paper after all", it
 * does not say "destroy the paper". Deleting the bytes is a separate, explicit,
 * `company.manage` action over the document (D6, `./documents`).
 *
 * The freeze is re-checked here and not only on the way in: a link created while
 * the revision was a draft is still a claim of a report that has since been
 * locked (LC-8(2)).
 */
export async function deleteLink(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<LinkDeleteResult> {
  return db.transaction(async (tx): Promise<LinkDeleteResult> => {
    const [row] = await tx
      .select()
      .from(evidenceLink)
      .where(
        and(eq(evidenceLink.id, id), eq(evidenceLink.companyId, companyId)),
      )
      .limit(1);
    if (!row) return { ok: false, error: "NOT_FOUND" };

    const locked = await anyTargetLocked(tx, companyId, [
      { type: row.linkedObjectType, id: row.linkedObjectId },
    ]);
    if (locked) {
      return { ok: false, error: "LOCKED", rules: [ruleRef("VAL-010")] };
    }

    await tx.delete(evidenceLink).where(eq(evidenceLink.id, row.id));
    return { ok: true, row };
  });
}

// ─── The carry hook (DM-25, LC-4/LC-5/LC-9) ──────────────────────────────────

/**
 * Copy a version's evidence links onto its successor — the hook `VERSION_CARRY_HOOKS`
 * (T3.1's declared seam) runs inside the write transaction of every new version.
 *
 * See docs/decisions/server-evidence-links-L497.md for the full account.
 */
export async function carryEvidenceLinks(
  ctx: VersionCarryContext,
): Promise<void> {
  if (ctx.fromId === null) return;

  const sources = await ctx.db
    .select({
      documentId: evidenceLink.documentId,
      createdBy: evidenceLink.createdBy,
    })
    .from(evidenceLink)
    .where(
      and(
        eq(evidenceLink.companyId, ctx.companyId),
        eq(evidenceLink.linkedObjectType, ctx.table),
        eq(evidenceLink.linkedObjectId, ctx.fromId),
      ),
    );
  if (sources.length === 0) return;

  await ctx.db
    .insert(evidenceLink)
    .values(
      sources.map((source) => ({
        id: randomUUID(),
        companyId: ctx.companyId,
        documentId: source.documentId,
        linkedObjectType: ctx.table,
        linkedObjectId: ctx.toId,
        createdBy: source.createdBy,
      })),
    )
    .onConflictDoNothing();
}
