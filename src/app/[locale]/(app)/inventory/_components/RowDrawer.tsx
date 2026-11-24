"use client";

// =============================================================================
// THE DETAIL DRAWER (UI-2, LC-4, LC-5, LC-10) — one row, its whole body, its
// whole version chain, and the two writes a row accepts.
//
// EDITING IS VERSIONING, AND THE DRAWER HAS TO SAY SO. A PATCH does not update
// the row in place: it writes a NEW VERSION with a NEW id and stamps
// `superseded_by_id` on the one it replaces (§0.4, D5). Three consequences are
// visible here and are not incidental:
//
//   • THE SELECTION FOLLOWS THE ANSWER. A successful save switches the drawer to
//     the id the response carried. Staying on the old id would leave the user
//     editing a version that has just been superseded, and the next save would
//     be refused as NOT_FOUND with nothing on screen explaining why.
//   • SUPERSEDING AN APPROVED VERSION NEEDS A REASON (LC-5). The field is
//     required in the FORM — autosave does not fire and Save is disabled until
//     it is filled — and the server refuses without it regardless (422,
//     `{field: "change_reason"}`). The form asking first is UX; the refusal is
//     the rule. This is not the client refusing what the server would accept:
//     the server would refuse this exact write.
//   • APPROVE IS ALSO A VERSION (LC-4), so after it the head's actor is the
//     APPROVER and the author of the data is one link back — which is why the
//     chain below is a list of authors and not a "last modified by" line.
//
// A HISTORICAL VERSION IS READ-ONLY, and not because a flag says so: clicking an
// entry in the chain selects a version whose `superseded_by_id` is set, and
// `rowActionGates` reports no live head — the same answer `rows.ts` gives
// (NOT_FOUND for a superseded or tombstoned target). One rule, two places that
// agree by construction rather than by coincidence.
//
// THE INLINE CHECKS ARE ADVISORY (VR-2) — `_lib/checks` states the argument. The
// two rules that need the period's pinned factor set are NAMED as deferred
// rather than guessed at, so the user knows they are still coming.
// =============================================================================
import { X } from "lucide-react";
import { useTranslations } from "next-intl";

import { useCompany } from "@/shared/hooks/useSession";
import { useCompanySaves } from "@/shared/autosave/CompanySaveProvider";
import { autosaveKey } from "@/shared/autosave/controller";
import { useHelp } from "@/shared/hooks/useHelp";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkflowStatus } from "@/shared/enums";
import type { Capability } from "@/shared/roles";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";

import { SaveBar } from "../../organisation/_components/common";
import { useAutosave, type Draft } from "../../organisation/_lib/useAutosave";
import type {
  AssetDto,
  FacilityDto,
  LegalEntityDto,
  Refusal,
  RevisionDto,
  RowDto,
} from "../_lib/api";
import { rowActionGates } from "../_lib/actions";
import { FACTOR_SET_CHECKS, inlineChecks } from "../_lib/checks";
import {
  useMemberNames,
  useRow,
  useRowHistory,
  useRowWrites,
} from "../_lib/useInventory";
import type { TabSpec } from "../_lib/tabs";
import styles from "../page.module.css";
import {
  AccessNote,
  LoadErrorNote,
  Muted,
  RefusalNote,
  useRuleText,
} from "../../_components/ScreenKit";
import { StateBadge } from "./common";
import {
  CalculatedFactors,
  EmissionFields,
  EnergyFields,
  InstrumentFields,
  MixinFields,
  unitsFor,
} from "./RowFields";
import { VersionChain } from "./VersionChain";

/** A DTO value as a form control holds it (`useAutosave`'s header: all strings). */
function asDraftValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * The row as the FORM's baseline. Everything the DTO carries except the mixin's
 * service-owned half — `id`, the version columns and the audit stamps are the
 * service's (`SERVICE_OWNED_COLUMNS`) and no body may set them, so a form that
 * offered them would be offering to write what is stripped.
 */
