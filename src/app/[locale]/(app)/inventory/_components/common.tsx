"use client";

// =============================================================================
// The pieces only `/inventory` has: the enum options, the rule-hint renderer and
// the state badge. The section card, the notices and the refusal renderer are
// shared (`../../_components/ScreenKit`).
//
// ONE SENTENCE PER RULE, WHEREVER IT COMES FROM. `useRuleText` (shared) renders
// a VAL-* code through the `validation.*` keys, and it is used by BOTH the
// server-refusal path (`RefusalNote` → `refusal.rules`) and the inline hints
// (`CheckHints` ← `_lib/checks`). That is what makes VR-2 legible on screen: a
// hint the form showed early and a rule the server refused on are literally the
// same sentence, so the user is never shown two systems disagreeing about one
// row.
// =============================================================================
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/shared/ui/Badge";

import { useRuleText } from "../../_components/ScreenKit";
import styles from "../page.module.css";

/** A localised label for one wire value of a domain list (§0.8 constants). */
export function useEnumOptions(
  list: string,
  values: readonly string[],
): { value: string; label: string }[] {
  const t = useTranslations("inventory");
  return values.map((value) => {
    const key = `enums.${list}.${value}`;
    // A value with no key renders as its wire literal rather than throwing: the
    // constants are the source of truth and may gain a value before the copy
    // catches up (§0.8 — adding one is a data-only change). It is also the
    // DELIBERATE state for `activity_type` and `unit`, whose vocabularies are
    // factor keys and unit codes: translating `r134a` or `kWh` would be wrong.
    return { value, label: t.has(key) ? t(key) : value };
  });
}

/**
 * The inline hints of one field (VR-2) — advisory, never a refusal.
 *
 * They read as a NOTE, not as an error, because nothing here has been refused:
 * the write has not been attempted yet and the server may still accept the row.
 * The same code, once the server does refuse it, is rendered by `RefusalNote` in
 * the error register — same sentence, different weight.
 */
export function CheckHints({ codes }: { codes: readonly string[] }) {
  const ruleText = useRuleText();
  if (codes.length === 0) return null;
  return (
    <ul className={styles.hintList}>
      {codes.map((code) => (
        <li key={code}>
          <AlertCircle size={12} className={styles.hintIcon} /> {ruleText(code)}
        </li>
      ))}
    </ul>
  );
}

/** `draft` | `approved` (`ROW_STATES`, §4.8) as a badge. */
export function StateBadge({ state }: { state: string }) {
  const t = useTranslations("inventory");
  const key = `state.${state}`;
  return (
    <Badge variant={state === "approved" ? "green" : "gray"} size="sm">
      {t.has(key) ? t(key) : state}
    </Badge>
  );
}
