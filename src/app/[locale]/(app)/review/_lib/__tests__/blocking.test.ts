// =============================================================================
// WHAT THIS SUITE PROVES (T4.6 acceptance — "a blocking rule renders as what
// exactly to fix, with a link to the object").
//
// The suite is `environment: "node"` and there is no DOM to assert a rendered
// link against, so what is pinned is the DECISION behind the link:
//
//   • a finding about a row of the QUEUE points at that row, in place;
//   • a finding about anything else points at the SCREEN that owns it;
//   • a finding whose object this session may not open still produces a LINE,
//     with no link — it is never dropped, because it is one of the reasons the
//     transition did not happen;
//   • a code the refusal named that the stored results cannot place still
//     produces a line, for the same reason;
//   • the list is one line per (rule, OBJECT) — ten rows failing one rule are
//     ten things to fix, not one.
// =============================================================================
import { describe, expect, it } from "vitest";

import type { Capability } from "@/shared/roles";

import {
  advisoryItems,
  blockingItems,
  OBJECT_SCREEN,
  ruleTarget,
} from "../blocking";

const ALL: Capability[] = [
  "company.manage",
  "members.manage",
  "data.write",
  "data.submit",
  "data.review",
  "data.approve",
  "factors.custom",
  "audit.read",
  "data.read",
];

/** A session that may reach every screen except the factor library. */
const NO_FACTORS = ALL.filter((cap) => cap !== "factors.custom");

const QUEUE = new Set(["row-1", "row-2"]);

describe("ruleTarget", () => {
  it("points at a queue row in place, without navigating", () => {
    expect(
      ruleTarget({
        objectType: "emission_activity",
        objectId: "row-1",
        capabilities: ALL,
        queueRowIds: QUEUE,
      }),
    ).toEqual({ kind: "row", table: "emission_activity", id: "row-1" });
  });

  it("sends an input row that is NOT in the queue to /inventory", () => {
    // An already-approved row, or one of another revision: still an input row,
    // just not one this screen can select.
    expect(
      ruleTarget({
        objectType: "purchased_energy_activity",
        objectId: "row-99",
        capabilities: ALL,
        queueRowIds: QUEUE,
      }),
    ).toEqual({
      kind: "screen",
      href: "/inventory",
      objectType: "purchased_energy_activity",
    });
  });

  it("routes each object type to the screen that owns it", () => {
    for (const [objectType, href] of Object.entries(OBJECT_SCREEN)) {
      const target = ruleTarget({
        objectType,
        objectId: "obj-1",
        capabilities: ALL,
        queueRowIds: new Set(),
      });
      expect(target).toEqual({ kind: "screen", href, objectType });
    }
  });

  it("drops the link — not the finding — when the session may not open the screen", () => {
    // `/admin/factors` is hidden from every role without `factors.custom`; a
    // VAL-018 about a factor must not become a link that answers 403.
    const target = ruleTarget({
      objectType: "emission_factor",
      objectId: "f-1",
      capabilities: NO_FACTORS,
      queueRowIds: new Set(),
    });
    expect(target).toEqual({ kind: "none", objectType: "emission_factor" });
  });

  it("links the same finding once the capability is there", () => {
    expect(
      ruleTarget({
        objectType: "emission_factor",
        objectId: "f-1",
        capabilities: ALL,
        queueRowIds: new Set(),
      }),
    ).toEqual({
      kind: "screen",
      href: "/admin/factors",
      objectType: "emission_factor",
    });
  });

  it("has nothing to open for a finding with no object", () => {
    expect(
      ruleTarget({
        objectType: null,
        objectId: null,
        capabilities: ALL,
        queueRowIds: QUEUE,
      }),
    ).toEqual({ kind: "none", objectType: null });
  });

  it("has nothing to open for the revision itself — this IS that screen", () => {
    expect(
      ruleTarget({
        objectType: "report_revision",
        objectId: "rev-1",
        capabilities: ALL,
        queueRowIds: QUEUE,
      }),
    ).toEqual({ kind: "none", objectType: "report_revision" });
  });

  it("degrades an unknown object type to a line without a link", () => {
    expect(
      ruleTarget({
        objectType: "something_a_future_evaluator_invents",
        objectId: "x",
        capabilities: ALL,
        queueRowIds: QUEUE,
      }),
    ).toEqual({
      kind: "none",
      objectType: "something_a_future_evaluator_invents",
    });
  });
});

