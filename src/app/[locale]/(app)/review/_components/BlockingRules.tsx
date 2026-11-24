"use client";

// =============================================================================
// THE BLOCKING RULES, AS A LIST OF THINGS TO GO AND FIX (T4.6 acceptance; VR-3,
// DM-28, UI-3).
//
// EACH LINE IS A SENTENCE PLUS A DESTINATION, and nothing else. The sentence is
// the rule's own localised message, looked up BY CODE through `validation.*`
// (О-12) — this screen never writes rule text. The destination comes from
// `_lib/blocking#ruleTarget`, which is where the whole decision lives and where
// it is tested; this component holds exactly ONE reference per branch of
// `RuleTarget`, so the acceptance criterion is decided by a tested function
// rather than by the shape of this JSX.
//
// THE THIRD BRANCH IS THE HONEST ONE. `kind: "none"` is a finding whose object
// cannot be opened — it has no object at all, or its type has no screen, or the
// session may not reach the screen that owns it (a VAL-018 about an emission
// factor, for a role without `factors.custom`). The rule is still LISTED and
// still explained; it simply says WHERE the object lives instead of pretending
// to link there. Hiding such a finding would be worse than useless: it is one of
// the reasons the submit did not happen, and a user who cannot see it cannot
// even ask a colleague to fix it.
// =============================================================================
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import { Badge } from "@/shared/ui/Badge";

import type { BlockingItem } from "../_lib/blocking";
import type { InputTableName } from "../_lib/api";
import styles from "../page.module.css";
import { Muted } from "../../_components/ScreenKit";
import { useEnumLabel, useRuleText } from "./common";

export function BlockingRules({
  items,
  loading,
  onSelectRow,
}: {
  items: readonly BlockingItem[];
  loading: boolean;
  /** Select a row of the QUEUE in place — the row detail is on this screen. */
  onSelectRow: (table: InputTableName, id: string) => void;
}) {
  const t = useTranslations("review");
  const ruleText = useRuleText();
  const label = useEnumLabel();

  if (loading) return <Muted>{t("loadingSection")}</Muted>;
  if (items.length === 0) return <Muted>{t("blocking.clean")}</Muted>;

  return (
    <ul className={styles.blockingList}>
      {items.map((item) => {
        // Narrowed on a local const: `item.target` is a property access and the
        // compiler cannot keep a narrowing across the JSX callbacks below.
        const target = item.target;
        return (
          <li
            key={item.key}
            className={
              item.refusedNow ? styles.blockingItemHot : styles.blockingItem
            }
          >
            <AlertTriangle size={14} className={styles.blockingIcon} />
            <div className={styles.blockingMain}>
              {/* WHAT to fix — the rule's own message, by code. */}
              <p className={styles.blockingText}>{ruleText(item.code)}</p>
              <p className={styles.blockingMeta}>
                <Badge variant="gray" size="sm">
                  {item.code}
                </Badge>{" "}
                {t("blocking.scope", { scope: label("scope", item.scope) })}
              </p>

              {/* WHERE to fix it — one reference per `RuleTarget` branch. */}
              {target.kind === "row" && (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => onSelectRow(target.table, target.id)}
                >
                  {t("blocking.openRow")} <ArrowUpRight size={12} />
                </button>
              )}
              {target.kind === "screen" && (
                <Link href={target.href} className={styles.linkButton}>
                  {t("blocking.openScreen", {
                    object: label("objectType", target.objectType),
                  })}{" "}
                  <ArrowUpRight size={12} />
                </Link>
              )}
              {target.kind === "none" && (
                <span className={styles.blockingNoLink}>
                  {target.objectType === null
                    ? t("blocking.noObject")
                    : t("blocking.noAccess", {
                        object: label("objectType", target.objectType),
                      })}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
