/**
 * Seats — the team-member limit resolver and its enforcement (USERS-ROLES T2.2,
 * §10, D2, Q1).
 *
 * A "seat" is a slot in the company's `maxTeamMembers` quota (`plans.ts`, §Q1:
 * `trial:1, starter:5, pro:15, enterprise:-1`). The mechanism ships now; the
 * numbers come straight from `PLAN_FEATURES` — we do not invent new ones.
 *
 * What holds a seat (§10.1) — this is the SECURITY-relevant definition:
 *
 *   seatsUsed = count(company_members  WHERE status IN ('active','suspended'))
 *             + count(company_invitations
 *                     WHERE accepted_at IS NULL AND revoked_at IS NULL
 *                       AND expires_at > now())
 *
 *   - `active`    — obviously holds a seat.
 *   - `suspended` — holds a seat DELIBERATELY (leave, investigation): otherwise
 *     "suspend → invite" is a hole straight through the limit.
 *   - `removed`   — does NOT hold a seat.
 *   - a LIVE invitation holds a seat — otherwise 100 invitations on a 5-seat plan
 *     would let 100 people in (a race on accept).
 *
 * [review T0.1] The count is `active ∪ suspended`, but the partial index
 * `company_members_active_idx` covers only `WHERE status = 'active'` — so this
 * path does NOT use it and runs a seq scan over one company's rows (tens of rows,
 * acceptable). The index is deliberately NOT widened and this query is deliberately
 * NOT narrowed to `status = 'active'` to "use" it: narrowing would UNDERCOUNT and
 * reopen the suspend→invite hole. A seat-path index, if ever needed, is a separate
 * one (`WHERE status IN ('active','suspended')`), not the T0.1 index.
 */
import "server-only";

import { and, count, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";

import { requireWithinLimit, type GuardResult } from "@/server/billing/guard";
import type { getSession } from "@/server/auth/session";
import { logAudit } from "@/server/db/audit";
import { companyInvitations, companyMembers } from "@/server/db/schema";
import type * as schema from "@/server/db/schema";
import { PLAN_FEATURES, type PlanId } from "@/shared/plans";
import type { CompanyRole } from "@/shared/roles";

/** The pooled singleton `db` or a transaction handle — same contract as the services. */
type Schema = typeof schema;
type DbClient =
  | PostgresJsDatabase<Schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      Schema,
      ExtractTablesWithRelations<Schema>
    >;

/** The (non-null) session the seat guard operates on — same shape guards use. */
type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/** Statuses of a membership that HOLD a seat (§10.1). `removed` does not. */
const SEAT_HOLDING_STATUSES = ["active", "suspended"] as const;

/**
 * How many seats a company currently uses (§10.1). `active ∪ suspended` members
 * plus every LIVE invitation (unaccepted, unrevoked, unexpired). See the module
 * header for why the count is NOT narrowed to `status = 'active'`.
 */
export async function getSeatUsage(
  db: DbClient,
  companyId: string,
  /**
   * A live invitation to EXCLUDE from the count — the one currently being accepted
   * (T2.4 review, Low #2). Accept is seat-neutral (it converts an invite into a
   * member), so counting the accepting invitation would double-count it and block
   * the final invited member from filling the last seat.
   */
  excludeInvitationId?: string,
): Promise<number> {
  const [members] = await db
    .select({ n: count() })
    .from(companyMembers)
    .where(
      and(
        eq(companyMembers.companyId, companyId),
        inArray(companyMembers.status, [...SEAT_HOLDING_STATUSES]),
      ),
    );

  const [invites] = await db
    .select({ n: count() })
    .from(companyInvitations)
    .where(
      and(
        eq(companyInvitations.companyId, companyId),
        isNull(companyInvitations.acceptedAt),
        isNull(companyInvitations.revokedAt),
        gt(companyInvitations.expiresAt, sql`now()`),
        excludeInvitationId
          ? ne(companyInvitations.id, excludeInvitationId)
          : undefined,
      ),
    );

  return (members?.n ?? 0) + (invites?.n ?? 0);
}

/**
 * Require a free seat before ADDING a member (§10.2). Reuses the existing quota
 * guard `requireWithinLimit` — it already reads `writeFeatures.maxTeamMembers`,
 * treats `-1` as unlimited, and denies with `PLAN_REQUIRED` (402). Returns the
 * SAME shape every guard returns: `null` allows, `{ok:false,error:"PLAN_REQUIRED"}`
 * denies. Call it AFTER `requireCapability('members.manage')`.
 *
 * A session with no company has no seats to gate → `null` (the caller's own
 * company/auth guard has already rejected such a request).
 */
export async function requireSeat(
  db: DbClient,
  session: Session,
  /** Forwarded to `getSeatUsage` — the invitation being accepted (T2.4 Low #2). */
  excludeInvitationId?: string,
): Promise<GuardResult> {
  const companyId = session.company?.id;
  if (!companyId) return null;
  const used = await getSeatUsage(db, companyId, excludeInvitationId);
  return requireWithinLimit(session, "maxTeamMembers", used);
}

/**
 * Revoke every LIVE (unaccepted, unrevoked) invitation for a company by stamping
 * `revoked_at = now()`. Used on a downgrade into over-seat (§10.3): the pending
 * invitations have not touched anyone yet, so they are pulled rather than left to
 * push the company further over its (now lower) limit. Returns how many were
 * revoked. The predicate omits `expires_at` on purpose — an already-expired
 * invitation costs nothing to stamp and stays consistently "not live".
 */
export async function revokePendingInvitations(
  db: DbClient,
  companyId: string,
): Promise<number> {
  const revoked = await db
    .update(companyInvitations)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(companyInvitations.companyId, companyId),
        isNull(companyInvitations.acceptedAt),
        isNull(companyInvitations.revokedAt),
      ),
    )
    .returning({ id: companyInvitations.id });
  return revoked.length;
}

