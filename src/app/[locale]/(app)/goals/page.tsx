"use client";

import { PageLayout } from "../_components/PageLayout";
import { Card } from "@/shared/ui/Card";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";
import { ProgressBar } from "@/shared/ui/ProgressBar";
import {
  Target,
  TrendingDown,
  Flag,
  Plus,
  Save,
  Pencil,
  Trash2,
  Loader2,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { clsx } from "clsx";
import { apiFetch } from "@/shared/api/client";
import type { ActionResult } from "@/server/actions/types";
import { useCompany } from "@/shared/hooks/useSession";
import { FeatureGate } from "@/shared/components/FeatureGate";
import styles from "./page.module.css";
import { UNITS } from "@/shared/units";

// ─── The `goals` columns (§Q5) + their CHECK enums (mirror schema.ts) ─────────
// The enum VALUES are the contract with the DB CHECK constraints and stay here;
// only their labels are localised (goals.categories.* / goals.statuses.*), so a
// translation can never widen or rename the persisted set.
const CATEGORY_VALUES = [
  "emissions",
  "energy",
  "waste",
  "social",
  "governance",
  "supply_chain",
  "water",
  "biodiversity",
] as const;

const STATUS_VALUES = [
  "not_started",
  "on_track",
  "at_risk",
  "behind",
  "completed",
] as const;

/** A persisted `goals` row as it comes back over the wire (numeric → string). */
interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  targetYear: string | null;
  targetValue: string | null;
  currentValue: string | null;
  unit: string | null;
  baselineYear: string | null;
  baselineValue: string | null;
  status: string | null;
  sbtiAligned: boolean | null;
}

type FormState = {
  id: string | null;
  title: string;
  description: string;
  category: string;
  targetYear: string;
  targetValue: string;
  currentValue: string;
  unit: string;
  baselineYear: string;
  baselineValue: string;
  status: string;
  sbtiAligned: boolean;
};

const emptyForm = (): FormState => ({
  id: null,
  title: "",
  description: "",
  category: "emissions",
  targetYear: "",
  targetValue: "",
  currentValue: "",
  unit: UNITS.tCO2e,
  baselineYear: "",
  baselineValue: "",
  status: "not_started",
  sbtiAligned: false,
});

const s = (v: string | null | undefined) => (v == null ? "" : String(v));

/** Project a persisted row onto the editable form (numeric strings pass through). */
function rowToForm(row: GoalRow): FormState {
  return {
    id: row.id,
    title: s(row.title),
    description: s(row.description),
    category: s(row.category) || "emissions",
    targetYear: s(row.targetYear),
    targetValue: s(row.targetValue),
    currentValue: s(row.currentValue),
    unit: s(row.unit),
    baselineYear: s(row.baselineYear),
    baselineValue: s(row.baselineValue),
    status: s(row.status) || "not_started",
    sbtiAligned: Boolean(row.sbtiAligned),
  };
}

