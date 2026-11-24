// =============================================================================
// Role / capability model (§6, D13) — SHARED, because the UI hides buttons by
// the same capability the server enforces (a client-side gate is UX only; the
// authoritative check lives in `server/auth/capabilities.ts`).
//
// Two axes must NOT be conflated: this file is ROLES (what a member may DO in a
// company); `shared/plans.ts` + `server/billing/*` is PLANS (what the company
// paid for). They live in separate modules on purpose (§6.3).
// =============================================================================

/** The six company roles (§6.1). A membership carries exactly one. */
export type CompanyRole =
  | "esg_admin"
  | "data_owner"
  | "contributor"
  | "reviewer"
  | "approver"
  | "auditor";

/**
 * The ten capability keys (§6.1). Note `data.read` is a concrete key, NOT a
 * `*.read` wildcard — the resolver checks membership by literal equality, so no
 * wildcard semantics are introduced (§6.2).
 */
export type Capability =
  | "company.manage"
  | "members.manage"
  | "billing.manage"
  | "data.write"
  | "data.submit"
  | "data.review"
  | "data.approve"
  | "factors.custom"
  | "audit.read"
  | "data.read";

/**
 * The capability matrix (§6.2) — the single source of truth for what each role
 * may do. Each row is the set of capabilities marked ✅ in the §6.2 table.
 *
 * CRITICAL: `esg_admin` does NOT carry `data.approve` here. Approval is meant to
 * be done by someone other than the person who entered the data. The solo-admin
 * case (no independent approver) is handled at runtime by the compensating grant
 * in `effectiveCapabilities` (D13, §Q3) — the STATIC matrix stays pure.
 */
export const ROLE_CAPABILITIES: Record<CompanyRole, readonly Capability[]> = {
  esg_admin: [
    "company.manage",
    "members.manage",
    "billing.manage",
    "data.write",
    "data.submit",
    "data.review",
    "factors.custom",
    "audit.read",
    "data.read",
  ],
  data_owner: [
    "data.write",
    "data.submit",
    "data.review",
    "factors.custom",
    "audit.read",
    "data.read",
  ],
  contributor: ["data.write", "data.submit", "data.read"],
  reviewer: ["data.review", "audit.read", "data.read"],
  // USERS-ROLES-PLAN §7 — SLEEPING CAPABILITY. `data.approve` has no consumer
  // until the periods layer: the approval route is deliberately deferred
  // (`saveMonthlyEmission` resets `status` to draft on every save, so approving
  // on top of the current model would be fictitious). Do NOT delete `data.approve`
  // (here or in `effectiveCapabilities`) as dead code — see USERS-ROLES-PLAN §7.
  approver: ["data.approve", "audit.read", "data.read"],
  auditor: ["audit.read", "data.read"],
} as const;

/**
 * Roles that grant `data.approve` BY THE MATRIX — DERIVED, not hand-listed. It
 * is the source of truth for counting a company's active approvers (D13): if a
 * future role gains `data.approve`, the count picks it up automatically and the
 * compensating grant will not fire where an independent approver already exists.
 */
export const APPROVER_ROLES: readonly CompanyRole[] = (
  Object.keys(ROLE_CAPABILITIES) as CompanyRole[]
).filter((r) => ROLE_CAPABILITIES[r].includes("data.approve"));

/**
 * Effective capabilities for a role = the matrix row, plus the compensating
 * `data.approve` grant (D13, §Q3) IFF `role === 'esg_admin'` AND there is no
 * active approver in the company (`approversCount === 0`).
 *
 * Pure function. The condition is ABSENCE OF AN APPROVER, not head-count: tying
 * the grant to `activeMemberCount === 1` is a rejected dead-end — inviting a
 * contributor would take the company's only path to approving a period away
 * (§Q3). Depends solely on `approversCount`.
 */
export function effectiveCapabilities(
  role: CompanyRole,
  /** Count of ACTIVE memberships whose role grants `data.approve` by the matrix. */
  approversCount: number,
): Capability[] {
  const base = ROLE_CAPABILITIES[role];
  if (
    role === "esg_admin" &&
    approversCount === 0 &&
    !base.includes("data.approve")
  ) {
    return [...base, "data.approve"];
  }
  return [...base];
}
