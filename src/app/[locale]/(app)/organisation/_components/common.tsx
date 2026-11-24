"use client";

// =============================================================================
// The pieces only `/organisation` has: the enum options, the save indicator and
// the counter badge. The section card, the notices, the plan lock and the
// refusal renderer are shared (`../../_components/ScreenKit`).
// =============================================================================
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import type { SaveStatus } from "../_lib/useAutosave";
import styles from "../page.module.css";

/** A localised label for one wire value of a domain list (§0.8 constants). */
export function useEnumOptions(
  list: string,
  values: readonly string[],
): { value: string; label: string }[] {
  const t = useTranslations("organisation");
  return values.map((value) => {
    const key = `enums.${list}.${value}`;
    // An enum value with no key yet renders as its wire literal rather than
    // throwing: the constants are the source of truth and may gain a value
    // before the copy catches up (§0.8 — adding one is a data-only change).
    return { value, label: t.has(key) ? t(key) : value };
  });
}

/**
 * The autosave indicator + the explicit confirm (UI-1 asks for both).
 *
 * `refused` and `saved` are mutually exclusive by construction — see the header
 * of `../_lib/useAutosave`. The button stays enabled while dirty so a user who
 * does not want to wait for the debounce (or who has just answered a refusal)
 * can push the write themselves.
 */
export function SaveBar({
  status,
  dirty,
  onConfirm,
}: {
  status: SaveStatus;
  dirty: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations("organisation");
  return (
    <div className={styles.saveBar}>
      <span className={styles.saveStatus}>
        {status === "saving" && (
          <>
            <Loader2 size={14} className={styles.spin} /> {t("save.saving")}
          </>
        )}
        {status === "saved" && (
          <>
            <Check size={14} className={styles.iconOk} /> {t("save.saved")}
          </>
        )}
        {status === "dirty" && t("save.dirty")}
        {status === "refused" && (
          <>
            <AlertCircle size={14} className={styles.iconOff} />{" "}
            {t("save.refused")}
          </>
        )}
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={!dirty}
        loading={status === "saving"}
        onClick={onConfirm}
      >
        {t("save.confirm")}
      </Button>
    </div>
  );
}

/** The UI-7 counter badge: "2 of 3 legal entities", "11 of 15 facilities". */
export function CounterBadge({
  label,
  atLimit,
}: {
  label: string;
  atLimit: boolean;
}) {
  return (
    <Badge variant={atLimit ? "yellow" : "gray"} size="sm">
      {label}
    </Badge>
  );
}
