"use client";

// THE DATA-QUALITY EDITOR (UI-3, §4.17 DM-27, DQ-2, DQ-3, VAL-038, VAL-039).
//
// See docs/decisions/app-evidence-_components-DqEditor-L3.md for the full account.
import { Gauge } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";

import type { WorkflowStatus } from "@/shared/enums";
import type { Capability } from "@/shared/roles";
import { Badge } from "@/shared/ui/Badge";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import { SaveBar } from "../../organisation/_components/common";
import { useAutosave, type Draft } from "../../organisation/_lib/useAutosave";
import type { DqAssessmentDto, RuleRef } from "../_lib/api";
import {
  dqBody,
  dqEditorGates,
  overrideReasonGiven,
  PEDIGREE_SCORES,
  PERCENT_SCORES,
  QUALITY_TIERS,
} from "../_lib/dq";
import type { useEvidenceWrites } from "../_lib/useEvidence";
import styles from "../page.module.css";
import { Muted, RefusalNote } from "../../_components/ScreenKit";
import { useInstant } from "../../_lib/useInstant";
import { ScoreBadge, WarningHints } from "./common";

/** A DTO value as a form control holds it (`useAutosave`'s header: all strings). */
function asDraftValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** The stored assessment as the form's baseline — the eleven editable columns. */
function baselineOf(assessment: DqAssessmentDto | null): Draft {
  const draft: Draft = {};
  for (const field of [...PEDIGREE_SCORES, ...PERCENT_SCORES]) {
    draft[field] = asDraftValue(assessment?.[field]);
  }
  draft.quality_tier = asDraftValue(assessment?.quality_tier);
  draft.quality_comment = asDraftValue(assessment?.quality_comment);
  draft.is_overridden = asDraftValue(assessment?.is_overridden ?? false);
  draft.override_reason = asDraftValue(assessment?.override_reason);
  return draft;
}

