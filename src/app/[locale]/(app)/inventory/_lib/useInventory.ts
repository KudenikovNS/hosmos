"use client";
import {
  companyQueryKey,
  invalidateCompanyQueries,
} from "@/shared/autosave/company-queries";
import { useCompanySaves } from "@/shared/autosave/CompanySaveProvider";
import { useCompany } from "@/shared/hooks/useSession";

// =============================================================================
// THE DATA HOOKS OF `/inventory` (T3.5) — shaped exactly like
// `organisation/_lib/useOrganisation.ts` and `admin/factors/_lib/useFactors.ts`,
// and the header of the first one is the rationale for all three properties:
// the hook is UX only (§0.1 — the ROUTES enforce), a 403 on a list is
// `accessChanged` rather than a crash (R-11), and a write returns a
// `WriteOutcome` instead of throwing.
//
// WHAT IS DIFFERENT HERE, and there are three things:
//
//   1. THE LISTING IS THE CROSS-TABLE ONE (T3.4). Seven tabs over three tables
//      are ONE `GET /api/inventory?revision_id=…` and a client-side filter by
//      `source_table` + `kind` (`./tabs#belongsToTab`), not seven requests. The
//      approval queue is a SERVER-named composition (`?queue`), never assembled
//      here — a client that spelled "state=draft and current and not deleted"
//      itself could disagree with the counter beside it.
//   2. A ROW'S BODY COMES FROM ITS OWN TABLE. The inventory projects three body
//      columns (kind/label/quantity); the drawer needs the whole row, so opening
//      one fetches `/api/activities/<family>/[id]` — the split §12.2 draws.
//   3. WRITES INVALIDATE THE INVENTORY, THE ROW AND ITS HISTORY. An edit is a
//      NEW VERSION with a NEW id (LC-5), so the drawer follows the id the
//      response carries; leaving the old one selected would show a version that
//      has just been superseded and offer to approve it.
//
// THE MEMBER ROSTER IS SHARED, NOT REFETCHED. The version chain shows WHO wrote
// and WHO approved each version, and the mixin carries user ids. `/settings`
// already owns that query; importing its key means the drawer reads the same
// react-query cache entry rather than adding a second copy of the roster.
// =============================================================================
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { apiFetch } from "@/shared/api/client";
import { SESSION_QUERY_KEY } from "@/shared/hooks/useSession";

import { MEMBERS_QUERY_KEY, type Member } from "../../settings/_lib/useMembers";
import {
  classifyRefusal,
  isAccessError,
  type ApiBody,
  type HistoryData,
  type InventoryListData,
  type InventoryRowDto,
  type PeriodDto,
  type PeriodListData,
  type RevisionDto,
  type RevisionListData,
  type RowDto,
  type WriteOutcome,
} from "./api";
import type { RowFamily } from "./tabs";

/** react-query keys. Tuples so one row's history can be invalidated alone. */
const PERIODS_KEY = ["periods"] as const;
const revisionsKey = (periodId: string) =>
  ["periods", periodId, "revisions"] as const;
const inventoryKey = (revisionId: string, queue: boolean) =>
  ["inventory", revisionId, queue ? "queue" : "all"] as const;
const rowKey = (family: RowFamily, id: string) =>
  ["activities", family, id] as const;
const historyKey = (family: RowFamily, id: string) =>
  ["activities", family, id, "history"] as const;

/** Stable empty arrays — a fresh `[]` per render would churn every memo below. */
const NO_ROWS: InventoryRowDto[] = [];
const NO_PERIODS: PeriodDto[] = [];
const NO_REVISIONS: RevisionDto[] = [];
const NO_VERSIONS: RowDto[] = [];
const NO_MEMBERS: Member[] = [];

/**
 * What a section needs to know about its list before it can render it.
 *
 * EXPORTED FOR THE DISCLOSURE SCREEN (T3.5b), which is a sibling page of this
 * one (`../disclosures`) reading two more `/api/*` collections through the same
 * two primitives below. A second copy of "a 403 on a list is `accessChanged`,
 * not a crash" and of "a write returns a `WriteOutcome` and never throws" is
 * exactly the drift `../../_lib/refusal` exists to prevent: those two rules are
 * one decision, and the two screens must not answer it differently.
 */
