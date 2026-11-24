"use client";

// =============================================================================
// THE DATA HOOKS OF `/evidence` (T4.5) — shaped exactly like
// `inventory/_lib/useInventory.ts` and importing its two primitives rather than
// re-writing them: `useList` (a 403 on a list is `accessChanged`, not a crash,
// R-11) and `useWrite` (a write returns a `WriteOutcome` and never throws) are
// ONE decision for every screen of this app, not four.
//
// WHAT IS DIFFERENT HERE, and there are four things:
//
//   1. TWO REQUESTS FEED THE WHOLE SCREEN. The library is `GET /api/documents`
//      and the link table is `GET /api/evidence-links` UNFILTERED — which the
//      route was written to serve ("an unfiltered list is the company's whole
//      link table, which is what an evidence overview screen wants"). Both
//      directions of DM-25 are then answered by indexing in the browser
//      (`./filters`), instead of by one `?document_id=` request per row of the
//      table.
//   2. AN UPLOAD IS MULTIPART, SO IT HAS ITS OWN WRITE. `useWrite` serialises
//      JSON; a `FormData` body must reach `fetch` untouched so the browser can
//      set the boundary. `useUpload` is therefore separate — but it classifies
//      its refusal through the SAME `classifyRefusal`, so a 402 on an upload and
//      a 402 anywhere else are still one vocabulary.
//   3. THE AUDIT READ IS ASKED FOR ONLY WHEN THE SESSION MAY HAVE IT.
//      `/api/audit` requires `audit.read` (§6.2 — a contributor deliberately
//      lacks it), and firing it regardless would classify a perfectly ordinary
//      403 as `accessChanged` and tell the user their rights had just changed.
//      They had not. So the caller passes `enabled` from `useCapabilities()`, the
//      request is not made, and the timeline states which half it is missing.
//      The route enforces either way: this is politeness, not the guard.
//   4. AN ASSESSMENT IS KEYED BY ITS OBJECT, not by its own id. `dq_assessment`
//      has a UNIQUE `(company_id, object_type, object_id)` (К-16). Within the
//      session company the object identifies the assessment and PUT is an upsert;
//      query key is the pair and the write invalidates exactly that key.
// =============================================================================
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { apiFetch } from "@/shared/api/client";
import { SESSION_QUERY_KEY } from "@/shared/hooks/useSession";

import { useList, useWrite } from "../../inventory/_lib/useInventory";
import {
  classifyRefusal,
  HISTORY_PATH,
  type ApiBody,
  type AssessmentData,
  type AssessmentWriteData,
  type AuditEntryDto,
  type DocumentDto,
  type DocumentListData,
  type EvidenceLinkDto,
  type InputTableName,
  type InventoryListData,
  type InventoryRowDto,
  type LinkListData,
  type LinkWriteData,
  type RowHistoryData,
  type RowMixinDto,
  type UploadData,
  type WriteOutcome,
} from "./api";

/** react-query keys. Tuples so one assessment can be invalidated alone. */
const DOCUMENTS_KEY = ["documents"] as const;
const LINKS_KEY = ["evidence-links"] as const;
const assessmentKey = (objectType: string, objectId: string) =>
  ["dq", objectType, objectId] as const;
const historyKey = (table: string, id: string) =>
  ["row-history", table, id] as const;
const auditKey = (limit: number) => ["audit", limit] as const;
const inventoryKey = (revisionId: string) =>
  ["inventory", revisionId, "all"] as const;

/**
 * How much of the company's audit trail the timeline reads.
 *
 * `/api/audit` clamps `limit` to 100, so this is the ceiling and not a
 * preference. What matters is that the number is KNOWN to the client:
 * `auditWindowIncomplete` compares it with what came back and the timeline
 * discloses when the window is shorter than the row's life (`./timeline`).
 */
export const AUDIT_LIMIT = 100;

/** Stable empty arrays — a fresh `[]` per render would churn every memo. */
const NO_DOCUMENTS: DocumentDto[] = [];
const NO_LINKS: EvidenceLinkDto[] = [];
const NO_VERSIONS: RowMixinDto[] = [];
const NO_AUDIT: AuditEntryDto[] = [];
const NO_ROWS: InventoryRowDto[] = [];

