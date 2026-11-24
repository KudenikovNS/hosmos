"use client";

// =============================================================================
// `/inventory/scope-3` — SPEND-BASED SCOPE 3, AS AN ESTIMATE (О-8/MIG-10, T3.6).
//
// WHY THE SCREEN EXISTS. The editor itself is not new: it shipped on
// `/calculator`, and it is a live, billable feature (`scope3` entitlement). What
// is new is that `/calculator` is deleted in T3.8 along with the wide-table
// model it was built on. The spend feature is PARKED, not dropped — `scope3_spend`
// and `scope3_results` survive Phase 1 — so it needs a home that survives with
// it, and `/inventory` is where figures are entered.
//
// IT IS NOT PART OF THE GROSS TOTAL, AND THE PAGE SAYS SO. Everything else under
// `/inventory` is measured activity that the Phase-1 calculation turns into the
// gross Scope 1 + Scope 2 figures. This is a spend-based ESTIMATE: euros of
// purchasing multiplied by an EXIOBASE industry average. It is a legitimate
// GHG-Protocol screening method for categories 1 and 2 and a genuinely useful
// number, and it is NOT of the same order of confidence as a metered kWh. So the
// distinction is stated on the page, above the editor, rather than left to be
// inferred from where the number does not appear.
//
// THE YEAR IS THE COMPANY'S REPORTING YEAR. `scope3_spend` is keyed by
// `(company, year, commodity)` and predates the Phase-1 period model (it is Phase
// 3's to re-home, О-10); the route defaults to `companies.reporting_year` and the
// screen asks for the same one, so the two cannot disagree about which year is
// being edited.
// =============================================================================
import { Coins } from "lucide-react";
import { useTranslations } from "next-intl";

import { useCompany } from "@/shared/hooks/useSession";

import { PageLayout } from "../../_components/PageLayout";
import { Scope3SpendEditor } from "./_components/Scope3SpendEditor";
import styles from "./page.module.css";

export default function Scope3SpendPage() {
  const t = useTranslations("scope3.page");
  const { company, loading } = useCompany();
  const year = company?.reporting_year ?? String(new Date().getFullYear() - 1);

  return (
    <PageLayout title={t("title")} subtitle={t("subtitle")} loading={loading}>
      <div className={styles.estimateNote}>
        <Coins size={16} className={styles.estimateIcon} />
        <div>
          <p className={styles.estimateTitle}>{t("estimateTitle")}</p>
          <p className={styles.estimateBody}>{t("estimateBody")}</p>
        </div>
      </div>

      <Scope3SpendEditor year={year} />
    </PageLayout>
  );
}
