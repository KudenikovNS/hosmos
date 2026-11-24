/**
 * Партия 20 — the GA4 tag's rules: it runs only on consent, it never carries an
 * identifier, and the privacy policy names it. All three are promises the site
 * already made in writing (banner, §12, P7), so all three are tested.
 */
import { describe, expect, it } from "vitest";

import termsEn from "../../../messages/terms.en.json";
import termsSl from "../../../messages/terms.sl.json";
import {
  DEFAULT_MEASUREMENT_ID,
  analyticsAllowed,
  analyticsPath,
  disableFlag,
  gaCookieNames,
  isIdSegment,
  isMeasurementId,
  measuredHere,
  measurementId,
} from "../ga/ga";
import { PUBLIC_PATHS, isPublicPathname } from "../routes";

describe("the measurement id", () => {
  it("is the committed property when nothing overrides it", () => {
    expect(measurementId("")).toBe(DEFAULT_MEASUREMENT_ID);
    expect(measurementId(undefined)).toBe(DEFAULT_MEASUREMENT_ID);
    expect(isMeasurementId(DEFAULT_MEASUREMENT_ID)).toBe(true);
  });

  it("takes an override, and switches off on request", () => {
    expect(measurementId("G-ABCDE12345")).toBe("G-ABCDE12345");
    expect(measurementId("off")).toBeNull();
    expect(measurementId("none")).toBeNull();
  });

  it("treats a malformed id as off rather than shipping a dead tag", () => {
    expect(measurementId("UA-12345-1")).toBeNull();
    expect(measurementId("G-")).toBeNull();
    expect(measurementId("g-abcde12345")).toBeNull();
  });
});

describe("consent gates the tag", () => {
  it("runs only on «all»", () => {
    expect(analyticsAllowed("all")).toBe(true);
    expect(analyticsAllowed("necessary")).toBe(false);
    expect(analyticsAllowed(null)).toBe(false);
  });
});

describe("only the main site is measured", () => {
  // The owner's rule of 20.09.2026: the public site, never the product.
  it("counts the public pages, in any locale", () => {
    for (const path of ["/", "/vsme", "/terms", "/login", "/register"])
      expect(measuredHere(path), path).toBe(true);
    for (const path of ["/sl/vsme", "/ru/terms", "/hr/", "/sl/login"])
      expect(measuredHere(path), path).toBe(true);
  });

  it("never counts a screen inside the account", () => {
    for (const path of [
      "/dashboard",
      "/sl/organisation",
      "/sl/inventory/disclosures",
      "/sl/reports",
      "/en/review",
      "/sl/evidence/9d73dd0a-69f3-4632-a6c1-b5f093492f23",
      "/sl/settings",
      "/sl/admin/factors",
    ])
      expect(measuredHere(path), path).toBe(false);
  });

  it("answers nothing for no path, and shares one list with the router", () => {
    expect(measuredHere(null)).toBe(false);
    expect(measuredHere("")).toBe(false);
    // `src/proxy.ts` gates navigation with the same predicate: a page is
    // measured because it is public, never because analytics forgot it.
    expect(PUBLIC_PATHS).toContain("/vsme");
    expect(PUBLIC_PATHS).not.toContain("/dashboard");
    expect(isPublicPathname("/sl/vsme")).toBe(true);
    expect(isPublicPathname("/sl/dashboard")).toBe(false);
  });
});

describe("withdrawing consent", () => {
  // Verified live: without the kill switch the already-loaded library kept
  // sending a hit on the next navigation, and its cookies stayed.
  it("knows the library's own off switch", () => {
    expect(disableFlag(DEFAULT_MEASUREMENT_ID)).toBe(
      `ga-disable-${DEFAULT_MEASUREMENT_ID}`,
    );
  });

  it("names the cookies to expire — the two the policy lists", () => {
    expect(gaCookieNames(DEFAULT_MEASUREMENT_ID)).toEqual([
      "_ga",
      "_ga_FNT7ZJBFER",
    ]);
  });
});

describe("the path an event may carry", () => {
  it("drops the query string and the fragment", () => {
    expect(analyticsPath("/sl/reports?revision=7&tab=xlsx")).toBe(
      "/sl/reports",
    );
    expect(analyticsPath("/sl/terms#cookies")).toBe("/sl/terms");
  });

  it("replaces identifiers with a placeholder", () => {
    expect(
      analyticsPath("/sl/evidence/9d73dd0a-69f3-4632-a6c1-b5f093492f23"),
    ).toBe("/sl/evidence/:id");
    expect(analyticsPath("/sl/invite/abcdefghijklmnopqrstuvwxyz012345")).toBe(
      "/sl/invite/:id",
    );
    expect(analyticsPath("/sl/periods/20240101")).toBe("/sl/periods/:id");
  });

  it("keeps screen names, which is the whole point of measuring", () => {
    expect(analyticsPath("/sl/inventory/disclosures")).toBe(
      "/sl/inventory/disclosures",
    );
    expect(analyticsPath("/en/vsme")).toBe("/en/vsme");
    expect(analyticsPath("/")).toBe("/");
    expect(isIdSegment("disclosures")).toBe(false);
    expect(isIdSegment("scope-3")).toBe(false);
    expect(isIdSegment("2024")).toBe(false);
  });
});

describe("the privacy policy keeps its promise", () => {
  // P7 says: «If an analytics tool is connected, this section is updated with
  // its cookie names and retention before it goes live.» It is connected now.
  const cookieSection = (terms: typeof termsEn) =>
    JSON.stringify(
      terms.termsContent.privacySections.find((s) => s.id === "cookies"),
    );

  it("names the tool, its cookies and their retention, in both languages", () => {
    for (const terms of [termsEn, termsSl]) {
      const section = cookieSection(terms as typeof termsEn);
      expect(section).toContain("Google Analytics");
      expect(section).toContain("_ga");
      expect(section).toContain(
        `_ga_${DEFAULT_MEASUREMENT_ID.replace("G-", "")}`,
      );
      expect(section).toContain("Google Ireland Limited");
      expect(section).toMatch(/2 (years|leti)/);
    }
  });

  it("no longer claims that no analytics tool is connected", () => {
    for (const terms of [termsEn, termsSl]) {
      const section = cookieSection(terms as typeof termsEn);
      expect(section).not.toContain("none at present");
      expect(section).not.toContain("trenutno nobenega");
    }
  });
});
