"use client";

import { PageLayout } from "../_components/PageLayout";
import { Card } from "@/shared/ui/Card";
import { Button } from "@/shared/ui/Button";
import { Badge } from "@/shared/ui/Badge";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";
import {
  Link2,
  Plus,
  Save,
  Pencil,
  Trash2,
  Loader2,
  ShieldCheck,
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

// ─── The `supply_chain_data` columns (§Q5) + the risk-level CHECK enum ─────────
// The enum VALUES are the contract with the DB CHECK constraint and stay here;
// only their labels are localised (supplyChain.riskLevels.*).
const RISK_VALUES = ["low", "medium", "high", "critical"] as const;

const RISK_BADGE: Record<string, "green" | "gray" | "yellow" | "red"> = {
  low: "green",
  medium: "gray",
  high: "yellow",
  critical: "red",
};

/** A persisted `supply_chain_data` row as it comes over the wire (numeric → string). */
interface SupplierRow {
  id: string;
  supplierName: string;
  supplierCountry: string | null;
  category: string | null;
  spendEur: string | null;
  emissionsTco2e: string | null;
  riskLevel: string | null;
  tier: number | null;
  esgScore: number | null;
  certified: boolean | null;
  certification: string | null;
  notes: string | null;
}

type FormState = {
  id: string | null;
  supplierName: string;
  supplierCountry: string;
  category: string;
  spendEur: string;
  emissionsTco2e: string;
  riskLevel: string;
  tier: string;
  esgScore: string;
  certified: boolean;
  certification: string;
  notes: string;
};

const emptyForm = (): FormState => ({
  id: null,
  supplierName: "",
  supplierCountry: "",
  category: "",
  spendEur: "",
  emissionsTco2e: "",
  riskLevel: "medium",
  tier: "1",
  esgScore: "",
  certified: false,
  certification: "",
  notes: "",
});

const s = (v: string | number | null | undefined) =>
  v == null ? "" : String(v);

/** Project a persisted row onto the editable form (numeric strings pass through). */
function rowToForm(row: SupplierRow): FormState {
  return {
    id: row.id,
    supplierName: s(row.supplierName),
    supplierCountry: s(row.supplierCountry),
    category: s(row.category),
    spendEur: s(row.spendEur),
    emissionsTco2e: s(row.emissionsTco2e),
    riskLevel: s(row.riskLevel) || "medium",
    tier: s(row.tier) || "1",
    esgScore: s(row.esgScore),
    certified: Boolean(row.certified),
    certification: s(row.certification),
    notes: s(row.notes),
  };
}

const numOrNull = (v: string) => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export default function SupplyChainPage() {
  const t = useTranslations("supplyChain");
  const { company, loading } = useCompany();
  const [rows, setRows] = useState<SupplierRow[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res =
        await apiFetch<ActionResult<SupplierRow[]>>("/api/supply-chain");
      if (res.ok) setRows(res.data);
    } catch (err) {
      console.error("Failed to load suppliers:", err);
    }
  }, []);

  // Fetch-on-mount: load the company's persisted suppliers. The fetch lives in a
  // nested async IIFE (matches the Goals/People page pattern).
  useEffect(() => {
    if (!company) return;
    let cancelled = false;
    (async () => {
      try {
        const res =
          await apiFetch<ActionResult<SupplierRow[]>>("/api/supply-chain");
        if (!cancelled && res.ok) setRows(res.data);
      } catch (err) {
        console.error("Failed to load suppliers:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company]);

  const riskOptions = useMemo(
    () =>
      RISK_VALUES.map((value) => ({ value, label: t(`riskLevels.${value}`) })),
    [t],
  );

  // A row may carry a risk level outside the current enum (older data): fall back
  // to the raw value rather than to a missing-message error.
  const riskLabel = (value: string | null) =>
    value && (RISK_VALUES as readonly string[]).includes(value)
      ? t(`riskLevels.${value}`)
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
    if (form.supplierName.trim() === "") {
      setError(t("errNoName"));
      return;
    }
    const isEdit = !!form.id;
    setSaving(true);
    setError(null);
    try {
      // Identity is never sent (PATTERN 3). `id` (when set) means edit-in-place;
      // we send only the raw disclosure values — no footprint coefficient (D7).
      const payload = {
        ...(form.id ? { id: form.id } : {}),
        supplierName: form.supplierName.trim(),
        supplierCountry: form.supplierCountry.trim() || null,
        category: form.category.trim() || null,
        spendEur: numOrNull(form.spendEur),
        emissionsTco2e: numOrNull(form.emissionsTco2e),
        riskLevel: form.riskLevel,
        tier: numOrNull(form.tier),
        esgScore: numOrNull(form.esgScore),
        certified: form.certified,
        certification: form.certification.trim() || null,
        notes: form.notes.trim() || null,
      };
      const res = await apiFetch<ActionResult<SupplierRow>>(
        "/api/supply-chain",
        { method: "POST", body: JSON.stringify(payload) },
      );
      if (!res.ok) throw new Error(res.error);
      await load();
      resetForm();
      toast.success(isEdit ? t("okUpdated") : t("okCreated"));
    } catch (err) {
      console.error("Failed to save supplier:", err);
      toast.error(
        err instanceof Error && err.message === "VALIDATION"
          ? t("errValidation")
          : t("errSave"),
      );
    } finally {
      setSaving(false);
    }
  }, [company, form, load, resetForm, t]);

  const handleEdit = useCallback((row: SupplierRow) => {
    setForm(rowToForm(row));
    setError(null);
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const res = await apiFetch<ActionResult<{ id: string }>>(
          `/api/supply-chain?id=${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error(res.error);
        if (form.id === id) resetForm();
        await load();
        toast.success(t("okDeleted"));
      } catch (err) {
        console.error("Failed to delete supplier:", err);
        toast.error(t("errDelete"));
      } finally {
        setBusyId(null);
      }
    },
    [form.id, load, resetForm, t],
  );

  // Summary figures derived from the persisted list.
  const total = rows.length;
  const certified = rows.filter((r) => r.certified).length;
  const highRisk = rows.filter(
    (r) => r.riskLevel === "high" || r.riskLevel === "critical",
  ).length;
  const scores = rows
    .map((r) => r.esgScore)
    .filter((v): v is number => typeof v === "number");
  const avgScore =
    scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : null;

  return (
    <PageLayout title={t("title")} subtitle={t("subtitle")} loading={loading}>
      <FeatureGate feature="supplyChain" title={t("gateTitle")}>
        {/* Summary */}
        <div className={styles.summaryGrid}>
          <Card padding="sm" className={styles.summaryCard}>
            <p className={styles.summaryLabel}>{t("totalSuppliers")}</p>
            <p className={`${styles.summaryValue} ${styles.valueGray}`}>
              {total}
            </p>
          </Card>
          <Card padding="sm" className={styles.summaryCard}>
            <p className={styles.summaryLabel}>{t("certifiedCount")}</p>
            <p className={`${styles.summaryValue} ${styles.valueGreen}`}>
              {certified}
            </p>
          </Card>
          <Card padding="sm" className={styles.summaryCard}>
            <p className={styles.summaryLabel}>{t("highCriticalRisk")}</p>
            <p className={`${styles.summaryValue} ${styles.valueYellow}`}>
              {highRisk}
            </p>
          </Card>
          <Card padding="sm" className={styles.summaryCard}>
            <p className={styles.summaryLabel}>{t("avgScore")}</p>
            <p className={`${styles.summaryValue} ${styles.valueBlue}`}>
              {avgScore ?? "—"}
            </p>
          </Card>
        </div>

        {/* Add / edit form */}
        <Card className={styles.formCard}>
          <div className={styles.formHeader}>
            <Link2 size={20} className={styles.iconBlue} />
            <h3 className={styles.formTitle}>
              {form.id ? t("editSupplier") : t("addSupplierForm")}
            </h3>
          </div>
          <div className={styles.formGrid}>
            <Input
              label={t("fieldName")}
              value={form.supplierName}
              onChange={(e) => setField("supplierName", e.target.value)}
              placeholder="Metal Parts GmbH"
            />
            <Input
              label={t("fieldCountry")}
              value={form.supplierCountry}
              onChange={(e) => setField("supplierCountry", e.target.value)}
              placeholder={t("fieldCountryPlaceholder")}
            />
            <Input
              label={t("fieldCategory")}
              value={form.category}
              onChange={(e) => setField("category", e.target.value)}
              placeholder={t("fieldCategoryPlaceholder")}
            />
            <Select
              label={t("fieldRiskLevel")}
              options={riskOptions}
              value={form.riskLevel}
              onChange={(e) => setField("riskLevel", e.target.value)}
            />
            <Input
              label={t("fieldSpend")}
              type="number"
              step="any"
              value={form.spendEur}
              onChange={(e) => setField("spendEur", e.target.value)}
              placeholder="0"
            />
            <Input
              label={t("fieldEmissions")}
              type="number"
              step="any"
              value={form.emissionsTco2e}
              onChange={(e) => setField("emissionsTco2e", e.target.value)}
              placeholder="0"
            />
            <Input
              label={t("fieldTier")}
              type="number"
              value={form.tier}
              onChange={(e) => setField("tier", e.target.value)}
              placeholder="1"
            />
            <Input
              label={t("fieldEsgScore")}
              type="number"
              value={form.esgScore}
              onChange={(e) => setField("esgScore", e.target.value)}
              placeholder={t("fieldEsgScorePlaceholder")}
            />
            <Input
              label={t("fieldCertification")}
              value={form.certification}
              onChange={(e) => setField("certification", e.target.value)}
              placeholder="ISO 14001"
            />
            <div className={styles.toggleRow}>
              <input
                id="certified"
                type="checkbox"
                checked={form.certified}
                onChange={(e) => setField("certified", e.target.checked)}
              />
              <label htmlFor="certified" className={styles.toggleLabel}>
                {t("certifiedSupplier")}
              </label>
            </div>
            <div className={styles.formFull}>
              <Input
                label={t("fieldNotes")}
                value={form.notes}
                onChange={(e) => setField("notes", e.target.value)}
                placeholder={t("fieldNotesPlaceholder")}
              />
            </div>
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
                  <Plus size={18} className={styles.btnIcon} />{" "}
                  {t("addSupplier")}
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

        {/* Supplier List */}
        <Card className={styles.tableCard}>
          <h3 className={styles.tableTitle}>{t("suppliers")}</h3>
          {rows.length === 0 ? (
            <p className={styles.emptyList}>
              {t.rich("emptyList", {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr className={styles.headRow}>
                    <th className={styles.th}>{t("thCompany")}</th>
                    <th className={styles.th}>{t("thCountry")}</th>
                    <th className={styles.th}>{t("thRisk")}</th>
                    <th className={styles.th}>{t("thScore")}</th>
                    <th className={styles.th}>{t("thCertified")}</th>
                    <th className={styles.thRight}>{t("thActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={styles.row}>
                      <td className={styles.td}>
                        <div className={styles.company}>
                          <div className={styles.companyIcon}>
                            <Link2 size={14} className={styles.iconBlue} />
                          </div>
                          <span className={styles.companyName}>
                            {r.supplierName}
                          </span>
                        </div>
                      </td>
                      <td
                        className={styles.tdCountry}
                        data-label={t("thCountry")}
                      >
                        {r.supplierCountry || "—"}
                      </td>
                      <td className={styles.td} data-label={t("thRisk")}>
                        <Badge
                          variant={
                            RISK_BADGE[r.riskLevel ?? "medium"] ?? "gray"
                          }
                        >
                          {riskLabel(r.riskLevel)}
                        </Badge>
                      </td>
                      <td className={styles.td} data-label={t("thScore")}>
                        {r.esgScore != null ? (
                          <span className={styles.score}>{r.esgScore}/100</span>
                        ) : (
                          <span className={styles.scoreEmpty}>—</span>
                        )}
                      </td>
                      <td className={styles.td} data-label={t("thCertified")}>
                        {r.certified ? (
                          <Badge variant="green">
                            <ShieldCheck
                              size={10}
                              className={styles.badgeIcon}
                            />
                            {r.certification || t("thCertified")}
                          </Badge>
                        ) : (
                          <span className={styles.scoreEmpty}>—</span>
                        )}
                      </td>
                      <td className={styles.tdRight}>
                        <div className={styles.rowActions}>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleEdit(r)}
                          >
                            <Pencil size={12} />
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleDelete(r.id)}
                            loading={busyId === r.id}
                          >
                            <Trash2 size={12} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </FeatureGate>
    </PageLayout>
  );
}
