"use client";

// `/review` — the review and approval workspace (T4.6; UI-3 second half, §5.1,
// §5.4, DM-14, LC-1, LC-7, F1/PG-3).
//
// See docs/decisions/app-review-page-L3.md for the full account.
import { ClipboardCheck, FolderOpen, GitPullRequestArrow } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import type { WorkflowStatus } from "@/shared/enums";
import { useCapabilities } from "@/shared/hooks/useCapabilities";
import { usePlan } from "@/shared/hooks/usePlan";
import { useSession } from "@/shared/hooks/useSession";
import { Badge } from "@/shared/ui/Badge";
import { Select } from "@/shared/ui/Select";
import { NoReportingPeriodBanner } from "@/shared/ui/NoReportingPeriodBanner";
import { NoLegalEntityBanner } from "@/shared/ui/NoLegalEntityBanner";
import { NoReportRevisionBanner } from "@/shared/ui/NoReportRevisionBanner";

import { PageLayout } from "../_components/PageLayout";
import { useLegalEntities } from "../organisation/_lib/useOrganisation";
import {
  useInventoryRows,
  useMemberNames,
  usePeriods,
  useRevisions,
} from "../inventory/_lib/useInventory";
import { ApprovalQueue } from "./_components/ApprovalQueue";
import {
  AccessNote,
  LoadErrorNote,
  Muted,
  SectionCard,
} from "../_components/ScreenKit";
import { RevisionPanel } from "./_components/RevisionPanel";
import type { InputTableName, Refusal, RevisionAction } from "./_lib/api";
import { advisoryItems, blockingItems } from "./_lib/blocking";
import { bulkReport, type BulkReport } from "./_lib/bulk";
import { facilityGateFacts } from "./_lib/plan";
import {
  actionOffers,
  transitionNotice,
  type TransitionNotice,
} from "./_lib/transitions";
import {
  useBoundary,
  useFacilities,
  useNewRevision,
  useRowApprovals,
  useTransition,
  useCalculate,
  type CalculationOutcome,
  useValidation,
} from "./_lib/useReview";
import styles from "./page.module.css";

/** No failure list until a transition has actually been refused. */
const NO_FAILURES: never[] = [];

