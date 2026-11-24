"use client";

// Scope-3 spend-line editor (§Q3(b)/§Q3-FX, DATA-INTEGRITY-PLAN T2.4). The client
// for the T1.5b spend engine: a repeatable per-commodity line editor whose ONLY
// output is `{commodityKey, spendAmount, currency}` — the EXIOBASE factor and the
// FX conversion are applied server-side (the client never sends a coefficient or a
// rate). The commodity + currency dropdowns are DB-derived (fetched from the route),
// so they cannot drift from what the engine resolves. Gated behind the `scope3`
// FeatureGate (UX only; the route re-checks the entitlement).
//
// T3.6 (О-8/MIG-10) MOVED IT OFF `/calculator` ONTO `/inventory/scope-3`. The
// component itself is unchanged apart from its message namespace: it used to
// live under `calculator.scope3Spend`, and `calculator` — the page and the whole
// i18n namespace — is deleted by T3.8. Its host page says what the page's own
// header says: these figures are an ESTIMATE and sit OUTSIDE the gross Scope 1+2
// totals.
//
// AND IT SAYS WHEN IT CANNOT PRICE ANYTHING AT ALL. A factor set that carries no
// per-€1000 spend factors (the client's own `si-2025` is one, by design) leaves
// the commodity catalogue empty, and an empty dropdown beside a 422 that names
// no reason reads as a broken feature. It is not one: it is the factor library
// declining to price spend, which is the same fact the calculation layer states
// rather than rounding to zero (§0.7). So the refusal comes down NAMED
// (`NO_SPEND_FACTORS`, `../_lib/api`), the explanation replaces the add-row
// where the editor would have been, and money already entered stays on screen
// marked UNPRICED — because a line nothing can price is not a line worth
// nothing, and this screen must not let it be read as one.
import { AlertTriangle, Ban, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { apiFetch } from "@/shared/api/client";
import { FeatureGate } from "@/shared/components/FeatureGate";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Card } from "@/shared/ui/Card";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import {
  classifyRefusal,
  spendRefusalOf,
  unpriceableSpend,
  type ApiBody,
  type Refusal,
  type SpendFactorSetRef,
  type SpendView,
  type SpendWriteData,
} from "../_lib/api";
import styles from "./Scope3SpendEditor.module.css";

/**
 * WHY SPEND CANNOT BE PRICED — where the add-row would have been.
 *
 * The same register as `PlanNote` on `/review`: it names the thing that is in
 * the way (the factor set, by name and code), says what would change it, and
 * states in its own sentence that the lines below are UNPRICED rather than zero.
 * Not a toast — a toast is for something that just happened, and this is a
 * standing fact about the period that outlives any one click.
 */
function UnpriceableNote({
  year,
  factorSet,
}: {
  year: string;
  factorSet: SpendFactorSetRef | null;
}) {
  const t = useTranslations("scope3.editor");
  return (
    <div role="note" className={styles.unpriceable}>
      <Ban size={16} className={styles.unpriceableIcon} />
      <div>
        <p className={styles.unpriceableTitle}>{t("unpriceableTitle")}</p>
        <p className={styles.unpriceableBody}>
          {factorSet
            ? t("unpriceableBody", {
                year,
                name: factorSet.name,
                code: factorSet.code,
              })
            : t("unpriceableBodyNoSet", { year })}
        </p>
        <p className={styles.unpriceableHint}>{t("unpriceableLines")}</p>
      </div>
    </div>
  );
}

