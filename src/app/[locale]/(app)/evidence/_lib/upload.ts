// =============================================================================
// WHAT THE UPLOAD PANEL SAYS AFTERWARDS — one pure function, and the only place
// this screen decides it (T4.5 acceptance, EV-0, EV-1, PG-1, VAL-013).
//
// TWO OF THE FOUR ACCEPTANCE CRITERIA OF THIS TASK ARE ABOUT THIS SENTENCE, and
// both are about telling the truth at the moment an upload ends:
//
//   • AN UPLOAD OVER THE PLAN'S CAP IS NOT AN ERROR, IT IS A PRICE. The route
//     answers 402 `PLAN_REQUIRED` twice over — once against `Content-Length`
//     before a byte is read, once from the streaming counter inside
//     `DocumentStorage.put` — and it is deliberately the SAME answer both times,
//     because the customer's move is the same one either way. So `plan` is its
//     own branch here and carries the NUMBER the plan allows: "this file is
//     bigger than the 20 MB your plan uploads" is a product statement, whereas
//     "the change could not be saved" is the technical error the criterion
//     forbids. Nothing else can produce this branch: a validation failure has a
//     FIELD, a blocking rule has CODES, and neither is 402.
//   • A HASH DUPLICATE IS A SUCCESS WITH A SUGGESTION (EV-1). The bytes were
//     already on disk, the second `document` row WAS written, and the server
//     attached Warning VAL-013 rather than refusing — so the branch is `stored`,
//     exactly like an ordinary upload, and the duplicate travels as a HINT
//     hanging off it. A user who reads "already uploaded" as "your upload
//     failed" would re-upload it a third time; the hint therefore names the
//     document that already exists and offers to use THAT one, which is what
//     VAL-013's message actually suggests.
//
// WHY IT IS A FUNCTION AND NOT THREE `&&`s IN THE PANEL. The suite is
// `environment: "node"` and includes only `*.test.ts` — there is no DOM to
// assert "the plan explanation rendered and the error list did not" against. The
// decision is therefore data in, data out, the panel holds ONE reference to each
// branch, and `__tests__/upload.test.ts` pins the part that could regress: that
// a 402 can never come out as an error line, and that a duplicate can never come
// out as a refusal.
// =============================================================================
import type {
  DocumentDto,
  Refusal,
  RuleRef,
  UploadData,
  WriteOutcome,
} from "./api";

/**
 * The DM-24 metadata fields the upload form offers, in the order it shows them.
 *
 * The names are the MULTIPART FIELD NAMES the route parses (`parseDocumentMeta`,
 * `@/server/evidence/documents`), not display labels: the form appends exactly
 * these keys, so a field renamed on the server stops matching here rather than
 * being silently dropped from every future upload. `file_name` is absent on
 * purpose — it defaults to the picked file's own name, and offering to retype it
 * before the file is chosen invites a name that describes a different document.
 */
export const DOCUMENT_META_FIELDS = [
  "issuer",
  "document_date",
  "coverage_start",
  "coverage_end",
  "confidentiality",
  "retention_date",
] as const;

/** The `confidentiality` vocabulary of DM-24 (`Confidentiality`, §4.16). */
export const CONFIDENTIALITY_VALUES = [
  "public",
  "internal",
  "confidential",
] as const;

/**
 * VAL-013 AS THE SCREEN RENDERS IT: a stored document, and the earlier ones that
 * hold the same bytes.
 */
export interface DuplicateHint {
  /** The row the upload created. It EXISTS — the upload succeeded (EV-1). */
  readonly stored: DocumentDto;
  /**
   * Documents of this company already holding the same `file_hash`, newest
   * first (the order `GET /api/documents` returns). These are what the hint
   * offers to reuse.
   */
  readonly earlier: readonly DocumentDto[];
  /** The warning codes the server attached — VAL-013 today. May be empty. */
  readonly codes: readonly string[];
}

