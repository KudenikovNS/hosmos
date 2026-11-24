/**
 * getSession() on Drizzle + better-auth (PG-IMPL-SPEC §1.2 — task T-11; extended
 * by USERS-ROLES T1.2b, §8.1/§8.2, D12).
 *
 * Server-only replacement for the Supabase `queries/session.ts` getSession. The
 * original `DbSession {userId,email,name,company}` shape is preserved 1:1 —
 * `useSession`, `getServerSession` and every action consume it, so consumers must
 * not observe any difference in those fields:
 *   - `email`/`name` come straight from the better-auth `user` (name is set from
 *     `user.name`, mirroring how the old code derived a display name), and
 *   - `company` is the active company, projected to the exact `DbCompany` field
 *     set (snake_case) the old `.from("companies").select("*")` cast to.
 *
 * T1.2b changes ONLY the SOURCE of the active company — from `profiles.company_id`
 * to the D10 resolver (`resolveActiveMembership`) — and ADDS three optional
 * fields (`membership`/`capabilities`/`memberships`). Because the T0.1 backfill
 * set `active_company_id = company_id`, the resolver returns the SAME company the
 * old code did, so `company` is byte-for-byte unchanged for every existing user.
 *
 * The `DbSession`/`DbCompany` types live in `@/server/db/types` (the single
 * source of truth for the shape after the Supabase query layer was removed).
 */
import "server-only";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";

import { auth } from "@/server/auth";
import { db } from "@/server/db";
import {
  countMembers,
  listMemberships,
  resolveActiveMembership,
} from "@/server/db/members";
import { companies } from "@/server/db/schema";
import type {
  DbMembership,
  DbMembershipSummary,
  DbSession,
} from "@/server/db/types";
import { effectiveCapabilities, type Capability } from "@/shared/roles";

/** The Drizzle client accepted by the resolver helpers (pooled `db` or a `tx`). */
type DbClient = Parameters<typeof resolveActiveMembership>[0];

/** The active-company-derived fields of a session (everything except identity). */
interface SessionContext {
  company: DbSession["company"];
  membership: DbMembership | null;
  capabilities: Capability[];
  memberships: DbMembershipSummary[];
}

/**
 * Resolve the active-company context for a user — the T1.2b enrichment (§8.2).
 * Exported (and client-parameterised) so it is exercised directly against the
 * integration harness; `getSession` calls it with the pooled `db` singleton.
 *
 * No active membership → `{company:null, membership:null, capabilities:[],
 * memberships:[]}` (a brand-new user, or one excluded from every company).
 *
 * Query budget: `resolveActiveMembership` (2, or 3 on the rare self-heal write) +
 * `listMemberships` (1) + the company projection (1) + `countMembers` (1) — a
 * CONSTANT 5 (6 on heal), never N+1 in the member count.
 */
export async function resolveSessionContext(
  client: DbClient,
  userId: string,
): Promise<SessionContext> {
  const memberships = await listMemberships(client, userId);

  const active = await resolveActiveMembership(client, userId);
  if (!active) {
    return { company: null, membership: null, capabilities: [], memberships };
  }

  const [row] = await client
    .select({
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
    })
    .from(companies)
    .where(eq(companies.id, active.companyId))
    .limit(1);
  // `plan` has a NOT-NULL default ('trial') in the schema and the old DbCompany
  // contract types it as a non-null string; keep that guarantee.
  const company = row ? { ...row, plan: row.plan ?? "trial" } : null;

  const { approvers, members } = await countMembers(client, active.companyId);
  const membership: DbMembership = {
    companyId: active.companyId,
    role: active.role,
    status: "active",
    hasIndependentApprover: approvers > 0,
    activeMemberCount: members,
  };
  const capabilities = effectiveCapabilities(active.role, approvers);

  return { company, membership, capabilities, memberships };
}

export async function getSession(): Promise<DbSession | null> {
  const s = await auth.api.getSession({ headers: await headers() });
  if (!s) return null;

  const { id: userId, email, name } = s.user;
  const { company, membership, capabilities, memberships } =
    await resolveSessionContext(db, userId);

  return {
    userId,
    email,
    name,
    company,
    membership,
    capabilities,
    memberships,
  };
}
