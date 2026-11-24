"use client";

// =============================================================================
// ONE METRIC OF THE CATALOGUE, AS A ROW OF THE FORM (T3.5b — DM-18, DM-19,
// LC-3…LC-5, PG-6).
//
// A METRIC IS ALWAYS ON SCREEN. Unanswered, it shows as «not collected» with its
// requirement and its condition beside it; that is the point of the whole task —
// `T5.6` prints the same three states, so a hole in the report is explained
// here rather than guessed at. A form that only rendered answered metrics would
// make every unanswered one invisible, which is the failure mode B8–B10 and B11
// have had since the beginning.
//
// EDITING IS VERSIONING, AS EVERYWHERE ELSE IN THIS MODEL. A save on an existing
// record is a PATCH, which writes a NEW version with a NEW id and stamps
// `superseded_by_id` on the one it replaces (§0.4, D5) — the same `rows.ts` the
// activities use. Two consequences are visible here:
//
//   • SUPERSEDING AN APPROVED VERSION NEEDS A REASON (LC-5). The field is
//     required in the form and Save is not offered without it; the server
//     refuses the same write regardless (422, `{field: "change_reason"}`). The
//     form asking first is UX, the refusal is the rule.
//   • THE CARD FOLLOWS THE LIST, NOT AN ID. A successful write invalidates the
//     revision's disclosure list, the new version arrives under the same
//     `metric_key`, and the card is REMOUNTED by its parent (`key` = the record
//     id) with the new version as its baseline. Nothing here holds a stale id.
//
// PG-6 IS A PRODUCT STATEMENT, NOT AN ERROR. A Comprehensive metric on a plan
// without `vsmeComprehensive` stays VISIBLE — locked, in state «not applicable»,
// with an upgrade CTA (PG-5). Hiding it would leave the upgrade screen unable to
// say what the upgrade contains. The gate itself is the server's: a direct POST
// is refused 422 whatever this card renders (AC-14).
//
// THE CAPABILITY DECISION IS NOT MADE HERE. `rowActionGates` (`../../_lib/
// actions`) is the same pure function the Scope 1/2 drawer uses and the same one
// `../../_lib/__tests__/actions.test.ts` pins across the whole role × capability
// matrix — there is ONE answer to "may this session write to this revision", and
// this screen does not get to invent a second.
// =============================================================================
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Link } from "@/i18n/navigation";
import type { WorkflowStatus } from "@/shared/enums";
import type { Capability } from "@/shared/roles";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { HelpTip } from "@/shared/ui/HelpTip";
import { Input } from "@/shared/ui/Input";

import { rowActionGates } from "../../_lib/actions";
import { RefusalNote } from "../../../_components/ScreenKit";
import type {
  DisclosureDto,
  MetricDto,
  Refusal,
  WriteOutcome,
} from "../_lib/api";
import {
  EMPTY_DRAFT,
  controlFor,
  draftOf,
  filledField,
  metricState,
  moduleAvailable,
  valueBody,
  type ValueDraft,
} from "../_lib/catalog";
import styles from "../page.module.css";
import { suggestionApplied, type Suggestion } from "../_lib/suggest";
import { StateBadge } from "./common";
import { ValueControl } from "./ValueControl";

/** Where every upgrade CTA of this app points. */
const UPGRADE_HREF = "/settings";

export interface MetricCardProps {
  readonly metric: MetricDto;
  /** This metric's current records for the entity being edited (oldest first). */
  readonly records: readonly DisclosureDto[];
  /** PG-6 — may this session record Comprehensive values (`writeFeatures`)? */
  readonly comprehensive: boolean;
  /** 0021 — may this session record simplified-ESRS values? Default false. */
  readonly simplifiedEsrs?: boolean;
  /** Straight from `useCapabilities()`. This screen never sees a role. */
  readonly capabilities: readonly Capability[];
  readonly revisionStatus: WorkflowStatus | null;
  readonly revisionId: string | null;
  readonly legalEntityId: string | null;
  readonly create: (body: unknown) => Promise<WriteOutcome<DisclosureDto>>;
  readonly edit: (
    id: string,
    body: unknown,
  ) => Promise<WriteOutcome<DisclosureDto>>;
  readonly approve: (id: string) => Promise<WriteOutcome<DisclosureDto>>;
  /** Партия 18 — what the organisation data already says (`suggestionFor`). */
  readonly suggestion?: Suggestion | null;
}

