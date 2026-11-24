"use client";

import type { Capability } from "@/shared/roles";
import { useSession } from "./useSession";

interface CapabilityState {
  /** The effective capabilities resolved by the SERVER (`/api/session`). */
  capabilities: Capability[];
  /** `true` iff the server granted `cap` for the active membership. */
  has: (cap: Capability) => boolean;
  loading: boolean;
}

/**
 * T4.1 (§13.5): the role-side analogue of `usePlan` (`usePlan.ts:51`) over
 * `useSession` (`useSession.ts:27`). It exposes the capabilities the SERVER
 * already resolved (matrix ∪ the D13 compensating grant) and surfaced as a
 * SIBLING of `DbSession` — the client and server then decide on the SAME set.
 *
 * INVARIANT (§0.1/§0.2): capabilities are READ straight from the session; this
 * hook never reconstructs rights from `role` (no `if (role === 'esg_admin')`).
 * Like `FeatureGate` (`FeatureGate.tsx:27`), this is a UX layer, NOT a security
 * boundary — hiding a control is never the guard; the API routes enforce.
 *
 * Absent (logged out / older cached response) → an empty set, i.e. `.has(...)`
 * is `false` — a safe default that never over-grants.
 */
export function useCapabilities(): CapabilityState {
  const { data, isLoading } = useSession();
  const capabilities = data?.capabilities ?? [];
  return {
    capabilities,
    has: (cap: Capability) => capabilities.includes(cap),
    loading: isLoading,
  };
}
