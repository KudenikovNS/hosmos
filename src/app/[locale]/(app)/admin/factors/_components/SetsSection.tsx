"use client";

// =============================================================================
// THE FACTOR SETS AND THE RELEASE ACTIONS (UI-4, DM-21).
//
// The whole product rule is visible in one card: a set is `draft` (editable),
// `active` (pinnable by a period, frozen) or `archived` (superseded, frozen).
// The buttons follow from the status and nothing else —
//   • draft   → Release, Archive
//   • active  → New version, Archive
//   • archived→ New version
// — so "a release is only ever a new version" is not a sentence in a tooltip but
// the only path the screen offers. The server refuses the rest regardless
// (`@/server/factors/factor-sets`); this is the UX half.
//
// THE FORM IS NOT AN AUTOSAVE. A new version is a deliberate act with a code
// that becomes permanent provenance, so it is an explicit submit — unlike the
// organisation profile, where a draft layer over a server row is the right shape.
// =============================================================================
import { CopyPlus, Layers } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";

import type { FactorSetDto, Refusal, WriteOutcome } from "../_lib/api";
import {
  Muted,
  RefusalNote,
  SectionCard,
} from "../../../_components/ScreenKit";
import { StatusBadge } from "./common";
import styles from "../page.module.css";

/** The new-version form's own state. `code` is the only value with no default. */
interface DraftSet {
  code: string;
  name: string;
  description: string;
}

const EMPTY_DRAFT: DraftSet = { code: "", name: "", description: "" };

export function SetsSection({
  sets,
  selectedId,
  loading,
  canManage,
  onSelect,
  onCreate,
  onUpdate,
}: {
  sets: FactorSetDto[];
  selectedId: string | null;
  loading: boolean;
  canManage: boolean;
  onSelect: (id: string) => void;
  onCreate: (body: {
    code: string;
    name: string;
    description?: string;
    copy_from?: string;
  }) => Promise<WriteOutcome<FactorSetDto>>;
  onUpdate: (
    id: string,
    body: Record<string, unknown>,
  ) => Promise<WriteOutcome<FactorSetDto>>;
}) {
  const t = useTranslations("factors");
  const [draft, setDraft] = useState<DraftSet | null>(null);
  const [copyFrom, setCopyFrom] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  const openNewVersion = (sourceId: string | null) => {
    const source = sets.find((set) => set.id === sourceId) ?? null;
    setCopyFrom(sourceId);
    setRefusal(null);
    setDraft(
      source
        ? {
            ...EMPTY_DRAFT,
            name: t("sets.copyOf", { name: source.name }),
          }
        : EMPTY_DRAFT,
    );
  };

  const submit = async () => {
    if (!draft) return;
    setBusy(true);
    const result = await onCreate({
      code: draft.code,
      name: draft.name,
      ...(draft.description ? { description: draft.description } : {}),
      ...(copyFrom ? { copy_from: copyFrom } : {}),
    });
    setBusy(false);
    if (result.ok) {
      setDraft(null);
      onSelect(result.data.id);
      return;
    }
    setRefusal(result);
  };

  const changeStatus = async (id: string, status: string) => {
    setBusy(true);
    const result = await onUpdate(id, { status });
    setBusy(false);
    setRefusal(result.ok ? null : result);
  };

  return (
    <SectionCard
      icon={<Layers size={20} className={styles.iconBlue} />}
      title={t("sets.title")}
      subtitle={t("sets.subtitle")}
    >
      {loading && <Muted>{t("loadingSection")}</Muted>}
      {!loading && sets.length === 0 && <Muted>{t("sets.empty")}</Muted>}

      <div className={styles.rowStack}>
        {sets.map((set) => (
          <div
            key={set.id}
            className={
              set.id === selectedId ? styles.setRowActive : styles.setRow
            }
          >
            <button
              type="button"
              className={styles.rowMain}
              onClick={() => onSelect(set.id)}
              aria-current={set.id === selectedId ? "true" : undefined}
            >
              <span className={styles.rowTitle}>
                {set.name} <code className={styles.code}>{set.code}</code>
              </span>
              <span className={styles.rowSubtitle}>
                {t("sets.factorCount", { count: set.factor_count })}
                {set.published_at
                  ? ` · ${t("sets.published", { date: set.published_at.slice(0, 10) })}`
                  : ` · ${t("sets.unpublished")}`}
              </span>
            </button>

            <div className={styles.rowActions}>
              <StatusBadge status={set.status} />
              {canManage && set.status === "draft" && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => changeStatus(set.id, "active")}
                >
                  {t("sets.release")}
                </Button>
              )}
              {canManage && set.status !== "archived" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => changeStatus(set.id, "archived")}
                >
                  {t("sets.archive")}
                </Button>
              )}
              {canManage && set.status !== "draft" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => openNewVersion(set.id)}
                >
                  {t("sets.newVersion")}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {canManage && !draft && (
        <div className={styles.sectionActions}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => openNewVersion(null)}
          >
            <CopyPlus size={14} /> {t("sets.createEmpty")}
          </Button>
        </div>
      )}

      {canManage && draft && (
        <div className={styles.inlineForm}>
          <p className={styles.inlineFormTitle}>
            {copyFrom ? t("sets.newVersionTitle") : t("sets.createTitle")}
          </p>
          {copyFrom && <Muted>{t("sets.copyExplain")}</Muted>}
          <div className={styles.twoCol}>
            <Input
              label={t("fields.code")}
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            />
            <Input
              label={t("fields.name")}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <Input
            label={t("fields.description")}
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
          <div className={styles.formActions}>
            <Button size="sm" loading={busy} onClick={submit}>
              {t("sets.create")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setRefusal(null);
              }}
            >
              {t("actions.cancel")}
            </Button>
          </div>
        </div>
      )}

      <RefusalNote screen="factors" refusal={refusal} />
    </SectionCard>
  );
}
