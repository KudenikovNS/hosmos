"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Building2, CheckCircle2, MailCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { PlanetIcon } from "@/shared/ui/PlanetIcon";
import { apiFetch } from "@/shared/api/client";
import type { SessionResponse } from "@/shared/hooks/useSession";
import type { CompanyRole } from "@/shared/roles";
import { useRoleLabels } from "@/app/[locale]/(app)/settings/_lib/useMembers";
import styles from "./page.module.css";

/**
 * Public invitation accept page (USERS-ROLES T4.2b, §9.4 / §9.5 / R-12).
 *
 * It shows the FOUR-field public preview (`GET /api/invitations/preview`) — company,
 * role, inviter, expiry — and an accept action (`POST /api/invitations/accept`).
 *
 * R-12: EVERY unusable token — invalid, expired, already used, or unknown — is
 * collapsed into ONE benign message. The preview route already answers the same
 * opaque 422 for all four, so the page never distinguishes which it was (that would
 * make this public page a token-enumeration oracle).
 *
 * Auth: the page is public (the invitee is not yet a member, and may not even have
 * an account tied to this company), so it does NOT require the manage capability.
 * When the visitor is not signed in, it routes them to `/login?redirectTo=…` — the
 * codebase's existing same-origin auth-redirect pattern — and back here afterwards.
 *
 * i18n (post-#13): the page lives under `[locale]` so it inherits the root layout's
 * `NextIntlClientProvider`; the invite link stays `/invite/<token>` (default locale,
 * `as-needed` prefix), and `/sl/invite/<token>` serves the Slovenian copy.
 */

/**
 * Raw `ActionResult`-shaped body of the invitation endpoints, read via `ok`. The
 * `error` is a plain `string` (not the narrow `ActionErrorCode`): the API handler
 * emits access/seat codes — `UNAUTHENTICATED`, `PLAN_REQUIRED`, `VALIDATION` — that
 * live outside that union.
 */
type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** The exactly-four public preview fields (§9.4), dates as ISO strings on the wire. */
interface InvitationPreview {
  companyName: string;
  role: CompanyRole;
  invitedByName: string | null;
  expiresAt: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "invalid" }
  // A transport/non-JSON failure (offline, 502/504 HTML) — RETRYABLE and kept
  // strictly apart from `invalid`, which stays reserved for the opaque 422 (R-12).
  | { kind: "error" }
  | { kind: "ready"; preview: InvitationPreview };

export default function InviteAcceptPage() {
  const t = useTranslations("invite");
  const roleLabels = useRoleLabels();
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  // `null` until the session lookup resolves — drives the sign-in vs. accept CTA.
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  // Bumped by the retry button to re-run the load effect after a transport failure.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // Preview (public) and session (to pick the CTA) resolve in parallel. Both
        // setStates run AFTER the awaits (async, not synchronous in the effect body).
        const [previewRes, session] = await Promise.all([
          apiFetch<ApiResult<InvitationPreview>>(
            `/api/invitations/preview?token=${encodeURIComponent(token)}`,
          ),
          apiFetch<SessionResponse | null>("/api/session"),
        ]);
        if (!active) return;
        setAuthed(!!session);
        // Any non-ok preview is the single opaque 422 (R-12) → one invalid state.
        setLoad(
          previewRes.ok
            ? { kind: "ready", preview: previewRes.data }
            : { kind: "invalid" },
        );
      } catch {
        // Network / non-JSON throw — do NOT collapse into `invalid` (that would
        // mislabel an outage as a bad token). Show a retryable error instead.
        if (active) setLoad({ kind: "error" });
      }
    })();
    return () => {
      active = false;
    };
  }, [token, reloadKey]);

  const retryLoad = () => {
    setLoad({ kind: "loading" });
    setReloadKey((k) => k + 1);
  };

  const goToLogin = () => {
    // Same-origin redirect target the /login page already understands (`redirectTo`).
    const redirectTo = encodeURIComponent(`/invite/${token}`);
    router.push(`/login?redirectTo=${redirectTo}`);
  };

  const handleAccept = async () => {
    setAccepting(true);
    setAcceptError(null);
    try {
      const res = await apiFetch<
        ApiResult<{ companyId: string; role: string }>
      >("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        setAccepted(true);
        // The membership + active-company switch happened server-side; land in-app.
        setTimeout(() => router.push("/readiness"), 1200);
        return;
      }
      if (res.error === "UNAUTHENTICATED") {
        goToLogin();
        return;
      }
      if (res.error === "PLAN_REQUIRED") {
        // The company filled its last seat between issue and accept (§10.2).
        setAcceptError(t("seatLimit"));
        return;
      }
      // VALIDATION or anything else → the SAME benign message (R-12): don't leak
      // whether the token expired, was used, or the accept lost a concurrent race.
      setLoad({ kind: "invalid" });
    } catch {
      // Network / non-JSON throw on accept — retryable, not a token verdict.
      setAcceptError(t("acceptError"));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.brand}>
          <PlanetIcon size={22} />
          <span className={styles.brandText}>Hosmos</span>
        </div>

        {load.kind === "loading" ? (
          <p className={styles.muted}>{t("loading")}</p>
        ) : load.kind === "invalid" ? (
          <div className={styles.stateBlock}>
            <div className={styles.iconCircleWarn}>
              <ShieldAlert size={22} />
            </div>
            <h1 className={styles.title}>{t("unavailableTitle")}</h1>
            <p className={styles.body}>{t("invalidMessage")}</p>
          </div>
        ) : load.kind === "error" ? (
          <div className={styles.stateBlock}>
            <div className={styles.iconCircleWarn}>
              <ShieldAlert size={22} />
            </div>
            <h1 className={styles.title}>{t("errorTitle")}</h1>
            <p className={styles.body}>{t("errorBody")}</p>
            <Button className={styles.action} onClick={retryLoad}>
              {t("tryAgain")}
            </Button>
          </div>
        ) : accepted ? (
          <div className={styles.stateBlock}>
            <div className={styles.iconCircleOk}>
              <CheckCircle2 size={22} />
            </div>
            <h1 className={styles.title}>{t("acceptedTitle")}</h1>
            <p className={styles.body}>
              {t("acceptedBody", { company: load.preview.companyName })}
            </p>
          </div>
        ) : (
          <div className={styles.stateBlock}>
            <div className={styles.iconCircle}>
              <MailCheck size={22} />
            </div>
            <h1 className={styles.title}>{t("previewTitle")}</h1>
            <div className={styles.detailCard}>
              <div className={styles.detailRow}>
                <Building2 size={16} className={styles.detailIcon} />
                <span className={styles.detailLabel}>{t("fieldCompany")}</span>
                <span className={styles.detailValue}>
                  {load.preview.companyName}
                </span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>{t("fieldRole")}</span>
                <span className={styles.detailValue}>
                  {roleLabels[load.preview.role]}
                </span>
              </div>
              {load.preview.invitedByName && (
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>
                    {t("fieldInvitedBy")}
                  </span>
                  <span className={styles.detailValue}>
                    {load.preview.invitedByName}
                  </span>
                </div>
              )}
            </div>

            {acceptError && (
              <p role="alert" className={styles.error}>
                {acceptError}
              </p>
            )}

            {authed === false ? (
              <>
                <p className={styles.body}>{t("signInPrompt")}</p>
                <Button className={styles.action} onClick={goToLogin}>
                  {t("signInButton")}
                </Button>
              </>
            ) : (
              <Button
                className={styles.action}
                loading={accepting}
                disabled={authed === null}
                onClick={handleAccept}
              >
                {t("acceptButton")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
