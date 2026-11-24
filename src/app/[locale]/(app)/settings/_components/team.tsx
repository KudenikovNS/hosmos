"use client";
import { clsx } from "clsx";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useState } from "react";
import { Button } from "@/shared/ui/Button";
import { Badge } from "@/shared/ui/Badge";
import { CheckCircle2, AlertCircle, ArrowRight, Copy } from "lucide-react";
import {
  ALL_ROLES,
  useRoleLabels,
  type Member,
  type MemberActionFailure,
  type MemberActionResult,
} from "../_lib/useMembers";
import type {
  Invitation,
  IssuedInvite,
  InviteFailure,
  InviteIssueResult,
  InviteActionResult,
} from "../_lib/useInvitations";
import type { CompanyRole } from "@/shared/roles";
import styles from "../page.module.css";

// The team half of /settings: member rows, the invitation form, the one-time
// invite link and pending invitations. Extracted from page.tsx (10.09.2026).

/**
 * `settings`-namespace message KEY for a refused member mutation — NEVER a raw
 * "Error 403". The caller resolves it with `t(...)` so the copy stays localized.
 */
function memberActionMessage(reason: MemberActionFailure): string {
  switch (reason) {
    case "last_admin":
      return "team.errLastAdmin";
    case "access_changed":
      return "team.accessChanged";
    default:
      return "team.errGeneric";
  }
}

/** A member's initials for the avatar (first letter of each name word). */
function initialsOf(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("");
}

/**
 * One roster row. The role dropdown + Remove button render ONLY when
 * `canManage` (mirrors the server `members.manage` capability, §0.1) AND the row
 * is not the current user — self-demotion/removal is always a server 403 (D9), so
 * offering it would only produce a confusing refusal. Failures are surfaced inline
 * as explanatory copy, never as a red app error.
 */
export function TeamMemberRow({
  member,
  canManage,
  isSelf,
  onChangeRole,
  onRemove,
}: {
  member: Member;
  canManage: boolean;
  isSelf: boolean;
  onChangeRole: (
    userId: string,
    role: CompanyRole,
  ) => Promise<MemberActionResult>;
  onRemove: (userId: string) => Promise<MemberActionResult>;
}) {
  const t = useTranslations("settings");
  const roleLabels = useRoleLabels();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const showControls = canManage && !isSelf;

  const run = async (
    action: () => Promise<MemberActionResult>,
    successKey: string,
  ) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await action();
      // Errors stay inline (deliberate benign messaging, R-11/R-7); only the
      // success confirmation surfaces as a toast.
      if (!res.ok) setMsg(t(memberActionMessage(res.reason)));
      else toast.success(t(successKey));
    } catch {
      // A thrown apiFetch (network / non-JSON) must not leave the control spinning.
      setMsg(t("team.errGeneric"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.memberRow}>
      <div className={styles.avatar}>
        <span className={styles.avatarInitials}>{initialsOf(member.name)}</span>
      </div>
      <div className={styles.rowMain}>
        <p className={styles.rowTitle}>
          {member.name}
          {isSelf && (
            <span className={styles.rowSubtitle}> ({t("team.you")})</span>
          )}
        </p>
        <p className={styles.rowSubtitle}>{member.email}</p>
        {msg && (
          <p role="alert" className={styles.rowError}>
            {msg}
          </p>
        )}
      </div>
      {member.status === "suspended" && (
        <Badge variant="yellow" size="sm">
          {t("team.suspended")}
        </Badge>
      )}
      {showControls ? (
        <div className={styles.memberControls}>
          <select
            aria-label={t("team.roleForMember", { name: member.name })}
            className={styles.roleSelect}
            value={member.role}
            disabled={busy}
            onChange={(e) =>
              run(
                () =>
                  onChangeRole(member.userId, e.target.value as CompanyRole),
                "team.okRoleChanged",
              )
            }
          >
            {ALL_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabels[r]}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            loading={busy}
            onClick={() => run(() => onRemove(member.userId), "team.okRemoved")}
          >
            {t("team.remove")}
          </Button>
        </div>
      ) : (
        <Badge variant={member.role === "esg_admin" ? "blue" : "gray"}>
          {roleLabels[member.role]}
        </Badge>
      )}
    </div>
  );
}

