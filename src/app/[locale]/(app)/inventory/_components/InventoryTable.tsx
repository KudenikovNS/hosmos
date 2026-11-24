"use client";

// =============================================================================
// THE LISTING OF ONE TAB (UI-2) — the cross-table inventory, filtered.
//
// WHAT IT IS SHOWING, precisely: CURRENT versions of NON-DELETED rows of the
// selected revision. None of those three is a filter this screen turns on —
// `/api/inventory` applies them unconditionally (API-2, LC-6), because a listing
// that could return every version would count each edit as a row and the number
// on screen would be how often somebody typed rather than the size of the report.
//
// THE COLUMNS ARE THE SERVER'S BODY SUMMARY, not a projection of this file's
// choosing: `kind`, `label` and `quantity` are the three columns `BODY_SUMMARY`
// declares per table, plus the mixin's placement and `unit`. A tab that wanted a
// fourth would change that map, not this component — which is exactly the note
// T3.4 left for T3.5.
//
// TRUNCATION IS STATED. The read stops at `MAX_INVENTORY_ROWS`; saying so is the
// difference between "this is the inventory" and "this is as much of it as one
// request returns".
// =============================================================================
import { useFormatter, useTranslations } from "next-intl";

import type { FacilityDto, InventoryRowDto } from "../_lib/api";
import type { TabSpec } from "../_lib/tabs";
import styles from "../page.module.css";
import { AccessNote, LoadErrorNote, Muted } from "../../_components/ScreenKit";
import { StateBadge } from "./common";

export function InventoryTable({
  tab,
  rows,
  truncated,
  loading,
  accessChanged,
  loadError,
  facilities,
  selectedId,
  onOpen,
}: {
  tab: TabSpec;
  rows: InventoryRowDto[];
  truncated: boolean;
  loading: boolean;
  accessChanged: boolean;
  loadError: boolean;
  facilities: FacilityDto[];
  selectedId: string | null;
  onOpen: (row: InventoryRowDto) => void;
}) {
  const t = useTranslations("inventory");
  const format = useFormatter();

  if (accessChanged) return <AccessNote />;
  if (loading) return <Muted>{t("loadingSection")}</Muted>;
  if (loadError) return <LoadErrorNote />;
  if (rows.length === 0) return <Muted>{t("table.empty")}</Muted>;

  const site = (id: string | null) =>
    id
      ? (facilities.find((facility) => facility.id === id)?.facility_name ??
        t("table.unknownSite"))
      : // A row with no site is legal and carries its reason in `notes` (VAL-104,
        // AC-2) — so it is labelled, never blank.
        t("table.noSite");

  return (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t("table.label")}</th>
              <th>{t("table.kind")}</th>
              <th>{t("table.site")}</th>
              <th>{t("table.period")}</th>
              <th>{t("table.quantity")}</th>
              <th>{t("table.state")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={row.id === selectedId ? styles.rowActive : undefined}
              >
                <td>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => onOpen(row)}
                  >
                    {row.label ?? t("table.unnamed")}
                  </button>
                </td>
                <td>
                  {t.has(`enums.kind.${row.kind}`)
                    ? t(`enums.kind.${row.kind}`)
                    : row.kind}
                </td>
                <td>{site(row.facility_id)}</td>
                <td>{row.year_month ?? t("table.wholePeriod")}</td>
                <td>
                  {row.quantity === null
                    ? "—"
                    : `${format.number(row.quantity)} ${row.unit ?? ""}`.trim()}
                </td>
                <td>
                  <StateBadge state={row.state} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && <Muted>{t("table.truncated")}</Muted>}
      <Muted>{t(`table.hint.${tab.scope}`)}</Muted>
    </>
  );
}