const NOT_EDITABLE: readonly string[] = [
  "id",
  "revision_id",
  "state",
  "approved_by",
  "approved_at",
  "previous_version_id",
  "superseded_by_id",
  "change_reason",
  "is_deleted",
  "actor_id",
  "actor_role",
  "created_at",
  "metric_key",
  "location_factor_id",
  "market_factor_id",
];

function baselineOf(row: RowDto | null): Draft {
  if (!row) return {};
  const draft: Draft = {};
  for (const [key, value] of Object.entries(row)) {
    if (NOT_EDITABLE.includes(key)) continue;
    draft[key] = asDraftValue(value);
  }
  return draft;
}

export function RowDrawer({
  tab,
  rowId,
  revisionId,
  revisionStatus,
  revisions,
  capabilities,
  entities,
  facilities,
  assets,
  onSelectVersion,
  onSavedVersion,
  onClose,
}: {
  tab: TabSpec;
  /** The version being shown — an inventory row, or a chain entry the user picked. */
  rowId: string;
  revisionId: string | null;
  revisionStatus: WorkflowStatus | null;
  revisions: RevisionDto[];
  /** Straight from `useCapabilities()`. This screen never sees a role. */
  capabilities: readonly Capability[];
  entities: LegalEntityDto[];
  facilities: FacilityDto[];
  assets: AssetDto[];
  onSelectVersion: (id: string) => void;
  onSavedVersion: (from: string, to: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("inventory");
  const help = useHelp("inventory.help");
  const ruleText = useRuleText();
  const detail = useRow(tab.family, rowId);
  const chain = useRowHistory(tab.family, rowId);
  const nameOf = useMemberNames();
  const writes = useRowWrites(tab.family, revisionId);

  const { company } = useCompany();
  const { coordinator } = useCompanySaves();
  const currentVersion = useRef(rowId);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const row = detail.row;
  const [reason, setReason] = useState("");
  const [approveRefusal, setApproveRefusal] = useState<Refusal | null>(null);
  const [approving, setApproving] = useState(false);

  const gates = rowActionGates({ capabilities, revisionStatus, row });
  const reasonGiven = reason.trim() !== "";
  // LC-5 in the form: an approved version may not be superseded without a
  // reason, so the write is not offered until there is one. The server refuses
  // the same write; this only makes the demand visible before the round trip.
  const writable =
    gates.canSaveDraft && (!gates.needsChangeReason || reasonGiven);

  const baseline = useMemo(() => baselineOf(row), [row]);

  const save = useCallback(
    async (patch: Draft) => {
      if (!row) return { ok: false as const, kind: "unknown" as const };
      const result = await writes.edit(currentVersion.current, {
        ...patch,
        ...(reasonGiven ? { change_reason: reason } : {}),
      });
      // A new version has a NEW id — follow it, or the next save edits a
      // version that no longer exists (see the header).
      if (result.ok) {
        const nextId = (result.data as RowDto).id;
        coordinator.follow(
          autosaveKey(
            company?.id,
            `row:${tab.family}:${currentVersion.current}`,
          ),
          autosaveKey(company?.id, `row:${tab.family}:${nextId}`),
        );
        const fromId = currentVersion.current;
        currentVersion.current = nextId;
        if (mounted.current) setReason("");
        onSavedVersion(fromId, nextId);
      }
      return result;
    },
    [
      row,
      writes,
      reason,
      reasonGiven,
      onSavedVersion,
      coordinator,
      company?.id,
      tab.family,
    ],
  );

  const autosave = useAutosave({
    contextKey: `row:${tab.family}:${rowId}`,
    baseline,
    save,
    enabled: writable,
  });
  const checks = inlineChecks(tab.table, autosave.values);

  const approve = async () => {
    if (!row || approving) return;
    setApproving(true);
    setApproveRefusal(null);
    const result = await writes.approve(row.id);
    setApproving(false);
    if (result.ok) onSelectVersion((result.data as RowDto).id);
    else setApproveRefusal(result);
  };

  return (
    <aside className={styles.drawer} aria-label={t("drawer.title")}>
      <div className={styles.drawerHead}>
        <div className={styles.headerGrow}>
          <p className={styles.cardTitle}>{t("drawer.title")}</p>
          {row && (
            <p className={styles.headerSubtitle}>
              {t("drawer.subtitle", { tab: t(`tabs.${tab.id}`) })}
            </p>
          )}
        </div>
        {row && <StateBadge state={row.state} />}
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t("drawer.close")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      {detail.accessChanged ? (
        <AccessNote />
      ) : detail.loading ? (
        <Muted>{t("loadingSection")}</Muted>
      ) : detail.loadError || !row ? (
        <LoadErrorNote />
      ) : (
        <>
          {!gates.revisionOpen && <Muted>{t("revision.frozenBody")}</Muted>}
          {row.superseded_by_id !== null && (
            <Muted>{t("drawer.supersededNote")}</Muted>
          )}
          {row.is_deleted && <Muted>{t("drawer.tombstoneNote")}</Muted>}

          <fieldset className={styles.fieldset} disabled={!writable}>
            <div className={styles.twoCol}>
              <MixinFields
                values={autosave.values}
                set={autosave.set}
                checks={checks}
                disabled={!writable}
                idPrefix="row"
                entities={entities}
                facilities={facilities}
                units={unitsFor(tab)}
              />
              {tab.family === "emission" && (
                <EmissionFields
                  tab={tab}
                  values={autosave.values}
                  set={autosave.set}
                  checks={checks}
                  disabled={!writable}
                  idPrefix="row"
                />
              )}
              {tab.family === "energy" && (
                <EnergyFields
                  values={autosave.values}
                  set={autosave.set}
                  checks={checks}
                  disabled={!writable}
                  idPrefix="row"
                  assets={assets}
                />
              )}
              {tab.family === "instruments" && (
                <InstrumentFields
                  values={autosave.values}
                  set={autosave.set}
                  checks={checks}
                  disabled={!writable}
                  idPrefix="row"
                />
              )}
            </div>
          </fieldset>

          {tab.family === "energy" && "location_factor_id" in row && (
            <CalculatedFactors
              locationFactorId={row.location_factor_id}
              marketFactorId={row.market_factor_id}
            />
          )}

          {/* VR-2: what this screen deliberately does NOT decide for itself. */}
          <div className={styles.deferred}>
            <p className={styles.subsectionTitle}>
              {t("checks.deferredTitle")}
            </p>
            <ul className={styles.hintList}>
              {FACTOR_SET_CHECKS.map((code) => (
                <li key={code}>{ruleText(code)}</li>
              ))}
            </ul>
            <p className={styles.calculatedBody}>{t("checks.deferredBody")}</p>
          </div>

          {gates.needsChangeReason && gates.revisionOpen && (
            <div className={styles.reason}>
              <Input
                label={t("fields.change_reason")}
                help={help("change_reason")}
                id="row-change-reason"
                required
                hint={t("hints.change_reason")}
                error={reasonGiven ? undefined : t("changeReason.required")}
                value={reason}
                disabled={!gates.canSaveDraft}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}

          <RefusalNote screen="inventory" refusal={autosave.refusal} />

          {gates.canSaveDraft && (
            <SaveBar
              status={autosave.status}
              dirty={autosave.dirty && writable}
              onConfirm={autosave.confirm}
            />
          )}

          {/* The approve button. ONE reference to `gates.canApprove`, which is
              false without `data.approve` under every other input — and the
              route requires the capability itself, so a direct POST from a
              console is still a 403. */}
          {gates.canApprove && (
            <div className={styles.formActions}>
              <Button
                size="sm"
                loading={approving}
                onClick={() => void approve()}
              >
                {t("actions.approve")}
              </Button>
              <span className={styles.saveStatus}>{t("approve.hint")}</span>
            </div>
          )}
          <RefusalNote screen="inventory" refusal={approveRefusal} />

          <VersionChain
            versions={chain.versions}
            truncated={chain.truncated}
            loading={chain.loading}
            selectedId={row.id}
            revisionId={revisionId}
            revisions={revisions}
            nameOf={nameOf}
            onSelect={onSelectVersion}
          />
        </>
      )}
    </aside>
  );
}
