// =============================================================================
// Normalized domain shapes returned by the Drizzle data-access layer.
//
// These are pure, DB-free, framework-neutral types (no `server-only`, no runtime
// imports) so they are safe to import type-only from both server modules and
// client components. They were relocated here from the removed Supabase query
// layer during the Supabase cutover (PG-PLAN T-26); the shapes are unchanged.
//
//   - `DbCompany` — the normalized company row shape the services and API routes
//     return (column names mapped to stable domain field names decoupled from
//     the schema).
//   - `DbSession` — the `getSession()` return shape (userId/email/name/company),
//     preserved 1:1 for `useSession`, `getServerSession` and the API routes.
//
// TRIMMED IN T3.8 AND T3.9 (plan §5, «легаси-типы `db/types.ts` — подрезка»). The
// denormalized emission-factor shapes are gone in two steps. T3.8 removed the DTO
// half with its consumers (`DbSource`, `EmissionFactorCategory`, `EmissionFactor`,
// `EmissionFactorAttributesDto`, `FlightAttrsDto`, `RefrigerantAttrsDto`,
// `GridAttrsDto` — read only by `/api/factors`, `src/server/db/factors.ts`,
// `normalize.toEmissionFactor` and the `data-sources` page). T3.9 removed the
// STORED half (`EmissionFactorAttributes` and its seven members) together with the
// table it described: `schema.ts` bound it with `.$type<>()` on `emission_factors`
// and `seed.ts` wrote it, and `drizzle/0005_drop_legacy.sql` drops that table. The
// factor library is now `factor_set` + `emission_factor` (0004), whose columns are
// typed and need no JSONB union.
// =============================================================================

import type { Capability, CompanyRole } from "@/shared/roles";

export interface DbCompany {
  id: string;
  name: string;
  industry: string | null;
  nace_code: string | null;
  country: string | null;
  country_code: string | null;
  headcount: number | null;
  plan: string;
  reporting_year: string | null;
  currency: string | null;
}

/**
 * The user's ACTIVE membership in the session's active company, enriched with the
 * two derived counters `getSession()` computes for it (USERS-ROLES §8.1, D12).
 * Only an `active` membership ever reaches the session; a stale/suspended pointer
 * is resolved away by the D10 resolver before this is built.
 */
export interface DbMembership {
  companyId: string;
  role: CompanyRole;
  status: "active";
  /**
   * Whether the company has an active member whose role grants `data.approve` by
   * the matrix. `false` → the D13 compensating grant fired and an approval by this
   * member would be flagged as non-independent (§11.2).
   */
  hasIndependentApprover: boolean;
  /** Count of active members. INFORMATIONAL — capabilities do not depend on it. */
  activeMemberCount: number;
}

/** One entry of the user's active-membership list — the company switcher (§8.1). */
export interface DbMembershipSummary {
  companyId: string;
  companyName: string;
  role: CompanyRole;
}

export interface DbSession {
  userId: string;
  email: string;
  name: string;
  company: DbCompany | null;
  /** NEW (D12) — the active membership, or `null` when the user has none. */
  membership?: DbMembership | null;
  /** NEW (D12) — effective capabilities (matrix ∪ the D13 compensating grant). */
  capabilities?: Capability[];
  /** NEW (D12) — all of the user's active memberships (company switcher). */
  memberships?: DbMembershipSummary[];
}

// =============================================================================
// Billing shapes (BILLING-IMPL-SPEC §3.6).
//
// `PlanFeaturesConfig` is the JSONB stored in `plans.features` — a `PlanFeatures`
// stripped of its presentational `{id,name,price}` (id → `plans.id`, name →
// `plans.name`, price → `plan_prices.amount_minor`). `plans.features.$type<>()`
// binds this shape so a typo'd feature key is caught by `tsc`/`next build`.
// `PaymentPayload` is the discriminated `payments.payload` union — what a payment
// is for (a subscription plan/period, or a one-off SKU).
// =============================================================================

import type { PlanFeatures, PlanId } from "@/shared/plans";

/** `plans.features` JSONB — `PlanFeatures` without `{id,name,price}` (§3.6). */
export type PlanFeaturesConfig = Omit<PlanFeatures, "id" | "name" | "price">;

/** `payments.payload` JSONB — discriminated by `kind` (§3.6). */
export type PaymentPayload =
  // `proration:true` marks a prorated upgrade charge (T-C2). The route already
  // applied the plan change synchronously, so the webhook must NOT re-activate on
  // this payment's ORDER_COMPLETED (that would reset the period — see the route).
  | {
      kind: "subscription";
      plan: PlanId;
      period: "monthly" | "annual";
      proration?: boolean;
    }
  | { kind: "one_off"; sku: string; qty: number; description: string };
