"use client";

// =============================================================================
// THE DATA HOOKS OF `/admin/factors` (T2.8) — shaped exactly like
// `organisation/_lib/useOrganisation.ts`, and the header there is the rationale
// for all three properties: the hook is UX only (§0.1 — the ROUTES enforce
// `factors.custom`), a 403 on a list is `accessChanged` rather than a crash
// (R-11), and a write returns a `WriteOutcome` instead of throwing.
//
// WHAT IS DIFFERENT HERE, and it is one thing: THE FACTOR LIST IS PAGED AND
// FILTERED ON THE SERVER. `legacy-v1` holds 440 rows, so the query key carries
// the set, the search text and the offset — changing any of them is a new query
// rather than a client-side filter over a list that was never fully fetched.
// =============================================================================
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { apiFetch } from "@/shared/api/client";
import { SESSION_QUERY_KEY } from "@/shared/hooks/useSession";

import {
  classifyRefusal,
  isAccessError,
  type ApiBody,
  type EmissionFactorDto,
  type FactorPageData,
  type FactorSetDetailData,
  type FactorSetDto,
  type FactorSetListData,
  type WriteOutcome,
} from "./api";

/** react-query keys. Tuples so one set's factors can be invalidated alone. */
const SETS_KEY = ["factor-sets"] as const;
const setKey = (id: string) => ["factor-sets", id] as const;
const factorsKey = (id: string, search: string, offset: number) =>
  ["factor-sets", id, "factors", search, offset] as const;

/** Stable empty arrays — a fresh `[]` per render would churn every memo below. */
const NO_SETS: FactorSetDto[] = [];
const NO_FACTORS: EmissionFactorDto[] = [];

/** How many factors one page of the table shows (the route caps it at 500). */
export const PAGE_SIZE = 50;

/** What a section needs to know about its list before it can render it. */
interface ListState<T> {
  data: T | null;
  loading: boolean;
  /** 401/403/no-company — the benign "your access changed" state (R-11). */
  accessChanged: boolean;
  /** A transport failure or a 500 — distinct from an empty library. */
  loadError: boolean;
}

/** One `ActionResult`-shaped GET, classified into {@link ListState}. */
function useList<T>(
  key: readonly unknown[],
  path: string | null,
): ListState<T> {
  const query = useQuery<ApiBody<T>>({
    queryKey: key,
    queryFn: () => apiFetch<ApiBody<T>>(path as string),
    enabled: path !== null,
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

/** A write against `/api/*`: JSON in, {@link WriteOutcome} out, never a throw. */
type WriteFn = <T>(
  path: string,
  method: "POST" | "PATCH",
  payload: unknown,
  invalidate: readonly (readonly unknown[])[],
) => Promise<WriteOutcome<T>>;

/** THE write path of this screen. Stable across renders (see the T2.7 header). */
function useWrite(): WriteFn {
  const queryClient = useQueryClient();
  return useCallback(
    async <T>(
      path: string,
      method: "POST" | "PATCH",
      payload: unknown,
      invalidate: readonly (readonly unknown[])[],
    ): Promise<WriteOutcome<T>> => {
      let body: ApiBody<T>;
      try {
        body = await apiFetch<ApiBody<T>>(path, {
          method,
          body: JSON.stringify(payload),
        });
      } catch {
        // A thrown `apiFetch` is a transport failure (no JSON at all) — not a
        // refusal the server made, and it must not leave a form spinning.
        return { ok: false, kind: "unknown" };
      }
      if (body.ok) {
        for (const key of invalidate) {
          queryClient.invalidateQueries({ queryKey: key });
        }
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
 * The factor library: every set, plus the two writes UI-4 asks for — "new
 * version" (a draft seeded with a copy of another set's factors) and the
 * release/archive transition.
 */
export function useFactorSets() {
  const list = useList<FactorSetListData>(SETS_KEY, "/api/factor-sets");
  const write = useWrite();

  const create = useCallback(
    (body: {
      code: string;
      name: string;
      description?: string;
      copy_from?: string;
    }) => write<FactorSetDto>("/api/factor-sets", "POST", body, [SETS_KEY]),
    [write],
  );
  const update = useCallback(
    (id: string, body: Record<string, unknown>) =>
      write<FactorSetDto>(`/api/factor-sets/${id}`, "PATCH", body, [
        SETS_KEY,
        setKey(id),
      ]),
    [write],
  );

  return {
    sets: list.data?.factor_sets ?? NO_SETS,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
    create,
    update,
  };
}

/** One set's detail: the row again, plus its sources and licences (UI-4). */
export function useFactorSetDetail(id: string | null) {
  const list = useList<FactorSetDetailData>(
    setKey(id ?? "none"),
    id ? `/api/factor-sets/${id}` : null,
  );
  return {
    set: list.data?.factor_set ?? null,
    provenance: list.data?.provenance ?? [],
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/** One page of one set's factors, filtered server-side (see the header). */
export function useFactors(
  setId: string | null,
  search: string,
  offset: number,
) {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (search.trim()) params.set("search", search.trim());
  const list = useList<FactorPageData>(
    factorsKey(setId ?? "none", search.trim(), offset),
    setId ? `/api/factor-sets/${setId}/factors?${params.toString()}` : null,
  );
  return {
    factors: list.data?.factors ?? NO_FACTORS,
    total: list.data?.total ?? 0,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}
