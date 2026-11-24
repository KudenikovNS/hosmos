// =============================================================================
// EVIDENCE EVALUATORS (spec §6.2, §8) — the rules whose SUBJECT is a `document`
// or a link to one, rather than an input row.
//
// VAL-013 is the first, and it arrives with T4.1 for the usual reason: until
// `POST /api/documents` existed no code path could write the row it judges, so
// the rule could be evaluated but never triggered. With it `PENDING_EVALUATORS`
// loses its T4.1 entry. VAL-037 joins it with T4.2 on identical grounds: its
// subject is an `evidence_link` (§6.2 `appliesTo`), and until
// `POST /api/evidence-links` there was none.
//
// WHY A DUPLICATE IS A WARNING AND NOT A REFUSAL (EV-1). `document.file_hash`
// carries an INDEX and deliberately no UNIQUE (DM-24): the same invoice is
// legitimately uploaded twice — once as evidence for January and once, by
// another contributor, for the annual figure — and refusing the second upload
// would lose the second person's intent while the bytes are already
// deduplicated on disk anyway (EV-0). So the row is written, the file is not
// duplicated, and the finding says "you may want to reuse the one that is
// already here".
//
// VAL-036 joins them with T4.4 and is the one rule here that leaves the
// database: EV-5's "файл доступен" is a question only `DocumentStorage` can
// answer. See its own block below for what it asks, when, and — the part that is
// easy to get wrong — how a MISSING FILE is told apart from a storage OUTAGE.
//
// Tenant pin as everywhere else: the probe filters on `company_id`, so a
// foreign `targetId` matches no document and the evaluator finds nothing —
// never another tenant's row, never an error that confirms the id exists. That
// also means a hash shared with ANOTHER company is invisible here, which is the
// intended reading of "совпадение хэша в компании" (EV-1): the suggestion is to
// reuse a document the caller can actually see.
// =============================================================================
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import { document, evidenceLink } from "@/server/db/schema";
import {
  INPUT_TABLES,
  currentRowIds,
  type InputTableName,
} from "@/server/inventory/tables";
import {
  DocumentStorageError,
  documentStorage,
  type DocumentStorage,
} from "@/server/storage/document-storage";

import type { EvaluatorContext, RuleFinding } from "../types";

import { loadInputRow } from "./activities";

/**
 * VAL-013 — "possible duplicate document (hash / issuer / date)".
 *
 * The HASH is the part that can be decided mechanically and is the only part
 * decided here: two rows with the same `file_hash` in the same company hold
 * byte-identical files, full stop. Issuer and date are named by §6.2 as further
 * HINTS for the UI to show beside the suggestion, not as an independent test —
 * two different invoices from the same issuer on the same date are a normal
 * thing and flagging them would train users to ignore the warning.
 *
 * Returns nothing when `targetId` is not a document of this company: silence
 * means "not applicable", never "passed" (see `../types`).
 */
export async function evaluateVal013(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const [row] = await ctx.db
    .select({ id: document.id, fileHash: document.fileHash })
    .from(document)
    .where(
      and(eq(document.id, ctx.targetId), eq(document.companyId, ctx.companyId)),
    )
    .limit(1);
  if (!row) return [];

  const [twin] = await ctx.db
    .select({ id: document.id })
    .from(document)
    .where(
      and(
        eq(document.companyId, ctx.companyId),
        eq(document.fileHash, row.fileHash),
        ne(document.id, row.id),
      ),
    )
    .orderBy(sql`uploaded_at`)
    .limit(1);

  return [{ passed: !twin, objectType: "document", objectId: row.id }];
}

// ─── VAL-037 — does the evidence cover the month it is attached to? ──────────

