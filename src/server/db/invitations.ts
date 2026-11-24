/**
 * Invitation data-access — issuing, listing, revoking and re-sending company
 * invitations (USERS-ROLES T2.3, §9.1–9.7 / D7 / D8 / §4.4).
 *
 * Pure service functions in the style of `members.ts`: they take the Drizzle
 * client/transaction as their first argument, so routes pass the pooled `db` and
 * tests exercise them against the real Postgres harness (T0.2).
 *
 * Two secrets invariants this module owns (§0.5 / §9.2):
 *   - the raw single-use token exists EXACTLY ONCE — it is generated here,
 *     returned to the caller (which shows it once and mails it) and NEVER
 *     persisted or logged. Only `token_hash = sha256(raw)` (hex) lives in the DB.
 *   - the partial unique index `company_invitations_pending_key` allows ONE live
 *     (unaccepted, unrevoked) invitation per `(company, email)`. A second issue on
 *     a live pair is a 23505 unique violation, surfaced as a business refusal
 *     (`duplicate`) — the route maps it to 422, never a 500. Re-inviting therefore
 *     revokes the old row first (`resendInvitation`), sidestepping the index (§9.6).
 */
import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";

import type { CompanyRole } from "@/shared/roles";

import { logAudit } from "./audit";
import { switchCompany } from "./members";
import {
  companies,
  companyInvitations,
  companyMembers,
  profiles,
  user,
} from "./schema";
import type * as schema from "./schema";
import type { DbCompany } from "./types";

/** The pooled singleton `db` or a transaction handle — same contract as the services. */
type Schema = typeof schema;
type DbClient =
  | PostgresJsDatabase<Schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      Schema,
      ExtractTablesWithRelations<Schema>
    >;

/**
 * One invitation row as exposed to callers — WITHOUT `token_hash` (§0.5). The raw
 * token is NEVER here; it travels only in `rawToken` out of the creating functions.
 */
export interface InvitationListItem {
  id: string;
  email: string;
  role: CompanyRole;
  invitedBy: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date | null;
}

/**
 * The safe column set for every read/return of an invitation: everything EXCEPT
 * `token_hash`. Reused so no code path can accidentally select the hash.
 */
const invitationColumns = {
  id: companyInvitations.id,
  email: companyInvitations.email,
  role: companyInvitations.role,
  invitedBy: companyInvitations.invitedBy,
  expiresAt: companyInvitations.expiresAt,
  acceptedAt: companyInvitations.acceptedAt,
  revokedAt: companyInvitations.revokedAt,
  createdAt: companyInvitations.createdAt,
};

type InvitationColumnRow = {
  id: string;
  email: string;
  role: string;
  invitedBy: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date | null;
};

function toItem(row: InvitationColumnRow): InvitationListItem {
  return { ...row, role: row.role as CompanyRole };
}

/**
 * Result of issuing an invitation — a discriminated union so the route maps a
 * business refusal to 422 WITHOUT the service throwing:
 *   - `already_member` — the email is an ACTIVE member of the company (§9.6);
 *   - `suspended`      — the email is a SUSPENDED member (un-suspend, don't invite);
 *   - `duplicate`      — a live invitation already exists for `(company, email)`;
 *   - `{ ok:true, … }` — created, carries the safe row and the ONE-TIME raw token.
 */
export type IssueInvitationResult =
  | { ok: true; row: InvitationListItem; rawToken: string }
  | { ok: false; reason: "already_member" | "suspended" | "duplicate" };

/** Normalise an email exactly as it is stored (§4.4): `lower(trim(email))`. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * True for a Postgres unique-violation (SQLSTATE 23505) — the partial index
 * `company_invitations_pending_key` firing on a second live invitation (§4.4).
 * drizzle (0.45) wraps driver errors in a `DrizzleQueryError`, so the original
 * `PostgresError` (which carries `.code`) is reached via the `.cause` chain.
 */