/** The evidence library — the company's documents, newest upload first (EV-6). */
export function useDocuments() {
  const list = useList<DocumentListData>(DOCUMENTS_KEY, "/api/documents");
  return {
    documents: list.data?.documents ?? NO_DOCUMENTS,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/** The whole link table of the company (DM-25) — indexed in the browser. */
export function useEvidenceLinks() {
  const list = useList<LinkListData>(LINKS_KEY, "/api/evidence-links");
  return {
    links: list.data?.links ?? NO_LINKS,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/** The cross-table listing of one revision — the rows a document is linked to. */
export function useInventoryRows(revisionId: string | null) {
  const list = useList<InventoryListData>(
    inventoryKey(revisionId ?? "none"),
    revisionId ? `/api/inventory?revision_id=${revisionId}` : null,
  );
  return {
    rows: list.data?.inventory ?? NO_ROWS,
    truncated: list.data?.truncated ?? false,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/**
 * One object's DQ assessment (DM-27). `null` means the object exists and has
 * none yet — a real state, and a more useful answer to an editor than a 404 it
 * would have to interpret.
 */
export function useAssessment(
  objectType: string | null,
  objectId: string | null,
) {
  const list = useList<AssessmentData>(
    assessmentKey(objectType ?? "none", objectId ?? "none"),
    objectType && objectId ? `/api/dq/${objectType}/${objectId}` : null,
  );
  return {
    assessment: list.data?.assessment ?? null,
    /** The GET succeeded — so `assessment: null` means "none yet", not "unknown". */
    loaded: list.data !== null,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/** THE version chain of one row (API-2, LC-10) — oldest first, any input table. */
export function useRowVersions(
  table: InputTableName | null,
  id: string | null,
) {
  const list = useList<RowHistoryData>(
    historyKey(table ?? "none", id ?? "none"),
    table && id ? HISTORY_PATH[table](id) : null,
  );
  return {
    versions: list.data?.versions ?? NO_VERSIONS,
    truncated: list.data?.truncated ?? false,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/**
 * The company's recent `audit_log` rows (§Q6), newest first.
 *
 * `enabled` is the caller's `audit.read` check — see point 3 of the header. When
 * it is false NO REQUEST IS MADE and the timeline says the audit half is not
 * being shown, which is the truth; the route would answer 403 either way.
 */
export function useAuditTrail(enabled: boolean) {
  const list = useList<AuditEntryDto[]>(
    auditKey(AUDIT_LIMIT),
    enabled ? `/api/audit?limit=${AUDIT_LIMIT}` : null,
  );
  return {
    entries: list.data ?? NO_AUDIT,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/**
 * THE upload (EV-0, EV-1, PG-1) — the one write of this screen that is not JSON.
 *
 * The `FormData` goes to `fetch` untouched: setting a `Content-Type` by hand
 * would strip the multipart boundary the browser generates, and the route would
 * see a body it cannot parse. Everything else is `useWrite`'s contract, and
 * deliberately so — the refusal is classified by the SAME function, a 401/403
 * refetches the session, and a transport failure is `unknown` rather than a
 * throw that leaves the panel spinning.
 */
export function useUpload(): (
  form: FormData,
) => Promise<WriteOutcome<UploadData>> {
  const queryClient = useQueryClient();
  return useCallback(
    async (form: FormData): Promise<WriteOutcome<UploadData>> => {
      let body: ApiBody<UploadData>;
      try {
        body = await apiFetch<ApiBody<UploadData>>("/api/documents", {
          method: "POST",
          body: form,
        });
      } catch {
        return { ok: false, kind: "unknown" };
      }
      if (body.ok) {
        queryClient.invalidateQueries({ queryKey: DOCUMENTS_KEY });
        return { ok: true, data: body.data };
      }
      const refusal = classifyRefusal(body);
      if (refusal.kind === "access_changed") {
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
      return { ok: false, ...refusal };
    },
    [queryClient],
  );
}

/**
 * The four JSON writes of this screen, each invalidating what it changed.
 *
 * The invalidation sets are built INSIDE each callback, as `useRowWrites` builds
 * its own: a fresh array above them would be a new dependency on every render,
 * and every consumer of these callbacks would see an identity that never
 * settles.
 *
 * DELETING A DOCUMENT INVALIDATES THE LINKS TOO. `evidence_link.document_id` is
 * ON DELETE CASCADE, so removing a document removes every link that cited it —
 * a table left holding the old links would show usage counts for a document that
 * is gone.
 */
export function useEvidenceWrites() {
  const write = useWrite();

  const link = useCallback(
    (values: {
      documentId: string;
      objectType: string;
      objectId: string;
    }): Promise<WriteOutcome<LinkWriteData>> =>
      write<LinkWriteData>("/api/evidence-links", "POST", values, [LINKS_KEY]),
    [write],
  );

  const unlink = useCallback(
    (id: string): Promise<WriteOutcome<{ id: string }>> =>
      write<{ id: string }>(`/api/evidence-links/${id}`, "DELETE", undefined, [
        LINKS_KEY,
      ]),
    [write],
  );

  const removeDocument = useCallback(
    (
      id: string,
    ): Promise<WriteOutcome<{ id: string; bytes_removed: boolean }>> =>
      write<{ id: string; bytes_removed: boolean }>(
        `/api/documents/${id}`,
        "DELETE",
        undefined,
        [DOCUMENTS_KEY, LINKS_KEY],
      ),
    [write],
  );

  const saveAssessment = useCallback(
    (
      objectType: string,
      objectId: string,
      body: Record<string, unknown>,
    ): Promise<WriteOutcome<AssessmentWriteData>> =>
      write<AssessmentWriteData>(
        `/api/dq/${objectType}/${objectId}`,
        "PUT",
        body,
        [assessmentKey(objectType, objectId)],
      ),
    [write],
  );

  return { link, unlink, removeDocument, saveAssessment };
}
