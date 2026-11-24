"use client";

import { PageLayout } from "../_components/PageLayout";
import { Card } from "@/shared/ui/Card";
import { Badge } from "@/shared/ui/Badge";
import { ProgressBar } from "@/shared/ui/ProgressBar";
import { Button } from "@/shared/ui/Button";
import {
  CheckCircle2,
  Circle,
  Shield,
  Scale,
  Eye,
  Lock,
  Save,
  Loader2,
} from "lucide-react";
import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/shared/api/client";
import type { ActionResult } from "@/server/actions/types";
import { useCompany, SESSION_QUERY_KEY } from "@/shared/hooks/useSession";
import { FeatureGate } from "@/shared/components/FeatureGate";
import { clsx } from "clsx";
import styles from "./page.module.css";

// ─── Governance checklist definition ──────────────────────────────────────────
const GOVERNANCE_ITEMS = [
  {
    categoryKey: "catBoard",
    icon: Scale,
    esrs: "G1-1, G1-3",
    items: [
      "boardComposition",
      "independentDirectors",
      "boardDiversity",
      "execCompensation",
      "esgCommittee",
    ],
  },
  {
    categoryKey: "catEthics",
    icon: Shield,
    esrs: "G1-3, G1-4",
    items: [
      "codeOfEthics",
      "antiCorruption",
      "whistleblowing",
      "conflictOfInterest",
      "politicalContributions",
      "antiBriberyTraining",
    ],
  },
  {
    categoryKey: "catData",
    icon: Lock,
    esrs: "G1-1",
    items: [
      "gdprAssessment",
      "dpa",
      "privacyPolicy",
      "breachNotification",
      "dpoAppointed",
      "dataRetention",
    ],
  },
  {
    categoryKey: "catRisk",
    icon: Eye,
    esrs: "G1-2, G1-5",
    items: [
      "riskRegister",
      "riskMethodology",
      "continuityPlan",
      "internalAudit",
      "complianceMonitoring",
    ],
  },
];

const ALL_ITEMS = GOVERNANCE_ITEMS.flatMap((g) => g.items);

export default function GovernancePage() {
  const t = useTranslations("governance");
  const { company, loading } = useCompany();
  const queryClient = useQueryClient();
  const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Seed the editable checklist from the company record when THAT record
  // changes (first load, refetch after save). Done during render, keyed on the
  // previous `company`, rather than in an effect — same data, one commit.
  const [seenCompany, setSeenCompany] = useState(company);
  if (company !== seenCompany) {
    setSeenCompany(company);
    const gd = (company as unknown as Record<string, unknown>)?.governance_data;
    if (gd && typeof gd === "object") {
      setCheckedItems(gd as Record<string, boolean>);
    }
  }

  const toggleItem = useCallback((label: string) => {
    setCheckedItems((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      return next;
    });
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!company) return;
    setSaving(true);
    try {
      const res = await apiFetch<ActionResult<unknown>>(
        "/api/company/governance",
        {
          method: "PATCH",
          body: JSON.stringify({ governance_data: checkedItems }),
        },
      );
      if (!res.ok) throw new Error(`save failed: ${res.error}`);
      queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      setDirty(false);
      toast.success(t("saved"));
    } catch (err) {
      console.error("Failed to save governance:", err);
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  }, [company, checkedItems, queryClient, t]);

  const totalItems = ALL_ITEMS.length;
  const doneItems = ALL_ITEMS.filter((item) => checkedItems[item]).length;

  return (
    <PageLayout title={t("title")} subtitle={t("subtitle")} loading={loading}>
      <FeatureGate feature="governanceParams" title={t("gateTitle")}>
        <div className={styles.topRow}>
          <div className={styles.progressWrap}>
            <ProgressBar
              value={doneItems}
              max={totalItems}
              label={t("completion")}
              color="blue"
              showLabel
            />
          </div>
          <div className={styles.badges}>
            <Badge variant="blue">GDPR</Badge>
            <Badge variant="blue">ISO 27001</Badge>
            <Badge variant="blue">ESRS G1</Badge>
          </div>
        </div>

        {GOVERNANCE_ITEMS.map((group) => {
          const groupDone = group.items.filter(
            (item) => checkedItems[item],
          ).length;
          return (
            <Card key={group.categoryKey} className={styles.groupCard}>
              <div className={styles.groupHeader}>
                <div className={styles.groupIcon}>
                  <group.icon size={20} className={styles.iconBlue} />
                </div>
                <div className={styles.groupInfo}>
                  <h3 className={styles.groupTitle}>{t(group.categoryKey)}</h3>
                  <p className={styles.groupMeta}>
                    {t("groupMeta", {
                      done: groupDone,
                      total: group.items.length,
                    })}{" "}
                    · <span className={styles.groupEsrs}>{group.esrs}</span>
                  </p>
                </div>
                <span className={styles.groupPct}>
                  {Math.round((groupDone / group.items.length) * 100)}%
                </span>
              </div>
              <div className={styles.itemsList}>
                {group.items.map((item) => {
                  const done = !!checkedItems[item];
                  return (
                    <div
                      key={item}
                      role="checkbox"
                      aria-checked={done}
                      tabIndex={0}
                      className={styles.item}
                      onClick={() => toggleItem(item)}
                      onKeyDown={(e) => {
                        if (e.key === " " || e.key === "Enter") {
                          e.preventDefault();
                          toggleItem(item);
                        }
                      }}
                    >
                      {done ? (
                        <CheckCircle2 size={20} className={styles.iconDone} />
                      ) : (
                        <Circle size={20} className={styles.iconTodo} />
                      )}
                      <span
                        className={clsx(
                          styles.itemLabel,
                          done && styles.itemLabelDone,
                        )}
                      >
                        {t(`items.${item}`)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}

        <div className={styles.saveRow}>
          <Button size="lg" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? (
              <>
                <Loader2
                  size={18}
                  className={clsx(styles.btnIcon, styles.spin)}
                />{" "}
                {t("saving")}
              </>
            ) : (
              <>
                <Save size={18} className={styles.btnIcon} /> {t("save")}
              </>
            )}
          </Button>
          {dirty && <span className={styles.dirtyMsg}>{t("unsaved")}</span>}
        </div>

        <p className={styles.footnote}>{t("footnote")}</p>
      </FeatureGate>
    </PageLayout>
  );
}
