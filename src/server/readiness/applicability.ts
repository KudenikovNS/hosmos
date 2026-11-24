/**
 * Recording — or withdrawing — the decision that a datapoint does not apply,
 * or is omitted as classified/sensitive (VSME B1 §24(b)), for the current
 * revision. See `drizzle/0016_disclosure_applicability.sql`.
 */
import { and, eq } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import {
  disclosureApplicability,
  metricCatalog,
  reportRevision,
} from "@/server/db/schema";

export type ApplicabilityDecision = "not_applicable" | "sensitive_omitted";

export type ApplicabilityOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "unknown_metric" | "no_revision" | "locked" | "reason_required";
    };

export async function decideApplicability(
  db: DbClient,
  companyId: string,
  actorId: string | null,
  input: {
    revisionId: string;
    metricKey: string;
    /** `null` withdraws the decision — the datapoint applies again. */
    status: ApplicabilityDecision | null;
    reason: string | null;
  },
): Promise<ApplicabilityOutcome> {
  const [revision] = await db
    .select({ id: reportRevision.id, status: reportRevision.status })
    .from(reportRevision)
    .where(
      and(
        eq(reportRevision.id, input.revisionId),
        eq(reportRevision.companyId, companyId),
      ),
    )
    .limit(1);
  if (!revision) return { ok: false, reason: "no_revision" };
  if (revision.status === "locked") return { ok: false, reason: "locked" };

  const [metric] = await db
    .select({ key: metricCatalog.metricKey })
    .from(metricCatalog)
    .where(eq(metricCatalog.metricKey, input.metricKey))
    .limit(1);
  if (!metric) return { ok: false, reason: "unknown_metric" };

  if (input.status === null) {
    await db
      .delete(disclosureApplicability)
      .where(
        and(
          eq(disclosureApplicability.companyId, companyId),
          eq(disclosureApplicability.revisionId, revision.id),
          eq(disclosureApplicability.metricKey, metric.key),
        ),
      );
    return { ok: true };
  }

  const reason = (input.reason ?? "").trim();
  if (reason === "") return { ok: false, reason: "reason_required" };

  await db
    .insert(disclosureApplicability)
    .values({
      companyId,
      revisionId: revision.id,
      metricKey: metric.key,
      status: input.status,
      reason,
      decidedBy: actorId,
    })
    .onConflictDoUpdate({
      target: [
        disclosureApplicability.revisionId,
        disclosureApplicability.metricKey,
      ],
      set: {
        status: input.status,
        reason,
        decidedBy: actorId,
        decidedAt: new Date(),
      },
    });
  return { ok: true };
}
