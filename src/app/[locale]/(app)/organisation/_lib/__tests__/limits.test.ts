// =============================================================================
// PG-5 — "the subsidiary button is ABSENT from the DOM on Starter, not disabled".
//
// The acceptance criterion is about rendering, and this repository has no
// DOM-render harness (no jsdom, no testing-library) — adding one for a single
// assertion would be a larger change than the feature. So the property is pinned
// in the two places it actually lives:
//
//   1. THE DECISION is `subsidiaryAffordance`, a pure function, exercised below
//      against the REAL plan matrix rather than against hand-written numbers —
//      so a future edit to `PLAN_FEATURES.starter.maxLegalEntities` fails here
//      rather than silently un-hiding the control.
//   2. THE RENDERING is `../../_components/AddSubsidiary.tsx`, whose whole job is
//      to turn that decision into markup. The last test reads the file and
//      asserts the two things a reviewer would check by eye: the `hidden` branch
//      returns `null` BEFORE anything is rendered, and the file contains no
//      `disabled` anywhere — because "disabled" is precisely the wrong answer to
//      this requirement, and it is the answer someone will reach for one day.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PLAN_FEATURES, type PlanId } from "@/shared/plans";

import {
  limitAffordance,
  subsidiaryAffordance,
  UNLIMITED,
  withinLimit,
} from "../limits";

describe("withinLimit", () => {
  it("treats -1 as no cap", () => {
    expect(withinLimit(UNLIMITED, 0)).toBe(true);
    expect(withinLimit(UNLIMITED, 10_000)).toBe(true);
  });

  it("is exclusive on the cap — `used === limit` has no room left", () => {
    expect(withinLimit(3, 2)).toBe(true);
    expect(withinLimit(3, 3)).toBe(false);
    expect(withinLimit(3, 4)).toBe(false);
  });
});

describe("limitAffordance — the GENERAL PG-5 rule", () => {
  it("keeps the control visible and explained once the cap is spent", () => {
    // Starter: "3 of 3 facilities" → locked, NOT hidden (the CTA is the point).
    expect(limitAffordance(PLAN_FEATURES.starter.maxFacilities, 3)).toBe(
      "locked",
    );
    expect(limitAffordance(PLAN_FEATURES.starter.maxFacilities, 2)).toBe(
      "available",
    );
    // Enterprise facilities are uncapped.
    expect(limitAffordance(PLAN_FEATURES.enterprise.maxFacilities, 999)).toBe(
      "available",
    );
  });

  it("never answers `hidden` — that is the exception's answer, not this one", () => {
    for (const limit of [-1, 0, 1, 3, 15]) {
      for (const used of [0, 1, 3, 20]) {
        expect(limitAffordance(limit, used)).not.toBe("hidden");
      }
    }
  });
});

describe("subsidiaryAffordance — the ONE PG-5 exception", () => {
  it("HIDES the control on every plan whose org tree is capped at one entity", () => {
    // The tariff PDF names Starter; the matrix gives trial the same cap (PG-1),
    // and a control whose every use answers 402 must not be offered either.
    const capped: PlanId[] = ["trial", "starter"];
    for (const plan of capped) {
      expect(PLAN_FEATURES[plan].maxLegalEntities).toBe(1);
      for (const used of [0, 1, 2]) {
        expect(
          subsidiaryAffordance(PLAN_FEATURES[plan].maxLegalEntities, used),
        ).toBe("hidden");
      }
    }
  });

  it("offers it on a plan that can hold a group, and locks it at the cap", () => {
    const pro = PLAN_FEATURES.pro.maxLegalEntities; // 3
    expect(subsidiaryAffordance(pro, 1)).toBe("available");
    expect(subsidiaryAffordance(pro, 2)).toBe("available");
    expect(subsidiaryAffordance(pro, 3)).toBe("locked");

    const enterprise = PLAN_FEATURES.enterprise.maxLegalEntities; // 10
    expect(subsidiaryAffordance(enterprise, 9)).toBe("available");
    expect(subsidiaryAffordance(enterprise, 10)).toBe("locked");
  });

  it("offers it on an uncapped tree", () => {
    expect(subsidiaryAffordance(UNLIMITED, 500)).toBe("available");
  });
});

describe("AddSubsidiary renders nothing when the affordance is `hidden`", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../../_components/AddSubsidiary.tsx"),
    "utf8",
  );

  const guard = source.indexOf('if (affordance === "hidden") return null;');

  it("returns null on `hidden` before any markup is produced", () => {
    expect(guard).toBeGreaterThan(-1);
    // Nothing renderable may precede the guard: JSX after it is unreachable for
    // a hidden affordance, JSX before it would not be.
    expect(source.indexOf("<")).toBeGreaterThan(guard);
  });

  it("never merely disables the control", () => {
    // Everything from the guard on is the rendering half of the file. The word
    // appears in the header comment above it, which is where it belongs.
    expect(source.slice(guard)).not.toContain("disabled");
  });
});