function isUniqueViolation(e: unknown): boolean {
  for (
    let err: unknown = e;
    err != null;
    err = (err as { cause?: unknown }).cause
  ) {
    if (
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Generate a token and INSERT one invitation row, returning the safe row and the
 * raw token. The raw token (`base64url(randomBytes(32))`, 256 bits, §9.2) exists
 * only here and in the return value; the DB stores ONLY `sha256(raw)` hex (D7).
 * `expires_at = now() + 7 days` (D8). A 23505 on the partial index bubbles up so
 * the callers can turn it into a `duplicate` refusal.
 */
async function insertInvitationRow(
  db: DbClient,
  params: {
    companyId: string;
    email: string;
    role: CompanyRole;
    invitedBy: string | null;
  },
): Promise<{ row: InvitationListItem; rawToken: string }> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  const [row] = await db
    .insert(companyInvitations)
    .values({
      companyId: params.companyId,
      email: params.email,
      role: params.role,
      tokenHash,
      invitedBy: params.invitedBy,
      expiresAt: sql`now() + interval '7 days'`,
    })
    .returning(invitationColumns);

  return { row: toItem(row), rawToken };
}

/**
 * Look up whether `email` (normalised) already HOLDS a membership seat in the
 * company — an `active` or `suspended` member (§9.6). `removed` / no membership
 * return `undefined` (an invitation is allowed). Joins `user` for the email; the
 * comparison is on `lower(user.email)` so a differently-cased identity still matches.
 */
async function findSeatHoldingStatus(
  db: DbClient,
  companyId: string,
  email: string,
): Promise<"active" | "suspended" | undefined> {
  const [row] = await db
    .select({ status: companyMembers.status })
    .from(companyMembers)
    .innerJoin(user, eq(user.id, companyMembers.userId))
    .where(
      and(
        eq(companyMembers.companyId, companyId),
        inArray(companyMembers.status, ["active", "suspended"]),
        sql`lower(${user.email}) = ${email}`,
      ),
    )
    .limit(1);
  return row?.status as "active" | "suspended" | undefined;
}

/**
 * Issue an invitation for `email` to join `companyId` as `role` (§9.1). Validates
 * the membership state first (active/suspended → refusal), then creates the row.
 * A live-invitation collision on the partial index is caught and returned as a
 * `duplicate` refusal (§9.6). Returns the raw token EXACTLY ONCE for the caller to
 * mail + show; it is never persisted.
 */
export async function issueInvitation(
  db: DbClient,
  params: {
    companyId: string;
    email: string;
    role: CompanyRole;
    invitedBy: string | null;
  },
): Promise<IssueInvitationResult> {
  const email = normalizeEmail(params.email);

  const seatStatus = await findSeatHoldingStatus(db, params.companyId, email);
  if (seatStatus === "active") return { ok: false, reason: "already_member" };
  if (seatStatus === "suspended") return { ok: false, reason: "suspended" };

  try {
    const created = await insertInvitationRow(db, {
      companyId: params.companyId,
      email,
      role: params.role,
      invitedBy: params.invitedBy,
    });
    return { ok: true, row: created.row, rawToken: created.rawToken };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

/**
 * List a company's invitations for the admin surface (§9.1), newest first, WITHOUT
 * `token_hash` (§0.5). Strictly scoped to `companyId` (tenant isolation — the
 * caller passes `session.company.id`, NEVER a request value).
 */
export async function listInvitations(
  db: DbClient,
  companyId: string,
): Promise<InvitationListItem[]> {
  const rows = await db
    .select(invitationColumns)
    .from(companyInvitations)
    .where(eq(companyInvitations.companyId, companyId))
    .orderBy(desc(companyInvitations.createdAt));
  return rows.map(toItem);
}

/**
 * Revoke an invitation by stamping `revoked_at = now()` (§9.1). Strictly scoped to
 * `companyId`: a foreign or non-existent id matches no row and returns `false`, so
 * the route answers 403 (never touching, nor leaking, another tenant's row).
 * Returns whether a row of THIS company was revoked.
 */
export async function revokeInvitation(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<boolean> {
  const revoked = await db
    .update(companyInvitations)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(companyInvitations.id, id),
        eq(companyInvitations.companyId, companyId),
      ),
    )
    .returning({ id: companyInvitations.id });
  return revoked.length > 0;
}

/**
 * Result of a resend — `not_found` when the id is not this company's invitation
 * (route → 403), else the freshly-created row and its one-time raw token.
 */
export type ResendInvitationResult =
  | { ok: true; row: InvitationListItem; rawToken: string }
  | { ok: false; reason: "not_found" | "duplicate" };

/**
 * Re-send an invitation (§9.6): in ONE transaction, revoke the existing row then
 * create a NEW one for the same `(email, role)`. Revoking first frees the partial
 * unique index (`company_invitations_pending_key`) so the insert cannot collide.
 * The OLD raw token is now unusable (its row is revoked); a brand-new token is
 * returned. Scoped to `companyId` — a foreign/gone id is `not_found`.
 *
 * A concurrent resend/issue for the same `(company,email)` can still make the
 * insert hit the partial unique index. The 23505 is caught OUTSIDE the
 * transaction so it rolls back whole — the original invitation stays live (never
 * revoked-without-replacement) — and surfaces as a clean `duplicate` refusal
 * instead of a 500 (T2.3 security review, Low #1).
 */
export async function resendInvitation(
  db: DbClient,
  companyId: string,
  id: string,
  invitedBy: string | null,
): Promise<ResendInvitationResult> {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          email: companyInvitations.email,
          role: companyInvitations.role,
        })
        .from(companyInvitations)
        .where(
          and(
            eq(companyInvitations.id, id),
            eq(companyInvitations.companyId, companyId),
          ),
        )
        .limit(1);
      if (!existing) return { ok: false, reason: "not_found" };

      // Revoke the old row FIRST so it leaves the partial unique index, then insert
      // a fresh live invitation for the same recipient (§9.6). The revoke is
      // double-scoped by `companyId` too (defence in depth — the SELECT already
      // authorised the row, but the mutation should not rely on that alone; T2.3
      // review Low #2).
      await tx
        .update(companyInvitations)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(companyInvitations.id, id),
            eq(companyInvitations.companyId, companyId),
          ),
        );

      const created = await insertInvitationRow(tx, {
        companyId,
        email: existing.email,
        role: existing.role as CompanyRole,
        invitedBy,
      });
      return { ok: true, row: created.row, rawToken: created.rawToken };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