export default function ReviewPage() {
  const t = useTranslations("review");
  const caps = useCapabilities();
  // The SAME sets the routes require — read straight from the server-resolved
  // session, never reconstructed from a role.
  const capabilities = caps.capabilities;
  const canApprove = caps.has("data.approve");
  const canWrite = caps.has("data.write");

  // LC-7 / R7. `hasIndependentApprover` is a COMPANY fact the server resolves in
  // `resolveSessionContext` (`approvers > 0`, counted over active memberships
  // whose role grants `data.approve` by the matrix). `undefined` — still loading,
  // or an older cached response — is deliberately NOT `false`: the disclosure
  // must not flash before the session resolves.
  const { data: sessionData } = useSession();
  const showSelfApproval =
    canApprove && sessionData?.membership?.hasIndependentApprover === false;

  const plan = usePlan();
  const entities = useLegalEntities();

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

  // DM-14 — the queue is a name the SERVER owns (`?queue=1`), never assembled
  // here (see `/api/inventory`).
  const queue = useInventoryRows(revisionId, true);
  const validation = useValidation(revisionId);

  // F1's two numbers, for wording the 402 and nothing else (`_lib/plan`).
  const boundary = useBoundary(periodId);
  const facilities = useFacilities();
  const gate = useMemo(
    () =>
      facilityGateFacts({
        maxFacilities: plan.features.maxFacilities,
        boundary: boundary.entries,
        facilities: facilities.facilities,
      }),
    [plan.features.maxFacilities, boundary.entries, facilities.facilities],
  );

  const transition = useTransition();
  const calculate = useCalculate();
  const approveRows = useRowApprovals();
  const newRevision = useNewRevision();
  const nameOf = useMemberNames();

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [report, setReport] = useState<BulkReport | null>(null);
  const [notice, setNotice] = useState<TransitionNotice | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [calculation, setCalculation] = useState<CalculationOutcome | null>(
    null,
  );
  const [busyAction, setBusyAction] = useState<RevisionAction | null>(null);
  const [restating, setRestating] = useState(false);
  const [restateRefusal, setRestateRefusal] = useState<Refusal | null>(null);
  const [pickedRowId, setPickedRowId] = useState<string | null>(null);

  // The selection is validated against what is loaded: a row that has just been
  // approved has left the queue, and keeping it "open" would describe something
  // the listing no longer shows.
  const selectedRowId =
    queue.rows.find((row) => row.id === pickedRowId)?.id ?? null;

  const offers = actionOffers({ capabilities, status: revisionStatus });

  const queueRowIds = useMemo(
    () => new Set(queue.rows.map((row) => row.id)),
    [queue.rows],
  );
  // The codes the LAST refusal named — so the list can mark what just refused
  // without hiding everything else that is stored against this revision.
  const failures =
    notice !== null && notice.kind === "blocked"
      ? notice.failures
      : NO_FAILURES;
  const blocking = useMemo(
    () =>
      blockingItems({
        results: validation.blocking,
        failures,
        capabilities,
        queueRowIds,
      }),
    [validation.blocking, failures, capabilities, queueRowIds],
  );
  // The other half of DM-28: findings that are stored, are not passed, and
  // block nothing. `blocking` cannot be derived from `results` by this screen
  // (the route sends both, see `_lib/api`), so the filter here is over
  // `!passed && !blocking` — a warning that PASSED is a rule with nothing to
  // say, not a reassurance to print.
  const advisory = useMemo(
    () =>
      advisoryItems({
        results: validation.results.filter(
          (result) => !result.passed && !result.blocking,
        ),
        capabilities,
        queueRowIds,
      }),
    [validation.results, capabilities, queueRowIds],
  );

  const runTransition = async (action: RevisionAction, comment: string) => {
    if (!revisionId || busyAction) return;
    setBusyAction(action);
    const outcome = await transition(revisionId, action, { comment });
    setBusyAction(null);
    setNotice(transitionNotice(outcome, action, gate));
  };

  const runCalculate = async () => {
    if (!revisionId || calculating) return;
    setCalculating(true);
    setCalculation(await calculate(revisionId));
    setCalculating(false);
  };

  const runBulkApprove = async () => {
    if (bulkBusy) return;
    const rows = queue.rows.filter((row) => selected.has(row.id));
    if (rows.length === 0) return;
    setBulkBusy(true);
    const attempts = await approveRows(rows);
    setBulkBusy(false);
    setReport(bulkReport(attempts));
    // Only the rows that WENT THROUGH leave the selection: the refused ones are
    // still selected, so a second press after a fix retries exactly them.
    const refused = new Set(
      attempts.filter((a) => !a.outcome.ok).map((a) => a.row.id),
    );
    setSelected(refused);
  };

  const runRestate = async (changeReason: string) => {
    if (!periodId || !revisionId || restating) return;
    setRestating(true);
    const outcome = await newRevision(periodId, {
      seedFrom: revisionId,
      changeReason,
    });
    setRestating(false);
    setRestateRefusal(outcome.ok ? null : outcome);
  };

  const selectRow = (_table: InputTableName, id: string) => setPickedRowId(id);

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
      loading={periods.loading || entities.loading}
    >
      {(entities.accessChanged ||
        periods.accessChanged ||
        revisions.accessChanged ||
        queue.accessChanged) && <AccessNote />}
      {(entities.loadError || periods.loadError || revisions.loadError) && (
        <LoadErrorNote />
      )}
      {hasRevision && !canApprove && <Muted>{t("readOnlyNote")}</Muted>}

      {entitiesReadable && entities.entities.length === 0 && (
        <NoLegalEntityBanner />
      )}
      {periodsReadable && period === null && <NoReportingPeriodBanner />}
      {periodsReadable && period !== null && (
        <SectionCard
          icon={<FolderOpen size={20} className={styles.iconBlue} />}
          title={t("scope.title")}
          subtitle={t("scope.subtitle")}
        >
          <Select
            label={t("scope.period")}
            id="review-period"
            options={periods.periods.map((period) => ({
              value: period.id,
              label: period.period_name,
            }))}
            value={periodId ?? ""}
            onChange={(e) => {
              setPickedPeriodId(e.target.value);
              setPickedRowId(null);
              setSelected(new Set());
              setReport(null);
              setNotice(null);
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

      {hasRevision && (
        <div className={styles.split}>
          <SectionCard
            icon={<ClipboardCheck size={20} className={styles.iconGreen} />}
            title={t("queue.title")}
            subtitle={t("queue.subtitle")}
            badge={
              <Badge variant="gray" size="sm">
                {t("queue.count", { count: queue.rows.length })}
              </Badge>
            }
          >
            {revisionId === null ? (
              <Muted>{t("queue.noRevision")}</Muted>
            ) : (
              <ApprovalQueue
                rows={queue.rows}
                truncated={queue.truncated}
                loading={queue.loading}
                loadError={queue.loadError}
                canApprove={canApprove}
                selected={selected}
                onToggle={(rowId) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(rowId)) next.delete(rowId);
                    else next.add(rowId);
                    return next;
                  })
                }
                onToggleAll={(all) =>
                  setSelected(
                    all ? new Set(queue.rows.map((r) => r.id)) : new Set(),
                  )
                }
                onApprove={() => void runBulkApprove()}
                busy={bulkBusy}
                report={report}
                selectedRowId={selectedRowId}
                onSelectRow={setPickedRowId}
              />
            )}
          </SectionCard>

          <SectionCard
            icon={<GitPullRequestArrow size={20} className={styles.iconBlue} />}
            title={t("revision.title")}
            subtitle={t("revision.subtitle")}
          >
            {validation.loadError && <LoadErrorNote />}
            <RevisionPanel
              revision={revision}
              offers={offers}
              notice={notice}
              busy={busyAction}
              onTransition={(action, comment) =>
                void runTransition(action, comment)
              }
              blocking={blocking}
              advisory={advisory}
              blockingLoading={validation.loading}
              onSelectRow={selectRow}
              nameOf={nameOf}
              showSelfApproval={showSelfApproval}
              canRestate={canWrite}
              restating={restating}
              restateRefusal={restateRefusal}
              onRestate={(reason) => void runRestate(reason)}
              onCalculate={() => void runCalculate()}
              calculating={calculating}
              calculation={calculation}
            />
          </SectionCard>
        </div>
      )}
    </PageLayout>
  );
}
