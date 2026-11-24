// =============================================================================
// Plan catalogue — pure, DB-free seed data + row→features builder (§5, §6.1).
//
// This module is deliberately free of `server-only` and of any database / IO
// import so it can be pulled in by BOTH the seed CLI (`seed.ts`) and the
// server-only resolver (`entitlements.ts`), AND imported by the DB-free snapshot
// test without dragging in a Postgres client (§6.4, plan T-A2 / Р-2).
//
//   - `PLAN_SEED` — the exact rows written to `plans` + `plan_prices`. Derived
//     1:1 from `PLAN_FEATURES` (the client contract + snapshot oracle, Вариант А
//     §6.2): `plans.features` = `PlanFeatures` MINUS `{id,name,price}` (the 13
//     remaining fields verbatim, incl. `integrations` — Ф-1); prices are the
//     minor-unit (cents) EUR amounts (monthly = price×100, annual = ×10, §5.2).
//   - `planRowsToFeatures(plansRows, pricesRows)` — the inverse builder that
//     reconstructs the full `PlanFeatures` map (adds back `{id,name,price}`,
//     price = monthly EUR `amount_minor` / 100). Pure: no DB, no cache. Both the
//     resolver and the snapshot test run it, so "DB matrix == PLAN_FEATURES" is
//     provable without Docker.
// =============================================================================

import type { PlanFeaturesConfig } from "@/server/db/types";
import { PLAN_FEATURES, type PlanFeatures, type PlanId } from "@/shared/plans";

/** One `plans` row (business key + hierarchy + entitlements JSONB). */
export interface PlanSeedRow {
  id: PlanId;
  name: string;
  sortOrder: number;
  features: PlanFeaturesConfig;
}

/** One `plan_prices` row (minor-unit cents; §3.2/§5.2). */
export interface PlanPriceSeedRow {
  planId: PlanId;
  period: "monthly" | "annual";
  currency: "EUR";
  amountMinor: number;
}

/** Plan hierarchy → `sort_order` (== `PLAN_ORDER`, `plans.ts:148`). */
const PLAN_ORDER: PlanId[] = ["trial", "starter", "pro", "enterprise"];

/** Strip the presentational `{id,name,price}` → the stored `features` config. */
function toFeaturesConfig(features: PlanFeatures): PlanFeaturesConfig {
  const { id: _id, name: _name, price: _price, ...config } = features;
  return config;
}

/**
 * The catalogue rows, verbatim from `PLAN_FEATURES` (§5.1/§5.2). Kept as data
 * (not re-typed by hand) so it can never drift from the oracle: the snapshot
 * test proves `planRowsToFeatures(PLAN_SEED.*)` round-trips back to it.
 */
export const PLAN_SEED: {
  plans: PlanSeedRow[];
  prices: PlanPriceSeedRow[];
} = {
  plans: PLAN_ORDER.map((id, index) => ({
    id,
    name: PLAN_FEATURES[id].name,
    sortOrder: index,
    features: toFeaturesConfig(PLAN_FEATURES[id]),
  })),
  prices: PLAN_ORDER.flatMap((id) => {
    const monthly = PLAN_FEATURES[id].price * 100; // EUR → minor cents (§0.3)
    return [
      {
        planId: id,
        period: "monthly" as const,
        currency: "EUR" as const,
        amountMinor: monthly,
      },
      {
        planId: id,
        period: "annual" as const,
        currency: "EUR" as const,
        amountMinor: monthly * 10, // ОВ-1: annual = 10× monthly (§5.2)
      },
    ];
  }),
};

// Structural row shapes accepted by the builder — compatible with both
// `PLAN_SEED.*` and Drizzle `db.select().from(plans|planPrices)` results.
type PlanRowLike = { id: string; name: string; features: PlanFeaturesConfig };
type PriceRowLike = {
  planId: string;
  period: string;
  currency: string;
  amountMinor: number;
};

/**
 * Rebuild the full `PlanFeatures` map from `plans` + `plan_prices` rows.
 *
 * Pure and DB-free: adds back the presentational `{id,name,price}` (price =
 * monthly EUR `amount_minor` / 100 → the `PlanFeatures.price: number` contract,
 * `plans.ts:10`) and spreads the stored `features` config. Prices other than
 * (period='monthly', currency='EUR') are ignored, so passing the whole
 * `plan_prices` set is fine.
 *
 * ── Why the row SUPPLEMENTS the code defaults (T1.8 (б), О-13) ──────────────
 * The stored config is a JSONB blob written by an older deploy; it can be one
 * feature-set behind the code that reads it. The naive `{id,name,price,
 * ...row.features}` therefore produced `undefined` for every key the code knows
 * and the row does not — and `undefined` is not a safe floor, it is an OPEN
 * gate: `currentCount >= undefined` is `false`, so `requireWithinLimit` lets
 * everything through; `features.reportFormats.includes(fmt)` throws a TypeError
 * (HTTP 500); a numeric compare against `undefined` is NaN. Spreading
 * `PLAN_FEATURES[id]` FIRST makes the row an OVERLAY: every key the code
 * declares always has a value, and the DB still wins wherever it has an opinion
 * (that is the point of the catalogue being the runtime source of truth, §6.2).
 * The 0004 data migration back-fills the row itself; this is the belt to its
 * braces, and it also covers a row that is stale for any other reason.
 * `{id,name,price}` are re-applied AFTER the spread because those three live in
 * their own columns (`plans.id/name`, `plan_prices.amount_minor`), not in the
 * JSONB — the DB is authoritative for them and a stray key in `features` must
 * not shadow them.
 */
export function planRowsToFeatures(
  plansRows: readonly PlanRowLike[],
  pricesRows: readonly PriceRowLike[],
): Map<PlanId, PlanFeatures> {
  const monthlyEur = new Map<string, number>();
  for (const price of pricesRows) {
    if (price.period === "monthly" && price.currency === "EUR") {
      monthlyEur.set(price.planId, price.amountMinor);
    }
  }

  const result = new Map<PlanId, PlanFeatures>();
  for (const row of plansRows) {
    const id = row.id as PlanId;
    // An id the code does not know cannot have code defaults; fall back to the
    // `trial` contract — the same safest floor `getPlanFeatures` already uses,
    // and still a COMPLETE object rather than a half-populated one.
    const defaults = PLAN_FEATURES[id] ?? PLAN_FEATURES.trial;
    result.set(id, {
      ...defaults,
      ...row.features,
      id,
      name: row.name,
      price: (monthlyEur.get(row.id) ?? 0) / 100,
    });
  }
  return result;
}
