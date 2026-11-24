"use client";

// =============================================================================
// `/organisation` — Organisation & Boundaries (UI-1, UI-7, PG-5, D14/D15).
//
// THE SCREEN EVERYTHING ELSE HANGS ON: without a legal entity there is no
// facility, without a period there is no boundary, and without a boundary there
// is no revision to lock. It composes six sections over the T2.2…T2.6 APIs and
// contributes no rules of its own.
//
// THE UI IS NOT THE GUARD (§0.1). `company.manage` decides which FORMS render;
// the routes enforce regardless, and a direct request without the capability is
// still a 403. Read access is `data.read`, so a reviewer or auditor sees the
// whole organisation and none of the forms — which is the intended shape, not a
// degraded one.
//
// LOADING WITHOUT AN EFFECT. Nothing on this page copies fetched data into state
// in a `useEffect`: forms LAYER a draft over the server row (see
// `_lib/useAutosave`), the wizard seeds from props in a lazy initialiser, and the
// selected period falls back to the first one by expression rather than by
// synchronisation. That is a deliberate constraint — the codebase's remaining
// `react-hooks/set-state-in-effect` warnings all come from the pattern this page
// avoids, and the lint baseline may not grow.
// =============================================================================
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { useCapabilities } from "@/shared/hooks/useCapabilities";
import { usePlan } from "@/shared/hooks/usePlan";
import { useCompany } from "@/shared/hooks/useSession";

import { PageLayout } from "../_components/PageLayout";
import { AssetsSection } from "./_components/AssetsSection";
import { BoundarySection } from "./_components/BoundarySection";
import { AccessNote, LoadErrorNote, Muted } from "../_components/ScreenKit";
import { FacilitiesSection } from "./_components/FacilitiesSection";
import { GroupSection } from "./_components/GroupSection";
import { OrganisationWizard } from "./_components/OrganisationWizard";
import { OrgTree } from "./_components/OrgTree";
import { PeriodsSection } from "./_components/PeriodsSection";
import { ProfileSection } from "./_components/ProfileSection";
import type { LegalEntityDto } from "./_lib/api";
import {
  useAssets,
  useBoundary,
  useFacilities,
  useLegalEntities,
  usePeriods,
} from "./_lib/useOrganisation";
import styles from "./page.module.css";

/**
 * The ROOT entity: the one with no parent. `listLegalEntities` orders by
 * `created_at`, so the first parentless row is the one the wizard created — and
 * a group that has somehow lost its root (only possible by hand) falls back to
 * the first entity rather than leaving the profile card empty.
 */
function rootOf(entities: LegalEntityDto[]): LegalEntityDto | null {
  return (
    entities.find((entity) => entity.parent_organisation_id === null) ??
    entities[0] ??
    null
  );
}

