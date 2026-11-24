/**
 * WHICH CATALOGUE MODULES a company may work in — the plan's answer, read the
 * way the readiness hub and the renderer need it: by company id, without a
 * session.
 *
 * ── WHY NOT `getEntitlements` ───────────────────────────────────────────────
 * `getEntitlements(session)` is the WRITE gate: it knows the subscription row,
 * the lapse mode and the trial clock, and `server/inventory/disclosures.ts`
 * refuses a value through it. This module answers a READ question — "which
 * datapoints does this company's report contain" — and is called from places
 * that have a company id and no session (`loadReadiness`, `loadRenderInput`).
 * It reads the denormalised `companies.plan` and the DB plan catalogue, the
 * same pair `loadReadiness` read before партия 9 factored it out; a lapsed
 * subscription therefore still SHOWS the modules it bought (read-only mode,
 * §9) and is refused when it tries to write.
 *
 * ── THE TWO MODULES ─────────────────────────────────────────────────────────
 *   • `comprehensive`   — VSME C1…C9 (`metric_catalog.module='comprehensive'`),
 *                         PG-6, `vsmeComprehensive`.
 *   • `simplifiedEsrs`  — the 50 simplified-ESRS datapoints
 *                         (`standard='esrs'`, 0019), `simplifiedEsrs` (0021).
 */
import { eq } from "drizzle-orm";

import type { DbClient } from "@/server/db/client";
import { companies, plans } from "@/server/db/schema";
import { PLAN_FEATURES, type PlanId } from "@/shared/plans";

export interface CompanyModules {
  readonly planId: PlanId;
  readonly comprehensive: boolean;
  readonly simplifiedEsrs: boolean;
}

/** The plan whose module a `metric_catalog.module` value needs, if any. */
export function moduleFeature(
  module: string,
): "vsmeComprehensive" | "simplifiedEsrs" | null {
  if (module === "comprehensive") return "vsmeComprehensive";
  if (module === "simplified_esrs") return "simplifiedEsrs";
  return null;
}

export async function loadCompanyModules(
  db: DbClient,
  companyId: string,
): Promise<CompanyModules> {
  const [company] = await db
    .select({ plan: companies.plan })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const raw = company?.plan as PlanId | null | undefined;
  const planId: PlanId = raw && raw in PLAN_FEATURES ? raw : "trial";
  const [row] = await db
    .select({ features: plans.features })
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  const stored = (row?.features ?? null) as {
    vsmeComprehensive?: boolean;
    simplifiedEsrs?: boolean;
  } | null;
  return {
    planId,
    comprehensive:
      stored?.vsmeComprehensive ?? PLAN_FEATURES[planId].vsmeComprehensive,
    simplifiedEsrs:
      stored?.simplifiedEsrs ?? PLAN_FEATURES[planId].simplifiedEsrs,
  };
}