export function DqEditor({
  objectType,
  objectId,
  assessment,
  loading,
  capabilities,
  revisionStatus,
  writes,
  warnings,
  onWarnings,
}: {
  /** `linked_object_type` of the row being assessed — the path's first segment. */
  objectType: string;
  objectId: string;
  assessment: DqAssessmentDto | null;
  loading: boolean;
  /** Straight from `useCapabilities()`. This screen never sees a role. */
  capabilities: readonly Capability[];
  revisionStatus: WorkflowStatus | null;
  writes: ReturnType<typeof useEvidenceWrites>;
  /**
   * The non-blocking findings of the LAST accepted save (VAL-038).
   *
   * OWNED BY THE PARENT, on purpose. A successful save remounts this component
   * (see the `key` the row panel gives it, and why), which would otherwise
   * discard the very warnings that save produced — the hint would flash and
   * vanish. A refusal does NOT remount it, so the refusal and the dirty draft
   * stay exactly where `useAutosave` left them.
   */
  warnings: readonly RuleRef[];
  onWarnings: (warnings: readonly RuleRef[]) => void;
}) {
  const t = useTranslations("evidence");
  const instant = useInstant();

  const gates = dqEditorGates({ capabilities, revisionStatus, assessment });

  const baseline = useMemo(() => baselineOf(assessment), [assessment]);

  const save = useCallback(
    async (patch: Draft) => {
      // The PATCH decides WHETHER there is anything to save; the BODY is the
      // whole assessment, because `is_overridden` must be on every one of them
      // (`_lib/dq#dqBody`).
      const values = { ...baseline, ...patch };
      const result = await writes.saveAssessment(
        objectType,
        objectId,
        dqBody(values, values.is_overridden === "true"),
      );
      // VAL-038 rides along on a SUCCESS only. A refusal wrote nothing, so it
      // has no findings to show and the previous ones would be about a state
      // that no longer exists.
      onWarnings(result.ok ? result.data.warnings : []);
      return result;
    },
    [writes, objectType, objectId, baseline, onWarnings],
  );

  const autosave = useAutosave({
    contextKey: `dq:${objectType}:${objectId}`,
    baseline,
    save,
    enabled: gates.canEdit,
  });
  const wantsOverride = autosave.values.is_overridden === "true";
  const reasonReady = overrideReasonGiven(
    wantsOverride,
    autosave.values.override_reason ?? "",
  );

  const tierLabel = (tier: string | null) =>
    tier === null
      ? t("dq.noTier")
      : t.has(`enums.qualityTier.${tier}`)
        ? t(`enums.qualityTier.${tier}`)
        : tier;

  return (
    <div className={styles.dq}>
      <p className={styles.subsectionTitle}>
        <Gauge size={14} /> {t("dq.title")}
      </p>

      {loading ? (
        <Muted>{t("loadingSection")}</Muted>
      ) : (
        <>
          <div className={styles.badgeRow}>
            <Badge
              variant={assessment?.quality_tier ? "blue" : "gray"}
              size="sm"
            >
              {tierLabel(assessment?.quality_tier ?? null)}
            </Badge>
            {assessment?.is_overridden && (
              <Badge variant="violet" size="sm">
                {t("dq.overridden")}
              </Badge>
            )}
            {PEDIGREE_SCORES.map((field) => (
              <ScoreBadge
                key={field}
                label={t(`fields.${field}`)}
                value={assessment?.[field] ?? null}
                max={5}
              />
            ))}
            {PERCENT_SCORES.map((field) => (
              <ScoreBadge
                key={field}
                label={t(`fields.${field}`)}
                value={assessment?.[field] ?? null}
                max={100}
              />
            ))}
          </div>

          {assessment === null && <Muted>{t("dq.none")}</Muted>}
          {assessment?.assessed_at && (
            <Muted>
              {t("dq.assessedAt", { when: instant(assessment.assessed_at) })}
            </Muted>
          )}
          {assessment?.is_overridden && assessment.override_reason && (
            <p className={styles.overrideReason}>
              {t("dq.overrideReason", { reason: assessment.override_reason })}
            </p>
          )}

          {gates.lockedByOverride && <Muted>{t("dq.lockedByOverride")}</Muted>}
          {!gates.revisionOpen && <Muted>{t("dq.frozen")}</Muted>}

          {gates.canEdit && (
            <>
              <fieldset className={styles.fieldset}>
                <div className={styles.twoCol}>
                  {PEDIGREE_SCORES.map((field) => (
                    <Input
                      key={field}
                      id={`dq-${field}`}
                      label={t(`fields.${field}`)}
                      type="number"
                      min={1}
                      max={5}
                      hint={t("dq.pedigreeHint")}
                      value={autosave.values[field] ?? ""}
                      onChange={(e) =>
                        autosave.set({ [field]: e.target.value })
                      }
                    />
                  ))}
                  {PERCENT_SCORES.map((field) => (
                    <Input
                      key={field}
                      id={`dq-${field}`}
                      label={t(`fields.${field}`)}
                      type="number"
                      min={0}
                      max={100}
                      unit="%"
                      value={autosave.values[field] ?? ""}
                      onChange={(e) =>
                        autosave.set({ [field]: e.target.value })
                      }
                    />
                  ))}
                  <Select
                    id="dq-quality-tier"
                    label={t("fields.quality_tier")}
                    options={QUALITY_TIERS.map((tier) => ({
                      value: tier,
                      label: t(`enums.qualityTier.${tier}`),
                    }))}
                    value={autosave.values.quality_tier ?? ""}
                    onChange={(e) =>
                      autosave.set({ quality_tier: e.target.value })
                    }
                  />
                  <Input
                    id="dq-quality-comment"
                    label={t("fields.quality_comment")}
                    hint={t("dq.commentHint")}
                    value={autosave.values.quality_comment ?? ""}
                    onChange={(e) =>
                      autosave.set({ quality_comment: e.target.value })
                    }
                  />
                </div>
              </fieldset>

              {/* DQ-2. ONE reference to `gates.canOverride`, which is false
                  without `data.review` under every other input — and the route
                  requires the capability itself, so a direct PUT is still a
                  403. */}
              {gates.canOverride && (
                <div className={styles.override}>
                  <label className={styles.checkboxRow} htmlFor="dq-override">
                    <input
                      id="dq-override"
                      type="checkbox"
                      checked={wantsOverride}
                      onChange={(e) =>
                        autosave.set({
                          is_overridden: e.target.checked ? "true" : "false",
                        })
                      }
                    />
                    {t("dq.overrideLabel")}
                  </label>
                  {wantsOverride && (
                    <Input
                      id="dq-override-reason"
                      label={t("fields.override_reason")}
                      required
                      hint={t("dq.overrideHint")}
                      error={reasonReady ? undefined : t("dq.overrideRequired")}
                      value={autosave.values.override_reason ?? ""}
                      onChange={(e) =>
                        autosave.set({ override_reason: e.target.value })
                      }
                    />
                  )}
                </div>
              )}

              <RefusalNote screen="evidence" refusal={autosave.refusal} />
              <WarningHints codes={warnings.map((warning) => warning.code)} />
              <SaveBar
                status={autosave.status}
                dirty={autosave.dirty && reasonReady}
                onConfirm={autosave.confirm}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