/** `YYYY-MM` → the ISO dates of its first and last day. */
function monthWindow(yearMonth: string): { start: string; end: string } {
  const [year, month] = yearMonth.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${yearMonth}-01`,
    end: `${yearMonth}-${String(last).padStart(2, "0")}`,
  };
}

/** Is `type` one of the four input tables — the only targets with a month? */
function isInputTable(type: string): type is InputTableName {
  return type in INPUT_TABLES;
}

/**
 * VAL-037 — "покрытие периода эвиденсом" (EV-4): the document's
 * `coverage_start`/`coverage_end` against the linked row's `year_month`.
 *
 * THE SUBJECT IS THE LINK, not the row and not the document, exactly as §6.2's
 * `appliesTo: ["evidence_link"]` says — and it has to be, because DM-28 keys a
 * stored result on `(rule, object_type, object_id)`. Filing the finding under
 * the ROW would make two documents on one row collide on one key, so "the
 * January invoice covers it, the February one does not" would come out as
 * whichever link was evaluated last. The finding carries the row's
 * `revision_id` so it surfaces on `GET /api/revisions/[id]/validation` beside
 * everything else that revision has to answer for.
 *
 * IT FIRES ONLY ON NO OVERLAP AT ALL. A billing period is not a calendar month:
 * an invoice covering 15 Jan – 14 Feb is the normal way an energy supplier bills
 * a January figure, and demanding containment would put a warning on most rows
 * in most companies — a warning that is usually noise is a warning nobody reads.
 * This is the same line VAL-007 draws for facility dates, drawn the same way and
 * for the same reason. What the rule catches is the real mistake: the February
 * invoice attached to the January row, where the two windows do not touch.
 *
 * A HALF-OPEN COVERAGE IS HALF-CHECKED. Only `coverage_start` set means "from
 * then on" — the row fails only if its month ended before that date; only
 * `coverage_end` set is the mirror.
 *
 * WHAT PASSES WITHOUT COMPARISON, and it is deliberately a PASS rather than
 * silence (silence means "not applicable", `../types`):
 *   • BOTH `coverage_*` NULL. They are optional DM-24 metadata; a document that
 *     claims no period cannot contradict one. Failing here would flag every
 *     upload where the uploader skipped two date fields, i.e. most of them, and
 *     the rule that catches "no evidence at all" is DQ-4/VAL-041 (T4.4), not
 *     this one.
 *   • The row has NO `year_month` — `contractual_instrument` normally has none
 *     (it covers the whole period) and the column is nullable on all four.
 *     There is nothing to compare a coverage window with.
 * Silence is reserved for a link that is not this rule's business: a target of
 * another tenant, or one of the three non-row object types (`legal_entity`,
 * `facility`, `emission_factor`), which have no month at all.
 */
export async function evaluateVal037(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const [link] = await ctx.db
    .select({
      id: evidenceLink.id,
      documentId: evidenceLink.documentId,
      objectType: evidenceLink.linkedObjectType,
      objectId: evidenceLink.linkedObjectId,
    })
    .from(evidenceLink)
    .where(
      and(
        eq(evidenceLink.id, ctx.targetId),
        eq(evidenceLink.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  if (!link || !isInputTable(link.objectType)) return [];

  const t = INPUT_TABLES[link.objectType];
  const [row] = await ctx.db
    .select({ yearMonth: t.yearMonth, revisionId: t.revisionId })
    .from(t)
    .where(and(eq(t.id, link.objectId), eq(t.companyId, ctx.companyId)))
    .limit(1);
  if (!row) return [];

  const finding = (passed: boolean): RuleFinding[] => [
    {
      passed,
      objectType: "evidence_link",
      objectId: link.id,
      revisionId: row.revisionId,
    },
  ];
  if (!row.yearMonth) return finding(true);

  const [doc] = await ctx.db
    .select({
      coverageStart: document.coverageStart,
      coverageEnd: document.coverageEnd,
    })
    .from(document)
    .where(
      and(
        eq(document.id, link.documentId),
        eq(document.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  if (!doc || (doc.coverageStart === null && doc.coverageEnd === null)) {
    return finding(true);
  }

  // ISO dates compare correctly as strings, which is why they are read as
  // strings: `date` columns come back `YYYY-MM-DD` and so does `monthWindow`.
  const month = monthWindow(row.yearMonth);
  const endsBefore = doc.coverageEnd !== null && doc.coverageEnd < month.start;
  const startsAfter =
    doc.coverageStart !== null && doc.coverageStart > month.end;
  return finding(!endsBefore && !startsAfter);
}

// ─── VAL-036 — is the evidence behind an approved figure still there? ────────

/**
 * Lowercase hex SHA-256 — the shape DM-24 requires of `document.file_hash`.
 *
 * The column is `char(64) NOT NULL`, so a row ALWAYS carries something; what it
 * does not guarantee is that the something is a digest. A blank (the column is
 * space-padded), a truncated value or a non-hex string is EV-5's "отсутствующий
 * hash" — the file may well be on disk, but nothing ties those bytes to this
 * row, which is the whole reason an auditor asks for a hash.
 */
const SHA256 = /^[0-9a-f]{64}$/i;

/** A document as the integrity check reads it — three columns, no body. */
interface DocumentIntegrityInput {
  readonly id: string;
  readonly fileHash: string;
  readonly storageKey: string;
}

/**
 * Which of `documentIds` cannot be stood behind (EV-5) — THE integrity check,
 * with one implementation and two callers.
 *
 * VAL-036 calls it for the documents of ONE row (below); VAL-041 calls it for
 * the documents of a whole revision at approve/lock (`./revision`). A second
 * copy would be the one that forgets the difference the next paragraph is about.
 *
 * A MISSING FILE IS A VERDICT; AN OUTAGE IS NOT. `stat` answers `null` for "no
 * object under that key" and THROWS `DocumentStorageError` when it could not
 * look at all — an unreadable mount, an unset `DOCUMENTS_DIR`, an I/O error.
 * The two must not be merged: a missing file means the evidence is gone and the
 * approval must be refused, while a disk that is briefly unavailable means the
 * check DID NOT HAPPEN, and answering "your evidence is broken" to that is a
 * false accusation that a retry would contradict. So a thrown storage error is
 * RE-THROWN: the run fails, the route degrades to 500 (`apiRoute`), and the
 * caller tries again — the one honest answer to "we could not tell".
 *   `INVALID_KEY` is the exception that proves the rule. It is thrown before any
 * filesystem access, by a `storage_key` that is not `{uuid}/{sha256}` — a defect
 * in the ROW, not in the storage, and one no retry will fix. It fails the rule.
 *
 * WHY THE DIGEST IS NOT RE-COMPUTED. The key IS the digest (EV-0: objects live
 * under `{companyId}/{sha256}`), so an object's presence under a key already
 * asserts that bytes with that digest exist. Comparing the key's digest with
 * `file_hash` is therefore a real check — it catches a row whose two columns
 * disagree — while re-hashing every file at every approval would read the whole
 * evidence library to learn what content addressing already guarantees.
 */
export async function brokenDocumentIds(
  db: DbClient,
  companyId: string,
  documentIds: readonly string[],
  storage: DocumentStorage = documentStorage,
): Promise<Set<string>> {
  const broken = new Set<string>();
  if (documentIds.length === 0) return broken;

  const docs: DocumentIntegrityInput[] = await db
    .select({
      id: document.id,
      fileHash: document.fileHash,
      storageKey: document.storageKey,
    })
    .from(document)
    .where(
      and(
        eq(document.companyId, companyId),
        inArray(document.id, [...documentIds]),
      ),
    );

  for (const doc of docs) {
    const hash = doc.fileHash.trim().toLowerCase();
    if (!SHA256.test(hash)) {
      broken.add(doc.id);
      continue;
    }
    let stored;
    try {
      stored = await storage.stat(doc.storageKey);
    } catch (error) {
      if (
        error instanceof DocumentStorageError &&
        error.code === "INVALID_KEY"
      ) {
        broken.add(doc.id);
        continue;
      }
      throw error; // an outage is not a verdict — see the doc comment
    }
    if (!stored || stored.sha256.toLowerCase() !== hash) broken.add(doc.id);
  }
  return broken;
}

/** The documents attached to ONE row version (DM-25), newest link first. */
async function documentsOfRow(
  db: DbClient,
  companyId: string,
  table: InputTableName,
  rowId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ documentId: evidenceLink.documentId })
    .from(evidenceLink)
    .where(
      and(
        eq(evidenceLink.companyId, companyId),
        eq(evidenceLink.linkedObjectType, table),
        eq(evidenceLink.linkedObjectId, rowId),
      ),
    );
  return rows.map((row) => row.documentId);
}

/**
 * The documents cited by the CURRENT rows of one revision — the bounded set
 * VAL-041 re-checks at approve/lock (EV-5), exported for `./revision`.
 *
 * BOUNDED IS THE POINT. "Is the evidence still there" is a question about files,
 * and the naive way to ask it is to walk the company's document library on every
 * approval — which grows without limit while the answer that matters concerns
 * only the handful of documents this report rests on. Walking OUT from the rows
 * through `evidence_link` keeps the number of `stat` calls proportional to the
 * evidence of the revision being approved, and a document nobody linked is never
 * touched at all.
 */
export async function documentsOfRevision(
  db: DbClient,
  companyId: string,
  revisionId: string,
): Promise<string[]> {
  const rows = await currentRowIds(db, companyId, revisionId);
  const ids = new Set<string>();
  for (const row of rows) {
    for (const id of await documentsOfRow(db, companyId, row.table, row.id)) {
      ids.add(id);
    }
  }
  return [...ids];
}

/**
 * VAL-036 — "целостность файла эвиденса (hash есть, файл доступен)" (EV-5).
 * BLOCKING, and the blocking is the delicate part.
 *
 * IT BLOCKS THE APPROVAL OF EXACTLY THE ROWS THE BROKEN DOCUMENT BACKS, which is
 * §6.2's own wording and not a blanket refusal of the revision. The mechanism is
 * the direction of the walk: the run is aimed at a ROW, the evaluator asks that
 * row which documents stand behind it, and only those are examined. A row that
 * cites a healthy document — or cites none — is approved while its neighbour is
 * refused, because nothing in this file ever looks at a document the target row
 * does not link to.
 *
 * IT SPEAKS ONLY FOR AN `approved` VERSION, and that is EV-5's "проверяется при
 * approve/lock" rather than a shortcut. LC-4 makes approval a NEW VERSION whose
 * `state` is `approved`, so the write that asks for the approval is precisely the
 * write whose row reads `approved` — the rule stays a rule about a STATE (the
 * kind this engine prefers) and still fires at the one moment EV-5 names.
 * Saving a draft, editing it, deleting it: silence, no `stat`, no round trip to
 * the disk on a keystroke. A row with no links at all is silent too — "no
 * evidence anywhere" is a HOLE, and DQ-4/VAL-041 owns holes.
 *
 * THE FINDING IS FILED UNDER THE DOCUMENT (§6.2 `appliesTo: document`), one per
 * document examined, carrying the row's `revision_id` so it surfaces on
 * `GET /api/revisions/[id]/validation`. Filing it under the ROW would collapse
 * two documents of one row onto one DM-28 key and answer "which file is
 * missing" with whichever was evaluated last — the same trap VAL-037 avoids by
 * filing under the link.
 *
 * NOT AT UPLOAD. A document is not judged when it is stored: `put` has just
 * written the bytes and returned their digest, so the check would be a tautology
 * with a syscall in it. `POST /api/documents` runs the `record` scope against the
 * DOCUMENT id, which is not an input row, so this evaluator returns `[]` there.
 */
export async function evaluateVal036(
  ctx: EvaluatorContext,
): Promise<RuleFinding[]> {
  const row = await loadInputRow(ctx);
  if (!row || row.state !== "approved") return [];

  const documentIds = await documentsOfRow(
    ctx.db,
    ctx.companyId,
    row.table,
    row.id,
  );
  if (documentIds.length === 0) return [];

  const broken = await brokenDocumentIds(ctx.db, ctx.companyId, documentIds);
  return documentIds.map((id) => ({
    passed: !broken.has(id),
    objectType: "document",
    objectId: id,
    revisionId: row.revisionId,
  }));
}