/**
 * What the panel says after an attempt. Exactly one branch per outcome, and the
 * discriminator is the thing the user must understand.
 */
export type UploadNotice =
  /** Accepted and written. `duplicate` is non-null when EV-1 fired. */
  | { kind: "stored"; document: DocumentDto; duplicate: DuplicateHint | null }
  /** 402 — the plan's upload ceiling, stated with the number (PG-1/PG-5). */
  | { kind: "plan"; maxUploadMb: number }
  /** Everything else the server refused, in the vocabulary `refusal.ts` owns. */
  | { kind: "refused"; refusal: Refusal }
  /** Партия 24 — the file is not one of EV-0's types; says which are. */
  | { kind: "unsupportedType" };

/** The codes of a warning list, in the order the server sent them. */
function codesOf(warnings: readonly RuleRef[]): string[] {
  return warnings.map((warning) => warning.code);
}

/**
 * The duplicate hint of an accepted upload, or `null` when there is none.
 *
 * TWO SIGNALS, AND EITHER ALONE IS ENOUGH. `deduplicated` is `DocumentStorage`
 * saying the content-addressed key already existed; VAL-013 is the evaluator
 * saying another row of this company carries the same hash. They almost always
 * agree, but they are answered by different layers at different moments — a row
 * whose file was deduplicated is a duplicate even if the rule list came back
 * empty — so the hint is offered when EITHER speaks, and the codes are reported
 * as they arrived rather than assumed.
 *
 * `earlier` may legitimately be empty: `library` is the listing as it stood
 * BEFORE the upload was refetched, so a duplicate of a document the current
 * filter hid still produces a hint, just without a row to point at. The panel
 * says the shorter sentence in that case rather than pretending to link
 * somewhere.
 *
 * A WITHHELD HASH IS NOT A MATCH. `file_hash` is `null` for a `confidential`
 * document the caller may not download (EV-6, `serialiseDocument`), and `null`
 * is the ABSENCE of a fingerprint, not a fingerprint that two documents share —
 * comparing it would make every withheld row a "duplicate" of every other. So a
 * null on either side ends the comparison, and the hint degrades to the shorter
 * sentence exactly as it does for a duplicate that the filter hid. The upload
 * still KNOWS it is a duplicate: `deduplicated` and VAL-013 come from the
 * server, which can see what the client is not shown.
 */
export function duplicateHint(
  data: UploadData,
  library: readonly DocumentDto[],
): DuplicateHint | null {
  const codes = codesOf(data.warnings);
  if (!data.deduplicated && codes.length === 0) return null;
  const hash = data.document.file_hash;
  return {
    stored: data.document,
    earlier:
      hash === null
        ? []
        : library.filter(
            (candidate) =>
              candidate.id !== data.document.id && candidate.file_hash === hash,
          ),
    codes,
  };
}

/**
 * THE outcome of one upload, as the panel renders it.
 *
 * `maxUploadMb` comes from the session's resolved plan features (`usePlan`),
 * i.e. from what the SERVER said this company is entitled to — never from the
 * plan name. It is only ever used to WORD the 402; the refusal itself is the
 * server's.
 */
export function uploadNotice(
  outcome: WriteOutcome<UploadData>,
  library: readonly DocumentDto[],
  maxUploadMb: number,
): UploadNotice {
  if (outcome.ok) {
    return {
      kind: "stored",
      document: outcome.data.document,
      duplicate: duplicateHint(outcome.data, library),
    };
  }
  if (outcome.kind === "plan_required") return { kind: "plan", maxUploadMb };
  // Партия 24 — the server names the field but not the reason, and «check the
  // field file» tells a user nothing. A refusal ON THE FILE FIELD is, in
  // practice, EV-0's allowlist: the metadata fields have their own names.
  if (outcome.kind === "field" && outcome.field === "file")
    return { kind: "unsupportedType" };
  return { kind: "refused", refusal: outcome };
}
