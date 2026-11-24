// =============================================================================
// WHAT THIS SUITE PROVES: a role that can ACT on a screen can FIND it.
//
// T4.6 shipped `/review` gated on `data.review` alone, exactly as its acceptance
// line said — and that line was wrong. `ROLE_CAPABILITIES.approver` is
// `["data.approve", "audit.read", "data.read"]`, so the gate hid the approval
// workspace from the only role that exists to approve and lock it. The route
// still answered, which is what made it a bad bug rather than an obvious one: a
// role whose entire job is on a screen it cannot find in the sidebar.
//
// So the invariant is not "`/review` lists both capabilities" — that restates
// the fix and would survive the next screen making the same mistake. It is the
// GENERAL rule, checked against the transition matrix and the role matrix
// themselves: for every nav entry, every role holding a capability the screen
// accepts as a reason to act must see the entry. Add a seventh transition, or
// give a role a new capability, and this fails instead of shipping a screen
// somebody cannot reach.
// =============================================================================
import { describe, expect, it } from "vitest";

import {
  type Capability,
  type CompanyRole,
  ROLE_CAPABILITIES,
} from "@/shared/roles";

import { mayOpenNavItem, NAV_ITEMS } from "../navItems";
import { ALLOWED_TRANSITIONS } from "../../review/_lib/transitions";

const ROLES = Object.keys(ROLE_CAPABILITIES) as CompanyRole[];

/** What the sidebar hands `mayOpenNavItem` — a role's capabilities as a set. */
const capsOf = (role: CompanyRole): ReadonlySet<Capability> =>
  new Set<Capability>(ROLE_CAPABILITIES[role]);

describe("nav capability gates", () => {
  it("accepts a single capability and a list, and a list means ANY of them", () => {
    expect(mayOpenNavItem({}, new Set<Capability>())).toBe(true);
    expect(mayOpenNavItem({ capability: "data.review" }, ["data.review"])).toBe(
      true,
    );
    expect(
      mayOpenNavItem({ capability: "data.review" }, ["data.approve"]),
    ).toBe(false);

    const either = { capability: ["data.review", "data.approve"] } as const;
    expect(mayOpenNavItem(either, ["data.review"])).toBe(true);
    expect(mayOpenNavItem(either, ["data.approve"])).toBe(true);
    expect(mayOpenNavItem(either, ["data.write"])).toBe(false);
  });

  it("lets every role that can drive a revision transition find /review", () => {
    const review = NAV_ITEMS.find((item) => item.href === "/review");
    expect(review).toBeDefined();

    // The screen's REASONS to act, taken from the matrix rather than restated:
    // the capability of every transition it offers.
    const actionable = new Set<Capability>(
      ALLOWED_TRANSITIONS.map((rule) => rule.capability),
    );

    for (const role of ROLES) {
      const caps = capsOf(role);
      const canAct = [...actionable].some((capability) => caps.has(capability));
      if (!canAct) continue;
      expect(
        mayOpenNavItem(review!, caps),
        `role \`${role}\` can drive a transition but cannot see /review`,
      ).toBe(true);
    }
  });

  it("gates /review on the transition matrix itself, not a restatement of it", () => {
    const review = NAV_ITEMS.find((item) => item.href === "/review")!;
    const declared = new Set(
      typeof review.capability === "string"
        ? [review.capability]
        : (review.capability ?? []),
    );
    const fromMatrix = new Set(ALLOWED_TRANSITIONS.map((r) => r.capability));
    // Equal, both ways: a transition whose capability is missing here would
    // hide the screen from whoever drives it, and a capability listed here that
    // drives nothing would advertise the screen to somebody with no reason.
    expect([...declared].sort()).toEqual([...fromMatrix].sort());
  });

  it("keeps every role with a reason on /review, and the read-only one out", () => {
    const review = NAV_ITEMS.find((item) => item.href === "/review")!;
    // The two review roles divide this screen's work and NEITHER holds the
    // other's capability — the original gate hid it from one of them.
    expect(capsOf("approver").has("data.review")).toBe(false);
    expect(capsOf("reviewer").has("data.approve")).toBe(false);
    // And `contributor` belongs here too: `/review` is the only screen that
    // drives a transition, and `submit` is theirs.
    for (const role of [
      "approver",
      "reviewer",
      "contributor",
      "data_owner",
      "esg_admin",
    ] as const) {
      expect(mayOpenNavItem(review, capsOf(role)), role).toBe(true);
    }
    // `auditor` drives nothing: read-only, and /inventory tells the same story.
    expect(mayOpenNavItem(review, capsOf("auditor"))).toBe(false);
  });

  // T5.8 — `/reports` returns, and it returns UNGATED. The screen's own act
  // (producing a render) is `data.review` and is gated on the button and in the
  // route; LISTING and DOWNLOADING what was published is `data.read`, which is
  // what `GET /api/renders` answers to and what every role holds. An `auditor`
  // in particular must reach it: reading the reports a company published is the
  // whole of that role, and a `data.review` gate here would have repeated the
  // T4.6 mistake this file was written about — on the one screen where the
  // read-only role has the strongest claim.
  it("lets every role find /reports, auditor included", () => {
    const reports = NAV_ITEMS.find((item) => item.href === "/reports");
    expect(reports).toBeDefined();
    expect(reports!.capability).toBeUndefined();
    expect(reports!.feature).toBeNull(); // PG-2 gates the FORMAT, not the screen
    for (const role of ROLES) {
      expect(mayOpenNavItem(reports!, capsOf(role)), role).toBe(true);
    }
  });

  it("hides nothing from an esg_admin", () => {
    // The role that holds everything is the sanity check on the gates
    // themselves: if a gate hides a screen from `esg_admin`, the gate is wrong.
    const caps = capsOf("esg_admin");
    for (const item of NAV_ITEMS) {
      expect(
        mayOpenNavItem(item, caps),
        `esg_admin cannot see ${item.href}`,
      ).toBe(true);
    }
  });
});
