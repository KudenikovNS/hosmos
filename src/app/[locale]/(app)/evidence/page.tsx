"use client";

// =============================================================================
// `/evidence` — the document library, the links, the data quality and the change
// timeline (T4.5 — UI-3 first half; §4.16, §4.17, EV-0…EV-6, DQ-1…DQ-3, LC-10).
//
// WHAT THE SCREEN IS FOR. `/inventory` holds the numbers; this is where the
// numbers acquire a reason to be believed. Three things happen here and they are
// one workflow, not three screens: a paper is uploaded and described (§4.16), it
// is attached to the figure it stands behind (DM-25), and the figure's quality
// is scored and its history read (DM-27, LC-10). The second half of UI-3 — the
// approval queue and the revision transitions — is `/review` (T4.6), because
// review works on the inventory and not on the library.
//
// TWO REQUESTS FEED THE WHOLE SCREEN. `GET /api/documents` and an UNFILTERED
// `GET /api/evidence-links` — which the link route was written to serve — and
// every other view is an index over them (`_lib/filters`). The alternative is a
// `?document_id=` request per row of the table and a `?object_id=` per row of the
// inventory, i.e. an N+1 for a collection that is small by construction.
//
// THE REVISION IS THE SUBJECT, NOT THE PERIOD, exactly as on `/inventory` and
// `/inventory/disclosures`: a period holds several revisions and one is current
// (LC-1a); rows belong to a REVISION (DM-12), and links, assessments and rows
// are all frozen together once it is locked (§5.3, VAL-010).
//
// LOADING WITHOUT AN EFFECT, as on the other three screens: every selection here
// (period, document, row, filter) is an EXPRESSION over what is loaded right
// now, never state synchronised in a `useEffect`. The lint warning baseline may
// not grow.
//
// THE UI IS NOT THE GUARD (§0.1). `data.read` reaches the screen; `data.write`
// renders the upload form, the attach button and the score fields; `data.review`
// renders the override; `company.manage` renders the delete; `audit.read`
// decides whether the audit half of the timeline is even requested. Every one of
// them comes from `useCapabilities()` — what the SERVER resolved — and every
// route enforces its own regardless. No line of this screen derives a right from
// a role.
// =============================================================================
import { FileStack, FolderOpen, Rows3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import type { WorkflowStatus } from "@/shared/enums";
import { useCapabilities } from "@/shared/hooks/useCapabilities";
import { usePlan } from "@/shared/hooks/usePlan";
import { Badge } from "@/shared/ui/Badge";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";
import { NoInventoryDataBanner } from "@/shared/ui/NoInventoryDataBanner";
import { NoReportingPeriodBanner } from "@/shared/ui/NoReportingPeriodBanner";
import { NoLegalEntityBanner } from "@/shared/ui/NoLegalEntityBanner";
import { NoReportRevisionBanner } from "@/shared/ui/NoReportRevisionBanner";

import { PageLayout } from "../_components/PageLayout";
import { useLegalEntities } from "../organisation/_lib/useOrganisation";
import {
  useMemberNames,
  usePeriods,
  useRevisions,
} from "../inventory/_lib/useInventory";
import {
  AccessNote,
  LoadErrorNote,
  Muted,
  SectionCard,
} from "../_components/ScreenKit";
import { StateBadge, useEnumLabel } from "./_components/common";
import { DocumentDetail } from "./_components/DocumentDetail";
import { DocumentFilters, DocumentTable } from "./_components/DocumentTable";
import { RowPanel } from "./_components/RowPanel";
import { UploadPanel } from "./_components/UploadPanel";
import {
  linkCounts,
  linksByTarget,
  matchesDocument,
  matchesRow,
  NO_FILTER,
  targetKey,
  type DocumentFilter,
} from "./_lib/filters";
import {
  useAssessment,
  useAuditTrail,
  useDocuments,
  useEvidenceLinks,
  useEvidenceWrites,
  useInventoryRows,
  useRowVersions,
  useUpload,
} from "./_lib/useEvidence";
import styles from "./page.module.css";

/** No link for a target that has none — a stable empty array, not a fresh `[]`. */
const NO_LINKS: never[] = [];

export default function EvidencePage() {
  const t = useTranslations("evidence");
  const caps = useCapabilities();
  // The SAME sets the routes require — read straight from the server-resolved
  // session, never reconstructed from a role.
  const capabilities = caps.capabilities;
  const canWrite = caps.has("data.write");
  const canDelete = caps.has("company.manage");
  const canReadAudit = caps.has("audit.read");

  const plan = usePlan();
  const entities = useLegalEntities();
  const label = useEnumLabel();

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

  const library = useDocuments();
  const evidenceLinks = useEvidenceLinks();
  const listing = useInventoryRows(revisionId);
  const writes = useEvidenceWrites();
  const upload = useUpload();
  const nameOf = useMemberNames();

  const usage = useMemo(
    () => linkCounts(evidenceLinks.links),
    [evidenceLinks.links],
  );
  const byTarget = useMemo(
    () => linksByTarget(evidenceLinks.links),
    [evidenceLinks.links],
  );

  const [filter, setFilter] = useState<DocumentFilter>(NO_FILTER);
  const documents = library.documents.filter((document) =>
    matchesDocument(document, filter, usage.get(document.id) ?? 0),
  );

  // The selection is validated against what is loaded: a document that has just
  // been deleted, or one the filter now hides, must not stay "open" as a detail
  // block describing something the listing no longer shows.
  const [pickedDocumentId, setPickedDocumentId] = useState<string | null>(null);
  const selectedDocument =
    library.documents.find((document) => document.id === pickedDocumentId) ??
    null;

  const [query, setQuery] = useState("");
  const rows = listing.rows.filter((row) => matchesRow(row, query));
  const [pickedRowId, setPickedRowId] = useState<string | null>(null);
  const selectedRow =
    listing.rows.find((row) => row.id === pickedRowId) ?? null;

  // The three per-row reads. Each is `enabled` only once a row is selected, so
  // opening the screen costs the two listings above and nothing else.
  const assessment = useAssessment(
    selectedRow?.source_table ?? null,
    selectedRow?.id ?? null,
  );
  const chain = useRowVersions(
    selectedRow?.source_table ?? null,
    selectedRow?.id ?? null,
  );
  // `audit.read` decides whether the request is made at all — a 403 here is an
  // ordinary role boundary (§6.2), not the "your access changed" event R-11's
  // banner describes. The route enforces either way; see `useAuditTrail`.
  const audit = useAuditTrail(canReadAudit && selectedRow !== null);

  /** A link target as a sentence, for the library's "where is this used" list. */
  const describeTarget = (objectType: string, objectId: string): string => {
    const row = listing.rows.find(
      (candidate) =>
        candidate.id === objectId && candidate.source_table === objectType,
    );
    if (!row) return t("document.usedByOther");
    return t("document.usedByRow", {
      name: row.label ?? t("row.unnamed"),
      month: row.year_month ?? t("row.wholePeriod"),
    });
  };

  const entitiesReadable =
    !entities.loading && !entities.accessChanged && !entities.loadError;
  const periodsReadable =
    entitiesReadable &&
    entities.entities.length > 0 &&
    !periods.loading &&
    !periods.accessChanged &&
    !periods.loadError;
  const revisionsReadable =
    periodsReadable &&
    period !== null &&
    !revisions.loading &&
    !revisions.accessChanged &&
    !revisions.loadError;
  const hasRevision = revisionsReadable && revision !== null;

  return (
    <PageLayout
      title={t("title")}
      subtitle={t("subtitle")}
      loading={periods.loading || library.loading}
    >
      {(entities.accessChanged ||
        periods.accessChanged ||
        revisions.accessChanged ||
        library.accessChanged ||
        evidenceLinks.accessChanged) && <AccessNote />}
      {(entities.loadError ||
        periods.loadError ||
        revisions.loadError ||
        library.loadError) && <LoadErrorNote />}
      {!canWrite && <Muted>{t("readOnlyNote")}</Muted>}

      {entitiesReadable && entities.entities.length === 0 && (
        <NoLegalEntityBanner />
      )}
      {periodsReadable && period === null && <NoReportingPeriodBanner />}
      {periodsReadable && period !== null && (
        <SectionCard
          icon={<FolderOpen size={20} className={styles.iconBlue} />}
          title={t("scope.title")}
          subtitle={t("scope.subtitle")}
          badge={
            hasRevision && (
              <Badge
                variant={revisionStatus === "draft" ? "green" : "gray"}
                size="sm"
              >
                {t("scope.badge", {
                  no: revision.revision_no,
                  status: t.has(`revisionStatus.${revision.status}`)
                    ? t(`revisionStatus.${revision.status}`)
                    : revision.status,
                })}
              </Badge>
            )
          }
        >
          <Select
            label={t("scope.period")}
            id="evidence-period"
            options={periods.periods.map((period) => ({
              value: period.id,
              label: period.period_name,
            }))}
            value={periodId ?? ""}
            onChange={(e) => {
              setPickedPeriodId(e.target.value);
              setPickedRowId(null);
            }}
          />
        </SectionCard>
      )}
      {periodsReadable && period !== null && revisions.loading && (
        <Muted>{t("loadingSection")}</Muted>
      )}
      {revisionsReadable && revisionId === null && (
        <NoReportRevisionBanner periodName={period?.period_name ?? ""} />
      )}
      {revisionsReadable && revisionId !== null && !revision && (
        <LoadErrorNote />
      )}

      <SectionCard
        icon={<FileStack size={20} className={styles.iconGreen} />}
        title={t("library.title")}
        subtitle={t("library.subtitle")}
        badge={
          <Badge variant="gray" size="sm">
            {t("library.count", { count: documents.length })}
          </Badge>
        }
      >
        {/* `data.write` renders the form; `POST /api/documents` requires it too,
            so a direct upload without it is still a 403. */}
        {canWrite && (
          <UploadPanel
            library={library.documents}
            maxUploadMb={plan.features.maxUploadMb}
            upload={upload}
            onReuse={setPickedDocumentId}
          />
        )}

        <DocumentFilters filter={filter} onChange={setFilter} />
        <DocumentTable
          documents={documents}
          usage={usage}
          selectedId={selectedDocument?.id ?? null}
          loading={library.loading}
          loadError={library.loadError}
          onSelect={setPickedDocumentId}
        />
        {evidenceLinks.loadError && <LoadErrorNote />}

        {selectedDocument && (
          <DocumentDetail
            key={selectedDocument.id}
            document={selectedDocument}
            links={evidenceLinks.links.filter(
              (link) => link.document_id === selectedDocument.id,
            )}
            canDelete={canDelete}
            writes={writes}
            onDeleted={() => setPickedDocumentId(null)}
            describeTarget={describeTarget}
          />
        )}
      </SectionCard>

      {hasRevision &&
        !listing.loading &&
        !listing.accessChanged &&
        !listing.loadError &&
        listing.rows.length === 0 && <NoInventoryDataBanner />}
      {hasRevision && listing.accessChanged && <AccessNote />}
      {hasRevision && listing.loadError && <LoadErrorNote />}
      {hasRevision &&
        !listing.accessChanged &&
        !listing.loadError &&
        (listing.loading || listing.rows.length > 0) && (
          <div className={styles.split}>
            <SectionCard
              icon={<Rows3 size={20} className={styles.iconBlue} />}
              title={t("rows.title")}
              subtitle={t("rows.subtitle")}
              badge={
                <Badge variant="gray" size="sm">
                  {t("rows.count", { count: rows.length })}
                </Badge>
              }
            >
              <Input
                id="evidence-row-search"
                label={t("rows.search")}
                placeholder={t("rows.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {listing.loadError && <LoadErrorNote />}
              {revisionId === null ? (
                <Muted>{t("rows.noRevision")}</Muted>
              ) : listing.loading ? (
                <Muted>{t("loadingSection")}</Muted>
              ) : rows.length === 0 ? (
                <Muted>{t("rows.empty")}</Muted>
              ) : (
                <ul className={styles.rowList}>
                  {rows.map((row) => {
                    const attached =
                      byTarget.get(targetKey(row.source_table, row.id))
                        ?.length ?? 0;
                    return (
                      <li
                        key={row.id}
                        className={
                          row.id === selectedRow?.id
                            ? styles.rowItemActive
                            : styles.rowItem
                        }
                      >
                        <button
                          type="button"
                          className={styles.rowButton}
                          onClick={() => setPickedRowId(row.id)}
                        >
                          <span className={styles.rowName}>
                            {row.label ?? t("row.unnamed")}
                          </span>
                          <span className={styles.rowMeta}>
                            {label("kind", row.kind)} ·{" "}
                            {row.year_month ?? t("row.wholePeriod")}
                          </span>
                          <span className={styles.rowTags}>
                            <StateBadge state={row.state} />
                            <Badge
                              variant={attached === 0 ? "yellow" : "green"}
                              size="sm"
                            >
                              {attached === 0
                                ? t("rows.noEvidence")
                                : t("rows.evidenceCount", { count: attached })}
                            </Badge>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {listing.truncated && <Muted>{t("rows.truncated")}</Muted>}
            </SectionCard>

            {selectedRow && (
              <RowPanel
                key={selectedRow.id}
                row={selectedRow}
                links={
                  byTarget.get(
                    targetKey(selectedRow.source_table, selectedRow.id),
                  ) ?? NO_LINKS
                }
                documents={library.documents}
                selectedDocument={selectedDocument}
                capabilities={capabilities}
                revisionStatus={revisionStatus}
                revisionId={revisionId}
                assessment={assessment.assessment}
                assessmentLoading={assessment.loading}
                assessmentLoadError={assessment.loadError}
                versions={chain.versions}
                chainTruncated={chain.truncated}
                chainLoading={chain.loading}
                audit={audit.entries}
                auditAvailable={canReadAudit}
                nameOf={nameOf}
                writes={writes}
                onClose={() => setPickedRowId(null)}
              />
            )}
          </div>
        )}
    </PageLayout>
  );
}
