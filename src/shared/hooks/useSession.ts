"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/shared/api/client";
import type { DbSession } from "@/server/db/types";
import type { PlanFeatures } from "@/shared/plans";
import type { Entitlements, SubscriptionState } from "@/server/billing/guard";

import { SESSION_QUERY_KEY } from "./session-key";

export { SESSION_QUERY_KEY };

// T-A3 (§6.3, §13.4): `/api/session` additively serves the server-resolved plan
// `features` as a SIBLING of `DbSession` (never inside `DbCompany`). The field is
// optional, so existing consumers still see the unchanged `DbSession`; `usePlan`
// reads `features` when present and falls back to the local matrix otherwise.
//
// T-C3 (§9): additionally carries the entitlement `mode` (drives the readonly UI
// mirror) and the live `subscription` state (renewal/cancel/downgrade) for the
// settings billing UI. Both optional — a logged-out or cached response omits them.
// The types are TYPE-ONLY imports from the server guard (erased at compile) so no
// server runtime leaks into the client bundle.
export type SessionResponse = DbSession & {
  features?: PlanFeatures;
  mode?: Entitlements["mode"];
  subscription?: SubscriptionState | null;
};

export function useSession() {
  // T-22 (§1.5, §4.3): транспорт ушёл с server action `getSession` на HTTP —
  // `GET /api/session` (T-19) отдаёт тот же `DbSession | null` прямым JSON, так
  // что форма данных и `SESSION_QUERY_KEY` не меняются, а useCompany/useCurrentUser/
  // usePlan наследуют новый queryFn без правок. (DbSession — type-only импорт,
  // стирается при компиляции; runtime-зависимости от Supabase в хуке нет.)
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) =>
      apiFetch<SessionResponse | null>("/api/session", { signal }),
  });
}

export function useCompany() {
  const { data, isLoading } = useSession();
  return { company: data?.company ?? null, loading: isLoading };
}
