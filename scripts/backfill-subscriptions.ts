/**
 * Backfill script (BILLING §5, T-C1) — give every existing company a live
 * `trialing` subscription row so `getEntitlements` reads a real subscription
 * instead of degrading to `companies.plan` (guard.ts layer-A fallback).
 *
 * For each company WITHOUT a live subscription row (status IN
 * trialing/active/past_due) it inserts ONE `trialing` row using the company's
 * current `companies.plan` as `planId` (matching the `plans.id` business key),
 * `period='monthly'`, and `trialEndsAt=NULL` (open-ended — ОВ-2). Companies that
 * already have a live row are skipped, so a second run is a no-op. The
 * partial-unique index `company_subscription_company_active_key` is the backstop
 * against duplicates. Everything runs in ONE transaction.
 *
 * Like `seed.ts` this is a standalone tsx CLI (`tsx scripts/backfill-subscriptions.ts`):
 * it builds its own postgres.js client rather than importing `@/server/db` (which
 * is `server-only` and cannot load under tsx). The core `backfillSubscriptions(db)`
 * is exported and pure over its db handle so integration tests can drive it against
 * the test harness DB; `main()` only auto-runs as a CLI (guarded off under vitest).
 *
 * The PROD run is deferred (T-PROD) — this lands the code + a local rehearsal only.
 */
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/server/db/schema";
import { companies, companySubscription } from "@/server/db/schema";
import type { PlanId } from "@/shared/plans";

type Db = PostgresJsDatabase<typeof schema>;

/** Statuses that count as a live subscription (one per company). */
const LIVE_STATUSES = ["trialing", "active", "past_due"] as const;

/** Result of a backfill run. */
export interface BackfillResult {
  created: number;
  skipped: number;
}

/**
 * Insert a `trialing` `company_subscription` for every company that lacks a live
 * row. Idempotent: companies with a live row are skipped. Runs in one transaction.
 */
export async function backfillSubscriptions(db: Db): Promise<BackfillResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: companies.id, plan: companies.plan })
      .from(companies);

    let created = 0;
    let skipped = 0;
    for (const c of rows) {
      const [live] = await tx
        .select({ id: companySubscription.id })
        .from(companySubscription)
        .where(
          and(
            eq(companySubscription.companyId, c.id),
            inArray(companySubscription.status, [...LIVE_STATUSES]),
          ),
        )
        .limit(1);
      if (live) {
        skipped++;
        continue;
      }
      // companies.plan is CHECK-constrained to the plans.id business keys.
      const planId = (c.plan as PlanId | null) ?? "trial";
      await tx.insert(companySubscription).values({
        companyId: c.id,
        planId,
        period: "monthly",
        status: "trialing",
        trialEndsAt: null, // open-ended trial
      });
      created++;
    }
    return { created, skipped };
  });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — cannot backfill. Set DATABASE_URL before running.",
    );
  }
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  try {
    const { created, skipped } = await backfillSubscriptions(db);
    console.log(
      `Backfill complete: created=${created} trialing subscription(s), skipped=${skipped} (already live).`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

// Auto-run only as a CLI. Under vitest the module is imported for its exported
// `backfillSubscriptions`, so main() must NOT fire (it would call process.exit
// and tear down the test runner). Guard on both VITEST and NODE_ENV=test.
if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
