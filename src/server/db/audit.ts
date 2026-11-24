/**
 * Audit-trail write helper (§Q6, DATA-INTEGRITY-PLAN T2.1).
 *
 * Introduced HERE as the first consumer (the People write route); reused by the
 * remaining mutation routes (goals / supply-chain / scope3-spend / company /
 * governance / emissions save) and completed at every boundary in T4.1.
 *
 * The contract is deliberately tiny: one `audit_log` row per SUCCESSFUL mutating
 * request, written at the API boundary with the identity taken from the session
 * (PATTERN 3 — never from the request body). `summary` is a small jsonb blob
 * describing what changed (e.g. `{year, headcount, fte}`) — enough for the Data
 * Sources audit log (T4.2) without dragging the full row along.
 */
import "server-only";

import { desc, eq, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";

import type { CompanyRole } from "@/shared/roles";

import { auditLog, profiles } from "./schema";
import type * as schema from "./schema";

/** The pooled singleton `db` or a transaction handle — same contract as the other services. */
type Schema = typeof schema;
type DbClient =
  | PostgresJsDatabase<Schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      Schema,
      ExtractTablesWithRelations<Schema>
    >;

/** The entities that can appear in the audit trail (§Q6). */
type AuditEntity =
  | "monthly_emissions"
  | "scope3_spend"
  | "company"
  | "governance"
  | "people"
  | "goals"
  | "supply_chain"
  // Phase 2 (USERS-ROLES) — member/invitation management writes. Added here so the
  // type is ready before the routes land; `entity` is a free `text` column (no
  // CHECK), so this is a pure type widening with no DDL.
  | "member"
  | "invitation"
  // DATA-MODEL T2.5 — the reporting boundary (LC-10, DM-9). The entity is the
  // BOUNDARY of a period, not one `period_scope` row: it is written as a whole
  // set, so `entityId` is the period and `summary` carries the diff (added /
  // changed with before+after / removed). Same pure type widening — `entity` is
  // a free `text` column with no CHECK.
  | "period_scope"
  // DATA-MODEL T2.6 — the ONE state machine (D22, LC-10). Every transition of a
  // `report_revision`, and its creation, writes one row: `entityId` is the
  // revision and `summary` carries `{action, from, to}` plus, for the two
  // `data.approve` actions, the §11.2 self-approval disclosure. Same pure type
  // widening — `entity` is a free `text` column with no CHECK.
  | "report_revision"
  // DATA-MODEL T3.1 — the four input tables of the D23 mixin (§4.9–4.12). The
  // per-ROW audit trail is the version chain itself (LC-10), so these appear for
  // one action only: `approve`, which is where the §11.2 self-approval
  // disclosure has to be recorded and where `data.approve` finally gets its
  // first consumer (USERS-ROLES-PLAN §7 п.3). `entityId` is the APPROVED
  // version — the new one — so the trail points at the row the approval created
  // rather than at the draft it superseded. Same pure type widening.
  | "emission_activity"
  | "purchased_energy_activity"
  | "contractual_instrument"
  | "disclosure_record"
  // DATA-MODEL T5.4 — the calculation run (CALC-6). `entityId` is the REVISION
  // and `summary` carries the `run_id` with its counts: a run is append-only and
  // has no row of its own to point at, and "which revision was calculated, when,
  // by whom, and did it come out green" is the fact an auditor asks for. Only
  // `create` ever appears — a run is appended, never amended. Same pure type
  // widening as every entry above: `entity` is a free `text` column with no CHECK.
  | "calculation"
  // DATA-MODEL T5.7 — one immutable render (DM-30, REN-5). `entityId` is the
  // `report_render` row, and `summary` carries the four facts an auditor asks
  // about a published report: which format and LANGUAGE it is (О-14), which
  // calculation run it shows, what its `file_hash` is, and whether it claimed
  // full or partial coverage (D14). Only `create` ever appears — a render is
  // immutable, and re-rendering appends another row. Same pure type widening.
  | "report_render";

/** Insert of one audit row: identity + what changed. */
export interface AuditEntry {
  companyId: string;
  /** The acting user (profiles.id); null when unknown (FK → set null on delete). */
  userId: string | null;
  /**
   * The actor's company role AT THE TIME of the action (USERS-ROLES §4.6, §11.1).
   * A SNAPSHOT, not an FK: the user's role may change later, but this stays what
   * it was. Null when unknown (no active membership, or a system/cron actor).
   */
  actorRole?: CompanyRole | null;
  entity: AuditEntity;
  /** The affected row's id, when there is one. */
  entityId?: string | null;
  action: "create" | "update" | "delete";
  /** A compact, JSON-serialisable description of the mutation. */
  summary?: Record<string, unknown>;
}

/**
 * Write one `audit_log` row for a successful mutation. Best-effort by contract:
 * callers invoke it AFTER the mutation has committed its own effect, so an audit
 * failure never rolls back the user's write — but it does surface via the route's
 * `apiRoute` catch-all if the insert throws.
 */
export async function logAudit(db: DbClient, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    companyId: entry.companyId,
    userId: entry.userId,
    actorRole: entry.actorRole ?? null,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    action: entry.action,
    summary: entry.summary ?? {},
  });
}

