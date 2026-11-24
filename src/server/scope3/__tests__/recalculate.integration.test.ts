// =============================================================================
// T3.6 — `recalculateScope3Spend` against a REAL Postgres (harness T-13).
//
// WHAT IS BEING PROVED, AND WHY IT NEEDS A DATABASE. The arithmetic already has
// pure tests (`./compute.test.ts`, moved with the function). What could only ever
// break here is the DECOUPLING itself and the factor SOURCE:
//
//   • a company that has never filled in a monthly grid gets a full answer — the
//     whole point of О-8/MIG-10, and the thing the old `NoMonthlyDataError` made
//     impossible;
//   • the factors come from the NEW `emission_factor` library (`activity_type =
//     'scope3_spend:<commodity_key>'` in the active `factor_set`), which is what
//     survived T3.9's drop of the legacy `emission_factors`;
//   • an empty `scope3_spend` is a RESULT (zeroes, stale rows removed), not an
//     error — so deleting the last line cannot leave a number behind;
//   • the recalculation stays inside categories 1 and 2: an activity-based
//     category row of the same (company, year) is left exactly as it was.
//
// TRIMMED IN T3.9. The first bullet used to name `monthly_emissions_data` and
// `people_data`, and the last one asserted that `emission_results` stayed empty.
// All three tables are dropped by `drizzle/0005_drop_legacy.sql`, which turns
// those assertions from a decoupling proof into a test of nothing — a query
// against a table no writer could reach because no table exists. What still
// carries the proof is stated positively above and checked below: the
// recalculation reads only spend lines, FX and the factor library (a company with
// no other data gets a correct number), and it writes only categories 1–2 of
// `scope3_results` (a pre-existing category-6 row survives byte-for-byte). The
// "no monthly data" half is now guaranteed structurally: `recalculateScope3Spend`
// could not read those tables if it tried.
// =============================================================================
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return {
    get db() {
      return harness.getTestDb();
    },
  };
});

import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { currencies, scope3Results, scope3Spend } from "@/server/db/schema";
import { eq } from "drizzle-orm";

import { listSpendCommodities } from "../factors";
import { recalculateScope3Spend } from "../recalculate";

/** Insert a spend line straight into the table — the route is tested elsewhere. */
async function addLine(
  companyId: string,
  values: {
    category: number;
    commodityKey: string;
    spendAmount: string;
    currency: string;
  },
) {
  await getTestDb()
    .insert(scope3Spend)
    .values({ companyId, year: "2024", ...values });
}

