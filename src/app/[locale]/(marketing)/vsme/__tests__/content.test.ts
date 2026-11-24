/**
 * The landing page's commercial facts (ТЗ §16 "Критерии приёмки").
 *
 * §16 pins exact figures — €300 / €1 000 / €2 000 a year excluding VAT, VESG Pro
 * broken down as €1 000 + €2 000, and entity/site/Scope 3 limits that must match
 * the §6 table. Those are the numbers a customer can hold us to, so they are
 * asserted here rather than trusted to review: a one-character edit to
 * `content.ts` is otherwise invisible until someone reads the rendered page.
 */
import { describe, expect, it } from "vitest";

import {
  PLANS,
  SPS,
  VESG_OFFER,
  formatEur,
  FEATURE_FLAGS,
  plan,
  spsConditionsStale,
} from "../content";
import { PLAN_FEATURES, type PlanId } from "@/shared/plans";

describe("pricing (§7, §16)", () => {
  it("charges €300 / €1 000 / €2 000 a year", () => {
    expect(plan("starter").annualPriceEur).toBe(300);
    expect(plan("pro").annualPriceEur).toBe(1000);
    expect(plan("enterprise").annualPriceEur).toBe(2000);
  });

  it("shows Starter first, so it leads on mobile without reordering (§14)", () => {
    expect(PLANS[0]?.id).toBe("starter");
  });

  it("highlights exactly one plan, and it is Pro (§7)", () => {
    expect(PLANS.filter((p) => p.highlighted).map((p) => p.id)).toEqual([
      "pro",
    ]);
  });

  // The page quotes a price; the billing layer invoices one. Until 06.09.2026
  // nothing compared them and two of the three plans disagreed (Starter 300 vs
  // 200, Enterprise 2 000 vs 10 000 a year). Annual = monthly × 10 (§5.2).
  it("quotes exactly what billing invoices: annual = PLAN_FEATURES.price × 10", () => {
    for (const p of PLANS) {
      expect(p.annualPriceEur, p.id).toBe(
        PLAN_FEATURES[p.id as PlanId].price * 10,
      );
    }
  });
});

describe("organisational limits (§6, §16)", () => {
  it("promises the limits the plan gate enforces (maxLegalEntities / maxFacilities)", () => {
    for (const p of PLANS) {
      const f = PLAN_FEATURES[p.id as PlanId];
      expect(p.entityLimit, `${p.id} entities`).toBe(f.maxLegalEntities);
      // `-1` is "unlimited" in the gate, `null` is "no limit" on the page.
      expect(p.siteLimit, `${p.id} sites`).toBe(
        f.maxFacilities === -1 ? null : f.maxFacilities,
      );
    }
  });

  it("matches the depth table row for row", () => {
    expect(plan("starter")).toMatchObject({ entityLimit: 1, siteLimit: 3 });
    expect(plan("pro")).toMatchObject({ entityLimit: 3, siteLimit: 15 });
    // `null` is "no limit" — Enterprise has unlimited sites, not zero.
    expect(plan("enterprise")).toMatchObject({
      entityLimit: 10,
      siteLimit: null,
    });
  });
});

describe("Scope 3 depth (§6)", () => {
  it("gives Starter an ESTIMATE of five categories, never full Scope 3", () => {
    const starter = plan("starter");
    expect(starter.scope3).toBe("spendCategories12");
  });

  it("gives Pro all fifteen and Enterprise the detailed breakdown", () => {
    expect(plan("pro").scope3).toBe("spendCategories12");
    expect(plan("enterprise").scope3).toBe("spendCategories12");
  });

  it("keeps suppliers and the API off Starter (§15 exclusions)", () => {
    expect(plan("starter").supplierRegistry).toBe(false);
    expect(plan("pro").supplierRegistry).toBe(true);
    expect(plan("starter").api).toBe(false);
    expect(plan("pro").api).toBe(false);
    // No plan sells an API until one exists (партия 16).
    expect(plan("enterprise").api).toBe(false);
  });
});

describe("VESG Pro (§8, §16)", () => {
  it("is €1 000 of SaaS Pro plus €2 000 of expert work", () => {
    expect(VESG_OFFER.saasPriceEur).toBe(1000);
    expect(VESG_OFFER.expertServiceEur).toBe(2000);
  });

  it("totals €3 000, and the total is derived rather than declared", () => {
    expect(VESG_OFFER.totalFirstYearEur).toBe(3000);
    expect(VESG_OFFER.totalFirstYearEur).toBe(
      VESG_OFFER.saasPriceEur + VESG_OFFER.expertServiceEur,
    );
  });

  it("prices the SaaS half at the real Pro plan price", () => {
    // The one way this block could quietly disagree with the pricing section.
    expect(VESG_OFFER.saasPriceEur).toBe(plan("pro").annualPriceEur);
  });
});

describe("SPS conditions (§9, §18)", () => {
  it("publishes the figures as verified on the document date", () => {
    expect(SPS.coFinancingPercent).toBe(60);
    expect(SPS.minSubsidyEur).toBe(1000);
    expect(SPS.maxSubsidyEur).toBe(9999.99);
    expect(SPS.sourceUrl).toContain("podjetniskisklad.si");
  });

  it("keeps publishing them while the check is fresh", () => {
    expect(spsConditionsStale(new Date("2026-08-16T00:00:00Z"))).toBe(false);
    expect(spsConditionsStale(new Date("2026-12-01T00:00:00Z"))).toBe(false);
  });

  it("withholds them once the check is older than the window (§14)", () => {
    // Past 180 days the page must fall back to neutral text plus the SPS link
    // rather than serve a promise nobody has re-read.
    expect(spsConditionsStale(new Date("2027-03-01T00:00:00Z"))).toBe(true);
  });
});

describe("feature flags (§15)", () => {
  it("promises none of the formats the MVP may not claim", () => {
    // Flipping any of these needs a working export, QA and approved copy — not
    // a code edit. The test is the tripwire for the edit that skips that.
    expect(FEATURE_FLAGS.xbrlExport).toBe(false);
    expect(FEATURE_FLAGS.ixbrlExport).toBe(false);
    expect(FEATURE_FLAGS.cdpMapping).toBe(false);
    expect(FEATURE_FLAGS.sbtiMapping).toBe(false);
    expect(FEATURE_FLAGS.tcfdMapping).toBe(false);
  });
});

describe("formatEur (§14)", () => {
  it("never lets the amount break away from the € sign", () => {
    const formatted = formatEur(300, "sl");
    expect(formatted).toContain(" ");
    // No plain space and no narrow no-break space survive the normalisation.
    expect(formatted).not.toMatch(/[  ]/);
  });

  it("keeps cents only when the amount has them", () => {
    expect(formatEur(300, "sl")).toBe("300\u00a0\u20ac");
    expect(formatEur(9999.99, "sl")).toBe("9999,99\u00a0\u20ac");
  });

  it("follows Slovene grouping rules rather than forcing a separator", () => {
    // CLDR gives Slovene `minimumGroupingDigits = 2`, so a four-digit amount is
    // written without one; forcing `useGrouping` here would print "1.000 €".
    expect(formatEur(1000, "sl")).toBe("1000\u00a0\u20ac");
    expect(formatEur(10000, "sl")).toBe("10.000\u00a0\u20ac");
  });

  it("formats English with the symbol in front and no stray space", () => {
    expect(formatEur(1000, "en")).toBe("€1,000");
  });
});
