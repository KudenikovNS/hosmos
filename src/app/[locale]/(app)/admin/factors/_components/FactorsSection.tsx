"use client";

// =============================================================================
// THE FACTORS OF ONE SET, AND WHERE THEY CAME FROM (UI-4 — DM-22, DM-21).
//
// TWO PANELS, ONE CARD.
//   • The PROVENANCE table is UI-4's "sources and licences": DM-22 puts the
//     source, its version, the licence and the URL on the FACTOR row, so the
//     honest way to answer "under what licence is this set usable" is to group
//     them. The seeded set answers `unspecified`, out loud (MIG-4) — a blank
//     would have read as "no licence issue".
//   • The FACTOR table is paged and searched ON THE SERVER (440 rows in
//     `legacy-v1`), so the search box is a query parameter and not a filter over
//     a list the browser never had.
//
// THE TABLE IS READ-ONLY, AND THAT IS THE FEATURE. Every released set is frozen
// (DM-21), and a draft's factors are added through the API — so what this panel
// owes the user is the reason, stated where they would look for an edit button:
// `sets.frozenNote` under a released set, `sets.draftNote` under a draft.
// =============================================================================
import { BookOpen, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/shared/ui/Input";
import { Button } from "@/shared/ui/Button";

import type {
  EmissionFactorDto,
  FactorProvenanceDto,
  FactorSetDto,
} from "../_lib/api";
import { PAGE_SIZE } from "../_lib/useFactors";
import {
  LoadErrorNote,
  Muted,
  SectionCard,
} from "../../../_components/ScreenKit";
import styles from "../page.module.css";

export function FactorsSection({
  set,
  provenance,
  factors,
  total,
  search,
  offset,
  loading,
  loadError,
  onSearch,
  onOffset,
}: {
  set: FactorSetDto | null;
  provenance: FactorProvenanceDto[];
  factors: EmissionFactorDto[];
  total: number;
  search: string;
  offset: number;
  loading: boolean;
  loadError: boolean;
  onSearch: (value: string) => void;
  onOffset: (value: number) => void;
}) {
  const t = useTranslations("factors");
  if (!set) return null;

  const shown = factors.length;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + shown;

  return (
    <SectionCard
      icon={<BookOpen size={20} className={styles.iconViolet} />}
      title={t("factors.title", { set: set.name })}
      subtitle={set.editable ? t("factors.draftNote") : t("factors.frozenNote")}
    >
      <div className={styles.subsection}>
        <p className={styles.subsectionTitle}>{t("provenance.title")}</p>
        {provenance.length === 0 ? (
          <Muted>{t("provenance.empty")}</Muted>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t("fields.sourceName")}</th>
                  <th>{t("fields.sourceVersion")}</th>
                  <th>{t("fields.licence")}</th>
                  <th>{t("fields.factorCount")}</th>
                </tr>
              </thead>
              <tbody>
                {provenance.map((entry, index) => (
                  <tr
                    key={`${entry.source_name}-${entry.source_version}-${index}`}
                  >
                    <td>
                      {entry.source_url ? (
                        <a
                          href={entry.source_url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {entry.source_name}
                        </a>
                      ) : (
                        entry.source_name
                      )}
                    </td>
                    <td>{entry.source_version}</td>
                    <td>{entry.licence ?? "—"}</td>
                    <td>{entry.factors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={styles.subsection}>
        <p className={styles.subsectionTitle}>{t("factors.listTitle")}</p>
        <Input
          label={t("factors.search")}
          value={search}
          placeholder={t("factors.searchHint")}
          onChange={(e) => onSearch(e.target.value)}
        />

        {loadError && <LoadErrorNote />}
        {loading && <Muted>{t("loadingSection")}</Muted>}
        {!loading && shown === 0 && <Muted>{t("factors.empty")}</Muted>}

        {shown > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t("fields.activityType")}</th>
                  <th>{t("fields.geography")}</th>
                  <th>{t("fields.applicableYear")}</th>
                  <th>{t("fields.factorValue")}</th>
                  <th>{t("fields.inputUnit")}</th>
                  <th>{t("fields.sourceName")}</th>
                </tr>
              </thead>
              <tbody>
                {factors.map((factor) => (
                  <tr key={factor.id}>
                    <td>
                      <span className={styles.rowTitle}>
                        {factor.activity_type}
                      </span>
                      <span className={styles.rowSubtitle}>
                        {factor.factor_name}
                      </span>
                    </td>
                    <td>{factor.geography}</td>
                    <td>{factor.applicable_year ?? "—"}</td>
                    <td>
                      {factor.factor_value} {factor.output_unit}
                    </td>
                    <td>{factor.input_unit}</td>
                    <td>{factor.source_version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className={styles.pager}>
          <span className={styles.rowSubtitle}>
            <Search size={12} /> {t("factors.range", { from, to, total })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset === 0}
            onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            {t("factors.previous")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={to >= total}
            onClick={() => onOffset(offset + PAGE_SIZE)}
          >
            {t("factors.next")}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