/**
 * Build the one-time invitation link `<app>/invite/<raw>` (§9.2). The raw token is
 * embedded here and travels to the recipient's mailbox and the one-time API
 * response ONLY. `BETTER_AUTH_URL` is the app origin (as used elsewhere); when it
 * is unset the link degrades to a relative `/invite/<raw>` rather than breaking.
 */
export function buildInviteUrl(rawToken: string): string {
  const base = process.env.BETTER_AUTH_URL ?? "";
  return `${base}/invite/${rawToken}`;
}

// =============================================================================
// Accepting an invitation (USERS-ROLES T2.4, §9.1 / §9.4 / §9.5 / Q4 / D8).
// The public preview and the transactional accept. A "live" invitation is one
// that is UNACCEPTED, UNREVOKED and UNEXPIRED — the single predicate below.
// =============================================================================

/** `accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()` — a usable invite. */
const liveInvitation = (tokenHash: string) =>
  and(
    eq(companyInvitations.tokenHash, tokenHash),
    isNull(companyInvitations.acceptedAt),
    isNull(companyInvitations.revokedAt),
    gt(companyInvitations.expiresAt, sql`now()`),
  );

/**
 * The EXACTLY-four public fields shown before acceptance (§9.4 / §0.6). NOTHING
 * else — no `companyId`, no `invitationId`, no inviter email, no member list, no
 * plan. A leaked token must not become a reconnaissance oracle about a company.
 */
export interface InvitationPreview {
  companyName: string;
  role: CompanyRole;
  invitedByName: string | null;
  expiresAt: Date;
}

/**
 * Public preview of a LIVE invitation by its token hash (§9.4). Returns the four
 * safe fields, or `null` for ANY unusable token (missing / expired / accepted /
 * revoked) — the route maps `null` to the SAME opaque 422 in every case (§9.5),
 * so the difference is visible only in the server log. LEFT JOIN `user` for the
 * inviter's display name (null when the inviter row is gone / `invited_by` NULL).
 */
