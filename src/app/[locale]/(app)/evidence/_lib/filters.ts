// =============================================================================
// THE LIBRARY'S FILTERS AND ITS TWO INDEXES (T4.5 — UI-3, §4.16, DM-25).
//
// FILTERING HAPPENS HERE AND NOT ON THE SERVER, deliberately. `GET /api/documents`
// returns the company's library whole and `GET /api/evidence-links` unfiltered
// returns the company's whole link table — the route's own header says an
// unfiltered list "is what an evidence overview screen wants". Two requests
// therefore feed the entire screen: the table, the per-document usage count, the
// "which documents back this row" panel and the orphan filter. The alternative —
// a query parameter per filter, and one `?document_id=` per table row — is a
// request per keystroke and an N+1 over the listing, for a collection that is
// small by construction (a company's evidence, not its transactions).
//
// WHAT THE FILTERS ARE FOR is the one editorial decision in this file. §4.16
// gives a document eleven fields; only four of them are things a person actually
// looks for evidence BY, and each answers a real question:
//   • `text`            — "the invoice from Elektro" (file name and issuer);
//   • `fileType`        — "the spreadsheets", i.e. the ones with numbers in;
//   • `confidentiality` — "what may I attach to a report someone else reads";
//   • `usage`           — "what have I uploaded and never attached to anything",
//     which is the only view that finds evidence nobody linked. That one is not
//     a column at all — it is a fact about the LINK table — which is why the
//     predicate takes the link count beside the document.
//
// EVERY FILTER IS ABSENT-MEANS-EVERYTHING. A blank `text`, an empty select and
// `usage: "any"` all match, so the default state of the screen is the whole
// library rather than nothing.
// =============================================================================
import type { DocumentDto, EvidenceLinkDto } from "./api";

/** How the library is narrowed. Every field's empty value means "no filter". */
export interface DocumentFilter {
  /** Substring of the file name or the issuer, case-insensitive. */
  readonly text: string;
  /** One `FileType` bucket (`pdf`/`xlsx`/`csv`/`image`/`other`), or "". */
  readonly fileType: string;
  /** One `Confidentiality` value, or "". */
  readonly confidentiality: string;
  /** `linked` — backs at least one object; `unlinked` — backs nothing yet. */
  readonly usage: "any" | "linked" | "unlinked";
}

/** The unfiltered state: the whole library. */
export const NO_FILTER: DocumentFilter = {
  text: "",
  fileType: "",
  confidentiality: "",
  usage: "any",
};

/** Does `haystack` contain `needle`, ignoring case? A blank needle matches. */
function contains(haystack: string | null, needle: string): boolean {
  if (needle === "") return true;
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

/**
 * Does this document belong in the filtered listing?
 *
 * `linkCount` is how many objects the document backs RIGHT NOW — from
 * {@link linkCounts}, i.e. from the link table the screen already holds. It is a
 * parameter rather than a lookup so the predicate stays pure and the "never
 * attached to anything" filter is testable without a query.
 */
export function matchesDocument(
  document: DocumentDto,
  filter: DocumentFilter,
  linkCount: number,
): boolean {
  if (filter.fileType !== "" && document.file_type !== filter.fileType) {
    return false;
  }
  if (
    filter.confidentiality !== "" &&
    document.confidentiality !== filter.confidentiality
  ) {
    return false;
  }
  if (filter.usage === "linked" && linkCount === 0) return false;
  if (filter.usage === "unlinked" && linkCount > 0) return false;
  // The text matches EITHER half: a user looking for "elektro" may be thinking
  // of the file or of who issued it, and asking them which would be asking them
  // to remember how they typed it months ago.
  return (
    contains(document.file_name, filter.text) ||
    contains(document.issuer, filter.text)
  );
}

/** How many objects each document backs, keyed by `document_id`. */
export function linkCounts(
  links: readonly EvidenceLinkDto[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const link of links) {
    counts.set(link.document_id, (counts.get(link.document_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The composite key of a link target — the pair DM-25 makes a link point at.
 *
 * `linked_object_id` is a uuid and would be unique on its own; the TYPE is in
 * the key anyway because that is what the wire carries and what the UNIQUE
 * `(document_id, linked_object_type, linked_object_id)` is spelled on. A key
 * that dropped it would agree with the server only by luck.
 */
export function targetKey(objectType: string, objectId: string): string {
  return `${objectType}:${objectId}`;
}

/** Which documents back each object, keyed by {@link targetKey}. */
export function linksByTarget(
  links: readonly EvidenceLinkDto[],
): Map<string, EvidenceLinkDto[]> {
  const index = new Map<string, EvidenceLinkDto[]>();
  for (const link of links) {
    const key = targetKey(link.linked_object_type, link.linked_object_id);
    const bucket = index.get(key);
    if (bucket) bucket.push(link);
    else index.set(key, [link]);
  }
  return index;
}

/**
 * Does an inventory row's label or source name match a search box?
 *
 * The row picker's whole job is "find the row this invoice belongs to", and the
 * three things a person remembers about a row are what it is called, which month
 * it is and what kind of row it is. A blank query lists everything.
 */
export function matchesRow(
  row: { label: string | null; kind: string; year_month: string | null },
  query: string,
): boolean {
  if (query === "") return true;
  return (
    contains(row.label, query) ||
    contains(row.kind, query) ||
    contains(row.year_month, query)
  );
}
