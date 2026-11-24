"use client";

// =============================================================================
// THE DATA HOOKS OF `/inventory/disclosures` (T3.5b).
//
// TWO READS AND THREE WRITES, and the shape of all five is `../../_lib/
// useInventory`'s: `useList` and `useWrite` are imported from it rather than
// re-written, so "a 403 on a list is `accessChanged`" and "a write returns a
// `WriteOutcome` and never throws" are ONE decision for both screens.
//
// WHAT IS DIFFERENT HERE, and there are three things:
//
//   1. THE CATALOGUE IS NOT TENANT DATA. `GET /api/metrics` returns the same 141
//      rows for every company (T2.8 — reading the catalogue is reading the
//      standard, and PG-6 gates the VALUE, not the metric), so its query key
//      carries no company and no revision. One fetch feeds all 20 sections.
//   2. THE ANSWERS ARE ONE LIST PER REVISION. `GET /api/disclosures?revision_id`
//      returns the CURRENT, non-deleted records of the revision — every metric's
//      answer in one request, which is what lets the screen show 141 states
//      without 141 round trips. The screen indexes them by metric itself
//      (`./catalog#recordsByMetric`), because "which record answers this metric"
//      also depends on the legal entity being edited.
//   3. AN EDIT IS A NEW ROW, SO THE LIST IS THE SUBJECT. Unlike the drawer of
//      `/inventory`, nothing here holds a row id across a save: the new version
//      arrives in the refetched list under the same metric, and the card reads
//      it from there. That is why every write invalidates exactly one key.
// =============================================================================
import { useLocale } from "next-intl";
import { useCallback } from "react";

import { useList, useWrite } from "../../_lib/useInventory";
import type {
  DisclosureDto,
  DisclosureListData,
  MetricDto,
  MetricListData,
  WriteOutcome,
} from "./api";

/** react-query keys. The catalogue's is revision-free on purpose (see above). */
// `standard=all` (0019): the VSME rows AND the 50 simplified-ESRS rows. The
// ESRS sections render locked on a plan without the layer, as C1…C9 do
// without Comprehensive — visible, so the upgrade has a face (PG-5).
const metricsKey = (locale: string) => ["metrics", "all", locale] as const;
const disclosuresKey = (revisionId: string) =>
  ["disclosures", revisionId] as const;

/** Stable empty arrays — a fresh `[]` per render would churn every memo. */
const NO_METRICS: MetricDto[] = [];
const NO_RECORDS: DisclosureDto[] = [];

/** The VSME catalogue (T2.8) — the data this whole screen is generated from. */
export function useMetrics() {
  // Партия 18 — the catalogue's words (`text`) come in the UI language.
  const locale = useLocale();
  const list = useList<MetricListData>(
    metricsKey(locale),
    `/api/metrics?standard=all&locale=${encodeURIComponent(locale)}`,
  );
  return {
    metrics: list.data?.metrics ?? NO_METRICS,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/** The CURRENT disclosure records of one revision (LC-6 — no tombstones). */
export function useDisclosureRecords(revisionId: string | null) {
  const list = useList<DisclosureListData>(
    disclosuresKey(revisionId ?? "none"),
    revisionId ? `/api/disclosures?revision_id=${revisionId}` : null,
  );
  return {
    records: list.data?.disclosures ?? NO_RECORDS,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/**
 * The three writes of a disclosure (LC-3, LC-5, LC-4).
 *
 * `edit` is a PATCH, which the server turns into a NEW VERSION with a new id —
 * and `change_reason` is required when the version being superseded is
 * `approved` (LC-5). The card asks for the reason first; the server refuses
 * without it regardless. Same rule, two places, one authority.
 */
export function useDisclosureWrites(revisionId: string | null) {
  const write = useWrite();

  // The invalidation set is built INSIDE each callback, exactly as
  // `useRowWrites` builds its own: a fresh array above them would be a new
  // dependency on every render, and every consumer of these callbacks would see
  // an identity that never settles.
  const create = useCallback(
    (body: unknown): Promise<WriteOutcome<DisclosureDto>> =>
      write<DisclosureDto>("/api/disclosures", "POST", body, [
        disclosuresKey(revisionId ?? "none"),
      ]),
    [write, revisionId],
  );

  const edit = useCallback(
    (id: string, body: unknown): Promise<WriteOutcome<DisclosureDto>> =>
      write<DisclosureDto>(`/api/disclosures/${id}`, "PATCH", body, [
        disclosuresKey(revisionId ?? "none"),
      ]),
    [write, revisionId],
  );

  const approve = useCallback(
    (id: string): Promise<WriteOutcome<DisclosureDto>> =>
      write<DisclosureDto>(
        `/api/disclosures/${id}/approve`,
        "POST",
        undefined,
        [disclosuresKey(revisionId ?? "none")],
      ),
    [write, revisionId],
  );

  return { create, edit, approve };
}
