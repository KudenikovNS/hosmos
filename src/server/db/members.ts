/**
 * Membership data-access — the active-company resolver and the company-switch
 * service (USERS-ROLES T1.2a, §8.2 / D10 / R8).
 *
 * These are pure service functions in the style of `emissions.ts` / `goals.ts`:
 * they take the Drizzle client/transaction as their first argument (never the
 * `server-only` singleton), so callers pass the pooled `db` and tests exercise
 * them against the real Postgres harness (T0.2). This module is deliberately
 * introduced BEFORE any consumer — `getSession()` and the routes still resolve
 * the company the old way; T1.2b cuts the hot path over to `resolveActiveMembership`
 * once it is proven here.
 *
 * Two invariants this module owns:
 *   - D10 — the resolver is deterministic and self-healing: a stale
 *     `active_company_id` is repaired to the first active membership, once.
 *   - R8  — `switchCompany` is the SINGLE writer of BOTH profile company columns
 *     (`company_id` + `active_company_id`); the self-heal step in the resolver is
 *     the only other write, and it writes both columns identically (D11). No other
 *     code path may `UPDATE profiles SET company_id`.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";

import { APPROVER_ROLES, type CompanyRole } from "@/shared/roles";

import { companies, companyMembers, profiles, user } from "./schema";
import type * as schema from "./schema";

/**
 * The Drizzle client accepted by every service function: either the pooled
 * singleton (`db` from ./index) or a transaction handle (`tx`). Mirrors the
 * `DbClient` type in the sibling service modules so these functions stay callable
 * inside a transaction and testable against the harness.
 */
type Schema = typeof schema;
type DbClient =
  | PostgresJsDatabase<Schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      Schema,
      ExtractTablesWithRelations<Schema>
    >;

/**
 * The active membership resolved for a user (D10, step 3/4). This is the base
 * record the session layer builds on; the two derived counts
 * (`hasIndependentApprover`, `activeMemberCount`) are NOT part of the resolve —
 * they come from `countMembers` and are assembled by T1.2b in `types.ts`
 * (`DbMembership`), which this module deliberately does not touch.
 */
export interface ResolvedMembership {
  companyId: string;
  companyName: string;
  role: CompanyRole;
  status: "active";
}

/** One row of the user's active-membership list (join with `companies.name`). */
export interface MembershipSummary {
  companyId: string;
  companyName: string;
  role: CompanyRole;
}

/** Both active-member counters for a company, returned by `countMembers`. */
export interface MemberCounts {
  /** Active members whose role grants `data.approve` by the matrix (APPROVER_ROLES). */
  approvers: number;
  /** Total active members. */
  members: number;
}

// The join select shared by `resolveActiveMembership` and `switchCompany`: an
// active membership plus its company name. `role`/`status` are text columns, so
// they are narrowed to the shared unions at this persistence boundary.
const membershipColumns = {
  companyId: companyMembers.companyId,
  companyName: companies.name,
  role: companyMembers.role,
  status: companyMembers.status,
  createdAt: companyMembers.createdAt,
};

type MembershipRow = {
  companyId: string;
  companyName: string;
  role: string;
  status: string;
  createdAt: Date | null;
};

function toResolved(row: MembershipRow): ResolvedMembership {
  return {
    companyId: row.companyId,
    companyName: row.companyName,
    role: row.role as CompanyRole,
    status: "active",
  };
}

/**
 * Resolve the user's active membership — the full D10 algorithm (§8.2):
 *
 *   1. read the profile (only `active_company_id` is needed);
 *   2. load the user's ACTIVE memberships `ORDER BY created_at ASC`, joined with
 *      `companies` for the name;
 *   3. pick the membership matching `active_company_id` if present;
 *   4. otherwise pick the first active membership (self-heal) and repair the
 *      profile: `UPDATE profiles SET active_company_id=$2, company_id=$2
 *      WHERE id=$1 AND active_company_id IS DISTINCT FROM $2`. The
 *      `IS DISTINCT FROM` guard is mandatory — it stops concurrent requests from
 *      writing the row needlessly (and handles the NULL case);
 *   5. no active membership → `null` (caller renders "no company" / 404).
 *
 * Query budget (§8.3): ≤3 — profile, memberships(+company join), and the
 * conditional self-heal UPDATE. The valid-active_company_id path costs 2 (no
 * write); the heal path costs 3.
 *
 * @returns the resolved active membership, or `null` when the user has no active
 *   membership (or no profile).
 */
