"use client";

// =============================================================================
// The pieces only `/evidence` has: the plan explanation, the warning-hint
// renderer and the small badges. The section card, the notices and the refusal
// renderer are shared (`../../_components/ScreenKit`).
//
// ONE SENTENCE PER RULE, WHEREVER IT COMES FROM. `useRuleText` (shared) renders
// a VAL-* code through the `validation.*` keys, and it is used by BOTH the
// refusal path (`RefusalNote`) and the WARNING path (`WarningHints` — VAL-013
// after an upload, VAL-037 after a link, VAL-038 after an assessment). That is
// the whole difference this screen has to keep visible: a warning and a refusal
// are the same sentence in two different registers, and only one of them means
// nothing was written.
//
// `PlanNote` IS NOT `RefusalNote`. PG-5 says a plan limit stays visible and
// explained with an upgrade CTA, and the acceptance criterion of this task says
// an over-limit upload must read as the plan and not as an error. So the 402
// never reaches the error list at all — `_lib/upload#uploadNotice` routes it to
// its own branch and this component states the number.
// =============================================================================
import { Info, Lock } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import { useRuleText } from "../../_components/ScreenKit";
import styles from "../page.module.css";

/** Where every upgrade CTA on this screen points (as elsewhere in the app). */
const UPGRADE_HREF = "/settings";

/** A localised label for one wire value, falling back to the literal. */
export function useEnumLabel(): (list: string, value: string) => string {
  const t = useTranslations("evidence");
  return (list, value) => {
    const key = `enums.${list}.${value}`;
    return t.has(key) ? t(key) : value;
  };
}

/**
 * A ceiling the PLAN sets (PG-5): visible, explained with the actual number, and
 * with an upgrade CTA. This is what a 402 on an upload looks like — never a red
 * error, because nothing is broken and the user's move is a plan and not a
 * different request.
 */
export function PlanNote({ maxUploadMb }: { maxUploadMb: number }) {
  const t = useTranslations("evidence");
  return (
    <div className={styles.planLock}>
      <Lock size={16} className={styles.planLockIcon} />
      <div className={styles.planLockMain}>
        <p className={styles.planLockTitle}>{t("upload.planTitle")}</p>
        <p className={styles.planLockBody}>
          {t("upload.planBody", { limit: maxUploadMb })}
        </p>
      </div>
      <Link href={UPGRADE_HREF} className={styles.planLockCta}>
        <Button size="sm">{t("actions.upgrade")}</Button>
      </Link>
    </div>
  );
}

/**
 * NON-BLOCKING findings of a write that SUCCEEDED — VAL-013, VAL-037, VAL-038.
 *
 * They read as a note and never as an error, because the row was written: the
 * server accepted the write and attached an observation. The same code, on a
 * write the server refused, is rendered by `RefusalNote` in the error register —
 * same sentence, different weight, and the difference is whether anything was
 * stored.
 */
export function WarningHints({ codes }: { codes: readonly string[] }) {
  const ruleText = useRuleText();
  if (codes.length === 0) return null;
  return (
    <ul className={styles.hintList}>
      {codes.map((code) => (
        <li key={code}>
          <Info size={12} className={styles.hintIcon} /> {ruleText(code)}
        </li>
      ))}
    </ul>
  );
}

/** `draft` | `approved` (`ROW_STATES`, §4.8) as a badge. */
export function StateBadge({ state }: { state: string }) {
  const t = useTranslations("evidence");
  const key = `rowState.${state}`;
  return (
    <Badge variant={state === "approved" ? "green" : "gray"} size="sm">
      {t.has(key) ? t(key) : state}
    </Badge>
  );
}

/**
 * One DQ score as a badge (DQ-3 — "score badge + explanation").
 *
 * A MISSING SCORE IS SHOWN AS MISSING, never as a zero and never as a dash that
 * could be read as one: VAL-038 exists because unfilled scores are a real state
 * that has to be visible, and a badge that rendered `null` as `0` would be
 * asserting the worst possible quality on data nobody has assessed.
 */
export function ScoreBadge({
  label,
  value,
  max,
}: {
  label: string;
  value: number | null;
  max: number;
}) {
  const t = useTranslations("evidence");
  return (
    <span className={styles.scoreBadge}>
      <span className={styles.scoreLabel}>{label}</span>
      {value === null ? (
        <Badge variant="gray" size="sm">
          {t("dq.unscored")}
        </Badge>
      ) : (
        <Badge variant={value * 2 >= max ? "green" : "yellow"} size="sm">
          {t("dq.scoreOf", { value, max })}
        </Badge>
      )}
    </span>
  );
}

/** An ISO date as a localised date, or an em dash (§4.16 carries dates, not instants). */
export function useDay(): (iso: string | null) => string {
  const format = useFormatter();
  return (iso) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: "medium" }) : "—";
}