const numOrNull = (v: string) => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export default function GoalsPage() {
  const t = useTranslations("goals");
  const { company, loading } = useCompany();
  const [rows, setRows] = useState<GoalRow[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<ActionResult<GoalRow[]>>("/api/goals");
      if (res.ok) setRows(res.data);
    } catch (err) {
      console.error("Failed to load goals:", err);
    }
  }, []);

  // Fetch-on-mount: load the company's persisted goals. The fetch lives in a
  // nested async IIFE (not a bare `load()` call) so the effect body itself never
  // calls setState synchronously (matches the People page pattern).
  useEffect(() => {
    if (!company) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<ActionResult<GoalRow[]>>("/api/goals");
        if (!cancelled && res.ok) setRows(res.data);
      } catch (err) {
        console.error("Failed to load goals:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company]);

  const categoryOptions = useMemo(
    () =>
      CATEGORY_VALUES.map((value) => ({
        value,
        label: t(`categories.${value}`),
      })),
    [t],
  );
  const statusOptions = useMemo(
    () =>
      STATUS_VALUES.map((value) => ({ value, label: t(`statuses.${value}`) })),
    [t],
  );

  // A row may carry a value outside the current enum (older data): fall back to
  // the raw value rather than to a missing-message error.
  const categoryLabel = (value: string | null) =>
    value && (CATEGORY_VALUES as readonly string[]).includes(value)
      ? t(`categories.${value}`)
      : (value ?? "—");
  const statusLabel = (value: string | null) =>
    value && (STATUS_VALUES as readonly string[]).includes(value)
      ? t(`statuses.${value}`)
      : (value ?? "—");

  const setField = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setError(null);
    },
    [],
  );

  const resetForm = useCallback(() => {
    setForm(emptyForm());
    setError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!company) return;
    if (form.title.trim() === "") {
      setError(t("errNoTitle"));
      return;
    }
    const isEdit = !!form.id;
    setSaving(true);
    setError(null);
    try {
      // Identity is never sent (PATTERN 3). `id` (when set) means edit-in-place;
      // the server applies factors/enums, we send only the raw field values.
      const payload = {
        ...(form.id ? { id: form.id } : {}),
        title: form.title.trim(),
        description: form.description.trim() || null,
        category: form.category,
        targetYear: form.targetYear.trim() || null,
        targetValue: numOrNull(form.targetValue),
        currentValue: numOrNull(form.currentValue),
        unit: form.unit.trim() || null,
        baselineYear: form.baselineYear.trim() || null,
        baselineValue: numOrNull(form.baselineValue),
        status: form.status,
        sbtiAligned: form.sbtiAligned,
      };
      const res = await apiFetch<ActionResult<GoalRow>>("/api/goals", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(res.error);
      await load();
      resetForm();
      toast.success(isEdit ? t("okUpdated") : t("okCreated"));
    } catch (err) {
      console.error("Failed to save goal:", err);
      toast.error(
        err instanceof Error && err.message === "VALIDATION"
          ? t("errValidation")
          : t("errSave"),
      );
    } finally {
      setSaving(false);
    }
  }, [company, form, load, resetForm, t]);

  const handleEdit = useCallback((row: GoalRow) => {
    setForm(rowToForm(row));
    setError(null);
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const res = await apiFetch<ActionResult<{ id: string }>>(
          `/api/goals?id=${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error(res.error);
        if (form.id === id) resetForm();
        await load();
        toast.success(t("okDeleted"));
      } catch (err) {
        console.error("Failed to delete goal:", err);
        toast.error(t("errDelete"));
      } finally {
        setBusyId(null);
      }
    },
    [form.id, load, resetForm, t],
  );

  return (
    <PageLayout title={t("title")} subtitle={t("subtitle")} loading={loading}>
      <FeatureGate feature="goals" title={t("gateTitle")}>
        {/* Add / edit form */}
        <Card className={styles.formCard}>
          <div className={styles.formHeader}>
            <Target size={20} className={styles.iconBlue} />
            <h3 className={styles.formTitle}>
              {form.id ? t("editTitle") : t("addTitle")}
            </h3>
          </div>
          <div className={styles.formGrid}>
            <div className={styles.formFull}>
              <Input
                label={t("fieldTitle")}
                value={form.title}
                onChange={(e) => setField("title", e.target.value)}
                placeholder={t("fieldTitlePlaceholder")}
              />
            </div>
            <div className={styles.formFull}>
              <Input
                label={t("fieldDescription")}
                value={form.description}
                onChange={(e) => setField("description", e.target.value)}
                placeholder={t("fieldDescriptionPlaceholder")}
              />
            </div>
            <Select
              label={t("fieldCategory")}
              options={categoryOptions}
              value={form.category}
              onChange={(e) => setField("category", e.target.value)}
            />
            <Select
              label={t("fieldStatus")}
              options={statusOptions}
              value={form.status}
              onChange={(e) => setField("status", e.target.value)}
            />
            <Input
              label={t("fieldUnit")}
              value={form.unit}
              onChange={(e) => setField("unit", e.target.value)}
              placeholder={UNITS.tCO2e}
            />
            <div className={styles.toggleRow}>
              <input
                id="sbtiAligned"
                type="checkbox"
                checked={form.sbtiAligned}
                onChange={(e) => setField("sbtiAligned", e.target.checked)}
              />
              <label htmlFor="sbtiAligned" className={styles.toggleLabel}>
                {t("sbtiAligned")}
              </label>
            </div>
            <Input
              label={t("fieldBaselineYear")}
              type="number"
              value={form.baselineYear}
              onChange={(e) => setField("baselineYear", e.target.value)}
              placeholder="2024"
            />
            <Input
              label={t("fieldBaselineValue")}
              type="number"
              step="any"
              value={form.baselineValue}
              onChange={(e) => setField("baselineValue", e.target.value)}
            />
            <Input
              label={t("fieldTargetYear")}
              type="number"
              value={form.targetYear}
              onChange={(e) => setField("targetYear", e.target.value)}
              placeholder="2030"
            />
            <Input
              label={t("fieldTargetValue")}
              type="number"
              step="any"
              value={form.targetValue}
              onChange={(e) => setField("targetValue", e.target.value)}
            />
            <Input
              label={t("fieldCurrentValue")}
              type="number"
              step="any"
              value={form.currentValue}
              onChange={(e) => setField("currentValue", e.target.value)}
            />
          </div>
          <div className={styles.formActions}>
            <Button size="lg" onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2
                    size={18}
                    className={clsx(styles.btnIcon, styles.spin)}
                  />
                  {t("saving")}
                </>
              ) : form.id ? (
                <>
                  <Save size={18} className={styles.btnIcon} />{" "}
                  {t("saveChanges")}
                </>
              ) : (
                <>
                  <Plus size={18} className={styles.btnIcon} /> {t("addGoal")}
                </>
              )}
            </Button>
            {form.id && (
              <Button variant="ghost" onClick={resetForm} disabled={saving}>
                {t("cancel")}
              </Button>
            )}
            {error && <span className={styles.errorMsg}>{error}</span>}
          </div>
        </Card>

        {/* Goals list */}
        <h3 className={styles.listTitle}>{t("listTitle")}</h3>
        {rows.length === 0 ? (
          <Card>
            <p className={styles.emptyList}>
              {t.rich("emptyList", {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </Card>
        ) : (
          <div className={styles.goalsGrid}>
            {rows.map((goal) => {
              const baseline = numOrNull(s(goal.baselineValue));
              const target = numOrNull(s(goal.targetValue));
              const current = numOrNull(s(goal.currentValue));
              let progress: number | null = null;
              if (baseline != null && target != null && current != null) {
                const isReduction = target < baseline;
                progress = isReduction
                  ? ((baseline - current) / (baseline - target)) * 100
                  : ((current - baseline) / (target - baseline)) * 100;
                if (!Number.isFinite(progress)) progress = null;
              }

              return (
                <Card key={goal.id} className={styles.goalCard}>
                  <div className={styles.goalHeader}>
                    <div className={styles.goalBadges}>
                      <Badge variant="blue">
                        {categoryLabel(goal.category)}
                      </Badge>
                      {goal.sbtiAligned && <Badge variant="violet">SBTi</Badge>}
                      <Badge variant="gray">{statusLabel(goal.status)}</Badge>
                    </div>
                    <div className={styles.goalActions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(goal)}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleDelete(goal.id)}
                        loading={busyId === goal.id}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>

                  <h4 className={styles.goalTitle}>{goal.title}</h4>

                  <div className={styles.goalStats}>
                    <div className={styles.goalStat}>
                      <p className={styles.goalStatLabel}>{t("baseline")}</p>
                      <p
                        className={`${styles.goalStatValue} ${styles.statBaseline}`}
                      >
                        {baseline ?? "—"}
                      </p>
                    </div>
                    <div className={styles.goalStat}>
                      <p className={styles.goalStatLabel}>{t("current")}</p>
                      <p
                        className={`${styles.goalStatValue} ${styles.statCurrent}`}
                      >
                        {current ?? "—"}
                      </p>
                    </div>
                    <div className={styles.goalStat}>
                      <p className={styles.goalStatLabel}>{t("target")}</p>
                      <p
                        className={`${styles.goalStatValue} ${styles.statTarget}`}
                      >
                        {target ?? "—"}
                      </p>
                    </div>
                  </div>

                  {progress != null && (
                    <>
                      <ProgressBar
                        value={Math.min(100, Math.max(0, progress))}
                        color={
                          progress >= 100
                            ? "green"
                            : progress >= 50
                              ? "blue"
                              : "violet"
                        }
                        showLabel
                        label={goal.unit ?? ""}
                      />
                      <div className={styles.goalFooter}>
                        {progress >= 50 ? (
                          <TrendingDown
                            size={14}
                            className={styles.iconGreen}
                          />
                        ) : (
                          <Flag size={14} className={styles.iconYellow} />
                        )}
                        <span className={styles.goalFooterText}>
                          {progress >= 100
                            ? t("targetReached")
                            : t("progress", { pct: Math.round(progress) })}
                        </span>
                      </div>
                    </>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </FeatureGate>
    </PageLayout>
  );
}
