"use client";
import {
  companyQueryKey,
  invalidateCompanyQueries,
} from "@/shared/autosave/company-queries";
import { useCompanySaves } from "@/shared/autosave/CompanySaveProvider";
import { useCompany } from "@/shared/hooks/useSession";

// =============================================================================
// THE DATA HOOKS OF `/organisation` (T2.7) — one react-query read per registry
// and one write function that classifies every refusal.
//
// Shaped after `settings/_lib/useMembers.ts`, and for the same reasons:
//
//   • THE HOOK IS UX ONLY (§0.1). It never decides a right. `company.manage`
//     hides the forms and the ROUTES enforce — a direct request without the
//     capability still answers 403, which is exactly what the acceptance of this
//     task asks to be true.
//   • A 403/401 ON A LIST IS NOT A CRASH (R-11). It is session-cache drift, so
//     it is surfaced as `accessChanged` and rendered as benign copy, kept apart
//     from `loadError` (a transport failure or a 500) — otherwise an outage
//     would read as "you have no facilities".
//   • A WRITE NEVER THROWS. `apiFetch` returns the body on any status, so the
//     write path returns a `WriteOutcome` and the only `catch` is for a genuine
//     transport failure (no JSON at all).
//
// INVALIDATION. A successful write invalidates the list it changed — and, for an
// `access_changed` refusal, the SESSION too, so the manage controls self-correct
// without a manual reload (the same move `useMembers` makes).
// =============================================================================
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { apiFetch } from "@/shared/api/client";
import { SESSION_QUERY_KEY } from "@/shared/hooks/useSession";

import {
  classifyRefusal,
  isAccessError,
  type ApiBody,
  type AssetDto,
  type AssetListData,
  type BoundaryData,
  type EntityListData,
  type FacilityDto,
  type FacilityListData,
  type LegalEntityDto,
  type PeriodDto,
  type PeriodListData,
  type PeriodScopeDto,
  type WriteOutcome,
} from "./api";

/** react-query keys. Tuples so a period's boundary can be invalidated alone. */
const ENTITIES_KEY = ["org", "entities"] as const;
const FACILITIES_KEY = ["org", "facilities"] as const;
const ASSETS_KEY = ["org", "assets"] as const;
const PERIODS_KEY = ["periods"] as const;
const boundaryKey = (periodId: string) =>
  ["periods", periodId, "scope"] as const;

/** Stable empty arrays — a fresh `[]` per render would churn every memo below. */
const NO_ENTITIES: LegalEntityDto[] = [];
const NO_FACILITIES: FacilityDto[] = [];
const NO_ASSETS: AssetDto[] = [];
const NO_PERIODS: PeriodDto[] = [];
const NO_SCOPE: PeriodScopeDto[] = [];

/** What every section needs to know about its list before it can render it. */
interface ListState<T> {
  data: T | null;
  loading: boolean;
  /** 401/403/no-company — the benign "your access changed" state (R-11). */
  accessChanged: boolean;
  /** A transport failure or a 500 — distinct from an empty registry. */
  loadError: boolean;
}

/** One `ActionResult`-shaped GET, classified into {@link ListState}. */
function useList<T>(
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

/** A write against `/api/*`: JSON in, {@link WriteOutcome} out, never a throw. */
type WriteFn = <T>(
  path: string,
  // DELETE since партия 21 — the asset register can remove an entry.
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  payload: unknown,
  invalidate: readonly (readonly unknown[])[],
) => Promise<WriteOutcome<T>>;

/**
 * THE write path of this screen. Stable across renders (its only dependency is
 * the query client), which is what lets the autosave effect debounce on it.
 */
function useWrite(): WriteFn {
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
              body: JSON.stringify(payload),
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
        // manage controls correct themselves (R-11).
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
      return { ok: false, ...refusal };
    },
    [queryClient, companyId, coordinator],
  );
}

/** The legal entities of the company + the API-3 counter (`{used, limit}`). */
export function useLegalEntities() {
  const list = useList<EntityListData>(ENTITIES_KEY, "/api/org/entities");
  const write = useWrite();
  const create = useCallback(
    (body: unknown) =>
      write<LegalEntityDto>("/api/org/entities", "POST", body, [
        ENTITIES_KEY,
        ["readiness"],
      ]),
    [write],
  );
  const update = useCallback(
    (id: string, body: unknown) =>
      write<LegalEntityDto>(`/api/org/entities/${id}`, "PATCH", body, [
        ENTITIES_KEY,
      ]),
    [write],
  );
  return {
    entities: list.data?.entities ?? NO_ENTITIES,
    used: list.data?.used ?? 0,
    /** `null` until the list has loaded — the caller falls back to the matrix. */
    limit: list.data?.limit ?? null,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
    create,
    update,
  };
}