export async function resolveActiveMembership(
  db: DbClient,
  userId: string,
): Promise<ResolvedMembership | null> {
  // 1 — profile (only active_company_id matters for the resolve).
  const [profile] = await db
    .select({ activeCompanyId: profiles.activeCompanyId })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  if (!profile) return null;

  // 2 — active memberships, oldest first (created_at is the D10 tie-breaker).
  const memberships = await db
    .select(membershipColumns)
    .from(companyMembers)
    .innerJoin(companies, eq(companies.id, companyMembers.companyId))
    .where(
      and(
        eq(companyMembers.userId, userId),
        eq(companyMembers.status, "active"),
      ),
    )
    .orderBy(asc(companyMembers.createdAt));

  // 3/4 — matching active_company_id, else the first active membership.
  const active =
    memberships.find((m) => m.companyId === profile.activeCompanyId) ??
    memberships[0] ??
    null;
  if (!active) return null; // 5 — no active membership.

  // 4 — self-heal, ONLY when the pointer is stale. The JS guard avoids issuing
  // the write on the common (already-synced) path; the SQL `IS DISTINCT FROM`
  // guard is still mandatory for concurrency (§8.2).
  if (profile.activeCompanyId !== active.companyId) {
    await db
      .update(profiles)
      .set({
        activeCompanyId: active.companyId,
        companyId: active.companyId, // D11 — both columns, same value.
        updatedAt: new Date(),
      })
      .where(
        sql`${profiles.id} = ${userId} AND ${profiles.activeCompanyId} IS DISTINCT FROM ${active.companyId}`,
      );
  }

  return toResolved(active);
}

/**
 * Count a company's active members in ONE aggregate query (§8.2 step 7):
 *
 *   SELECT count(*) FILTER (WHERE role = ANY($2)) AS approvers,
 *          count(*)                               AS members
 *   FROM company_members WHERE company_id = $1 AND status = 'active'
 *
 * `$2` is `APPROVER_ROLES` from `@/shared/roles` (DERIVED from the capability
 * matrix, never a hand-listed literal): a future role that gains `data.approve`
 * is counted automatically. `count(*)` returns NUMERIC (a string over the wire),
 * so both values are coerced to `number`.
 */
export async function countMembers(
  db: DbClient,
  companyId: string,
): Promise<MemberCounts> {
  // Build `ARRAY[$a, $b, …]::text[]` from scalar params — passing the JS array as
  // one bind is mis-encoded by the driver ("malformed array literal").
  const approverRoles = sql.join(
    APPROVER_ROLES.map((r) => sql`${r}`),
    sql`, `,
  );
  const rows = await db.execute<{ approvers: string; members: string }>(
    sql`SELECT count(*) FILTER (WHERE role = ANY(ARRAY[${approverRoles}]::text[])) AS approvers,
               count(*) AS members
        FROM company_members
        WHERE company_id = ${companyId} AND status = 'active'`,
  );
  const row = rows[0];
  return { approvers: Number(row.approvers), members: Number(row.members) };
}

/**
 * List the user's active memberships as `MembershipSummary[]` (join with
 * `companies.name`), oldest first — the company-switcher menu (§4.5).
 */
export async function listMemberships(
  db: DbClient,
  userId: string,
): Promise<MembershipSummary[]> {
  const rows = await db
    .select({
      companyId: companyMembers.companyId,
      companyName: companies.name,
      role: companyMembers.role,
    })
    .from(companyMembers)
    .innerJoin(companies, eq(companies.id, companyMembers.companyId))
    .where(
      and(
        eq(companyMembers.userId, userId),
        eq(companyMembers.status, "active"),
      ),
    )
    .orderBy(asc(companyMembers.createdAt));

  return rows.map((r) => ({
    companyId: r.companyId,
    companyName: r.companyName,
    role: r.role as CompanyRole,
  }));
}

