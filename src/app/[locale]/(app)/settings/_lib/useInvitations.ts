"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/api/client";
import type { CompanyRole } from "@/shared/roles";
import { SESSION_QUERY_KEY, useSession } from "@/shared/hooks/useSession";
import { MEMBERS_QUERY_KEY } from "./useMembers";

/** react-query key for the active company's invitations (`GET /api/invitations`). */
const INVITATIONS_QUERY_KEY = ["invitations"] as const;

/**
 * One invitation row as it crosses the wire (`GET /api/invitations` →
 * `InvitationListItem`). `Date` fields are ISO strings after JSON serialisation,
 * so they are typed `string | null` here (display only, never re-parsed for logic).
 *
 * NOTE (§0.5 / §9.7): there is NO raw token / `inviteUrl` here. The list stores
 * only a hash; the raw link exists exactly once, in the POST/resend response.
 */
export interface Invitation {
  id: string;
  email: string;
  role: CompanyRole;
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
}

/**
 * The ONE-TIME issue payload — the only place the raw `inviteUrl` is ever exposed
 * (§9.7). It is returned by `POST /api/invitations` (and resend) and shown once;
 * it can NEVER be recovered from `GET /api/invitations`.
 */
export interface IssuedInvite {
  id: string;
  email: string;
  role: CompanyRole;
  expiresAt: string;
  inviteUrl: string;
}

/**
 * Why an invite action was refused, as the UI must EXPLAIN it (never a raw code):
 *  - `plan_required`  — a 402 seat/plan gate (R-5/Q1): rendered as a PRODUCT upgrade
 *    message ("team collaboration from Starter"), NOT a technical/red error;
 *  - `access_changed` — a 403/401 from session-cache drift (R-11): the server is the
 *    source of truth and the client's cached capabilities went stale;
 *  - `invalid`        — a 422: bad email, or a business refusal the route collapses
 *    into VALIDATION (already a member / suspended / a live invite already exists);
 *  - `unknown`        — anything else (transport, 500).
 */
export type InviteFailure =
  "plan_required" | "access_changed" | "invalid" | "unknown";

export type InviteIssueResult =
  { ok: true; invite: IssuedInvite } | { ok: false; reason: InviteFailure };
export type InviteActionResult =
  { ok: true } | { ok: false; reason: "access_changed" | "unknown" };

/** Raw `ActionResult`-shaped body of the invitation endpoints (read via `ok`). */
type InviteApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Map a failed issue/resend `ActionResult` to a friendly reason. */
function classifyIssueFailure(error: string | undefined): InviteFailure {
  if (error === "PLAN_REQUIRED") return "plan_required";
  if (
    error === "FORBIDDEN" ||
    error === "UNAUTHENTICATED" ||
    error === "COMPANY_NOT_FOUND"
  )
    return "access_changed";
  if (error === "VALIDATION") return "invalid";
  return "unknown";
}

interface InvitationsState {
  /** PENDING invitations only (unaccepted, unrevoked), newest first. */
  invitations: Invitation[];
  loading: boolean;
  /** The list request itself came back 403/401/no-company (drift, R-11). */
  accessChanged: boolean;
  /** The list failed for a non-access reason (transport, 500). */
  loadError: boolean;
  issue: (email: string, role: CompanyRole) => Promise<InviteIssueResult>;
  resend: (id: string) => Promise<InviteIssueResult>;
  revoke: (id: string) => Promise<InviteActionResult>;
}

/**
 * The invitations hook — the sibling of `useMembers` (`useMembers.ts:130`): a
 * react-query read of `GET /api/invitations` plus issue / resend / revoke
 * mutations. On success it invalidates the invitations query AND the session (a
 * new/removed invitation shifts `seats` usage) AND the members roster (an accepted
 * invite would show up there).
 *
 * INVARIANT (§0.1): UX only. It never decides rights — the caller gates the invite
 * controls on `useCapabilities().has('members.manage')`, and the API routes
 * enforce regardless. A stale-cache 403/401 is normal and rendered benign (R-11).
 */