export interface ListState<T> {
  data: T | null;
  loading: boolean;
  /** 401/403/no-company — the benign "your access changed" state (R-11). */
  accessChanged: boolean;
  /** A transport failure or a 500 — distinct from an empty inventory. */
  loadError: boolean;
}

/** One `ActionResult`-shaped GET, classified into {@link ListState}. */
export function useList<T>(
  key: readonly unknown[],
  path: string | null,
): ListState<T> {
  const { company } = useCompany();
  const query = useQuery<ApiBody<T>>({
    queryKey: companyQueryKey(key, company?.id),
    queryFn: ({ signal }) => apiFetch<ApiBody<T>>(path as string, { signal }),
    enabled: path !== null && !!company,
  });
  const body = query.data;
  const accessChanged = !!body && !body.ok && isAccessError(body.error);
  return {
    data: body && body.ok ? body.data : null,
    loading: query.isLoading && path !== null,
    accessChanged,
    loadError: query.isError || (!!body && !body.ok && !accessChanged),
  };
}

/**
 * A write against `/api/*`: JSON in, {@link WriteOutcome} out, never a throw.
 *
 * `PUT` is in the union for `/evidence` (T4.5), whose DQ editor writes through
 * `PUT /api/dq/[objectType]/[objectId]` — an UPSERT on the DM-27 unique key, so
 * the verb is the server's choice and not a style question. Widening the union
 * here rather than giving that screen its own write path keeps "a 403 refetches
 * the session, a refusal is classified once, nothing throws" ONE decision for
 * every screen (see the T3.5b header on `useList`).
 */
export type WriteFn = <T>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  payload: unknown,
  invalidate: readonly (readonly unknown[])[],
) => Promise<WriteOutcome<T>>;