/** The site registry + the API-3 counter (UI-7's "11 of 15 facilities"). */
export function useFacilities() {
  const list = useList<FacilityListData>(FACILITIES_KEY, "/api/org/facilities");
  const write = useWrite();
  const create = useCallback(
    (body: unknown) =>
      write<FacilityDto>("/api/org/facilities", "POST", body, [FACILITIES_KEY]),
    [write],
  );
  const update = useCallback(
    (id: string, body: unknown) =>
      write<FacilityDto>(`/api/org/facilities/${id}`, "PATCH", body, [
        FACILITIES_KEY,
      ]),
    [write],
  );
  return {
    facilities: list.data?.facilities ?? NO_FACILITIES,
    used: list.data?.used ?? 0,
    limit: list.data?.limit ?? null,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
    create,
    update,
  };
}

/** The asset registry. `used` only — F5 puts no plan axis on assets. */
export function useAssets() {
  const list = useList<AssetListData>(ASSETS_KEY, "/api/org/assets");
  const write = useWrite();
  const create = useCallback(
    (body: unknown) =>
      write<AssetDto>("/api/org/assets", "POST", body, [ASSETS_KEY]),
    [write],
  );
  // Партия 21 — a registry you can only add to is a registry of your typos:
  // the owner could not correct a vehicle's plate or remove one sold. The API
  // has had PATCH and DELETE since T-9; only the screen was missing them.
  const update = useCallback(
    (id: string, body: unknown) =>
      write<AssetDto>(`/api/org/assets/${id}`, "PATCH", body, [ASSETS_KEY]),
    [write],
  );
  const remove = useCallback(
    (id: string) =>
      write<{ id: string }>(`/api/org/assets/${id}`, "DELETE", {}, [
        ASSETS_KEY,
      ]),
    [write],
  );
  return {
    assets: list.data?.assets ?? NO_ASSETS,
    used: list.data?.used ?? 0,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
    create,
    update,
    remove,
  };
}

/** The reporting periods + whether the plan may ask for a consolidated one. */
export function usePeriods() {
  const list = useList<PeriodListData>(PERIODS_KEY, "/api/periods");
  const write = useWrite();
  const create = useCallback(
    (body: unknown) =>
      write<PeriodDto>("/api/periods", "POST", body, [PERIODS_KEY]),
    [write],
  );
  const update = useCallback(
    (id: string, body: unknown) =>
      write<PeriodDto>(`/api/periods/${id}`, "PATCH", body, [PERIODS_KEY]),
    [write],
  );
  // The first revision of a period (партия 17): until it exists, every data
  // screen sends the user here — so the button has to be here.
  const startRevision = useCallback(
    (id: string) =>
      write<unknown>(`/api/periods/${id}/revisions`, "POST", {}, [PERIODS_KEY]),
    [write],
  );
  return {
    periods: list.data?.periods ?? NO_PERIODS,
    startRevision,
    used: list.data?.used ?? 0,
    /** PG-2 — `false` means the consolidated option is locked, not absent. */
    consolidatedAvailable: list.data?.consolidated_available ?? false,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
    create,
    update,
  };
}

/**
 * The boundary of ONE period (DM-8). `replace` is a full PUT: the payload states
 * the boundary in its entirety and an omitted entity LEAVES it, which is why the
 * caller always sends the merged set rather than a patch.
 */
export function useBoundary(periodId: string | null) {
  const list = useList<BoundaryData>(
    boundaryKey(periodId ?? "none"),
    periodId ? `/api/periods/${periodId}/scope` : null,
  );
  const write = useWrite();
  const replace = useCallback(
    (entries: unknown) =>
      periodId
        ? write<BoundaryData>(
            `/api/periods/${periodId}/scope`,
            "PUT",
            { entries },
            [boundaryKey(periodId)],
          )
        : Promise.resolve<WriteOutcome<BoundaryData>>({
            ok: false,
            kind: "unknown",
          }),
    [write, periodId],
  );
  return {
    entries: list.data?.entries ?? NO_SCOPE,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
    replace,
  };
}
