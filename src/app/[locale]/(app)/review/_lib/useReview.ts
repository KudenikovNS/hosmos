"use client";

// =============================================================================
// THE DATA HOOKS OF `/review` (T4.6) — shaped exactly like
// `inventory/_lib/useInventory.ts` and `evidence/_lib/useEvidence.ts`, and
// importing their primitives rather than re-writing them: `useList` (a 403 on a
// list is `accessChanged`, not a crash, R-11) and `useWrite` (a write returns a
// `WriteOutcome` and never throws) are ONE decision for every screen of this
// app, not five. The period picker, the revision list, the queue itself and the
// member roster are `/inventory`'s hooks, imported — so opening `/review` after
// `/inventory` refetches nothing either screen already holds.
//
// WHAT IS DIFFERENT HERE, and there are three things:
//
//   1. THE TRANSITION HAS ITS OWN WRITE, because `WriteOutcome` is not enough.
//      `classifyRefusal` answers WHICH KIND of refusal happened and deliberately
//      drops everything else; a transition refusal's whole value is the
//      additive `transition` payload (`{action, from, allowed, precondition,
//      reason, rows, pending, failures…}`), which is what turns "this was
//      refused" into "seven rows are still unapproved". So `useTransition`
//      performs the fetch itself — exactly as `useUpload` does for multipart —
//      and returns `Refusal` PLUS the server's detail. The CLASSIFICATION is
//      still `classifyRefusal`'s, so a 402 here and a 402 anywhere else remain
//      one vocabulary.
//   2. BULK APPROVE IS A LOOP OVER THE PER-ROW ROUTE (see `./bulk` for why there
//      is no bulk endpoint and why partial success is the normal outcome). The
//      loop is sequential and it does not stop at the first refusal: the queue
//      is a set of independent rows and VAL-036 refuses exactly the ones whose
//      evidence is missing.
//   3. EVERY WRITE INVALIDATES BY PREFIX. `["inventory"]`, `["periods"]` and the
//      validation key are invalidated as PREFIXES rather than as the exact
//      tuples `useInventory` builds privately: a transition changes the revision
//      status, which changes what the queue may contain, what the other screens
//      may edit and what the rules say — and a screen that guessed one private
//      key spelling wrong would silently show yesterday's answer. React-query
//      prefix matching makes the invalidation total by construction.
// =============================================================================
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { apiFetch } from "@/shared/api/client";
import { SESSION_QUERY_KEY } from "@/shared/hooks/useSession";

import {
  useBoundary,
  useFacilities,
} from "../../organisation/_lib/useOrganisation";
import { useList, useWrite } from "../../inventory/_lib/useInventory";
import {
  APPROVE_PATH,
  classifyRefusal,
  type ApiBody,
  type InventoryRowDto,
  type Refusal,
  type RevisionAction,
  type TransitionData,
  type TransitionDetail,
  type TransitionOutcome,
  type ValidationData,
  type ValidationResultDto,
  type WriteOutcome,
} from "./api";
import type { RowApprovalAttempt } from "./bulk";

/** react-query keys. Prefixes, so an invalidation cannot miss a private tuple. */
const INVENTORY_PREFIX = ["inventory"] as const;
const PERIODS_PREFIX = ["periods"] as const;
const validationKey = (revisionId: string) =>
  ["revision-validation", revisionId] as const;

/** Stable empty arrays — a fresh `[]` per render would churn every memo. */
const NO_RESULTS: ValidationResultDto[] = [];

export { useBoundary, useFacilities };

/**
 * The STORED validation results of one revision (DM-28).
 *
 * A READ that never re-runs anything (VR-2): the route serves what
 * `validation_result` holds, and the runs that fill it are the writes and the
 * transition gates. That is why every refused transition invalidates this key —
 * the gate DID re-evaluate on its way to refusing, and the rows it wrote are the
 * explanation the screen renders.
 */
