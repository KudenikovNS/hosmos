import type { QueryClient } from "@tanstack/react-query";

// Keep the resource prefix so existing broad invalidations still work, while
// a delayed response for A can never populate B's cache entry.
export const companyQueryKey = (
  key: readonly unknown[],
  companyId: string | undefined,
) => [...key, { companyId }] as const;

export function invalidateCompanyQueries(
  client: QueryClient,
  key: readonly unknown[],
  companyId: string | undefined,
) {
  return client.invalidateQueries({
    queryKey: key,
    predicate: (query) =>
      (query.queryKey.at(-1) as { companyId?: string } | undefined)
        ?.companyId === companyId,
  });
}
