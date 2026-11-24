// `frozen_scope` — WHAT A LOCKED REVISION REMEMBERS (DM-9, §4.7, CALC-7, D15).
//
// See docs/decisions/server-revisions-frozen.md for the full account.
import {
  captureHistoricalRenderContext,
  type HistoricalRenderContext,
} from "@/server/render/historical";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  captureCalculationContext,
  type CalculationContext,
} from "@/server/calc/context";

import type { DbClient } from "@/server/db/client";
import {
  calculationRunContext,
  periodScope,
  reportingPeriod,
  reportRevision,
} from "@/server/db/schema";
import type { CALCULATION_BEARING_FIELDS } from "@/server/periods/lifecycle";

/** The six DM-7a fields, by their API names — the type IS the list. */
type FrozenPeriod = Record<
  (typeof CALCULATION_BEARING_FIELDS)[number],
  string | number | null
>;

/** One frozen boundary row (DM-8), verbatim including its stated reason (D15). */
interface FrozenScopeEntry {
  legal_entity_id: string;
  status: string;
  exclusion_reason: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

/** The whole snapshot, as stored in `report_revision.frozen_scope`. */
export interface FrozenScope {
  version: 1;
  frozen_at: string;
  period_id: string;
  period: FrozenPeriod;
  scope: FrozenScopeEntry[];
  /** Absent on historical snapshots created before 0026; never backfilled. */
  calculation_context?: CalculationContext;
  /** F04: absent on previously locked revisions; never backfilled from live data. */
  render_context?: HistoricalRenderContext;
}

/**
 * Take the snapshot for `periodId`, inside the lock transaction.
 *
 * READ THROUGH THE TRANSACTION HANDLE (`tx`), never through the pooled `db`:
 * the lock updates the revision and copies the boundary in one transaction, so
 * the copy has to be of the state that transaction is committing. A read on
 * another connection could observe a boundary written a millisecond later and
 * freeze something the lock never approved.
 *
 * A period that does not exist for this company is not silently snapshotted as
 * empty — the caller has already resolved it, so this throws rather than storing
 * `{}`, which would look exactly like a legitimately empty boundary.
 */
export async function buildFrozenScope(
  tx: DbClient,
  companyId: string,
  periodId: string,
  revisionId?: string,
): Promise<FrozenScope> {
  const [period] = await tx
    .select()
    .from(reportingPeriod)
    .where(
      and(
        eq(reportingPeriod.id, periodId),
        eq(reportingPeriod.companyId, companyId),
      ),
    )
    .limit(1);
  if (!period) {
    throw new Error(`frozen_scope: period ${periodId} not found for company`);
  }

  const rows = await tx
    .select()
    .from(periodScope)
    .where(
      and(
        eq(periodScope.companyId, companyId),
        eq(periodScope.periodId, periodId),
      ),
    )
    .orderBy(asc(periodScope.legalEntityId));

  const includedEntityIds = rows
    .filter((row) => row.status === "included")
    .map((row) => row.legalEntityId);
  const [latest] = await tx
    .select({ snapshot: calculationRunContext.snapshot })
    .from(calculationRunContext)
    .innerJoin(
      reportRevision,
      eq(reportRevision.id, calculationRunContext.revisionId),
    )
    .where(
      and(
        eq(calculationRunContext.companyId, companyId),
        eq(reportRevision.companyId, companyId),
        eq(reportRevision.periodId, period.id),
        revisionId === undefined
          ? eq(reportRevision.isCurrent, true)
          : eq(reportRevision.id, revisionId),
      ),
    )
    .orderBy(
      desc(calculationRunContext.calculatedAt),
      desc(calculationRunContext.runId),
    )
    .limit(1);
  // Pin the same organisation/FX values as the last recorded calculation.
  // A revision with no recorded run can still take a truthful snapshot NOW,
  // at lock; an already locked legacy revision never calls this builder.
  const calculationContext =
    latest?.snapshot.inputs ??
    (await captureCalculationContext(tx, companyId, {
      periodId: period.id,
      startDate: period.startDate,
      endDate: period.endDate,
      factorSetId: period.factorSetId,
      frozen: true,
      includedEntityIds,
    }));

  const [revision] = await tx
    .select()
    .from(reportRevision)
    .where(
      and(
        eq(reportRevision.companyId, companyId),
        eq(reportRevision.periodId, periodId),
        revisionId === undefined
          ? eq(reportRevision.isCurrent, true)
          : eq(reportRevision.id, revisionId),
      ),
    )
    .limit(1);
  if (!revision)
    throw new Error("frozen_scope: revision not found for company");
  const renderContext = await captureHistoricalRenderContext(
    tx,
    companyId,
    revision,
  );

  return {
    render_context: renderContext,
    version: 1,
    frozen_at: new Date().toISOString(),
    period_id: period.id,
    calculation_context: calculationContext,
    period: {
      factor_set_id: period.factorSetId,
      start_date: period.startDate,
      end_date: period.endDate,
      reporting_basis: period.reportingBasis,
      methodology_version: period.methodologyVersion,
      base_year: period.baseYear,
    },
    scope: rows.map((row) => ({
      legal_entity_id: row.legalEntityId,
      status: row.status,
      exclusion_reason: row.exclusionReason,
      updated_by: row.updatedBy,
      updated_at: row.updatedAt?.toISOString() ?? null,
    })),
  };
}