/** `maxTeamMembers` for a plan, with `-1` (unlimited) mapped to `Infinity`. */
function seatLimitOf(plan: PlanId): number {
  const max = PLAN_FEATURES[plan].maxTeamMembers;
  return max === -1 ? Infinity : max;
}

/**
 * Apply the seat side-effects of a plan change at the point the change is applied
 * (§10.3) — the `POST /api/company/plan` route and the billing cron's scheduled
 * downgrade. PEOPLE ARE NEVER EVICTED: `maxTeamMembers` gates ADDING a member, not
 * their existence. Existing memberships are left EXACTLY as they are — no delete,
 * no status change. The company simply enters the visible `overLimit` state.
 *
 * Fires only when the change is a genuine seat DOWNGRADE (the new plan's seat
 * limit is lower than the old one) AND the company is now over-seat. In that case:
 *   - every live invitation is revoked (they have not been accepted yet), and
 *   - one `audit_log` row is written (`entity='company'`, `action='update'`,
 *     `summary={plan_downgrade, seats_used, seats_limit, invitations_revoked}`).
 *
 * Best-effort and additive to the money path: call it AFTER the plan write has
 * committed. `actorRole`/`userId` are `null` for a system/cron actor (no session).
 */
export async function applyPlanDowngradeSeatEffects(
  db: DbClient,
  params: {
    companyId: string;
    oldPlan: PlanId;
    newPlan: PlanId;
    actorRole: CompanyRole | null;
    userId: string | null;
  },
): Promise<void> {
  const newLimit = seatLimitOf(params.newPlan);
  // Not a seat downgrade (unlimited target, or the same/higher limit) → nothing.
  if (newLimit === Infinity || newLimit >= seatLimitOf(params.oldPlan)) return;

  const used = await getSeatUsage(db, params.companyId);
  // Downgraded but still within the new limit → no over-seat, nothing to revoke.
  if (used <= newLimit) return;

  const invitationsRevoked = await revokePendingInvitations(
    db,
    params.companyId,
  );
  await logAudit(db, {
    companyId: params.companyId,
    userId: params.userId,
    actorRole: params.actorRole,
    entity: "company",
    action: "update",
    summary: {
      plan_downgrade: true,
      seats_used: used,
      seats_limit: newLimit,
      invitations_revoked: invitationsRevoked,
    },
  });
}
