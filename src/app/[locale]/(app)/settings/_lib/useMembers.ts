"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { apiFetch } from "@/shared/api/client";
import { ROLE_CAPABILITIES, type CompanyRole } from "@/shared/roles";
import { SESSION_QUERY_KEY } from "@/shared/hooks/useSession";

/** react-query key for the active company's member roster (`GET /api/members`). */
export const MEMBERS_QUERY_KEY = ["members"] as const;

/**
 * One member row as it crosses the wire (`GET /api/members` → `MemberListItem`).
 * `Date` fields are serialised to ISO strings by the JSON response, so they are
 * typed `string | null` here (never re-parsed on the client — display only).
 */
export interface Member {
  userId: string;
  name: string;
  email: string;
  role: CompanyRole;
  status: "active" | "suspended";
  invitedAt: string | null;
  acceptedAt: string | null;
}

/** The six roles, DERIVED from the matrix (source of truth) — never hand-listed. */
export const ALL_ROLES = Object.keys(ROLE_CAPABILITIES) as CompanyRole[];

/**
 * Localized role labels (the `roles` message namespace). Use this everywhere a
 * role is shown to the user.
 */
export function useRoleLabels(): Record<CompanyRole, string> {
  const t = useTranslations("roles");
  return {
    esg_admin: t("esg_admin"),
    data_owner: t("data_owner"),
    contributor: t("contributor"),
    reviewer: t("reviewer"),
    approver: t("approver"),
    auditor: t("auditor"),
  };
}

/**
 * Why a member mutation was refused, as the UI must EXPLAIN it (never a raw code):
 *  - `last_admin`     — would leave the company with no active admin (D9);
 *  - `access_changed` — a 403/401 from session-cache drift (R-11): the server is
 *    the source of truth and the client's cached capabilities went stale;
 *  - `unknown`        — anything else (validation, transport, 500).
 */
export type MemberActionFailure = "last_admin" | "access_changed" | "unknown";
export type MemberActionResult =
  { ok: true } | { ok: false; reason: MemberActionFailure };

/** Raw `ActionResult`-shaped body of the member endpoints (read via `ok`). */
type MemberApiResult =
  { ok: true; data: unknown } | { ok: false; error: string };

/**
 * Does this action strip the company of its LAST active admin?
 *
 * The `[userId]` route collapses `self` / `last_admin` / `not_found` all into a
 * single `FORBIDDEN` (403) — indistinguishable by error code from a stale-session
 * 403 (R-11). So the last-admin case is classified CLIENT-SIDE from the roster we
 * already hold: only when the target is the sole active `esg_admin` AND the action
 * demotes or deactivates them is a 403 read as "must keep one admin". The server
 * remains the authority — this only picks the human message, never the guard.
 */
function wouldOrphanAdmins(
  members: Member[],
  userId: string,
  next: { role?: CompanyRole; status?: "removed" },
): boolean {
  const activeAdmins = members.filter(
    (m) => m.status === "active" && m.role === "esg_admin",
  );
  const target = members.find((m) => m.userId === userId);
  if (!target || target.status !== "active" || target.role !== "esg_admin") {
    return false;
  }
  if (activeAdmins.length > 1) return false; // another admin remains
  const nextRole = next.role ?? target.role;
  const stillActive = next.status !== "removed";
  return nextRole !== "esg_admin" || !stillActive;
}

/** Map a failed `ActionResult` to a friendly reason, given the last-admin guess. */
function classifyFailure(
  error: string | undefined,
  orphansAdmins: boolean,
): MemberActionFailure {
  if (error === "FORBIDDEN")
    return orphansAdmins ? "last_admin" : "access_changed";
  if (error === "UNAUTHENTICATED") return "access_changed";
  return "unknown";
}

interface MembersState {
  members: Member[];
  loading: boolean;
  /**
   * The list request itself came back 403/401/no-company (session-cache drift,
   * R-11). The caller shows the benign "your access has changed — refresh" state,
   * NOT a crash.
   */
  accessChanged: boolean;
  /**
   * The list request failed for a NON-access reason (transport error, 500, or an
   * unexpected `ok:false`). Distinct from an empty roster: the caller shows a
   * neutral "couldn't load members" note, never "no team members yet" — a server
   * outage must not read as "you have no teammates".
   */
  loadError: boolean;
  changeRole: (
    userId: string,
    role: CompanyRole,
  ) => Promise<MemberActionResult>;
  removeMember: (userId: string) => Promise<MemberActionResult>;
}

/**
 * The members-roster hook — the role-side analogue of `usePlan` (`usePlan.ts:51`):
 * a react-query read of `GET /api/members` plus PATCH/DELETE mutations that, on
 * success, invalidate the roster AND the session (a role change can shift the
 * current user's own effective capabilities — e.g. the D13 approver grant).
 *
 * INVARIANT (§0.1): this hook is UX only. It never decides rights — the caller
 * gates the manage controls on `useCapabilities().has('members.manage')`, and the
 * API routes enforce regardless. A stale-cache 403 is normal and rendered benign.
 */
export function useMembers(): MembersState {
  const queryClient = useQueryClient();

  const query = useQuery<MemberApiResult>({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: () => apiFetch<MemberApiResult>("/api/members"),
  });

  const body = query.data;
  const members: Member[] = body && body.ok ? (body.data as Member[]) : [];
  const accessChanged =
    !!body &&
    !body.ok &&
    (body.error === "FORBIDDEN" ||
      body.error === "UNAUTHENTICATED" ||
      body.error === "COMPANY_NOT_FOUND");
  // A genuine failure to load (network throw, 500, or an unexpected `ok:false`)
  // — kept apart from `accessChanged` and from a legitimately empty roster.
  const loadError = query.isError || (!!body && !body.ok && !accessChanged);

  const invalidate = () => {
    // The roster changed; and a role change can move the current user's own
    // capabilities (D13 grant), so refetch the session too (§4 constraint).
    queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  };

  const mutation = useMutation({
    mutationFn: async (vars: {
      userId: string;
      method: "PATCH" | "DELETE";
      role?: CompanyRole;
    }): Promise<MemberActionResult> => {
      const orphansAdmins = wouldOrphanAdmins(members, vars.userId, {
        role: vars.method === "PATCH" ? vars.role : undefined,
        status: vars.method === "DELETE" ? "removed" : undefined,
      });
      const result = await apiFetch<MemberApiResult>(
        `/api/members/${vars.userId}`,
        {
          method: vars.method,
          ...(vars.method === "PATCH"
            ? { body: JSON.stringify({ role: vars.role }) }
            : {}),
        },
      );
      if (result.ok) {
        invalidate();
        return { ok: true };
      }
      const reason = classifyFailure(result.error, orphansAdmins);
      // A drift 403 means the actor's own cached capabilities are stale — refetch
      // the session so the manage controls self-correct without a manual reload.
      if (reason === "access_changed") {
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
      return { ok: false, reason };
    },
  });

  return {
    members,
    loading: query.isLoading,
    accessChanged,
    loadError,
    changeRole: (userId, role) =>
      mutation.mutateAsync({ userId, method: "PATCH", role }),
    removeMember: (userId) =>
      mutation.mutateAsync({ userId, method: "DELETE" }),
  };
}
