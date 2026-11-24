// =============================================================================
// Capability guard (§6.3) — the SECURITY boundary for role-gated actions, the
// role-axis sibling of `server/billing/guard.ts`. Kept in a SEPARATE module on
// purpose: plans and roles are different axes, and mixing them in one file is
// exactly the confusion the brief warns against (§6.3).
//
// Style: RETURNS a result (`null` allows, `{ok:false,error:"FORBIDDEN"}` denies)
// like the billing guards, so a route does
//   `const forbidden = requireCapability(session, "data.write");`
//   `if (forbidden) return apiResult(req, forbidden);   // → HTTP 403`
// Unlike `requireFeature`, this is SYNCHRONOUS: the role and the effective
// capabilities are already resolved in `getSession()` (§8), so no DB hit.
// =============================================================================

import {
  effectiveCapabilities,
  type Capability,
  type CompanyRole,
} from "@/shared/roles";

// USERS-ROLES-PLAN §7 — SLEEPING CAPABILITY. `data.approve` has no consumer until
// the periods layer: the approval route is deliberately deferred
// (`saveMonthlyEmission` resets `status` to draft on every save, so approving on
// top of the current model would be fictitious). This guard already enforces
// `data.approve` (incl. the D13 grant) so the periods layer can gate on it with no
// rewrite. Do NOT delete this branch as dead code — see USERS-ROLES-PLAN §7.

/** Deny result — shape-compatible with `apiResult` (`FORBIDDEN` → 403, §6.4). */
type Forbidden = { ok: false; error: "FORBIDDEN" };
const FORBIDDEN: Forbidden = { ok: false, error: "FORBIDDEN" };

/** Guard outcome: `null` allows, `Forbidden` denies (return it to `apiResult`). */
export type CapabilityResult = Forbidden | null;

/**
 * Minimal LOCAL session shape this guard reads. Deliberately NOT `DbSession`:
 * the membership/capabilities fields are added to `DbSession` in T1.2b, so
 * depending on that type (or editing `types.ts`) here would couple this
 * foundation task to a later one. This structural interface accepts today's
 * `DbSession` (extra fields are fine) and tomorrow's extended one alike.
 *
 * `hasIndependentApprover` is optional so the role-fallback can apply the D13
 * grant when the session does not carry pre-computed `capabilities`.
 */
export interface CapabilitySession {
  membership?: { role: CompanyRole; hasIndependentApprover?: boolean } | null;
  capabilities?: Capability[];
}

/**
 * Require `cap` for the session. `null` allows; `FORBIDDEN` denies.
 *
 * Source of the effective grant (§6.3):
 *  1. PREFERRED — if the session carries pre-computed `capabilities` (resolved
 *     in `getSession()` with the D13 grant already applied), check against them.
 *  2. FALLBACK — otherwise compute from `membership.role` via
 *     `effectiveCapabilities`. `hasIndependentApprover === false` maps to
 *     `approversCount === 0` (grant active); anything else is treated as an
 *     approver present (no grant) — the conservative default for `data.approve`.
 *
 * Missing `session` or `membership` → `FORBIDDEN` (never throws): no company
 * context means no computable capability, which is a deny, not a crash.
 */
export function requireCapability(
  session: CapabilitySession | null | undefined,
  cap: Capability,
): CapabilityResult {
  if (!session) return FORBIDDEN;

  if (session.capabilities) {
    return session.capabilities.includes(cap) ? null : FORBIDDEN;
  }

  const membership = session.membership;
  if (!membership) return FORBIDDEN;

  const approversCount = membership.hasIndependentApprover === false ? 0 : 1;
  return effectiveCapabilities(membership.role, approversCount).includes(cap)
    ? null
    : FORBIDDEN;
}
