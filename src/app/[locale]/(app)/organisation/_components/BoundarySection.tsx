"use client";

// =============================================================================
// THE PERIOD BOUNDARY (UI-1, DM-8, DM-9, D10/D15, VAL-101, VAL-106).
//
// WHAT THIS IS. Not a registry flag: the boundary is the PER-PERIOD decision
// about which legal entities the report covers, and it is itself a DISCLOSURE —
// VSME B1 prints the entities AND the stated reason for every exclusion, and a
// locked revision freezes the whole set.
//
// THE REASON IS MANDATORY WHEN AN ENTITY IS OUT (D15), AND THE SERVER SAYS SO.
// This screen marks such a row invalid (`aria-invalid`, a required field) but it
// does NOT block the write and it does NOT write copy of its own: VAL-101 is the
// rule of record, it is evaluated inside the write transaction, and its refusal
// is rendered from `validation.VAL-101`. Blocking here would produce a second,
// untranslated opinion and would leave the rule unreachable from the API.
//
// THE PUT IS A FULL REPLACEMENT (see `@/server/periods/scope`): the payload is
// the boundary in its entirety and an omitted entity LEAVES it. So every save
// sends the merged set — baseline plus the draft — and never a patch. An entity
// that has never been touched and has no stored row is left out entirely rather
// than written as `not_assessed`: the boundary should record decisions, not the
// absence of them.
//
// A REFUSED PUT WRITES NOTHING AT ALL — no rows, no audit entry, no validation
// results (VR-3) — which is exactly why the draft survives it and the indicator
// keeps saying "not saved" (see `../_lib/useAutosave`).
// =============================================================================
import { ScanLine } from "lucide-react";
import { useTranslations } from "next-intl";

import { useHelp } from "@/shared/hooks/useHelp";
import { useCallback, useMemo } from "react";

import { APPLICABILITY_STATUSES } from "@/shared/enums";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import type {
  LegalEntityDto,
  PeriodDto,
  PeriodScopeDto,
  WriteOutcome,
} from "../_lib/api";
import { useAutosave, type Draft } from "../_lib/useAutosave";
import styles from "../page.module.css";
import {
  AccessNote,
  LoadErrorNote,
  Muted,
  RefusalNote,
  SectionCard,
} from "../../_components/ScreenKit";
import { SaveBar, useEnumOptions } from "./common";

const statusKey = (entityId: string) => `status:${entityId}`;
const reasonKey = (entityId: string) => `reason:${entityId}`;

/** An entity with no stored row is "not assessed" until someone decides. */
const UNDECIDED = "not_assessed";

/** The stored boundary (plus a default per untouched entity) as a flat draft. */
function boundaryBaseline(
  entities: LegalEntityDto[],
  entries: PeriodScopeDto[],
): Draft {
  const stored = new Map(
    entries.map((entry) => [entry.legal_entity_id, entry]),
  );
  const baseline: Draft = {};
  for (const entity of entities) {
    const entry = stored.get(entity.id);
    baseline[statusKey(entity.id)] = entry?.status ?? UNDECIDED;
    baseline[reasonKey(entity.id)] = entry?.exclusion_reason ?? "";
  }
  return baseline;
}

/** The flat draft → the `{entries:[…]}` body (a WHOLE boundary, see header). */
function toEntries(
  values: Draft,
  entities: LegalEntityDto[],
  stored: Set<string>,
) {
  return entities
    .filter(
      (entity) =>
        stored.has(entity.id) || values[statusKey(entity.id)] !== UNDECIDED,
    )
    .map((entity) => ({
      legal_entity_id: entity.id,
      status: values[statusKey(entity.id)],
      // Blank-as-null: a reason cannot outlive the exclusion that justified it.
      exclusion_reason: values[reasonKey(entity.id)] || null,
    }));
}

export function BoundarySection({
  period,
  entities,
  entries,
  loading,
  accessChanged,
  loadError,
  canManage,
  onReplace,
}: {
  period: PeriodDto | null;
  entities: LegalEntityDto[];
  entries: PeriodScopeDto[];
  loading: boolean;
  accessChanged: boolean;
  loadError: boolean;
  canManage: boolean;
  onReplace: (entries: unknown) => Promise<WriteOutcome<unknown>>;
}) {
  const t = useTranslations("organisation");
  const help = useHelp("organisation.help");
  const statuses = useEnumOptions(
    "applicabilityStatus",
    APPLICABILITY_STATUSES,
  );

  const baseline = useMemo(
    () => boundaryBaseline(entities, entries),
    [entities, entries],
  );
  const stored = useMemo(
    () => new Set(entries.map((entry) => entry.legal_entity_id)),
    [entries],
  );
  const save = useCallback(
    (patch: Draft) =>
      onReplace(toEntries({ ...baseline, ...patch }, entities, stored)),
    [onReplace, baseline, entities, stored],
  );
  const form = useAutosave({
    contextKey: `boundary:${period?.id ?? "none"}`,
    baseline,
    save,
    enabled: canManage && period !== null,
  });
  const { values, set } = form;

  return (
    <SectionCard
      icon={<ScanLine size={20} className={styles.iconGreen} />}
      title={t("boundary.title")}
      subtitle={t("boundary.subtitle")}
    >
      {!period ? (
        <Muted>{t("boundary.noPeriod")}</Muted>
      ) : accessChanged ? (
        <AccessNote />
      ) : loading ? (
        <Muted>{t("loadingSection")}</Muted>
      ) : loadError ? (
        <LoadErrorNote />
      ) : (
        <>
          <Muted>{t("boundary.forPeriod", { name: period.period_name })}</Muted>
          <fieldset className={styles.fieldset} disabled={!canManage}>
            <div className={styles.rowStack}>
              {entities.map((entity) => {
                const status = values[statusKey(entity.id)] ?? UNDECIDED;
                const reason = values[reasonKey(entity.id)] ?? "";
                // D15: an exclusion without a reason is not a disclosure. The
                // marking is the UI's; the REFUSAL is VAL-101's (see header).
                const reasonMissing =
                  status === "excluded" && reason.trim() === "";
                return (
                  <div key={entity.id} className={styles.boundaryRow}>
                    <p className={styles.rowTitle}>
                      {entity.organisation_name}
                    </p>
                    <Select
                      label={t("fields.boundaryStatus")}
                      help={help("boundaryStatus")}
                      id={`boundary-${entity.id}-boundaryStatus`}
                      aria-required
                      options={statuses}
                      value={status}
                      onChange={(e) =>
                        set({ [statusKey(entity.id)]: e.target.value })
                      }
                    />
                    <Input
                      label={t("fields.exclusionReason")}
                      help={help("exclusionReason")}
                      id={`boundary-${entity.id}-exclusionReason`}
                      value={reason}
                      required={status === "excluded"}
                      aria-invalid={reasonMissing}
                      hint={
                        status === "excluded"
                          ? t("boundary.reasonRequired")
                          : undefined
                      }
                      onChange={(e) =>
                        set({ [reasonKey(entity.id)]: e.target.value })
                      }
                    />
                  </div>
                );
              })}
              {entities.length === 0 && (
                <Muted>{t("boundary.noEntities")}</Muted>
              )}
            </div>
          </fieldset>
          <RefusalNote screen="organisation" refusal={form.refusal} />
          {canManage && (
            <SaveBar
              status={form.status}
              dirty={form.dirty}
              onConfirm={form.confirm}
            />
          )}
        </>
      )}
    </SectionCard>
  );
}