describeIntegration(
  "T3.6 recalculateScope3Spend (decoupled from the deleted legacy engine)",
  () => {
    beforeAll(async () => {
      await setupSchema();
    });
    beforeEach(async () => {
      await resetAppTables();
    });
    afterAll(async () => {
      await closeTestDb();
    });

    it("prices spend for a company with no other data at all, touching only categories 1–2", async () => {
      const company = await insertCompany({ countryCode: "SI" });
      // An activity-based category of the SAME (company, year), written by
      // something other than spend. It must come out of the recalculation
      // untouched — the spend estimate sits beside the activity-based figures,
      // never over them. This is what replaces the `emission_results` assertion
      // T3.9 removed with the table.
      await getTestDb().insert(scope3Results).values({
        companyId: company.id,
        year: "2024",
        categoryId: 6,
        categoryName: "Business travel",
        tco2e: "42.5",
        methodology: "activity-based",
        dataQuality: "primary",
      });

      // €10 000 × 350 ÷ 1e6 = 3.5 (cat 1); RSD 5 000 000 × 0.008541 × 450 ÷ 1e6.
      await addLine(company.id, {
        category: 1,
        commodityKey: "s3_c1_electronics",
        spendAmount: "10000",
        currency: "EUR",
      });
      await addLine(company.id, {
        category: 2,
        commodityKey: "s3_c2_machinery",
        spendAmount: "5000000",
        currency: "RSD",
      });

      const result = await recalculateScope3Spend(company.id, "2024");
      expect(result.warnings).toEqual([]);
      expect(result.cat1).toBeCloseTo(3.5, 2);
      expect(result.cat2).toBeCloseTo(19.22, 2);

      const rows = await getTestDb()
        .select()
        .from(scope3Results)
        .where(eq(scope3Results.companyId, company.id));
      expect(rows.map((r) => r.categoryId).sort()).toEqual([1, 2, 6]);
      // Category 6 is byte-for-byte what it was: the write set is {1, 2}.
      const cat6 = rows.find((r) => r.categoryId === 6);
      expect(cat6).toMatchObject({
        categoryName: "Business travel",
        tco2e: "42.5",
        methodology: "activity-based",
        dataQuality: "primary",
      });
    });

    it("empty spend → zeroes and no rows, not an error", async () => {
      const company = await insertCompany({ countryCode: "SI" });
      const result = await recalculateScope3Spend(company.id, "2024");
      expect(result).toEqual({ cat1: 0, cat2: 0, warnings: [] });
      expect(
        await getTestDb()
          .select()
          .from(scope3Results)
          .where(eq(scope3Results.companyId, company.id)),
      ).toHaveLength(0);
    });

    it("removing the last line deletes the stale result row", async () => {
      const company = await insertCompany({ countryCode: "SI" });
      await addLine(company.id, {
        category: 1,
        commodityKey: "s3_c1_electronics",
        spendAmount: "10000",
        currency: "EUR",
      });
      await recalculateScope3Spend(company.id, "2024");

      await getTestDb()
        .delete(scope3Spend)
        .where(eq(scope3Spend.companyId, company.id));
      const result = await recalculateScope3Spend(company.id, "2024");

      expect(result.cat1).toBe(0);
      expect(
        await getTestDb()
          .select()
          .from(scope3Results)
          .where(eq(scope3Results.companyId, company.id)),
      ).toHaveLength(0);
    });

    it("a commodity with no factor in the set warns and contributes 0 (D4)", async () => {
      const company = await insertCompany({ countryCode: "SI" });
      await addLine(company.id, {
        category: 1,
        commodityKey: "s3_c1_nonexistent",
        spendAmount: "10000",
        currency: "EUR",
      });
      const result = await recalculateScope3Spend(company.id, "2024");
      expect(result.cat1).toBe(0);
      expect(result.warnings).toEqual([
        "no spend factor for s3_c1_nonexistent 2024",
      ]);
    });

    it("a currency with no FX rate warns and contributes 0 (D4)", async () => {
      const company = await insertCompany({ countryCode: "SI" });
      // A code that exists in `currencies` (the FK demands it) but has NO
      // `fx_rates` row — every seeded ISO code does have one.
      await getTestDb()
        .insert(currencies)
        .values({ code: "XXX", name: "No-rate test", symbol: "¤", decimals: 2 })
        .onConflictDoNothing();
      await addLine(company.id, {
        category: 1,
        commodityKey: "s3_c1_electronics",
        spendAmount: "10000",
        currency: "XXX",
      });
      const result = await recalculateScope3Spend(company.id, "2024");
      expect(result.cat1).toBe(0);
      expect(result.warnings).toEqual(["no FX rate for XXX 2024"]);
    });

    it("offers exactly the 8 EXIOBASE per-€1000 commodities, category off the key", async () => {
      const commodities = await listSpendCommodities(getTestDb());
      expect(commodities).toHaveLength(8);
      expect(commodities.filter((c) => c.category === 1)).toHaveLength(6);
      expect(commodities.filter((c) => c.category === 2)).toHaveLength(2);
      const electronics = commodities.find(
        (c) => c.commodityKey === "s3_c1_electronics",
      );
      expect(electronics).toEqual({
        commodityKey: "s3_c1_electronics",
        category: 1,
        label: "Electronics (average)",
      });
      // Every offered commodity is one the recalculation can actually price — the
      // per-tonne scope-3 rows (e.g. `s3_c1_paper`) are not in this list at all.
      expect(commodities.some((c) => c.commodityKey === "s3_c1_paper")).toBe(
        false,
      );
    });
  },
);
