// T-C1 integration test — the `backfill-subscriptions` script against a REAL
// Postgres (T-13 harness). Proves it gives every company a live `trialing` row
// using its `companies.plan`, and is idempotent on a second run (partial-unique
// index → no duplicate live rows). Self-skips with no DATABASE_URL.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { and, eq, inArray } from "drizzle-orm";

import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { companySubscription } from "@/server/db/schema";

import { backfillSubscriptions } from "../../../../scripts/backfill-subscriptions";

const liveRows = (companyId: string) =>
  getTestDb()
    .select()
    .from(companySubscription)
    .where(
      and(
        eq(companySubscription.companyId, companyId),
        inArray(companySubscription.status, ["trialing", "active", "past_due"]),
      ),
    );

describeIntegration("T-C1 backfill-subscriptions", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it("creates exactly one trialing row per company using its plan", async () => {
    const trialCo = await insertCompany({ plan: "trial" });
    const proCo = await insertCompany({ plan: "pro" });

    const res = await backfillSubscriptions(getTestDb());
    expect(res.created).toBe(2);
    expect(res.skipped).toBe(0);

    const trialRows = await liveRows(trialCo.id);
    expect(trialRows).toHaveLength(1);
    expect(trialRows[0].status).toBe("trialing");
    expect(trialRows[0].planId).toBe("trial");
    expect(trialRows[0].period).toBe("monthly");
    expect(trialRows[0].trialEndsAt).toBeNull(); // open-ended

    const proRows = await liveRows(proCo.id);
    expect(proRows).toHaveLength(1);
    expect(proRows[0].planId).toBe("pro");
  });

  it("is idempotent — a second run creates no duplicates", async () => {
    const co = await insertCompany({ plan: "starter" });

    const first = await backfillSubscriptions(getTestDb());
    expect(first.created).toBe(1);

    const second = await backfillSubscriptions(getTestDb());
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);

    const rows = await liveRows(co.id);
    expect(rows).toHaveLength(1); // still exactly one live row
  });

  it("skips a company that already has a live subscription", async () => {
    const co = await insertCompany({ plan: "starter" });
    await getTestDb().insert(companySubscription).values({
      companyId: co.id,
      planId: "pro",
      period: "annual",
      status: "active",
    });

    const res = await backfillSubscriptions(getTestDb());
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);

    const rows = await liveRows(co.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].planId).toBe("pro"); // existing row untouched
    expect(rows[0].status).toBe("active");
  });
});