export async function previewInvitation(
  db: DbClient,
  tokenHash: string,
): Promise<InvitationPreview | null> {
  const [row] = await db
    .select({
      companyName: companies.name,
      role: companyInvitations.role,
      invitedByName: user.name,
      expiresAt: companyInvitations.expiresAt,
    })
    .from(companyInvitations)
    .innerJoin(companies, eq(companies.id, companyInvitations.companyId))
    .leftJoin(user, eq(user.id, companyInvitations.invitedBy))
    .where(liveInvitation(tokenHash))
    .limit(1);
  if (!row) return null;
  return {
    companyName: row.companyName,
    role: row.role as CompanyRole,
    invitedByName: row.invitedByName ?? null,
    expiresAt: row.expiresAt,
  };
}

// The `companies` projection matching `DbCompany` (mirrors `resolveSessionContext`
// in `session.ts`) — needed to build the seat-check session for the INVITATION's
// company, whose plan/id the seat guard reads.
const companyColumns = {
  id: companies.id,
  name: companies.name,
  industry: companies.industry,
  nace_code: companies.naceCode,
  country: companies.country,
  country_code: companies.countryCode,
  headcount: companies.headcount,
  plan: companies.plan,
  reporting_year: companies.reportingYear,
  currency: companies.currency,
};

/**
 * The internal context an accept needs: the invitation identity plus the FULL
 * `DbCompany` of the invitation's company (so `requireSeat` can be re-run against
 * THAT company, not the accepter's current one — §10.2). Never exposed to the
 * public preview surface.
 */
export interface AcceptInvitationContext {
  invitationId: string;
  role: CompanyRole;
  invitedEmail: string;
  invitedBy: string | null;
  company: DbCompany;
}

/**
 * Look up a LIVE invitation for acceptance by token hash, joined to its company
 * (§9.1). Same liveness predicate as the preview; `null` for any unusable token
 * (the route answers the opaque 422, §9.5). This is the read the route does
 * BEFORE the seat gate — the authoritative one-time guard is the conditional
 * UPDATE inside `acceptInvitation`.
 */
export async function findLiveInvitationForAccept(
  db: DbClient,
  tokenHash: string,
): Promise<AcceptInvitationContext | null> {
  const [row] = await db
    .select({
      invitationId: companyInvitations.id,
      role: companyInvitations.role,
      invitedEmail: companyInvitations.email,
      invitedBy: companyInvitations.invitedBy,
      company: companyColumns,
    })
    .from(companyInvitations)
    .innerJoin(companies, eq(companies.id, companyInvitations.companyId))
    .where(liveInvitation(tokenHash))
    .limit(1);
  if (!row) return null;
  return {
    invitationId: row.invitationId,
    role: row.role as CompanyRole,
    invitedEmail: row.invitedEmail,
    invitedBy: row.invitedBy,
    // `plan` is NOT NULL by default in the schema; keep the DbCompany guarantee.
    company: { ...row.company, plan: row.company.plan ?? "trial" },
  };
}

/**
 * Result of accepting: the joined company/role on success, or a single opaque
 * `invalid` — returned when a CONCURRENT accept won the one-time race (the
 * conditional UPDATE claimed zero rows). The route maps `invalid` to the SAME
 * 422 an unusable token gets (§9.5).
 */
export type AcceptInvitationResult =
  | { ok: true; companyId: string; role: CompanyRole; membershipId: string }
  | { ok: false; reason: "invalid" };

/** Thrown to roll the accept transaction back when the one-time claim loses the race. */
class InvitationRaceError extends Error {}

/**
 * Accept an invitation in ONE transaction (§9.1, Q4, D11). Ordered so the DB —
 * not the application — enforces single use:
 *
 *   1. CONDITIONAL UPDATE `SET accepted_at=now(), accepted_by=$u WHERE id=$1 AND
 *      accepted_at IS NULL RETURNING id` — a double-click / two concurrent accepts
 *      race here; exactly ONE flips the row. Zero rows back ⇒ the other one won ⇒
 *      throw to roll the whole transaction back (no membership, no audit).
 *   2. Q4 — `INSERT INTO profiles … ON CONFLICT DO NOTHING` for the accepter, so
 *      the `audit_log.user_id → profiles.id` FK below cannot fail for a user whose
 *      profile was never created.
 *   3. UPSERT `company_members` on `(company_id, user_id)` — REVIVES a `removed`
 *      row (→ `active`, new role, `removed_at=NULL`) or inserts a fresh one; the
 *      UNIQUE constraint guarantees ONE membership even under a double-click.
 *   4. `switchCompany` — the R8 single-writer of both profile company columns —
 *      points the accepter's active company at the invitation's company.
 *   5. `audit_log(entity='member', action='create')` with the NEW role snapshot
 *      and BOTH emails, so an accept whose account email differs from the invited
 *      email is RECORDED, not rejected (§9.6).
 */
