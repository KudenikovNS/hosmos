/**
 * `drizzle/0014_plan_prices_tz_v1.sql` is the ONLY way `plan_prices` reaches
 * production (О-13), and `PLAN_SEED.prices` is what the local seed writes. Two
 * renderings of one price list; this test reads the migration file and proves
 * they agree row for row, so a price edit in `PLAN_FEATURES` that forgets the
 * migration (or the reverse) fails here instead of on an invoice.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PLAN_SEED } from "../plan-catalog";

const FILE = path.resolve(
  __dirname,
  "../../../../drizzle/0014_plan_prices_tz_v1.sql",
);

/** `(gen_random_uuid(), 'pro', 'annual', 'EUR', 100000, true)` → tuple. */
function parseRows(sql: string) {
  const re =
    /\(gen_random_uuid\(\),\s*'([a-z]+)',\s*'(monthly|annual)',\s*'([A-Z]{3})',\s*(\d+),\s*true\)/g;
  const rows: {
    planId: string;
    period: string;
    currency: string;
    amountMinor: number;
  }[] = [];
  for (const m of sql.matchAll(re)) {
    rows.push({
      planId: m[1]!,
      period: m[2]!,
      currency: m[3]!,
      amountMinor: Number(m[4]),
    });
  }
  return rows;
}

describe("0014_plan_prices_tz_v1 ↔ PLAN_SEED.prices", () => {
  const sql = readFileSync(FILE, "utf8");
  const rows = parseRows(sql);

  it("carries every (plan, period) pair the seed carries, and nothing else", () => {
    const key = (r: { planId: string; period: string; currency: string }) =>
      `${r.planId}:${r.period}:${r.currency}`;
    expect(rows.map(key).sort()).toEqual(PLAN_SEED.prices.map(key).sort());
  });

  it("quotes the same cents as PLAN_SEED for every row", () => {
    for (const seed of PLAN_SEED.prices) {
      const row = rows.find(
        (r) =>
          r.planId === seed.planId &&
          r.period === seed.period &&
          r.currency === seed.currency,
      );
      expect(row, `${seed.planId} ${seed.period}`).toBeDefined();
      expect(row!.amountMinor).toBe(seed.amountMinor);
    }
  });

  it("upserts on the natural key rather than inserting blind", () => {
    expect(sql).toMatch(/ON CONFLICT \(plan_id, period, currency\)/);
    expect(sql).toMatch(/DO UPDATE SET amount_minor = excluded\.amount_minor/);
  });
});