/** THE write path of this screen. Stable across renders (see the T2.7 header). */
export function useWrite(): WriteFn {
  const queryClient = useQueryClient();
  const { company } = useCompany();
  const companyId = company?.id;
  const { coordinator } = useCompanySaves();
  return useCallback(
    async <T>(
      path: string,
      method: "POST" | "PATCH" | "PUT" | "DELETE",
      payload: unknown,
      invalidate: readonly (readonly unknown[])[],
    ): Promise<WriteOutcome<T>> => {
      let body: ApiBody<T>;
      try {
        body = await coordinator.write(
          () =>
            apiFetch<ApiBody<T>>(path, {
              method,
              ...(payload === undefined
                ? {}
                : { body: JSON.stringify(payload) }),
            }),
          companyId,
        );
      } catch {
        // A thrown `apiFetch` is a transport failure (no JSON at all) — it must
        // not leave a form spinning, and it is not a refusal the server made.
        return { ok: false, kind: "unknown" };
      }
      if (body.ok) {
        await Promise.all(
          invalidate.map((key) =>
            invalidateCompanyQueries(queryClient, key, companyId),
          ),
        );
        return { ok: true, data: body.data };
      }
      const refusal = classifyRefusal(body);
      if (refusal.kind === "access_changed") {
        // The actor's cached capabilities are stale — refetch the session so the
        // write controls correct themselves (R-11).
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
      return { ok: false, ...refusal };
    },
    [queryClient, companyId, coordinator],
  );
}

/** The reporting periods — the screen picks the revision through one. */
export function usePeriods() {
  const list = useList<PeriodListData>(PERIODS_KEY, "/api/periods");
  return {
    periods: list.data?.periods ?? NO_PERIODS,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/**
 * Партия 21 — open a RESTATEMENT of a locked revision, from the screen the
 * user is already on. `seedFrom` is not optional here on purpose: a
 * restatement started without it is an EMPTY revision (the API's default), and
 * an empty revision locked over a finished report is exactly the accident this
 * project made once already. The reason is required by §5.1 and by the form.
 */
export function useStartRevision(): (
  periodId: string,
  values: { seedFrom: string; changeReason: string },
) => Promise<WriteOutcome<RevisionDto>> {
  const write = useWrite();
  return useCallback(
    (periodId: string, values: { seedFrom: string; changeReason: string }) =>
      write<RevisionDto>(
        `/api/periods/${periodId}/revisions`,
        "POST",
        { seedFrom: values.seedFrom, change_reason: values.changeReason },
        [PERIODS_KEY, revisionsKey(periodId), ["inventory"], ["disclosures"]],
      ),
    [write],
  );
}

/** The revisions of one period; LC-1a publishes which one is current. */
export function useRevisions(periodId: string | null) {
  const list = useList<RevisionListData>(
    revisionsKey(periodId ?? "none"),
    periodId ? `/api/periods/${periodId}/revisions` : null,
  );
  return {
    revisions: list.data?.revisions ?? NO_REVISIONS,
    currentRevisionId: list.data?.current_revision_id ?? null,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/**
 * The cross-table inventory of ONE revision (DM-14). `queue` asks for the
 * approval queue — a name the SERVER owns, passed straight through.
 */
export function useInventoryRows(revisionId: string | null, queue: boolean) {
  const list = useList<InventoryListData>(
    inventoryKey(revisionId ?? "none", queue),
    revisionId
      ? `/api/inventory?revision_id=${revisionId}${queue ? "&queue=1" : ""}`
      : null,
  );
  return {
    rows: list.data?.inventory ?? NO_ROWS,
    truncated: list.data?.truncated ?? false,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/** ONE version, whole body included (§12.2 — the inventory carries a summary). */
export function useRow(family: RowFamily, id: string | null) {
  const list = useList<RowDto>(
    rowKey(family, id ?? "none"),
    id ? `/api/activities/${family}/${id}` : null,
  );
  return {
    row: list.data,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/**
 * THE VERSION CHAIN of one row (API-2, LC-10) — oldest first, and it crosses
 * revision boundaries: a row seeded into a new revision (LC-9) has
 * `previous_version_id` pointing at the row it was copied from, which lives in
 * the SOURCE revision. That is why the drawer prints each version's revision.
 */
export function useRowHistory(family: RowFamily, id: string | null) {
  const list = useList<HistoryData>(
    historyKey(family, id ?? "none"),
    id ? `/api/activities/${family}/${id}/history` : null,
  );
  return {
    versions: list.data?.versions ?? NO_VERSIONS,
    truncated: list.data?.truncated ?? false,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/** The company roster — so a version chain shows names rather than uuids. */
export function useMemberNames(): (userId: string | null) => string | null {
  const query = useQuery<ApiBody<Member[]>>({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: () => apiFetch<ApiBody<Member[]>>("/api/members"),
  });
  const body = query.data;
  const members = body && body.ok ? body.data : NO_MEMBERS;
  return (userId) => {
    if (!userId) return null;
    const member = members.find((m) => m.userId === userId);
    return member ? member.name || member.email : null;
  };
}

/** Both listings of one revision — the whole tab strip and the approval queue. */
function inventoryKeys(revisionId: string | null) {
  return [
    inventoryKey(revisionId ?? "none", false),
    inventoryKey(revisionId ?? "none", true),
  ];
}

/**
 * The three writes of one row family (LC-3…LC-5), each invalidating its reads.
 *
 * The invalidation set is built INSIDE each callback rather than above them: it
 * is derived from `family` and `revisionId`, and a fresh array in the closure
 * would be a new dependency on every render — which would give `useAutosave` a
 * `save` whose identity never settles and a debounce that never fires (the
 * warning its header describes).
 */
export function useRowWrites(family: RowFamily, revisionId: string | null) {
  const write = useWrite();

  const create = useCallback(
    (body: unknown) =>
      write<RowDto>(
        `/api/activities/${family}`,
        "POST",
        body,
        inventoryKeys(revisionId),
      ),
    [write, family, revisionId],
  );

  const edit = useCallback(
    (id: string, body: unknown) =>
      write<RowDto>(`/api/activities/${family}/${id}`, "PATCH", body, [
        ...inventoryKeys(revisionId),
        rowKey(family, id),
        historyKey(family, id),
      ]),
    [write, family, revisionId],
  );

  const approve = useCallback(
    (id: string) =>
      write<RowDto>(
        `/api/activities/${family}/${id}/approve`,
        "POST",
        undefined,
        [
          ...inventoryKeys(revisionId),
          rowKey(family, id),
          historyKey(family, id),
        ],
      ),
    [write, family, revisionId],
  );

  return { create, edit, approve };
}
