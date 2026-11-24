// =============================================================================
// Server-side entitlements resolver (§6.1) — plan features from the DB catalogue.
//
// The catalogue (`plans` + `plan_prices`) is the runtime source of truth (Вариант
// А §6.2); `PLAN_FEATURES` in `src/shared/plans.ts` stays only as the client
// contract + snapshot oracle + fallback. This module reads the catalogue once and
// caches it for the process lifetime (plans change rarely; the cache resets on
// deploy). The pure `planRowsToFeatures` builder (plan-catalog.ts) does the
// row→features reconstruction, shared with the seed and the snapshot test.
//
// `server-only` guards against accidental client bundling (it touches `db`). The
// DB-free snapshot test therefore imports the pure builder from plan-catalog.ts,
// NOT this module.
// =============================================================================

import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { planPrices, plans } from "@/server/db/schema";
import { PLAN_FEATURES, type PlanFeatures, type PlanId } from "@/shared/plans";

import { planRowsToFeatures } from "./plan-catalog";

// In-memory catalogue cache (process-lifetime; reset on deploy — §6.1).
let cache: Map<PlanId, PlanFeatures> | null = null;

/**
 * Resolve the full plan→features matrix from the DB catalogue (cached).
 *
 * Reads `plans` + the monthly EUR `plan_prices` and reconstructs each
 * `PlanFeatures` via the shared pure builder. Warms the cache on first call so
 * `getPlanFeaturesFromDb` can serve synchronously afterwards.
 */
export async function loadPlanFeatures(): Promise<Map<PlanId, PlanFeatures>> {
  if (cache) return cache;

  const [planRows, priceRows] = await Promise.all([
    db.select().from(plans),
    db
      .select()
      .from(planPrices)
      .where(
        and(eq(planPrices.period, "monthly"), eq(planPrices.currency, "EUR")),
      ),
  ]);

  cache = planRowsToFeatures(planRows, priceRows);
  return cache;
}

/**
 * Synchronous feature lookup from the warmed cache. Falls back to the `trial`
 * contract when the cache is cold or the id is unknown — the safest default
 * (never grants more than paid). Warm the cache with `loadPlanFeatures()` at the
 * request/session boundary before relying on this.
 */
export function getPlanFeaturesFromDb(id: PlanId): PlanFeatures {
  return cache?.get(id) ?? PLAN_FEATURES.trial;
}

/** Drop the cache (deploy/test hook — catalogue rarely changes at runtime). */
export function resetPlanFeaturesCache(): void {
  cache = null;
}
