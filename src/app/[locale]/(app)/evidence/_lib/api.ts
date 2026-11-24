// =============================================================================
// THE WIRE, AS THE `/evidence` SCREEN SEES IT (T4.5 — UI-3, API-1, §12.2).
//
// The same two rules as `organisation/_lib/api.ts` and `inventory/_lib/api.ts`,
// for the same reasons:
//
//   1. THE DTOs ARE IMPORTED, NOT RE-DECLARED. `DocumentDto`, `EvidenceLinkDto`
//      and `DqAssessmentDto` are owned by the services that serialise them
//      (`@/server/evidence/*`, `@/server/dq/assessments`), which is where §4.16
//      and §4.17 are actually spelled. Every import is `import type`, so the
//      server modules — and the drizzle runtime behind them — are erased at
//      compile and never reach the browser bundle.
//   2. A REFUSAL IS CLASSIFIED ONCE — `../../_lib/refusal`, re-exported here so
//      this screen's imports read like the other three screens'. §0.2 makes
//      401/403, 402, 422-with-rules, 422-with-field and bare-422 five different
//      things to say, and this screen must not invent a sixth.
//
// THE ONE PLACE THE WIRE HAS TO BE RESTATED is `AuditEntryDto`. `AuditLogRow`
// types `createdAt` as a `Date` because that is what the driver returns; what
// crosses `/api/audit` is JSON, i.e. a string. Re-declaring the whole row would
// be a second spelling of the contract, so only the one field that JSON changes
// is overridden and everything else stays the server's.
//
// TWO REFUSALS THIS SCREEN CARES ABOUT BY NAME:
//   • 402 `PLAN_REQUIRED` on an upload — the plan's `maxUploadMb` (PG-1, EV-0),
//     refused either by the `Content-Length` pre-check or by the streaming
//     counter inside `DocumentStorage.put`. Both come back as the SAME answer
//     because the customer's move is the same one, and `_lib/upload` turns it
//     into a plan explanation rather than into an error line.
//   • 403 on a DQ override (DQ-2). The editor hides the control without
//     `data.review`; the route requires the capability itself, so a direct PUT
//     is still 403 — see `_lib/dq`.
// =============================================================================
import type { AuditLogRow } from "@/server/db/audit";
import type { DqAssessmentDto } from "@/server/dq/assessments";
import type { DocumentDto } from "@/server/evidence/documents";
import type { EvidenceLinkDto } from "@/server/evidence/links";
import type { InventoryRowDto } from "@/server/inventory/inventory";
import type { InputTableName } from "@/server/inventory/tables";
import type { RowMixinDto } from "@/server/inventory/wire";

import {
  classifyRefusal,
  type ApiBody,
  type Refusal,
  type RuleRef,
  type WriteOutcome,
} from "../../_lib/refusal";

export type {
  DocumentDto,
  DqAssessmentDto,
  EvidenceLinkDto,
  InputTableName,
  InventoryRowDto,
  RowMixinDto,
};

export {
  classifyRefusal,
  type ApiBody,
  type Refusal,
  type RuleRef,
  type WriteOutcome,
};

/** `GET /api/documents` — the company's library, newest upload first (EV-6). */
export interface DocumentListData {
  documents: DocumentDto[];
}

/**
 * `POST /api/documents` — the answer to an upload that was ACCEPTED.
 *
 * `deduplicated` says the bytes were already on disk under the same
 * content-addressed key (EV-0); `warnings` carries VAL-013. NEITHER is a
 * failure: a second row was written and the upload happened. `_lib/upload` is
 * where that is turned into a hint rather than into an error.
 */
export interface UploadData {
  document: DocumentDto;
  deduplicated: boolean;
  warnings: RuleRef[];
}

/** `GET /api/evidence-links` — unfiltered, i.e. the company's whole link table. */
export interface LinkListData {
  links: EvidenceLinkDto[];
}

/** `POST /api/evidence-links` — `created: false` means the pair was already linked. */
export interface LinkWriteData {
  link: EvidenceLinkDto;
  created: boolean;
  warnings: RuleRef[];
}

/** `GET /api/dq/[objectType]/[objectId]` — `null` when nothing is assessed yet. */
export interface AssessmentData {
  assessment: DqAssessmentDto | null;
}

/** `PUT /api/dq/…` — the stored assessment plus VAL-038 as a non-blocking warning. */
export interface AssessmentWriteData {
  assessment: DqAssessmentDto;
  warnings: RuleRef[];
}

/** `GET /api/inventory` — the cross-table listing rows are picked from (DM-14). */
export interface InventoryListData {
  inventory: InventoryRowDto[];
  truncated: boolean;
}

/**
 * `GET …/history` — the version chain (API-2, LC-10), oldest first.
 *
 * Typed on the MIXIN rather than on one table's DTO: this screen shows the four
 * input tables through one timeline and reads only the 19 columns §4.8 gives all
 * of them. `truncated` means the walk stopped at `MAX_VERSION_CHAIN` and this is
 * a prefix — stated on screen, never smoothed over.
 */
export interface RowHistoryData {
  versions: RowMixinDto[];
  truncated: boolean;
}

/**
 * One `audit_log` row as `/api/audit` serialises it — the server's type with the
 * one field JSON changes overridden (see the header).
 */
export type AuditEntryDto = Omit<AuditLogRow, "createdAt"> & {
  createdAt: string | null;
};

/**
 * WHERE ONE ROW'S VERSION CHAIN IS READ FROM, per input table.
 *
 * A TOTAL record over `InputTableName`, so a fifth input table stops this file
 * compiling instead of producing a timeline that silently reads nothing. The two
 * vocabularies are the ones `inventory/_lib/tabs` already separates: the LISTING
 * labels a row with its `source_table` (К-8, the same string
 * `evidence_link.linked_object_type` uses), while the ROUTE is spelled by
 * family — and `disclosure_record` has no family at all, it has its own resource
 * (§12.2). Holding the mapping here means the timeline can open any row the
 * inventory listed without a second lookup.
 */
/**
 * WHERE THE BYTES ARE FETCHED FROM — the one API URL this screen hands to the
 * browser instead of to `apiFetch`.
 *
 * `GET /api/documents/[id]/download` applies EV-6 to the CONTENTS (the metadata
 * listing is `data.read`; the bytes are not) and answers with a
 * `Content-Disposition`. Letting the browser follow an ordinary link is what
 * makes that work at all — a `fetch` would land the file in memory and leave the
 * saving to code that would have to re-implement the header.
 *
 * The base is resolved exactly as `apiFetch` resolves it in the browser
 * (`NEXT_PUBLIC_BACKEND_URL`, the only backend URL that ships to the bundle), so
 * the link points at the same origin the rest of the screen talks to rather than
 * at whatever host happens to be serving the page. Absent — which is a
 * misconfiguration `apiFetch` throws on — it degrades to a same-origin path.
 */
export function downloadHref(documentId: string): string {
  const base = (process.env.NEXT_PUBLIC_BACKEND_URL ?? "").replace(/\/+$/, "");
  return `${base}/api/documents/${documentId}/download`;
}

export const HISTORY_PATH: Record<InputTableName, (id: string) => string> = {
  emission_activity: (id) => `/api/activities/emission/${id}/history`,
  purchased_energy_activity: (id) => `/api/activities/energy/${id}/history`,
  contractual_instrument: (id) => `/api/activities/instruments/${id}/history`,
  disclosure_record: (id) => `/api/disclosures/${id}/history`,
};