/**
 * `settings`-namespace message KEY for a refused invite action — NEVER a raw
 * "Error 4xx". The caller resolves it with `t(...)` so the copy stays localized.
 */
function inviteFailureMessage(reason: InviteFailure): string {
  switch (reason) {
    case "access_changed":
      return "team.accessChanged";
    case "invalid":
      return "team.errInviteInvalid";
    case "plan_required":
      // Rendered as a product upgrade block, not this string (see TeamInvite).
      return "team.planRequiredShort";
    default:
      return "team.errGeneric";
  }
}

/**
 * The invitation surface inside the Team card: an invite form, the ONE-TIME
 * `inviteUrl` reveal, and the pending-invitations list with resend/revoke.
 *
 * The raw `inviteUrl` (§9.7) is shown EXACTLY once — straight from the POST/resend
 * response — and is never read back from `GET /api/invitations` (the list stores
 * only a hash). A trial/seat 402 (`plan_required`, R-5/Q1) is rendered as a PRODUCT
 * upgrade message with a CTA, not a red error.
 */
export function TeamInvite({
  invitations,
  loading,
  accessChanged,
  loadError,
  onIssue,
  onResend,
  onRevoke,
  onUpgrade,
}: {
  invitations: Invitation[];
  loading: boolean;
  accessChanged: boolean;
  loadError: boolean;
  onIssue: (email: string, role: CompanyRole) => Promise<InviteIssueResult>;
  onResend: (id: string) => Promise<InviteIssueResult>;
  onRevoke: (id: string) => Promise<InviteActionResult>;
  onUpgrade: () => void;
}) {
  const t = useTranslations("settings");
  const roleLabels = useRoleLabels();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CompanyRole>("contributor");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<InviteFailure | null>(null);
  // The raw link is held only in local component state and dropped on the next
  // action — it is never persisted and never comes back from the list.
  const [issued, setIssued] = useState<IssuedInvite | null>(null);

  const handleIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await onIssue(email.trim(), role);
      if (res.ok) {
        setIssued(res.invite);
        setEmail("");
      } else {
        setFailure(res.reason);
      }
    } catch {
      // A thrown apiFetch (network / non-JSON) must not lock the form spinning.
      setFailure("unknown");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.inviteSection}>
      <p className={styles.inviteHeading}>{t("team.inviteHeading")}</p>
      <form className={styles.inviteForm} onSubmit={handleIssue}>
        <input
          type="email"
          aria-label={t("team.inviteeEmailLabel")}
          className={styles.inviteEmail}
          placeholder={t("team.inviteEmailPlaceholder")}
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select
          aria-label={t("team.inviteeRoleLabel")}
          className={styles.roleSelect}
          value={role}
          disabled={busy}
          onChange={(e) => setRole(e.target.value as CompanyRole)}
        >
          {ALL_ROLES.map((r) => (
            <option key={r} value={r}>
              {roleLabels[r]}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" size="sm" loading={busy}>
          {t("team.sendInvite")}
        </Button>
      </form>

      {/* 402 as a PRODUCT message (R-5/Q1): explain the upgrade, don't red-error. */}
      {failure === "plan_required" ? (
        <div className={styles.upgradeNote}>
          <p className={styles.upgradeNoteText}>{t("team.upgradeNote")}</p>
          <Button variant="primary" size="sm" onClick={onUpgrade}>
            {t("team.upgradePlan")}
            <ArrowRight size={14} className={styles.btnArrowIcon} />
          </Button>
        </div>
      ) : (
        failure && (
          <p role="alert" className={styles.rowError}>
            {t(inviteFailureMessage(failure))}
          </p>
        )
      )}

      {/* One-time reveal: the raw link, shown once, with a copy affordance. */}
      {issued && (
        <OneTimeInviteUrl invite={issued} onDismiss={() => setIssued(null)} />
      )}

      {/* Pending invitations */}
      {accessChanged ? (
        <p role="alert" className={styles.accessBanner}>
          {t("team.accessChanged")}
        </p>
      ) : loading ? (
        <p className={styles.mutedNote}>{t("team.loadingInvites")}</p>
      ) : loadError ? (
        <p role="alert" className={styles.rowError}>
          {t("team.loadInvitesError")}
        </p>
      ) : invitations.length === 0 ? (
        <p className={styles.mutedNote}>{t("team.noInvites")}</p>
      ) : (
        <div className={styles.rowStack}>
          {invitations.map((inv) => (
            <PendingInviteRow
              key={inv.id}
              invitation={inv}
              onResend={onResend}
              onRevoke={onRevoke}
              onRevealUrl={setIssued}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The one-time invite link box — the ONLY place the raw token is shown (§9.7). */
function OneTimeInviteUrl({
  invite,
  onDismiss,
}: {
  invite: IssuedInvite;
  onDismiss: () => void;
}) {
  const t = useTranslations("settings");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (permissions/insecure origin): the link stays visible
      // and selectable in the field, so the admin can copy it manually.
    }
  };

  return (
    <div className={styles.inviteUrlBox}>
      <p className={styles.inviteUrlTitle}>
        {t("team.inviteLinkFor", { email: invite.email })}
      </p>
      <p className={styles.inviteUrlWarn}>{t("team.inviteLinkWarn")}</p>
      <div className={styles.inviteUrlRow}>
        <input
          readOnly
          className={styles.inviteUrlInput}
          value={invite.inviteUrl}
          aria-label={t("team.inviteLinkLabel")}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button variant="secondary" size="sm" onClick={copy}>
          {copied ? (
            <>
              <CheckCircle2 size={14} className={styles.btnArrowIcon} />{" "}
              {t("team.copied")}
            </>
          ) : (
            <>
              <Copy size={14} className={styles.btnArrowIcon} />{" "}
              {t("team.copy")}
            </>
          )}
        </Button>
      </div>
      <button
        type="button"
        className={styles.inviteUrlDismiss}
        onClick={onDismiss}
      >
        {t("team.dismiss")}
      </button>
    </div>
  );
}

/**
 * One pending-invitation row with resend/revoke. A resend returns a NEW one-time
 * link (the old token is revoked server-side, §9.6), so it is bubbled up via
 * `onRevealUrl` to the one-time reveal box. Failures show inline, never as codes.
 */
function PendingInviteRow({
  invitation,
  onResend,
  onRevoke,
  onRevealUrl,
}: {
  invitation: Invitation;
  onResend: (id: string) => Promise<InviteIssueResult>;
  onRevoke: (id: string) => Promise<InviteActionResult>;
  onRevealUrl: (invite: IssuedInvite) => void;
}) {
  const t = useTranslations("settings");
  const roleLabels = useRoleLabels();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const handleResend = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await onResend(invitation.id);
      if (res.ok) onRevealUrl(res.invite);
      else setMsg(t(inviteFailureMessage(res.reason)));
    } catch {
      setMsg(t(inviteFailureMessage("unknown")));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await onRevoke(invitation.id);
      if (!res.ok) setMsg(t(inviteFailureMessage(res.reason)));
      else toast.success(t("team.okRevoked"));
    } catch {
      setMsg(t(inviteFailureMessage("unknown")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.memberRow}>
      <div className={styles.rowMain}>
        <p className={styles.rowTitle}>{invitation.email}</p>
        <p className={styles.rowSubtitle}>
          {t("team.invitedAs", { role: roleLabels[invitation.role] })}
        </p>
        {msg && (
          <p role="alert" className={styles.rowError}>
            {msg}
          </p>
        )}
      </div>
      <Badge variant="gray" size="sm">
        {t("team.pending")}
      </Badge>
      <div className={styles.memberControls}>
        <Button variant="ghost" size="sm" loading={busy} onClick={handleResend}>
          {t("team.resend")}
        </Button>
        <Button variant="ghost" size="sm" loading={busy} onClick={handleRevoke}>
          {t("team.revoke")}
        </Button>
      </div>
    </div>
  );
}

export function FeatureLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={styles.featureLine}>
      {ok ? (
        <CheckCircle2
          size={12}
          className={clsx(styles.iconShrink, styles.iconOk)}
        />
      ) : (
        <AlertCircle
          size={12}
          className={clsx(styles.iconShrink, styles.iconOff)}
        />
      )}
      <span className={ok ? styles.featureLabelOk : styles.featureLabelOff}>
        {label}
      </span>
    </div>
  );
}