/**
 * Switch the user's active company — the SINGLE writer of both profile company
 * columns (R8). Verifies the user has an ACTIVE membership in `companyId`; on
 * success writes BOTH `company_id` and `active_company_id` (D11) and returns the
 * now-active membership. On failure (no such active membership) it returns `null`
 * and writes nothing — it does NOT throw, so callers translate `null` into a
 * 403/404 of their choosing.
 *
 * @returns the resolved active membership on success, or `null` when the user has
 *   no active membership in `companyId` (the refusal form).
 */
export async function switchCompany(
  db: DbClient,
  userId: string,
  companyId: string,
): Promise<ResolvedMembership | null> {
  const [membership] = await db
    .select(membershipColumns)
    .from(companyMembers)
    .innerJoin(companies, eq(companies.id, companyMembers.companyId))
    .where(
      and(
        eq(companyMembers.userId, userId),
        eq(companyMembers.companyId, companyId),
        eq(companyMembers.status, "active"),
      ),
    )
    .limit(1);
  if (!membership) return null; // refusal: no active membership in that company.

  await db
    .update(profiles)
    .set({
      activeCompanyId: companyId,
      companyId, // D11 — both columns, same value.
      updatedAt: new Date(),
    })
    .where(eq(profiles.id, userId));

  return toResolved(membership);
}

// =============================================================================
// Member management (USERS-ROLES T2.1, §13.3 / D9 / §4.3) — the People admin
// surface: list a company's members and change a member's role/status, with the
// last-admin guard (D9) enforced in a transaction.
// =============================================================================

/** The three membership statuses (mirrors `company_members_status_check`, §4.3). */
export type MemberStatus = "active" | "suspended" | "removed";

/**
 * One row of the company members list (§13.3). `active`+`suspended` only —
 * `removed` reads as "not a member" (§4.3). `name`/`email` come from the joined
 * `user` identity row (both NOT NULL), scoped strictly to `companyId`.
 */
export interface MemberListItem {
  userId: string;
  name: string;
  email: string;
  role: CompanyRole;
  status: "active" | "suspended";
  invitedAt: Date | null;
  acceptedAt: Date | null;
}

/**
 * The updated membership returned on a successful mutation — enough for the audit
 * summary at the route boundary.
 */
interface MemberMutation {
  userId: string;
  role: CompanyRole;
  status: MemberStatus;
}

/**
 * Result of a member mutation — a discriminated union so the route can map a
 * business refusal to the right HTTP code WITHOUT the service throwing:
 *   - `self`       — actor targeting their own membership (§13.3, 403);
 *   - `last_admin` — would leave the company with zero active `esg_admin` (D9, 403);
 *   - `not_found`  — no such membership in THIS company (cross-tenant / gone, 403);
 *   - `{ ok:true }`— applied, carries the updated membership.
 */
export type MemberMutationResult =
  | { ok: true; membership: MemberMutation }
  | { ok: false; reason: "self" | "last_admin" | "not_found" };

/**
 * List a company's members for the People admin surface (§13.3): `active` and
 * `suspended` only, oldest first, strictly scoped to `companyId` (tenant
 * isolation — the caller passes `session.company.id`, NEVER a request value).
 * Joins `user` for the display name/email.
 */
export async function listCompanyMembers(
  db: DbClient,
  companyId: string,
): Promise<MemberListItem[]> {
  const rows = await db
    .select({
      userId: companyMembers.userId,
      name: user.name,
      email: user.email,
      role: companyMembers.role,
      status: companyMembers.status,
      invitedAt: companyMembers.invitedAt,
      acceptedAt: companyMembers.acceptedAt,
    })
    .from(companyMembers)
    .innerJoin(user, eq(user.id, companyMembers.userId))
    .where(
      and(
        eq(companyMembers.companyId, companyId),
        inArray(companyMembers.status, ["active", "suspended"]),
      ),
    )
    .orderBy(asc(companyMembers.createdAt));

  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    email: r.email,
    role: r.role as CompanyRole,
    status: r.status as "active" | "suspended",
    invitedAt: r.invitedAt,
    acceptedAt: r.acceptedAt,
  }));
}