export async function acceptInvitation(
  db: DbClient,
  params: {
    context: AcceptInvitationContext;
    userId: string;
    userEmail: string;
  },
): Promise<AcceptInvitationResult> {
  const { context, userId, userEmail } = params;
  const companyId = context.company.id;

  try {
    return await db.transaction(async (tx) => {
      // 1 — one-time claim, closed by the DB (§9.2). Loser rolls back (throw).
      const claimed = await tx
        .update(companyInvitations)
        .set({ acceptedAt: sql`now()`, acceptedBy: userId })
        .where(
          and(
            eq(companyInvitations.id, context.invitationId),
            isNull(companyInvitations.acceptedAt),
          ),
        )
        .returning({ id: companyInvitations.id });
      if (claimed.length === 0) throw new InvitationRaceError();

      // 2 — Q4: guarantee the accepter has a profile (audit FK target).
      await tx
        .insert(profiles)
        .values({ id: userId, email: userEmail })
        .onConflictDoNothing({ target: profiles.id });

      // 3 — membership: create, or revive a `removed` row (§9.6). An already
      // active/suspended member is NOT re-roled by accept (T2.4 review, Medium #2):
      // accept must not be a second, unguarded writer of role/status. Overwriting
      // would let (a) the sole active admin accept a lower-role invite to their own
      // company and drop active admins to zero (the D9 invariant the member-mgmt
      // path enforces), and (b) an existing member self-promote via an alias-
      // addressed invite. Role/status changes go ONLY through the D9-guarded
      // `PATCH /api/members` path. The token is still spent (step 1). Row locked
      // FOR UPDATE so a concurrent accept can't race the branch.
      const now = new Date();
      const [existing] = await tx
        .select({
          id: companyMembers.id,
          status: companyMembers.status,
          role: companyMembers.role,
        })
        .from(companyMembers)
        .where(
          and(
            eq(companyMembers.companyId, companyId),
            eq(companyMembers.userId, userId),
          ),
        )
        .for("update");

      let membershipId: string;
      let effectiveRole: CompanyRole;
      if (!existing) {
        const [m] = await tx
          .insert(companyMembers)
          .values({
            companyId,
            userId,
            role: context.role,
            status: "active",
            invitedBy: context.invitedBy,
            invitedAt: now,
            acceptedAt: now,
          })
          .returning({ id: companyMembers.id });
        membershipId = m.id;
        effectiveRole = context.role;
      } else if (existing.status === "removed") {
        await tx
          .update(companyMembers)
          .set({
            role: context.role,
            status: "active",
            invitedBy: context.invitedBy,
            invitedAt: now,
            acceptedAt: now,
            removedAt: null,
            updatedAt: now,
          })
          .where(eq(companyMembers.id, existing.id));
        membershipId = existing.id;
        effectiveRole = context.role;
      } else {
        // Already active/suspended — leave role and status untouched.
        membershipId = existing.id;
        effectiveRole = existing.role as CompanyRole;
      }
      const membership = { id: membershipId };

      // 4 — active company = the invitation's company (R8 single writer, D11).
      await switchCompany(tx, userId, companyId);

      // 5 — audit: the EFFECTIVE role (unchanged for an existing member, Medium #2)
      // + email divergence, recorded not blocked (§9.6). `invited_role` is kept when
      // it differs from the effective role, so a no-op re-role attempt is visible.
      await logAudit(tx, {
        companyId,
        userId,
        actorRole: effectiveRole,
        entity: "member",
        entityId: membership.id,
        action: "create",
        summary: {
          invited_email: context.invitedEmail,
          accepted_email: userEmail,
          ...(effectiveRole !== context.role
            ? { invited_role: context.role, role_unchanged: true }
            : {}),
        },
      });

      return {
        ok: true,
        companyId,
        role: effectiveRole,
        membershipId: membership.id,
      };
    });
  } catch (e) {
    if (e instanceof InvitationRaceError)
      return { ok: false, reason: "invalid" };
    throw e;
  }
}
