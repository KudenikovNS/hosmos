"use client";

// =============================================================================
// The pieces only `/review` has: the rule wording of the blocking list, the
// PLAN explanation, the self-approval disclosure and the small badges. The
// section card, the notices and the refusal renderer are shared
// (`../../_components/ScreenKit`).
//
// `useRuleText` HERE IS THE BLOCKING LIST'S. It is the only way a rule is worded
// in the blocking list and the bulk-approve tally, and its fallback for an
// unknown code says the CHECK did not pass — not that a change was refused, as
// the shared refusal wording does, because nothing here was refused.
//
// `PlanNote` IS NOT `RefusalNote`, and on this screen that separation IS an
// acceptance criterion. F1 refuses a Lock with 402 `PLAN_REQUIRED`; PG-5 says a
// plan limit stays visible and explained with an upgrade CTA. So the 402 never
// reaches the error list at all — `_lib/transitions#transitionNotice` routes it
// to its own branch before it reads a single rule code, and this component
// states the two numbers (§11.3's count of includable facilities, and the cap
// the plan allows) beside a link to /settings. "You have 4 sites included and
// your plan allows 3" is a product statement; "the change could not be saved" is
// the technical error the criterion forbids.
// =============================================================================
import { Info, Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import styles from "../page.module.css";

/** Where every upgrade CTA on this screen points (as elsewhere in the app). */
const UPGRADE_HREF = "/settings";

/** One VAL-* code as a sentence — the blocking list's spelling of a rule. */
export function useRuleText(): (code: string) => string {
  const t = useTranslations("review");
  const tRule = useTranslations("validation");
  return (code) =>
    tRule.has(code) ? tRule(code) : t("errors.ruleUnknown", { code });
}

/** A localised label for one wire value, falling back to the literal. */
export function useEnumLabel(): (list: string, value: string) => string {
  const t = useTranslations("review");
  return (list, value) => {
    const key = `enums.${list}.${value}`;
    return t.has(key) ? t(key) : value;
  };
}

/**
 * F1's ceiling (PG-3/PG-5): visible, explained with the ACTUAL numbers, and with
 * an upgrade CTA. This is what the 402 on Lock looks like — never a red error,
 * because nothing is broken and the customer's move is a plan rather than a
 * different request.
 *
 * `limit <= 0` means the browser could not resolve the numbers (an unlimited
 * plan, or a boundary that has not loaded). The sentence then says the plan caps
 * the sites without claiming how many — a missing number is better than a wrong
 * one in a refusal the user is being asked to pay to clear.
 */
export function PlanNote({
  facilities,
  limit,
}: {
  facilities: number;
  limit: number;
}) {
  const t = useTranslations("review");
  return (
    <div className={styles.planLock}>
      <Lock size={16} className={styles.planLockIcon} />
      <div className={styles.planLockMain}>
        <p className={styles.planLockTitle}>{t("lock.planTitle")}</p>
        <p className={styles.planLockBody}>
          {limit > 0
            ? t("lock.planBody", { facilities, limit })
            : t("lock.planBodyUnknown")}
        </p>
        <p className={styles.planLockHint}>{t("lock.planHint")}</p>
      </div>
      <Link href={UPGRADE_HREF} className={styles.planLockCta}>
        <Button size="sm">{t("actions.upgrade")}</Button>
      </Link>
    </div>
  );
}

/**
 * The self-approval disclosure (LC-7, §11.2) — the R7 inheritance.
 *
 * SHOWN WHEN THE D13 COMPENSATING GRANT IS LIVE FOR THIS VIEWER: they hold
 * `data.approve` AND the company has no independent approver. Gating on the
 * company flag alone would tell a contributor "you are approving your own data",
 * which is false for them; gating on the capability alone would say it to a real
 * `approver`, for whom it is also false. Both halves, or nothing.
 *
 * WHY IT EXISTS AT ALL. Without it, the Approve button vanishing the moment a
 * colleague is given the Approver role reads as a bug rather than as the
 * intended handover. Stating the grant while it is live is what makes its
 * disappearance legible — and Phase 1 DISCLOSES self-approval rather than
 * forbidding it (LC-7), so the sentence also has to say that the report will
 * carry it.
 */
export function SelfApprovalNote() {
  const t = useTranslations("review");
  return (
    <div className={styles.disclosure}>
      <Info size={16} className={styles.disclosureIcon} />
      <span>{t("selfApproval.disclosure")}</span>
    </div>
  );
}

/** A revision status (§5.1) as a badge — the vocabulary of the whole screen. */
export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("review");
  const key = `revisionStatus.${status}`;
  const variant =
    status === "locked"
      ? "violet"
      : status === "approved"
        ? "green"
        : status === "rejected"
          ? "red"
          : status === "in_review" || status === "submitted"
            ? "blue"
            : "gray";
  return (
    <Badge variant={variant} size="sm">
      {t.has(key) ? t(key) : status}
    </Badge>
  );
}

/** `draft` | `approved` (`ROW_STATES`, §4.8) as a badge. */
export function StateBadge({ state }: { state: string }) {
  const t = useTranslations("review");
  const key = `rowState.${state}`;
  return (
    <Badge variant={state === "approved" ? "green" : "gray"} size="sm">
      {t.has(key) ? t(key) : state}
    </Badge>
  );
}
