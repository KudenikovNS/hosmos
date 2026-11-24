import {
  QueryClient,
  dehydrate,
  HydrationBoundary,
} from "@tanstack/react-query";
import { Sidebar } from "./_components/Sidebar";
import { CompanySwitcher } from "./_components/CompanySwitcher";
import { NoCompanyGate } from "./_components/NoCompanyGate";
import {
  CompanySaveProvider,
  CompanyContent,
} from "@/shared/autosave/CompanySaveProvider";
import { QueryProvider } from "@/shared/providers/QueryProvider";
import { apiFetch } from "@/shared/api/client";
import { SESSION_QUERY_KEY } from "@/shared/hooks/session-key";
import styles from "./layout.module.css";
// Type-only import (erased at compile) — no Supabase client in this RSC bundle.
import type { DbSession } from "@/server/db/types";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // T-25 (§1.5, §4.3): prefetch the session server-side via `apiFetch("/api/session")`
  // — same `DbSession | null` shape and same `SESSION_QUERY_KEY` as the client
  // `useSession` hook, so the dehydrated cache matches on HydrationBoundary.
  //
  // RSC-in-dev caveat (§3.5, ОВ-4): in FRONT-DEV the RSC runs on localhost while
  // BACKEND_URL points at prod, so the forwarded localhost cookie is not the prod
  // session cookie — this prefetch returns `null` (anonymous) and `useSession`
  // then refetches the real session CLIENT-side (browser, `credentials:"include"`).
  // In PROD (same-origin) the cookie is valid, so the prefetch is authenticated and
  // the session is visible from the RSC hydration.
  const queryClient = new QueryClient();
  await queryClient.prefetchQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: () => apiFetch<DbSession | null>("/api/session"),
  });

  return (
    <QueryProvider>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <CompanySaveProvider>
          <div className={styles.shell}>
            <CompanyContent>
              <Sidebar />
            </CompanyContent>
            <main className={styles.main}>
              {/* T4.1 (§8.1): the company switcher lives in the app header. It
                self-hides with <2 memberships, so this bar is empty (no border,
                no height) for single-company users — the common case. */}
              <div className={styles.appHeader}>
                <CompanySwitcher />
              </div>
              {/* BUG-004: a signed-in account without a company gets the
                "create your company" step instead of an empty screen. */}
              <CompanyContent>
                <NoCompanyGate>{children}</NoCompanyGate>
              </CompanyContent>
            </main>
          </div>
        </CompanySaveProvider>
      </HydrationBoundary>
    </QueryProvider>
  );
}
