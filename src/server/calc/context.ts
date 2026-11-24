// F03: the non-row inputs of a calculation, captured once and never backfilled
// from today's registry for an old run. JSON contains data only (no Maps/Dates).
import { asc, eq, inArray, and } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import { getFxRates } from "@/server/db/fx";
import {
  calculationRunContext,
  facility,
  legalEntity,
} from "@/server/db/schema";
import type { AggregateEnergyRow } from "./aggregate";
import type { RunExclusion, RunLine, RunPeriod } from "./run";

export interface CalculationContext {
  readonly version: 1;
  readonly period: RunPeriod;
  readonly entities: readonly {
    id: string;
    country: string | null;
    name: string;
    turnover: string | null;
    currency: string | null;
  }[];
  readonly facilities: readonly {
    id: string;
    country: string | null;
    legalEntityId: string;
    name: string;
  }[];
  readonly fx: {
    year: string;
    rates: Readonly<Record<string, number>>;
  };
}

export interface StoredCalculationContext {
  readonly version: 1;
  readonly inputs: CalculationContext;
  readonly energy: readonly AggregateEnergyRow[];
  readonly owners: readonly Pick<
    RunLine,
    "activityTable" | "activityRowId" | "legalEntityId" | "facilityId"
  >[];
  readonly excluded: readonly RunExclusion[];
}

/** Read only entities in this boundary. Ordering makes value comparison stable. */
export async function captureCalculationContext(
  db: DbClient,
  companyId: string,
  period: RunPeriod,
): Promise<CalculationContext> {
  const ids = [...period.includedEntityIds];
  const [entities, facilities, rates] = await Promise.all([
    ids.length === 0
      ? []
      : db
          .select({
            id: legalEntity.id,
            country: legalEntity.country,
            name: legalEntity.name,
            turnover: legalEntity.turnover,
            currency: legalEntity.reportingCurrency,
          })
          .from(legalEntity)
          .where(
            and(
              eq(legalEntity.companyId, companyId),
              inArray(legalEntity.id, ids),
            ),
          )
          .orderBy(asc(legalEntity.id)),
    ids.length === 0
      ? []
      : db
          .select({
            id: facility.id,
            country: facility.country,
            legalEntityId: facility.legalEntityId,
            name: facility.facilityName,
          })
          .from(facility)
          .where(
            and(
              eq(facility.companyId, companyId),
              inArray(facility.legalEntityId, ids),
            ),
          )
          .orderBy(asc(facility.id)),
    getFxRates(db, period.endDate.slice(0, 4)),
  ]);
  // Only currencies actually used in the denominator can invalidate this run.
  const currencies = [
    ...new Set(
      entities.flatMap((e) => (e.currency === null ? [] : [e.currency])),
    ),
  ].sort();
  return {
    version: 1,
    period,
    entities,
    facilities,
    fx: {
      year: period.endDate.slice(0, 4),
      rates: Object.fromEntries(
        currencies.flatMap((code) => {
          const rate = rates.get(code);
          return rate === undefined ? [] : [[code, rate]];
        }),
      ),
    },
  };
}

export async function loadCalculationContext(
  db: DbClient,
  companyId: string,
  revisionId: string,
  runId: string,
): Promise<StoredCalculationContext | null> {
  const [row] = await db
    .select({ snapshot: calculationRunContext.snapshot })
    .from(calculationRunContext)
    .where(
      and(
        eq(calculationRunContext.companyId, companyId),
        eq(calculationRunContext.revisionId, revisionId),
        eq(calculationRunContext.runId, runId),
      ),
    )
    .limit(1);
  return row?.snapshot?.version === 1 && row.snapshot.inputs.version === 1
    ? row.snapshot
    : null;
}