/**
 * Context for computing the self-approval disclosure of a `data.approve` action.
 * A snapshot of the acting membership plus one fact the caller has already
 * resolved: whether the SAME `user_id` also authored the data being approved.
 */
export interface ApprovalDisclosureContext {
  /** The actor's company role at the time of the action. */
  role: CompanyRole;
  /** Count of ACTIVE memberships whose role grants `data.approve` by the matrix. */
  approversCount: number;
  /** Count of ACTIVE memberships in the company (informational). */
  activeMemberCount: number;
  /**
   * Whether the actor also authored (data.write/data.submit) the same entity.
   * NOT queried here — this function is pure; the periods layer resolves it
   * against `audit_log` in its own transaction and passes it in (§11.2).
   */
  actorAlsoAuthored: boolean;
}

/** The disclosure flags written into the audit `summary` of an approval (§11.2). */
export interface ApprovalDisclosure {
  /** Capability came from the compensating grant (D13), not the matrix. */
  approval_grant: boolean;
  /** One person both entered and approved the data. */
  self_approved: boolean;
  /** Final flag for the methodology appendix: an independent reviewer signed off. */
  independent_review: boolean;
  /** Dedicated approvers in the company (informational). */
  approvers_count: number;
  /** Active members in the company (informational). */
  active_member_count: number;
}

/**
 * USERS-ROLES-PLAN §7 — SLEEPING CAPABILITY. `data.approve` has NO consumer
 * until the periods layer lands: the approval route is deliberately deferred
 * (`saveMonthlyEmission` resets `status` to draft on every save, so approving on
 * top of the current model would be fictitious). This helper is proven by unit
 * tests so the periods layer can wire it in without a rewrite. Do NOT delete as
 * dead code — see USERS-ROLES-PLAN §7.
 *
 * Pure function — no DB access. The three flags answer DIFFERENT questions and do
 * not reduce to one another (§11.2):
 *  - `approval_grant` — company structure: `esg_admin` with no dedicated approver
 *    (`approversCount === 0`). About the ABSENCE OF THE ROLE, not head-count, so
 *    it stands even in an `esg_admin` + `contributor` company (§Q3, rejected the
 *    `activeMemberCount === 1` dead-end).
 *  - `self_approved` — this action: `approval_grant` OR the same user authored it.
 *  - `independent_review` — report conclusion: `!self_approved`.
 */
export function approvalDisclosure(
  ctx: ApprovalDisclosureContext,
): ApprovalDisclosure {
  const approval_grant = ctx.role === "esg_admin" && ctx.approversCount === 0;
  const self_approved = approval_grant || ctx.actorAlsoAuthored;
  const independent_review = !self_approved;
  return {
    approval_grant,
    self_approved,
    independent_review,
    approvers_count: ctx.approversCount,
    active_member_count: ctx.activeMemberCount,
  };
}

/** One audit-trail row as rendered on the Data Sources "Activity Log" (T4.2a). */
export interface AuditLogRow {
  id: string;
  entity: string;
  action: string;
  entityId: string | null;
  /** The actor's role snapshot at the time of the action; null for older/system rows. */
  actorRole: CompanyRole | null;
  /** The compact jsonb summary written alongside the mutation. */
  summary: Record<string, unknown>;
  createdAt: Date | null;
  /** The acting user's name/email from the joined profile; undefined when userId is null. */
  userName: string | undefined;
  userEmail: string | undefined;
}

/**
 * The most recent audit rows for ONE company, newest first (T4.2a).
 *
 * LEFT JOIN `profiles` because `auditLog.userId` is nullable (FK → set null on
 * delete): a row whose user has been removed still appears, with name/email
 * undefined. Scoped to `companyId` (tenant isolation) and capped at `limit` —
 * the route clamps `limit` to a safe range before calling.
 */
export async function listAuditLog(
  db: DbClient,
  companyId: string,
  limit: number,
): Promise<AuditLogRow[]> {
  const rows = await db
    .select({
      id: auditLog.id,
      entity: auditLog.entity,
      action: auditLog.action,
      entityId: auditLog.entityId,
      actorRole: auditLog.actorRole,
      summary: auditLog.summary,
      createdAt: auditLog.createdAt,
      userName: profiles.fullName,
      userEmail: profiles.email,
    })
    .from(auditLog)
    .leftJoin(profiles, eq(auditLog.userId, profiles.id))
    .where(eq(auditLog.companyId, companyId))
    // `id` as a stable tie-breaker: rows written within one request can share
    // `createdAt`, so ordering by timestamp alone is non-deterministic across reloads.
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    action: r.action,
    entityId: r.entityId,
    // `actor_role` is a free `text` column (no CHECK); older/system rows are null.
    actorRole: (r.actorRole as CompanyRole | null) ?? null,
    summary: (r.summary ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt,
    userName: r.userName ?? undefined,
    userEmail: r.userEmail ?? undefined,
  }));
}