export default function OrganisationPage() {
  const t = useTranslations("organisation");
  const caps = useCapabilities();
  // The SAME capability the write routes require (`company.manage`) — read
  // straight from the server-resolved session, never reconstructed from a role.
  const canManage = caps.has("company.manage");
  const { features, loading: planLoading } = usePlan();
  const { company } = useCompany();

  const entities = useLegalEntities();
  const facilities = useFacilities();
  const assets = useAssets();
  const periods = usePeriods();

  // Партия 21 — the period a legal entity's validity window is judged against:
  // the current one, or the newest the company has. Only for the warning; the
  // boundary itself is decided by the server.
  const currentPeriod = useMemo(() => {
    const list = periods.periods;
    if (list.length === 0) return null;
    const newest = [...list].sort((a, b) =>
      b.start_date.localeCompare(a.start_date),
    )[0];
    return {
      name: newest.period_name,
      start_date: newest.start_date,
      end_date: newest.end_date,
    };
  }, [periods.periods]);

  const [pickedPeriodId, setPickedPeriodId] = useState<string | null>(null);
  // No effect: the pick is an expression over what is loaded right now.
  const selectedPeriodId =
    pickedPeriodId && periods.periods.some((p) => p.id === pickedPeriodId)
      ? pickedPeriodId
      : (periods.periods[0]?.id ?? null);
  const selectedPeriod =
    periods.periods.find((p) => p.id === selectedPeriodId) ?? null;
  const boundary = useBoundary(selectedPeriodId);

  const root = rootOf(entities.entities);
  const firstRun =
    !entities.loading &&
    !entities.accessChanged &&
    !entities.loadError &&
    entities.entities.length === 0;

  // API-3's `limit` is the WRITE entitlement and is authoritative; the plan
  // matrix is the fallback while the list is still in flight, so the PG-5
  // decision is never taken on a placeholder.
  const entityLimit = entities.limit ?? features.maxLegalEntities;
  const facilityLimit = facilities.limit ?? features.maxFacilities;

  return (
    <PageLayout
      title={t("title")}
      subtitle={t("subtitle")}
      loading={planLoading || entities.loading}
    >
      {entities.accessChanged && <AccessNote />}
      {entities.loadError && <LoadErrorNote />}
      {!canManage && !entities.accessChanged && (
        <div className={styles.readOnlyBanner}>
          <Muted>{t("readOnlyNote")}</Muted>
        </div>
      )}

      {firstRun ? (
        canManage && company ? (
          <OrganisationWizard company={company} onCreate={entities.create} />
        ) : (
          <Muted>{t("wizard.needsAdmin")}</Muted>
        )
      ) : (
        <>
          {root && (
            <ProfileSection
              entity={root}
              addressRequired={boundary.entries.some(
                (entry) =>
                  entry.legal_entity_id === root.id &&
                  entry.status === "included",
              )}
              canManage={canManage}
              onSave={entities.update}
            />
          )}

          <OrgTree
            entities={entities.entities}
            facilities={facilities.facilities}
            assets={assets.assets}
            rootId={root?.id ?? null}
            entityLimit={entityLimit}
            facilityLimit={facilityLimit}
          />

          <GroupSection
            entities={entities.entities}
            used={entities.used}
            limit={entityLimit}
            loading={entities.loading}
            accessChanged={entities.accessChanged}
            loadError={entities.loadError}
            canManage={canManage}
            rootId={root?.id ?? null}
            onCreate={entities.create}
            onUpdate={entities.update}
            period={currentPeriod}
          />

          <FacilitiesSection
            facilities={facilities.facilities}
            entities={entities.entities}
            used={facilities.used}
            limit={facilityLimit}
            loading={facilities.loading}
            accessChanged={facilities.accessChanged}
            loadError={facilities.loadError}
            canManage={canManage}
            onCreate={facilities.create}
            onUpdate={facilities.update}
          />

          <AssetsSection
            assets={assets.assets}
            entities={entities.entities}
            facilities={facilities.facilities}
            used={assets.used}
            loading={assets.loading}
            accessChanged={assets.accessChanged}
            loadError={assets.loadError}
            canManage={canManage}
            onCreate={assets.create}
            onUpdate={assets.update}
            onRemove={assets.remove}
          />

          <PeriodsSection
            periods={periods.periods}
            used={periods.used}
            consolidatedAvailable={periods.consolidatedAvailable}
            loading={periods.loading}
            accessChanged={periods.accessChanged}
            loadError={periods.loadError}
            canManage={canManage}
            selectedId={selectedPeriodId}
            onSelect={setPickedPeriodId}
            onCreate={periods.create}
            onUpdate={periods.update}
            onStartRevision={periods.startRevision}
          />

          <BoundarySection
            period={selectedPeriod}
            entities={entities.entities}
            entries={boundary.entries}
            loading={boundary.loading}
            accessChanged={boundary.accessChanged}
            loadError={boundary.loadError}
            canManage={canManage}
            onReplace={boundary.replace}
          />
        </>
      )}
    </PageLayout>
  );
}
