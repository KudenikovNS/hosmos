// =============================================================================
// WHAT THIS SUITE PROVES (T4.6 acceptance — the 402 on Lock reads "4 sites
// included of 3").
//
// The NUMBERS are not on the wire (the 402 carries `{reason: "facility_limit",
// period_id}` and nothing else), so the screen counts them from the boundary and
// the facility registry. What is pinned here is that the count is
// `countIncludableFacilities`' count — BOTH conditions of §11.3 — because a
// number the customer cannot reconcile with what they just changed is worse than
// no number at all.
// =============================================================================
import { describe, expect, it } from "vitest";

import { facilityGateFacts } from "../plan";

const BOUNDARY = [
  { legal_entity_id: "e1", status: "included" },
  { legal_entity_id: "e2", status: "included" },
  { legal_entity_id: "e3", status: "excluded" },
];

const FACILITIES = [
  { legal_entity_id: "e1", included_in_boundary: true },
  { legal_entity_id: "e1", included_in_boundary: true },
  { legal_entity_id: "e2", included_in_boundary: true },
  { legal_entity_id: "e2", included_in_boundary: true },
  // Flagged out of the registry (DM-5) — not reported on this year.
  { legal_entity_id: "e2", included_in_boundary: false },
  // Belongs to an entity the PERIOD excludes (DM-8).
  { legal_entity_id: "e3", included_in_boundary: true },
];

describe("facilityGateFacts", () => {
  it("counts only facilities that BOTH the period and the registry include", () => {
    const facts = facilityGateFacts({
      maxFacilities: 3,
      boundary: BOUNDARY,
      facilities: FACILITIES,
    });
    expect(facts.facilities).toBe(4);
    expect(facts.limit).toBe(3);
    expect(facts.over).toBe(true);
  });

  it("comes back under the limit when a subsidiary leaves the boundary", () => {
    const facts = facilityGateFacts({
      maxFacilities: 3,
      boundary: [
        { legal_entity_id: "e1", status: "included" },
        { legal_entity_id: "e2", status: "excluded" },
      ],
      facilities: FACILITIES,
    });
    expect(facts.facilities).toBe(2);
    expect(facts.over).toBe(false);
  });

  it("comes back under the limit when a site leaves the registry boundary", () => {
    const facts = facilityGateFacts({
      maxFacilities: 3,
      boundary: BOUNDARY,
      facilities: FACILITIES.map((facility, index) =>
        index === 0 ? { ...facility, included_in_boundary: false } : facility,
      ),
    });
    expect(facts.facilities).toBe(3);
    expect(facts.over).toBe(false);
  });

  it("counts an undrawn boundary as zero, not as everything", () => {
    const facts = facilityGateFacts({
      maxFacilities: 3,
      boundary: [],
      facilities: FACILITIES,
    });
    expect(facts.facilities).toBe(0);
    expect(facts.over).toBe(false);
  });

  it("is never `over` on an unlimited plan", () => {
    const facts = facilityGateFacts({
      maxFacilities: -1,
      boundary: BOUNDARY,
      facilities: FACILITIES,
    });
    expect(facts.limit).toBe(-1);
    expect(facts.over).toBe(false);
  });

  it("is not over the limit when the count exactly equals it", () => {
    const facts = facilityGateFacts({
      maxFacilities: 4,
      boundary: BOUNDARY,
      facilities: FACILITIES,
    });
    expect(facts.over).toBe(false);
  });
});
