"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Building2, ChevronDown } from "lucide-react";
import { apiFetch } from "@/shared/api/client";
import type { ActionResult } from "@/server/actions/types";
import {
  SESSION_QUERY_KEY,
  useSession,
  type SessionResponse,
} from "@/shared/hooks/useSession";
import { useCompanySaves } from "@/shared/autosave/CompanySaveProvider";
import { confirmCompanySwitch } from "@/shared/autosave/switch-company";
import styles from "./CompanySwitcher.module.css";

/** The server rechecks membership. The client drains saves BEFORE changing its tenant. */
export function CompanySwitcher() {
  const t = useTranslations("topbar");
  const queryClient = useQueryClient();
  const { data } = useSession();
  const { coordinator, busy, setBusy } = useCompanySaves();
  const switching = useRef(false);
  const posting = useRef(false);
  const [unsavedTarget, setUnsavedTarget] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const memberships = data?.memberships ?? [];
  const activeCompanyId = data?.company?.id ?? "";

  const finish = (switched: boolean) => {
    coordinator.finish(switched);
    switching.current = false;
    posting.current = false;
    setUnsavedTarget(null);
    setBusy(false);
  };

  const switchCompany = async (companyId: string) => {
    if (posting.current) return;
    posting.current = true;
    setUnsavedTarget(null);
    // GETs can be cancelled. Writes must have settled before changing tenant.
    await queryClient.cancelQueries();
    try {
      const session = await confirmCompanySwitch(
        companyId,
        () =>
          apiFetch<ActionResult<{ companyId: string }>>(
            "/api/companies/switch",
            {
              method: "POST",
              body: JSON.stringify({ companyId }),
            },
          ),
        () => apiFetch<SessionResponse | null>("/api/session"),
      );
      const switched = session.company.id !== activeCompanyId;
      if (switched) {
        queryClient.removeQueries({
          predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0],
        });
      }
      coordinator.bind(session.company.id);
      queryClient.setQueryData(SESSION_QUERY_KEY, session);
      finish(switched);
      if (session.company.id !== companyId) {
        toast.error(t("switchError"));
        await queryClient.invalidateQueries();
      }
    } catch {
      // Keep the old page inert: its object ids must not be written under an
      // unknown server-side tenant. Reload is explicit and preserves the unload warning.
      setRecovery(true);
      toast.error(t("switchError"));
    }
  };

  const onChange = async (companyId: string) => {
    if (!companyId || companyId === activeCompanyId || switching.current)
      return;
    switching.current = true;
    setBusy(true);
    try {
      const saved = await coordinator.prepare();
      if (!saved) {
        setUnsavedTarget(companyId);
        return;
      }
      await switchCompany(companyId);
    } catch {
      finish(false);
      toast.error(t("switchError"));
    }
  };

  if (memberships.length < 2) return null;
  return (
    <div className={styles.wrapper}>
      <div className={styles.switcher}>
        <Building2 size={16} className={styles.icon} aria-hidden="true" />
        <select
          aria-label={t("activeCompany")}
          className={styles.select}
          value={activeCompanyId}
          disabled={busy}
          onChange={(event) => {
            void onChange(event.target.value);
          }}
        >
          {memberships.map((membership) => (
            <option key={membership.companyId} value={membership.companyId}>
              {membership.companyName}
            </option>
          ))}
        </select>
        <ChevronDown size={14} className={styles.chevron} aria-hidden="true" />
      </div>
      {unsavedTarget && (
        <div className={styles.notice} role="alert">
          <p>{t("unsavedSwitch")}</p>
          <button autoFocus type="button" onClick={() => finish(false)}>
            {t("stay")}
          </button>
          <button
            type="button"
            onClick={() => {
              void switchCompany(unsavedTarget);
            }}
          >
            {t("discardAndSwitch")}
          </button>
        </div>
      )}
      {recovery && (
        <div className={styles.notice} role="alert">
          <p>{t("switchRecovery")}</p>
          <button type="button" onClick={() => window.location.reload()}>
            {t("reload")}
          </button>
        </div>
      )}
    </div>
  );
}