export function MetricCard({
  metric,
  records,
  comprehensive,
  simplifiedEsrs = false,
  capabilities,
  revisionStatus,
  revisionId,
  legalEntityId,
  create,
  edit,
  approve,
  suggestion = null,
}: MetricCardProps) {
  const t = useTranslations("disclosures");
  const control = controlFor(metric);
  const record = records[0] ?? null;

  const [draft, setDraft] = useState<ValueDraft>(() =>
    control ? draftOf(control, record) : { text: "", lines: "", rows: [] },
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const gates = rowActionGates({ capabilities, revisionStatus, row: record });
  const locked = !moduleAvailable(metric.module, comprehensive, simplifiedEsrs);
  const state = metricState({ metric, record, comprehensive, simplifiedEsrs });
  const lockCopy =
    metric.module === "simplified_esrs" ? "lockedEsrs" : "locked";
  const reasonGiven = reason.trim() !== "";
  const label = metric.text?.label ?? metric.title_en ?? metric.title;
  const text = metric.text;
  const unit = text?.unit ?? metric.unit;
  const writable =
    gates.canSaveDraft &&
    !locked &&
    revisionId !== null &&
    legalEntityId !== null &&
    (!gates.needsChangeReason || reasonGiven);

  // A `value_type` outside the 12 is a corrupt catalogue row, not a metric this
  // form may guess a control for — the server refuses to write it either
  // (`loadMetric`). Saying so is more useful than an empty card.
  if (!control) {
    return (
      <li className={styles.metric}>
        <p className={styles.metricTitle}>{label}</p>
        <p className={styles.controlHint}>
          {t("unsupportedType", { type: metric.value_type })}
        </p>
      </li>
    );
  }

  const set = (patch: Partial<ValueDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setRefusal(null);
    setFault(null);
  };

  const save = async () => {
    if (busy || !writable) return;
    const composed = valueBody(control, draft);
    if (!composed.ok) {
      // NOT a refusal of a value (VR-2): there is nothing to send, or a JSON
      // number cannot be composed. See `valueBody`'s header.
      setFault(composed.fault);
      return;
    }
    setBusy(true);
    setFault(null);
    const result = record
      ? await edit(record.id, {
          ...composed.body,
          ...(reasonGiven ? { change_reason: reason } : {}),
        })
      : await create({
          revision_id: revisionId,
          legal_entity_id: legalEntityId,
          metric_key: metric.metric_key,
          ...composed.body,
        });
    setBusy(false);
    if (result.ok) setReason("");
    else setRefusal(result);
  };

  const runApprove = async () => {
    if (busy || !record) return;
    setBusy(true);
    const result = await approve(record.id);
    setBusy(false);
    if (!result.ok) setRefusal(result);
  };

  const stored = draftOf(control, record);
  const dirty = JSON.stringify(stored) !== JSON.stringify(draft);
  // The record answers, but not in a shape this form can show — a value written
  // by another client, or a catalogue row whose `value_type` changed under an
  // existing answer. Saying so beats offering a blank control that would
  // overwrite it on the next save (`draftOf`'s header).
  const unreadable =
    record !== null &&
    filledField(record) !== null &&
    JSON.stringify(stored) === JSON.stringify(EMPTY_DRAFT);

  return (
    <li className={styles.metric}>
      <div className={styles.metricHead}>
        <div className={styles.headerGrow}>
          <p className={styles.metricTitle}>
            {label}
            {/* Партия 22 — «what goes in this field» where the eye already is:
                on the datapoint's name. The inline hint under the control stays;
                the standard's own wording moves in here, so the card is short
                for someone who knows it and complete for someone who does not. */}
            <HelpTip label={t("guidanceTitle")}>
              {text?.hint && (
                <span className={styles.helpLine}>{text.hint}</span>
              )}
              {text?.guidance && (
                <span className={styles.helpLine}>
                  <span className={styles.helpLabel}>
                    {t("guidanceTitle")}:{" "}
                  </span>
                  {text.guidance}
                </span>
              )}
            </HelpTip>
          </p>
          <p className={styles.metricMeta}>
            {metric.metric_key}
            {metric.paragraph ? ` · §${metric.paragraph}` : ""}
            {unit ? ` · ${unit}` : ""}
            {metric.esrs_reference && (
              <>
                {" · "}
                <span className={styles.esrsRef}>
                  {t("esrsRef", {
                    reference: metric.esrs_reference.replace(/^ESRS\s*/i, ""),
                  })}
                </span>
              </>
            )}
          </p>
        </div>
        <Badge variant="gray" size="sm">
          {t.has(`requirement.${metric.requirement_type}`)
            ? t(`requirement.${metric.requirement_type}`)
            : metric.requirement_type}
        </Badge>
        <StateBadge state={state} />
      </div>

      {text?.applies_when && (
        <p className={styles.controlHint}>
          {t("appliesWhen", { condition: text.applies_when })}
        </p>
      )}
      {text?.data_source && (
        <p className={styles.controlHint}>
          {t("dataSource", { source: text.data_source })}
        </p>
      )}

      {locked ? (
        <div className={styles.planLock}>
          <Lock size={16} className={styles.planLockIcon} />
          <div className={styles.planLockMain}>
            <p className={styles.planLockTitle}>{t(`${lockCopy}.title`)}</p>
            <p className={styles.planLockBody}>{t(`${lockCopy}.body`)}</p>
          </div>
          <Link href={UPGRADE_HREF} className={styles.planLockCta}>
            <Button size="sm">{t(`${lockCopy}.cta`)}</Button>
          </Link>
        </div>
      ) : (
        <>
          <fieldset className={styles.fieldset} disabled={!writable}>
            <ValueControl
              metric={metric}
              control={control}
              draft={draft}
              set={set}
              disabled={!writable}
              idPrefix={`m-${metric.metric_key}`}
            />
          </fieldset>

          {unreadable && <p className={styles.fault}>{t("unreadableValue")}</p>}

          {suggestion &&
            gates.canSaveDraft &&
            !suggestionApplied(suggestion, draft) && (
              <div className={styles.suggestion}>
                <p className={styles.suggestionText}>
                  <span className={styles.suggestionLabel}>
                    {t("suggestion.label")}
                  </span>{" "}
                  {suggestion.display}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!writable}
                  onClick={() => set(suggestion.draft)}
                >
                  {t("suggestion.use")}
                </Button>
              </div>
            )}

          {record === null && metric.requirement_type !== "mandatory" && (
            <p className={styles.controlHint}>
              {t("notApplicable.before")}{" "}
              <Link href="/readiness">{t("notApplicable.link")}</Link>
            </p>
          )}

          {records.length > 1 && (
            <p className={styles.controlHint}>
              {t("severalRecords", { count: records.length })}
            </p>
          )}

          {gates.needsChangeReason && gates.revisionOpen && (
            <div className={styles.reason}>
              <Input
                label={t("changeReason.label")}
                id={`m-${metric.metric_key}-reason`}
                required
                hint={t("changeReason.hint")}
                error={reasonGiven ? undefined : t("changeReason.required")}
                value={reason}
                disabled={!gates.canSaveDraft}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}

          {fault && <p className={styles.fault}>{t(`faults.${fault}`)}</p>}
          <RefusalNote screen="inventory" refusal={refusal} />

          {(gates.canSaveDraft || gates.canApprove) && (
            <div className={styles.metricActions}>
              {gates.canSaveDraft && (
                <Button
                  size="sm"
                  loading={busy}
                  disabled={!writable || !dirty}
                  onClick={() => void save()}
                >
                  {record ? t("actions.saveEdit") : t("actions.save")}
                </Button>
              )}
              {gates.canApprove && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  onClick={() => void runApprove()}
                >
                  {t("actions.approve")}
                </Button>
              )}
              {record && (
                <span className={styles.metricVersion}>
                  {t("versionNote", {
                    state: t.has(`recordState.${record.state}`)
                      ? t(`recordState.${record.state}`)
                      : record.state,
                  })}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}
