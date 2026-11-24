"use client";

// =============================================================================
// THE LIBRARY LISTING AND ITS FILTERS (UI-3, §4.16 DM-24, DM-25).
//
// WHAT A ROW OF THIS TABLE IS FOR. §4.16 gives a document eleven fields and the
// table shows the five that answer "is this the paper I mean": what it is called,
// what kind of file it is, who issued it, what period it covers and how many
// figures it currently backs. Everything else — the hash, the retention date, the
// uploader — belongs to the detail block below the table, where it is read once
// rather than scanned.
//
// THE USAGE COUNT IS NOT DECORATION. It is the difference between a document that
// is doing its job and one that was uploaded and forgotten, and it is the only
// column that comes from the LINK table rather than from the document. It is also
// what makes the "never attached to anything" filter possible without a request
// per row: `linkCounts` indexes the whole link table once (`_lib/filters`).
//
// COVERAGE IS SHOWN BECAUSE VAL-037 JUDGES IT. A document whose coverage window
// misses the month of the row it is attached to comes back as a warning on the
// LINK (EV-4), so the window is a fact the user needs before they attach, not an
// explanation after. Missing ends are shown as missing — an open window is a real
// state and not a zero.
// =============================================================================
import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/shared/ui/Badge";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import type { DocumentDto } from "../_lib/api";
import { CONFIDENTIALITY_VALUES } from "../_lib/upload";
import type { DocumentFilter } from "../_lib/filters";
import styles from "../page.module.css";
import { LoadErrorNote, Muted } from "../../_components/ScreenKit";
import { useDay, useEnumLabel } from "./common";

/** The `FileType` buckets EV-0 accepts, as the filter offers them. */
const FILE_TYPES = ["pdf", "xlsx", "csv", "image", "other"] as const;

/** The three states of the usage filter (`_lib/filters#DocumentFilter`). */
const USAGE_VALUES = ["any", "linked", "unlinked"] as const;

export function DocumentFilters({
  filter,
  onChange,
}: {
  filter: DocumentFilter;
  onChange: (next: DocumentFilter) => void;
}) {
  const t = useTranslations("evidence");
  return (
    <div className={styles.filterGrid}>
      <Input
        id="evidence-search"
        label={t("filters.text")}
        value={filter.text}
        placeholder={t("filters.textPlaceholder")}
        onChange={(e) => onChange({ ...filter, text: e.target.value })}
      />
      <Select
        id="evidence-file-type"
        label={t("filters.fileType")}
        options={FILE_TYPES.map((value) => ({
          value,
          label: t(`enums.fileType.${value}`),
        }))}
        value={filter.fileType}
        onChange={(e) => onChange({ ...filter, fileType: e.target.value })}
      />
      <Select
        id="evidence-confidentiality"
        label={t("filters.confidentiality")}
        options={CONFIDENTIALITY_VALUES.map((value) => ({
          value,
          label: t(`enums.confidentiality.${value}`),
        }))}
        value={filter.confidentiality}
        onChange={(e) =>
          onChange({ ...filter, confidentiality: e.target.value })
        }
      />
      <Select
        id="evidence-usage"
        label={t("filters.usage")}
        options={USAGE_VALUES.map((value) => ({
          value,
          label: t(`filters.usageValues.${value}`),
        }))}
        value={filter.usage}
        onChange={(e) =>
          onChange({
            ...filter,
            usage: e.target.value as DocumentFilter["usage"],
          })
        }
      />
    </div>
  );
}

export function DocumentTable({
  documents,
  usage,
  selectedId,
  loading,
  loadError,
  onSelect,
}: {
  /** Already filtered — the page owns the predicate (`_lib/filters`). */
  documents: readonly DocumentDto[];
  /** How many objects each document backs, by `document_id`. */
  usage: Map<string, number>;
  selectedId: string | null;
  loading: boolean;
  loadError: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations("evidence");
  const day = useDay();
  // `file_type` is a free `text` column on the server (§4.16), so an unknown
  // bucket renders as its wire literal rather than throwing on a missing key.
  const label = useEnumLabel();

  if (loading) return <Muted>{t("loadingSection")}</Muted>;
  if (loadError) return <LoadErrorNote />;
  if (documents.length === 0) return <Muted>{t("library.empty")}</Muted>;

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t("library.name")}</th>
            <th>{t("library.type")}</th>
            <th>{t("library.issuer")}</th>
            <th>{t("library.coverage")}</th>
            <th>{t("library.usage")}</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => {
            const count = usage.get(document.id) ?? 0;
            return (
              <tr
                key={document.id}
                className={
                  document.id === selectedId ? styles.rowActive : styles.row
                }
                onClick={() => onSelect(document.id)}
              >
                <td>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => onSelect(document.id)}
                  >
                    <FileText size={12} /> {document.file_name}
                  </button>
                </td>
                <td>{label("fileType", document.file_type)}</td>
                <td>{document.issuer ?? "—"}</td>
                <td>
                  {document.coverage_start === null &&
                  document.coverage_end === null
                    ? t("library.noCoverage")
                    : t("library.coverageRange", {
                        from: day(document.coverage_start),
                        to: day(document.coverage_end),
                      })}
                </td>
                <td>
                  <Badge variant={count === 0 ? "gray" : "green"} size="sm">
                    {count === 0
                      ? t("library.unused")
                      : t("library.usedBy", { count })}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
