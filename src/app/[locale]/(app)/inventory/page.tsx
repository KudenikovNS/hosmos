"use client";

// =============================================================================
// `/inventory` — the Scope 1 and Scope 2 inventory (UI-2, VR-2, LC-5).
//
// WHAT THE SCREEN IS FOR. `/organisation` builds the frame — entities, sites,
// periods, boundary — and this is where the frame gets its numbers: the five
// Scope-1 categories of §4.9, purchased energy (§4.10) and the contractual
// instruments that make the market-based figure claimable (§4.11). Everything
// downstream (T5.3's calculation, T5.6's report) reads what is entered here, so
// the two things this screen must never blur are WHICH revision a figure belongs
// to and WHO is answerable for it.
//
// THE UI IS NOT THE GUARD (§0.1). `data.write` decides which FORMS render and
// `data.approve` whether the approve button exists; the routes enforce
// regardless, and a direct request without the capability is still a 403. Read
// access is `data.read`, so a reviewer or an auditor sees the whole inventory
// and none of the actions — the intended shape, not a degraded one. NO LINE OF
// THIS SCREEN DERIVES A RIGHT FROM A ROLE: the only source is
// `useCapabilities()`, which returns what the SERVER resolved, and the decision
// itself is one pure function (`_lib/actions#rowActionGates`) with a test over
// the whole capability matrix.
//
// THE REVISION IS THE SUBJECT, NOT THE PERIOD. A period may hold several
// revisions and exactly one is current (LC-1a); rows belong to a REVISION
// (DM-12), and mutating one is only legal while it is `draft` or `rejected`
// (LC-5). So the picker resolves period → current revision, the listing is
// filtered by `revision_id`, and a frozen revision is stated at the top rather
// than discovered through a refusal.
//
// LOADING WITHOUT AN EFFECT, as on `/organisation` and `/admin/factors`: every
// selection on this page (period, tab, opened row) is an EXPRESSION over what is
// loaded right now, never state synchronised in a `useEffect`. The lint baseline
// may not grow, and every remaining `react-hooks/set-state-in-effect` warning in
// the codebase comes from the pattern these three pages avoid.
// =============================================================================
import { Boxes, ClipboardCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useCapabilities } from "@/shared/hooks/useCapabilities";
import type { WorkflowStatus } from "@/shared/enums";
import { Badge } from "@/shared/ui/Badge";
import { NoReportingPeriodBanner } from "@/shared/ui/NoReportingPeriodBanner";
import { NoLegalEntityBanner } from "@/shared/ui/NoLegalEntityBanner";
import { NoReportRevisionBanner } from "@/shared/ui/NoReportRevisionBanner";
import { Select } from "@/shared/ui/Select";

import { PageLayout } from "../_components/PageLayout";
import {
  useAssets,
  useFacilities,
  useLegalEntities,
} from "../organisation/_lib/useOrganisation";
import {
  AccessNote,
  LoadErrorNote,
  Muted,
  SectionCard,
} from "../_components/ScreenKit";
import { InventoryTable } from "./_components/InventoryTable";
import { NewRowForm } from "./_components/NewRowForm";
import { RowDrawer } from "./_components/RowDrawer";
import { rowActionGates } from "./_lib/actions";
import { belongsToTab, TABS, tabOf, type TabId } from "./_lib/tabs";
import {
  type ListState,
  useInventoryRows,
  usePeriods,
  useRevisions,
  useRowWrites,
} from "./_lib/useInventory";
import styles from "./page.module.css";

function needsLegalEntitySetup(registry: ReturnType<typeof useLegalEntities>) {
  return (
    registry.loading ||
    registry.accessChanged ||
    registry.loadError ||
    registry.entities.length === 0
  );
}

/** Before periods are available, distinguish first setup from a failed read. */
function InventoryStartState({
  loading,
  accessChanged,
  loadError,
  missingLegalEntity = false,
}: Pick<ListState<unknown>, "loading" | "accessChanged" | "loadError"> & {
  missingLegalEntity?: boolean;
}) {
  const t = useTranslations("inventory");
  return (
    <PageLayout title={t("title")} subtitle={t("subtitle")} loading={loading}>
      {accessChanged ? (
        <AccessNote />
      ) : loadError ? (
        <LoadErrorNote />
      ) : missingLegalEntity ? (
        <NoLegalEntityBanner />
      ) : (
        <NoReportingPeriodBanner />
      )}
    </PageLayout>
  );
}