export function useValidation(revisionId: string | null) {
  const list = useList<ValidationData>(
    validationKey(revisionId ?? "none"),
    revisionId ? `/api/revisions/${revisionId}/validation` : null,
  );
  return {
    results: list.data?.results ?? NO_RESULTS,
    blocking: list.data?.blocking ?? NO_RESULTS,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/**
 * THE transition (§5.1, §12.2) — the one write of this screen that keeps the
 * server's own refusal detail (see point 1 of the header).
 *
 * A transport failure comes back as `{kind: "unknown"}` with no detail rather
 * than as a throw that would leave the panel spinning; a 401/403 additionally
 * refetches the session so the buttons correct themselves (R-11).
 */
export function useTransition(): (
  revisionId: string,
  action: RevisionAction,
  input?: { comment?: string; changeReason?: string },
) => Promise<TransitionOutcome> {
  const queryClient = useQueryClient();
  return useCallback(
    async (
      revisionId: string,
      action: RevisionAction,
      input: { comment?: string; changeReason?: string } = {},
    ): Promise<TransitionOutcome> => {
      let body: ApiBody<TransitionData> & { transition?: TransitionDetail };
      try {
        body = await apiFetch<
          ApiBody<TransitionData> & { transition?: TransitionDetail }
        >(`/api/revisions/${revisionId}/transition`, {
          method: "POST",
          body: JSON.stringify({
            action,
            ...(input.comment === undefined ? {} : { comment: input.comment }),
            ...(input.changeReason === undefined
              ? {}
              : { change_reason: input.changeReason }),
          }),
        });
      } catch {
        return { ok: false, refusal: { kind: "unknown" }, detail: null };
      }

      // The status moved (or an attempt re-ran the rules): both listings, the
      // revision list and the stored results are now stale.
      queryClient.invalidateQueries({ queryKey: PERIODS_PREFIX });
      queryClient.invalidateQueries({ queryKey: INVENTORY_PREFIX });
      queryClient.invalidateQueries({ queryKey: validationKey(revisionId) });

      if (body.ok) return { ok: true, data: body.data };

      const refusal = classifyRefusal(body);
      if (refusal.kind === "access_changed") {
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
      return { ok: false, refusal, detail: body.transition ?? null };
    },
    [queryClient],
  );
}

/** What `POST /api/revisions/[id]/calculate` reports about the run it made. */
interface CalculationRun {
  status: "ok" | "failed";
  lineCount: number;
  failedCount: number;
}

export type CalculationOutcome =
  | { ok: true; run: CalculationRun }
  | {
      ok: false;
      refusal: Refusal | { kind: "concurrent_modification" };
    };

/**
 * Run the calculation of a revision (партия 17). Until this hook existed the
 * run could only be started from the API, while `approve` demanded one — the
 * screen asked for something it offered no way to do. The rows, the results
 * and the validation are all stale afterwards, so all three are invalidated.
 */
export function useCalculate(): (
  revisionId: string,
) => Promise<CalculationOutcome> {
  const queryClient = useQueryClient();
  return useCallback(
    async (revisionId: string): Promise<CalculationOutcome> => {
      let body: ApiBody<{ run?: CalculationRun }>;
      try {
        body = await apiFetch<ApiBody<{ run?: CalculationRun }>>(
          `/api/revisions/${revisionId}/calculate`,
          { method: "POST", body: "{}" },
        );
      } catch {
        return { ok: false, refusal: { kind: "unknown" } };
      }
      queryClient.invalidateQueries({ queryKey: PERIODS_PREFIX });
      queryClient.invalidateQueries({ queryKey: INVENTORY_PREFIX });
      queryClient.invalidateQueries({ queryKey: validationKey(revisionId) });
      if (body.ok) {
        return body.data.run
          ? { ok: true, run: body.data.run }
          : { ok: false, refusal: { kind: "unknown" } };
      }
      if (body.error === "CONCURRENT_MODIFICATION") {
        return { ok: false, refusal: { kind: "concurrent_modification" } };
      }
      const refusal = classifyRefusal(body);
      if (refusal.kind === "access_changed") {
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
      return { ok: false, refusal };
    },
    [queryClient],
  );
}

/**
 * Approve rows of the queue, one request each (LC-4; see `./bulk`).
 *
 * SEQUENTIAL AND NON-STOPPING. Each row is independent, and a refusal of one
 * says nothing about the next — VAL-036 refuses exactly the rows whose evidence
 * is missing. Stopping at the first would leave the rest unattempted and the
 * user unable to tell "refused" from "not tried".
 */
export function useRowApprovals(): (
  rows: readonly InventoryRowDto[],
) => Promise<RowApprovalAttempt[]> {
  const write = useWrite();
  const queryClient = useQueryClient();
  return useCallback(
    async (rows: readonly InventoryRowDto[]): Promise<RowApprovalAttempt[]> => {
      const attempts: RowApprovalAttempt[] = [];
      for (const row of rows) {
        const outcome = await write<unknown>(
          APPROVE_PATH[row.source_table](row.id),
          "POST",
          undefined,
          [],
        );
        attempts.push({ row, outcome });
      }
      // Once, after the run: N invalidations of the same listing would refetch
      // the queue N times while it is still being worked through.
      queryClient.invalidateQueries({ queryKey: INVENTORY_PREFIX });
      return attempts;
    },
    [write, queryClient],
  );
}

/**
 * Start a new revision of a period — LC-9 and §5.1's first row.
 *
 * Over a LOCKED current revision this is a RESTATEMENT and `change_reason` is
 * mandatory: the server answers 422 `{field: "change_reason", reason:
 * "restatement_needs_reason"}`, which classifies as an ordinary
 * `{kind: "field"}` and needs nothing special here. `seedFrom` copies the
 * current rows of the revision being restated (LC-9), which is what makes a
 * restatement a correction rather than a blank report.
 */
export function useNewRevision(): (
  periodId: string,
  values: { seedFrom?: string; changeReason?: string },
) => Promise<WriteOutcome<unknown>> {
  const write = useWrite();
  return useCallback(
    (periodId: string, values: { seedFrom?: string; changeReason?: string }) =>
      write<unknown>(
        `/api/periods/${periodId}/revisions`,
        "POST",
        {
          ...(values.seedFrom ? { seedFrom: values.seedFrom } : {}),
          ...(values.changeReason === undefined
            ? {}
            : { change_reason: values.changeReason }),
        },
        [PERIODS_PREFIX, INVENTORY_PREFIX],
      ),
    [write],
  );
}