export function useInvitations(): InvitationsState {
  const queryClient = useQueryClient();

  const query = useQuery<InviteApiResult<Invitation[]>>({
    queryKey: INVITATIONS_QUERY_KEY,
    queryFn: () => apiFetch<InviteApiResult<Invitation[]>>("/api/invitations"),
  });

  const body = query.data;
  const all: Invitation[] = body && body.ok ? body.data : [];
  // The list carries every invitation (accepted / revoked / pending); the admin
  // surface shows only the PENDING ones (§9.1) — the actionable set.
  const invitations = all.filter(
    (inv) => inv.acceptedAt === null && inv.revokedAt === null,
  );
  const accessChanged =
    !!body &&
    !body.ok &&
    (body.error === "FORBIDDEN" ||
      body.error === "UNAUTHENTICATED" ||
      body.error === "COMPANY_NOT_FOUND");
  const loadError = query.isError || (!!body && !body.ok && !accessChanged);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });
    // A new/removed invite counts toward the seat limit (`seats` lives in the
    // session), and an accepted invite becomes a member — refresh both.
    queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
  };

  // Issue and resend share the same one-time-URL response shape; `resend` first
  // revokes the old row server-side (§9.6) and returns a fresh raw token.
  const issueOrResend = async (
    path: string,
    init: RequestInit,
  ): Promise<InviteIssueResult> => {
    const result = await apiFetch<InviteApiResult<IssuedInvite>>(path, init);
    if (result.ok) {
      invalidate();
      return { ok: true, invite: result.data };
    }
    const reason = classifyIssueFailure(result.error);
    // A drift 403/401 means the actor's cached capabilities are stale — refetch
    // the session so the invite controls self-correct without a manual reload.
    if (reason === "access_changed") {
      queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    }
    return { ok: false, reason };
  };

  const issueMutation = useMutation({
    mutationFn: (vars: { email: string; role: CompanyRole }) =>
      issueOrResend("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ email: vars.email, role: vars.role }),
      }),
  });

  const resendMutation = useMutation({
    mutationFn: (id: string) =>
      issueOrResend(`/api/invitations/${id}/resend`, { method: "POST" }),
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string): Promise<InviteActionResult> => {
      const result = await apiFetch<InviteApiResult<{ id: string }>>(
        `/api/invitations/${id}`,
        { method: "DELETE" },
      );
      if (result.ok) {
        invalidate();
        return { ok: true };
      }
      // DELETE collapses drift and a foreign/gone id both into 403; from a list we
      // only ever hold our own ids, so a 403 here reads as session drift (R-11).
      queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      return {
        ok: false,
        reason: result.error === "FORBIDDEN" ? "access_changed" : "unknown",
      };
    },
  });

  return {
    invitations,
    loading: query.isLoading,
    accessChanged,
    loadError,
    issue: (email, role) => issueMutation.mutateAsync({ email, role }),
    resend: (id) => resendMutation.mutateAsync(id),
    revoke: (id) => revokeMutation.mutateAsync(id),
  };
}

/** Seat usage vs. the plan limit, surfaced as a session SIBLING (§10.3, T2.2). */
export interface Seats {
  used: number;
  limit: number;
  overLimit: boolean;
}

/**
 * Read the server-computed `seats` off the session. It is an additive sibling of
 * `DbSession` (`/api/session`, T2.2) not present on the shared `SessionResponse`
 * type, so it is read through a local widening here — never recomputed client-side
 * (§0.1: the seat count is the server's, this is display only). `overLimit` drives
 * the over-seat banner and is never true on an unlimited plan.
 */
export function useSeats(): Seats | null {
  const { data } = useSession();
  const seats = (data as (typeof data & { seats?: Seats }) | undefined)?.seats;
  return seats ?? null;
}