export function Scope3SpendEditor({ year }: { year: string }) {
  const t = useTranslations("scope3.editor");
  // The named-refusal vocabulary, looked up BY TOKEN (`refusals.<token>`) — the
  // same shape `/admin/factors` renders `NEW_VERSION_ONLY` with.
  const tRefusals = useTranslations("scope3.refusals");
  const format = useFormatter();
  const [view, setView] = useState<SpendView | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last NAMED refusal, whether it came down with the GET (`spendRefusal` —
  // the state was already true when the screen opened) or with a refused POST
  // (the set was retired while the screen was open). One state, one renderer.
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  // Draft "new line" inputs.
  const [draftKey, setDraftKey] = useState("");
  const [draftAmount, setDraftAmount] = useState("");
  const [draftCurrency, setDraftCurrency] = useState("");

  // Fetch-on-mount + reload whenever the reporting year changes (the fresh view
  // replaces the old). The setState lives inside the async body (people-page pattern).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<ApiBody<SpendView>>(
          `/api/scope3-spend?year=${year}`,
        );
        if (cancelled || !res.ok) return;
        setView(res.data);
        setRefusal(spendRefusalOf(res.data));
        setDraftCurrency((c) => c || res.data.defaultCurrency);
      } catch (err) {
        console.error("Failed to load spend lines:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [year]);

  // Cat 1/2 are the only spend-based categories; anything else falls back to the
  // generic "Cat N" label rather than rendering an empty cell.
  const catLabel = (category: number) =>
    category === 1 || category === 2
      ? t(`cat${category}`)
      : t("catN", { n: category });

  const applyResult = useCallback((data: SpendWriteData) => {
    setWarnings(data.warnings ?? []);
    setView((prev) => (prev ? { ...prev, lines: data.lines } : prev));
  }, []);

  const addLine = useCallback(async () => {
    if (!draftKey || draftAmount.trim() === "") return;
    const amount = Number(draftAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setError(t("errNegative"));
      return;
    }
    // Whether this commodity already has a line decides add-vs-update wording;
    // capture it before the request resets `draftKey`.
    const isUpdate = (view?.lines ?? []).some(
      (l) => l.commodityKey === draftKey,
    );
    setBusy(true);
    setError(null);
    try {
      // The body carries ONLY commodity + amount + currency — no factor, no rate.
      const res = await apiFetch<ApiBody<SpendWriteData>>(
        `/api/scope3-spend?year=${year}`,
        {
          method: "POST",
          body: JSON.stringify({
            commodityKey: draftKey,
            spendAmount: amount,
            currency: draftCurrency,
          }),
        },
      );
      if (!res.ok) {
        // WHY, not just "no". A NAMED refusal is kept in state so the note below
        // renders it as a standing explanation (the set was retired while this
        // screen was open); everything else keeps the copy it always had.
        const why = classifyRefusal(res);
        if (unpriceableSpend(why)) setRefusal(why);
        toast.error(
          why.kind === "refused" && tRefusals.has(why.refusal)
            ? tRefusals(why.refusal)
            : res.error === "VALIDATION"
              ? t("errValidation")
              : t("errSave"),
        );
        return;
      }
      applyResult(res.data);
      setDraftKey("");
      setDraftAmount("");
      toast.success(isUpdate ? t("okUpdated") : t("okAdded"));
    } catch (err) {
      console.error("Failed to save spend line:", err);
      toast.error(t("errSave"));
    } finally {
      setBusy(false);
    }
  }, [
    draftKey,
    draftAmount,
    draftCurrency,
    year,
    applyResult,
    view,
    t,
    tRefusals,
  ]);

  const removeLine = useCallback(
    async (commodityKey: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await apiFetch<ApiBody<SpendWriteData>>(
          `/api/scope3-spend?year=${year}&commodityKey=${commodityKey}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error(res.error);
        applyResult(res.data);
        toast.success(t("okRemoved"));
      } catch (err) {
        console.error("Failed to remove spend line:", err);
        toast.error(t("errRemove"));
      } finally {
        setBusy(false);
      }
    },
    [year, applyResult, t],
  );

  const commodities = view?.commodities ?? [];
  const currencies = view?.currencies ?? [];
  const lines = view?.lines ?? [];
  const commodityLabel = (key: string) =>
    commodities.find((c) => c.commodityKey === key)?.label ?? key;

  // THE CONDITIONAL BRANCH. Non-null only when the server answered
  // `NO_SPEND_FACTORS` — i.e. no ACTIVE factor set carries per-€1000 spend
  // factors. Everything below that reads it is off on every ordinary load, which
  // is what makes "a spend-capable set behaves exactly as before" true by shape
  // rather than by hope.
  const unpriceable = unpriceableSpend(refusal);

  return (
    <FeatureGate feature="scope3" title={t("gateTitle")}>
      <Card className={styles.spanFull}>
        <div className={styles.header}>
          <div>
            <h3 className={styles.title}>{t("title")}</h3>
            <p className={styles.subtitle}>{t("subtitle", { year })}</p>
          </div>
          <div className={styles.badges}>
            <Badge variant="violet">EXIOBASE</Badge>
            <Badge variant="violet">GHG Protocol</Badge>
          </div>
        </div>

        {warnings.length > 0 && (
          <div className={styles.warnBox}>
            <AlertTriangle size={16} />
            <div>
              {warnings.map((w, i) => (
                <p key={i} className={styles.warnText}>
                  {w}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Existing lines. Money already entered is NEVER hidden by a refusal —
            it is the user's own figure and it is still true. What changes is
            what it is said to MEAN: an unpriceable line carries the "unpriced"
            badge, so it cannot be read as a line that came to zero tonnes. */}
        {lines.length > 0 ? (
          <div className={styles.lines}>
            {lines.map((l) => (
              <div key={l.id} className={styles.line}>
                <span className={styles.lineCat}>{catLabel(l.category)}</span>
                <span className={styles.lineLabel}>
                  {commodityLabel(l.commodityKey)}
                </span>
                <span className={styles.lineAmount}>
                  {format.number(l.spendAmount)} {l.currency}
                </span>
                {unpriceable && (
                  <span
                    className={styles.lineUnpriced}
                    title={t("unpricedHint")}
                  >
                    <Badge variant="gray">{t("unpriced")}</Badge>
                  </span>
                )}
                <button
                  type="button"
                  className={styles.removeBtn}
                  onClick={() => removeLine(l.commodityKey)}
                  disabled={busy}
                  aria-label={t("remove", {
                    label: commodityLabel(l.commodityKey),
                  })}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          // The ordinary empty state promises that no lines means 0 tCO2e. That
          // promise is FALSE when nothing can be priced, so it is not made.
          <p className={styles.empty}>
            {unpriceable ? t("emptyUnpriceable", { year }) : t("empty")}
          </p>
        )}

        {/* The add-row, OR the explanation that stands in its place. */}
        {unpriceable ? (
          <UnpriceableNote year={year} factorSet={unpriceable.factorSet} />
        ) : (
          <div className={styles.addRow}>
            <div className={styles.commodityField}>
              <Select
                label={t("commodity")}
                options={commodities.map((c) => ({
                  value: c.commodityKey,
                  label: t("commodityOption", {
                    cat: catLabel(c.category),
                    label: c.label,
                  }),
                }))}
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
              />
            </div>
            <div className={styles.amountField}>
              <Input
                label={t("amount")}
                type="number"
                min="0"
                step="any"
                value={draftAmount}
                onChange={(e) => setDraftAmount(e.target.value)}
              />
            </div>
            <div className={styles.currencyField}>
              <Select
                label={t("currency")}
                options={currencies.map((c) => ({
                  value: c.code,
                  label: `${c.code} (${c.symbol})`,
                }))}
                value={draftCurrency}
                onChange={(e) => setDraftCurrency(e.target.value)}
              />
            </div>
            <Button
              className={styles.addBtn}
              onClick={addLine}
              disabled={busy || !draftKey || draftAmount.trim() === ""}
            >
              {busy ? (
                <Loader2 size={16} className={styles.spin} />
              ) : lines.some((l) => l.commodityKey === draftKey) ? (
                <>
                  <Save size={16} /> {t("update")}
                </>
              ) : (
                <>
                  <Plus size={16} /> {t("add")}
                </>
              )}
            </Button>
          </div>
        )}

        {error && <p className={styles.errorMsg}>{error}</p>}

        {/* The footnote describes an FX conversion that is not going to happen
            while nothing can be priced; the unpriceable note says what does. */}
        {!unpriceable && (
          <p className={styles.footnote}>{t("footnote", { year })}</p>
        )}
      </Card>
    </FeatureGate>
  );
}
