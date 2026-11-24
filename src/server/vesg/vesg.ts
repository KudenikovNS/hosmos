/**
 * The VESG facts (`./evaluate.ts`) gathered from the database, and the one
 * write — a person confirming a manual requirement (0022).
 *
 * Reads the same rows the readiness hub reads (`loadReadiness` is called, not
 * re-implemented): the newest period, its current revision, the latest run.
 * What it adds is the company-wide part the voucher asks about — a locked
 * revision, immutable renders, a reviewing role among the members.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { loadLatestRun } from "@/server/calc/run";
import type { DbClient } from "@/server/db/client";
import {
  companyMembers,
  evidenceLink,
  factorSet,
  legalEntity,
  reportRender,
  reportRevision,
  vesgDecision,
} from "@/server/db/schema";
import { loadCurrentRevision } from "@/server/periods/lifecycle";
import { listPeriods } from "@/server/periods/periods";
import { loadReadiness, type ReadinessDto } from "@/server/readiness/readiness";
import { getRevision } from "@/server/revisions/revisions";

import {
  evaluateVesg,
  VESG_CALL_CLOSES,
  VESG_REQUIREMENTS,
  type VesgDecision,
  type VesgFacts,
  type VesgItem,
  type VesgRequirementId,
  type VesgSummary,
} from "./evaluate";

/** Roles that can review or approve without having entered the data. */
const REVIEWING_ROLES = ["reviewer", "approver", "auditor"] as const;

export interface VesgDto {
  readonly period: ReadinessDto["period"];
  readonly plan: ReadinessDto["plan"];
  readonly items: readonly VesgItem[];
  readonly summary: VesgSummary;
  readonly call_closes: string;
  readonly can_confirm: boolean;
}

export function isVesgRequirement(value: unknown): value is VesgRequirementId {
  return (
    typeof value === "string" &&
    (VESG_REQUIREMENTS as readonly string[]).includes(value)
  );
}

export async function loadVesg(
  db: DbClient,
  companyId: string,
  opts: { canConfirm: boolean },
): Promise<VesgDto> {
  const readiness = await loadReadiness(db, companyId);
  const periods = await listPeriods(db, companyId);
  const newest = periods[periods.length - 1] ?? null;
  const current = newest
    ? await loadCurrentRevision(db, companyId, newest.id)
    : undefined;
  const revision = current
    ? await getRevision(db, companyId, current.id)
    : undefined;

  const [
    entities,
    lockedRows,
    renderRows,
    reviewerRows,
    linkRows,
    decisionRows,
  ] = await Promise.all([
    db
      .select({
        country: legalEntity.country,
        employeeCount: legalEntity.employeeCount,
        averageFte: legalEntity.averageFte,
        parent: legalEntity.parentLegalEntityId,
      })
      .from(legalEntity)
      .where(eq(legalEntity.companyId, companyId)),
    newest
      ? db
          .select({ n: sql<number>`count(*)::int` })
          .from(reportRevision)
          .where(
            and(
              eq(reportRevision.companyId, companyId),
              eq(reportRevision.periodId, newest.id),
              eq(reportRevision.status, "locked"),
            ),
          )
      : Promise.resolve([{ n: 0 }]),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(reportRender)
      .where(eq(reportRender.companyId, companyId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(companyMembers)
      .where(
        and(
          eq(companyMembers.companyId, companyId),
          eq(companyMembers.status, "active"),
          inArray(companyMembers.role, [...REVIEWING_ROLES]),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(evidenceLink)
      .where(eq(evidenceLink.companyId, companyId)),
    db.select().from(vesgDecision).where(eq(vesgDecision.companyId, companyId)),
  ]);
  const run = revision ? await loadLatestRun(db, companyId, revision) : null;
  const [pinned] = newest
    ? await db
        .select({ code: factorSet.code })
        .from(factorSet)
        .where(eq(factorSet.id, newest.factorSetId))
        .limit(1)
    : [];

  const root = entities.find((e) => e.parent === null) ?? entities[0] ?? null;
  const decisions: Partial<Record<VesgRequirementId, VesgDecision>> = {};
  for (const row of decisionRows) {
    if (!isVesgRequirement(row.requirementKey)) continue;
    decisions[row.requirementKey] = {
      confirmed: row.confirmed,
      note: row.note,
      decided_at: row.decidedAt.toISOString(),
    };
  }

  const facts: VesgFacts = {
    root: root
      ? {
          country: root.country,
          employeeCount: root.employeeCount,
          averageFte: root.averageFte === null ? null : Number(root.averageFte),
        }
      : null,
    readiness: readiness.period
      ? {
          summary: readiness.summary,
          byCode: Object.fromEntries(
            readiness.disclosures.map((d) => [
              d.code,
              { percent: d.percent, applicable: d.applicable },
            ]),
          ),
          voluntary: readiness.disclosures.reduce(
            (n, d) =>
              n +
              d.datapoints.filter((p) => p.requirement_type === "voluntary")
                .length,
            0,
          ),
          comprehensive: readiness.plan.module === "basic_comprehensive",
        }
      : null,
    factorSetCode: pinned?.code ?? null,
    run: run
      ? {
          ok: run.aggregates.status === "ok",
          stale: run.freshness.stale,
          formulaVersion: run.lines[0]?.formulaVersion ?? null,
        }
      : null,
    locked: (lockedRows[0]?.n ?? 0) > 0,
    renders: renderRows[0]?.n ?? 0,
    reviewers: reviewerRows[0]?.n ?? 0,
    evidenceLinks: linkRows[0]?.n ?? 0,
    decisions,
  };
  const { items, summary } = evaluateVesg(facts);
  return {
    period: readiness.period,
    plan: readiness.plan,
    items,
    summary,
    call_closes: VESG_CALL_CLOSES,
    can_confirm: opts.canConfirm,
  };
}

export async function decideVesg(
  db: DbClient,
  companyId: string,
  actorId: string | null,
  input: {
    requirement: VesgRequirementId;
    confirmed: boolean;
    note: string | null;
  },
): Promise<void> {
  const note = input.note?.trim() ? input.note.trim() : null;
  await db
    .insert(vesgDecision)
    .values({
      companyId,
      requirementKey: input.requirement,
      confirmed: input.confirmed,
      note,
      decidedBy: actorId,
    })
    .onConflictDoUpdate({
      target: [vesgDecision.companyId, vesgDecision.requirementKey],
      set: {
        confirmed: input.confirmed,
        note,
        decidedBy: actorId,
        decidedAt: new Date(),
      },
    });
}