/**
 * Change a member's role and/or status, enforcing the last-admin guard (D9) in a
 * transaction. Used by BOTH `PATCH` (role/status) and `DELETE` (soft removal,
 * `status='removed'`) so the guard lives in exactly one place.
 *
 * D9 (§13.3, §10) — the last active `esg_admin` cannot be demoted, suspended or
 * removed, or the company would be locked out of member management (R2). The
 * check runs INSIDE the transaction over `SELECT … FOR UPDATE` of the company's
 * membership rows: locking them serialises two concurrent requests so they cannot
 * each strip one of the last two admins simultaneously. The refusal is a business
 * outcome (`{ok:false, reason:'last_admin'}`), NOT a throw — the route turns it
 * into 403 FORBIDDEN (an access rule, not a validation error).
 *
 * The self-guard (§13.3) is a pure identity check — an admin may not change their
 * own role/status — and short-circuits before any DB work. A target that is not a
 * member of `companyId` returns `not_found` (the route maps it to 403, never
 * leaking another tenant's row). `status='removed'` stamps `removed_at` (§4.3).
 */
export async function updateMembership(
  db: DbClient,
  params: {
    companyId: string;
    actorUserId: string;
    targetUserId: string;
    role?: CompanyRole;
    status?: MemberStatus;
  },
): Promise<MemberMutationResult> {
  const { companyId, actorUserId, targetUserId, role, status } = params;

  // Self-guard (§13.3): an admin cannot demote/suspend/remove themselves. Pure
  // identity comparison — no need to open a transaction for it.
  if (targetUserId === actorUserId) return { ok: false, reason: "self" };

  return db.transaction(async (tx) => {
    // Lock the company's membership rows (D9, §10). FOR UPDATE serialises the
    // admin-count check with the write, so concurrent requests cannot each remove
    // one of the last two active admins at the same time.
    const rows = await tx
      .select({
        userId: companyMembers.userId,
        role: companyMembers.role,
        status: companyMembers.status,
      })
      .from(companyMembers)
      .where(eq(companyMembers.companyId, companyId))
      .for("update");

    const target = rows.find((r) => r.userId === targetUserId);
    if (!target) return { ok: false, reason: "not_found" };

    const resultRole = (role ?? target.role) as CompanyRole;
    const resultStatus = (status ?? target.status) as MemberStatus;

    const targetIsActiveAdmin =
      target.status === "active" && target.role === "esg_admin";
    const targetRemainsActiveAdmin =
      resultStatus === "active" && resultRole === "esg_admin";
    const otherActiveAdmins = rows.filter(
      (r) =>
        r.userId !== targetUserId &&
        r.status === "active" &&
        r.role === "esg_admin",
    ).length;

    // D9: refuse when this change would drop the company's active-admin count to
    // zero — i.e. the target IS the last active admin and stops being one.
    if (
      targetIsActiveAdmin &&
      !targetRemainsActiveAdmin &&
      otherActiveAdmins === 0
    ) {
      return { ok: false, reason: "last_admin" };
    }

    const now = new Date();
    const [updated] = await tx
      .update(companyMembers)
      .set({
        ...(role ? { role } : {}),
        ...(status ? { status } : {}),
        // §4.3 — removal stamps removed_at; the row is kept (soft delete).
        ...(resultStatus === "removed" ? { removedAt: now } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(companyMembers.companyId, companyId),
          eq(companyMembers.userId, targetUserId),
        ),
      )
      .returning({
        userId: companyMembers.userId,
        role: companyMembers.role,
        status: companyMembers.status,
      });

    return {
      ok: true,
      membership: {
        userId: updated.userId,
        role: updated.role as CompanyRole,
        status: updated.status as MemberStatus,
      },
    };
  });
}