describe("blockingItems", () => {
  const stored = [
    {
      ruleCode: "VAL-036",
      scope: "record",
      objectType: "emission_activity",
      objectId: "row-1",
    },
    {
      ruleCode: "VAL-036",
      scope: "record",
      objectType: "emission_activity",
      objectId: "row-2",
    },
    // The very same finding read twice — one line, not two.
    {
      ruleCode: "VAL-036",
      scope: "record",
      objectType: "emission_activity",
      objectId: "row-2",
    },
    {
      ruleCode: "VAL-101",
      scope: "period",
      objectType: "reporting_period",
      objectId: "p-1",
    },
  ];

  it("makes one line per (rule, object), not per stored row", () => {
    const items = blockingItems({
      results: stored,
      failures: [],
      capabilities: ALL,
      queueRowIds: QUEUE,
    });
    expect(items.map((item) => [item.code, item.objectId])).toEqual([
      ["VAL-036", "row-1"],
      ["VAL-036", "row-2"],
      ["VAL-101", "p-1"],
    ]);
  });

  it("gives every line somewhere to go", () => {
    const items = blockingItems({
      results: stored,
      failures: [],
      capabilities: ALL,
      queueRowIds: QUEUE,
    });
    expect(items.map((item) => item.target.kind)).toEqual([
      "row",
      "row",
      "screen",
    ]);
  });

  it("marks the rules the LAST refusal named without hiding the others", () => {
    const items = blockingItems({
      results: stored,
      failures: [{ code: "VAL-036", scope: "record", object: "row-1" }],
      capabilities: ALL,
      queueRowIds: QUEUE,
    });
    expect(
      items.filter((item) => item.refusedNow).map((item) => item.code),
    ).toEqual(["VAL-036", "VAL-036"]);
    // The finding the refusal did not name is still listed.
    expect(items.some((item) => item.code === "VAL-101")).toBe(true);
  });

  it("states a refused code the stored results cannot place", () => {
    // A `reference_org` finding is company-wide and is not stored against this
    // revision, so nothing can be linked — but it is still why the submit failed.
    const items = blockingItems({
      results: [],
      failures: [{ code: "VAL-006", scope: "reference_org", object: null }],
      capabilities: ALL,
      queueRowIds: QUEUE,
    });
    expect(items).toEqual([
      {
        key: "VAL-006|-|-",
        code: "VAL-006",
        scope: "reference_org",
        objectType: null,
        objectId: null,
        target: { kind: "none", objectType: null },
        refusedNow: true,
      },
    ]);
  });

  it("does not duplicate a refused code that the stored results DO explain", () => {
    const items = blockingItems({
      results: stored,
      failures: [{ code: "VAL-036", scope: "record", object: "row-1" }],
      capabilities: ALL,
      queueRowIds: QUEUE,
    });
    expect(items.filter((item) => item.code === "VAL-036")).toHaveLength(2);
  });

  it("is empty when nothing is blocking", () => {
    expect(
      blockingItems({
        results: [],
        failures: [],
        capabilities: ALL,
        queueRowIds: QUEUE,
      }),
    ).toEqual([]);
  });

  it("orders by code then object, so a refetch does not reshuffle the list", () => {
    const items = blockingItems({
      results: [...stored].reverse(),
      failures: [],
      capabilities: ALL,
      queueRowIds: QUEUE,
    });
    expect(items.map((item) => `${item.code}/${item.objectId}`)).toEqual([
      "VAL-036/row-1",
      "VAL-036/row-2",
      "VAL-101/p-1",
    ]);
  });
});

describe("advisoryItems", () => {
  // A calculation-scoped WARNING: VAL-107 says a figure was priced by a weaker
  // basis than the pinned factor set offers. It refuses nothing, and until this
  // list existed `/review` rendered `validation.blocking` alone — so the finding
  // was stored, counted on the dashboard, and shown to nobody who could act on
  // it. A disclosure only a SQL client can reach is not a disclosure.
  const warnings = [
    {
      ruleCode: "VAL-107",
      scope: "revision",
      objectType: "calculation",
      objectId: "line-2",
    },
    {
      ruleCode: "VAL-107",
      scope: "revision",
      objectType: "calculation",
      objectId: "line-1",
    },
    // The same finding read twice — one line, exactly as the blocking list does.
    {
      ruleCode: "VAL-107",
      scope: "revision",
      objectType: "calculation",
      objectId: "line-1",
    },
  ];

  it("lists one line per (rule, object), ordered like the blocking list", () => {
    const items = advisoryItems({
      results: warnings,
      capabilities: ALL,
      queueRowIds: QUEUE,
    });
    expect(items.map((item) => `${item.code}/${item.objectId}`)).toEqual([
      "VAL-107/line-1",
      "VAL-107/line-2",
    ]);
  });

  it("never marks an advisory as something a transition just refused", () => {
    // `refusedNow` highlights the codes the LAST refusal named. A non-blocking
    // rule can never be one of them, so it is `false` by construction rather
    // than by the caller remembering to pass an empty failure list.
    const items = advisoryItems({
      results: warnings,
      capabilities: ALL,
      queueRowIds: QUEUE,
    });
    expect(items.every((item) => !item.refusedNow)).toBe(true);
  });

  it("states a finding it cannot link to instead of hiding it", () => {
    // `calculation` has no screen of its own — it is not an input row and not a
    // reference record — so the line carries the sentence and says where the
    // object lives rather than pointing at a route that does not exist. Hiding
    // it would be the failure this whole list exists to end.
    const [item] = advisoryItems({
      results: warnings,
      capabilities: ALL,
      queueRowIds: QUEUE,
    });
    expect(OBJECT_SCREEN.calculation).toBeUndefined();
    expect(item.target).toEqual({ kind: "none", objectType: "calculation" });
  });

  it("is empty when nothing was found", () => {
    expect(
      advisoryItems({ results: [], capabilities: ALL, queueRowIds: QUEUE }),
    ).toEqual([]);
  });
});
