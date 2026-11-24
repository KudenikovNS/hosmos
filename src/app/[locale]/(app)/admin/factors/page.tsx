"use client";

// =============================================================================
// `/admin/factors` — the factor library (UI-4; DM-21, DM-22, §12.2).
//
// WHAT THE SCREEN IS FOR. A `reporting_period` pins a `factor_set` (К-24), and
// that pin is the whole basis of AC-8: a locked report reproduces because the
// numbers behind it cannot move. This page is where that promise is visible —
// which sets exist, which one is released, what each is built from, and the one
// legal way to change a number: a NEW VERSION.
//
// THE UI IS NOT THE GUARD (§0.1). `factors.custom` decides which BUTTONS render
// and whether the sidebar shows the entry at all; the routes enforce regardless,
// and a direct POST without the capability is still a 403. Reading is
// `data.read`, so a reviewer or an auditor sees the whole library and none of
// the actions — the intended shape, not a degraded one.
//
// LOADING WITHOUT AN EFFECT, as on `/organisation`: the selected set is an
// EXPRESSION over what is loaded right now (falling back to the first set),
// never state synchronised in a `useEffect`. The lint baseline may not grow, and
// every remaining `react-hooks/set-state-in-effect` warning in the codebase
// comes from the pattern this page avoids.
// =============================================================================
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useCapabilities } from "@/shared/hooks/useCapabilities";

import { PageLayout } from "../../_components/PageLayout";
import { AccessNote, LoadErrorNote, Muted } from "../../_components/ScreenKit";
import { FactorsSection } from "./_components/FactorsSection";
import { SetsSection } from "./_components/SetsSection";
import {
  useFactors,
  useFactorSetDetail,
  useFactorSets,
} from "./_lib/useFactors";
import styles from "./page.module.css";

export default function AdminFactorsPage() {
  const t = useTranslations("factors");
  const caps = useCapabilities();
  // The SAME capability the write routes require — read straight from the
  // server-resolved session, never reconstructed from a role.
  const canManage = caps.has("factors.custom");

  const library = useFactorSets();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  // No effect: the pick is an expression over what is loaded right now.
  const selectedId =
    pickedId && library.sets.some((set) => set.id === pickedId)
      ? pickedId
      : (library.sets[0]?.id ?? null);

  const detail = useFactorSetDetail(selectedId);
  const factors = useFactors(selectedId, search, offset);

  const select = (id: string) => {
    setPickedId(id);
    setOffset(0);
  };
  const changeSearch = (value: string) => {
    setSearch(value);
    setOffset(0);
  };

  return (
    <PageLayout
      title={t("title")}
      subtitle={t("subtitle")}
      loading={library.loading}
    >
      {library.accessChanged && <AccessNote />}
      {library.loadError && <LoadErrorNote />}
      {!canManage && !library.accessChanged && (
        <div className={styles.readOnlyBanner}>
          <Muted>{t("readOnlyNote")}</Muted>
        </div>
      )}

      <SetsSection
        sets={library.sets}
        selectedId={selectedId}
        loading={library.loading}
        canManage={canManage}
        onSelect={select}
        onCreate={library.create}
        onUpdate={library.update}
      />

      <FactorsSection
        set={detail.set}
        provenance={detail.provenance}
        factors={factors.factors}
        total={factors.total}
        search={search}
        offset={offset}
        loading={factors.loading}
        loadError={factors.loadError}
        onSearch={changeSearch}
        onOffset={setOffset}
      />
    </PageLayout>
  );
}