export default function InventoryPage() {
  const t = useTranslations("inventory");
  const caps = useCapabilities();
  // The SAME sets the routes require — read straight from the server-resolved
  // session, never reconstructed from a role.
  const capabilities = caps.capabilities;

  // The organisation registries this screen places rows against. They are
  // `/organisation`'s hooks, imported rather than re-declared: one query key per
  // registry means opening the inventory does not refetch what the other screen
  // already holds.
  const entities = useLegalEntities();
  const facilities = useFacilities();
  const assets = useAssets();

  const periods = usePeriods();
  const [pickedPeriodId, setPickedPeriodId] = useState<string | null>(null);
  // No effect: the pick is an expression over what is loaded right now.
  const period =
    periods.periods.find((entry) => entry.id === pickedPeriodId) ??
    periods.periods[0] ??
    null;
  const periodId = period?.id ?? null;

  const revisions = useRevisions(periodId);
  const revisionId = revisions.currentRevisionId;
  const revision = revisions.revisions.find((r) => r.id === revisionId) ?? null;
  const revisionStatus: WorkflowStatus | null = revision?.status ?? null;

  const [tabId, setTabId] = useState<TabId | null>(null);
  const tab = tabOf(tabId);

  const [queue, setQueue] = useState(false);
  const listing = useInventoryRows(revisionId, queue);
  const rows = listing.rows.filter((row) => belongsToTab(tab, row));

  // The opened version. NOT validated against the listing: after an edit the
  // drawer follows the NEW version's id (LC-5), and a version the user picked
  // out of the history chain is superseded and therefore absent from a listing
  // that shows current rows only (API-2). Both are legitimate things to have
  // open; the drawer answers 404 for anything else.
  const [openedId, setOpenedId] = useState<string | null>(null);

  const writes = useRowWrites(tab.family, revisionId);
  // The create form is gated by the SAME predicate the drawer's Save is: there
  // is one answer to "may this session write to this revision", not two.
  const gates = rowActionGates({ capabilities, revisionStatus, row: null });

  const openTab = (next: TabId) => {
    setTabId(next);
    setOpenedId(null);
  };

  if (needsLegalEntitySetup(entities)) {
    return <InventoryStartState {...entities} missingLegalEntity />;
  }

  if (
    periods.loading ||
    periods.accessChanged ||
    periods.loadError ||
    period === null
  ) {
    return <InventoryStartState {...periods} />;
  }

  const revisionReadable = !revisions.accessChanged && !revisions.loadError;
  const showRows = revisionReadable && revision !== null;

  return (
    <PageLayout
      title={t("title")}
      subtitle={t("subtitle")}
      loading={revisions.loading}
    >
      {revisions.accessChanged && <AccessNote />}
      {revisions.loadError && <LoadErrorNote />}
      {showRows && !caps.has("data.write") && (
        <div className={styles.readOnlyBanner}>
          <Muted>{t("readOnlyNote")}</Muted>
        </div>
      )}

      <SectionCard
        icon={<Boxes size={20} className={styles.iconBlue} />}
        title={t("revision.title")}
        subtitle={t("revision.subtitle")}
        badge={
          showRows && (
            <Badge variant={gates.revisionOpen ? "green" : "gray"} size="sm">
              {t("revision.badge", {
                no: revision.revision_no,
                status: t.has(`revision.status.${revision.status}`)
                  ? t(`revision.status.${revision.status}`)
                  : revision.status,
              })}
            </Badge>
          )
        }
      >
        <div className={styles.twoCol}>
          <Select
            label={t("revision.period")}
            id="inventory-period"
            options={periods.periods.map((period) => ({
              value: period.id,
              label: period.period_name,
            }))}
            value={periodId ?? ""}
            onChange={(e) => {
              setPickedPeriodId(e.target.value);
              setOpenedId(null);
            }}
          />
          {showRows && (
            <label className={styles.checkboxRow} htmlFor="inventory-queue">
              <input
                id="inventory-queue"
                type="checkbox"
                checked={queue}
                onChange={(e) => setQueue(e.target.checked)}
              />
              <ClipboardCheck size={14} /> {t("queue.label")}
            </label>
          )}
        </div>
        {showRows && !gates.revisionOpen && (
          <Muted>{t("revision.frozenBody")}</Muted>
        )}
      </SectionCard>

      {revisionReadable && revisionId === null && (
        <NoReportRevisionBanner periodName={period.period_name} />
      )}
      {revisionReadable && revisionId !== null && !revision && (
        <LoadErrorNote />
      )}

      {showRows && (
        <>
          <div className={styles.tabStrip} role="tablist">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={entry.id === tab.id}
                className={
                  entry.id === tab.id
                    ? styles.tabButtonActive
                    : styles.tabButton
                }
                onClick={() => openTab(entry.id)}
              >
                <span className={styles.tabScope}>
                  {t(`scopes.${entry.scope}`)}
                </span>
                {t(`tabs.${entry.id}`)}
              </button>
            ))}
          </div>

          <div className={styles.split}>
            <SectionCard
              icon={<Boxes size={20} className={styles.iconGreen} />}
              title={t(`tabs.${tab.id}`)}
              subtitle={t("table.subtitle")}
              badge={
                queue ? (
                  <Badge variant="yellow" size="sm">
                    {t("queue.badge", { count: rows.length })}
                  </Badge>
                ) : (
                  <Badge variant="gray" size="sm">
                    {t("table.count", { count: rows.length })}
                  </Badge>
                )
              }
            >
              <InventoryTable
                tab={tab}
                rows={rows}
                truncated={listing.truncated}
                loading={listing.loading}
                accessChanged={listing.accessChanged}
                loadError={listing.loadError}
                facilities={facilities.facilities}
                selectedId={openedId}
                onOpen={(row) => setOpenedId(row.id)}
              />

              {gates.canSaveDraft && revisionId && (
                <NewRowForm
                  // Remounting per tab is deliberate: a draft half-typed as a
                  // stationary row has no meaning on the instruments tab.
                  key={tab.id}
                  tab={tab}
                  revisionId={revisionId}
                  entities={entities.entities}
                  facilities={facilities.facilities}
                  assets={assets.assets}
                  onCreate={writes.create}
                  onCreated={setOpenedId}
                />
              )}
            </SectionCard>

            {openedId && (
              <RowDrawer
                key={openedId}
                tab={tab}
                rowId={openedId}
                revisionId={revisionId}
                revisionStatus={revisionStatus}
                revisions={revisions.revisions}
                capabilities={capabilities}
                entities={entities.entities}
                facilities={facilities.facilities}
                assets={assets.assets}
                onSelectVersion={setOpenedId}
                onSavedVersion={(from, to) =>
                  setOpenedId((current) => (current === from ? to : current))
                }
                onClose={() => setOpenedId(null)}
              />
            )}
          </div>
        </>
      )}
    </PageLayout>
  );
}
