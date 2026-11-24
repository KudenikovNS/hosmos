// =============================================================================
// WHAT THIS SUITE PROVES (T4.6 — the status timeline).
//
// A stamp with no timestamp has not happened, and must not be rendered as a step
// that is merely undated: "not yet" and "we do not know when" look identical on a
// timeline and only one of them is true. The order is §5.1's own.
// =============================================================================
import { describe, expect, it } from "vitest";

import type { RevisionDto } from "../api";
import { revisionTimeline, TIMELINE_STEPS } from "../timeline";

function revision(overrides: Partial<RevisionDto>): RevisionDto {
  return {
    id: "rev-1",
    period_id: "p-1",
    revision_no: 1,
    status: "draft",
    is_current: true,
    assigned_to: null,
    review_comment: null,
    reviewed_by: null,
    reviewed_at: null,
    approved_by: null,
    approved_at: null,
    submitted_by: null,
    submitted_at: null,
    locked_by: null,
    locked_at: null,
    change_reason: null,
    seeded_from_revision_id: null,
    frozen_scope: null,
    created_by: "u-1",
    created_at: "2026-01-02T10:00:00.000Z",
    ...overrides,
  };
}

describe("revisionTimeline", () => {
  it("has nothing to show before a revision is loaded", () => {
    expect(revisionTimeline(null)).toEqual([]);
  });

  it("shows only the stamps that actually happened", () => {
    const entries = revisionTimeline(revision({}));
    expect(entries).toEqual([
      { step: "created", userId: "u-1", at: "2026-01-02T10:00:00.000Z" },
    ]);
  });

  it("keeps §5.1's order regardless of the timestamps", () => {
    const entries = revisionTimeline(
      revision({
        submitted_by: "u-2",
        submitted_at: "2026-01-03T10:00:00.000Z",
        approved_by: "u-3",
        approved_at: "2026-01-05T10:00:00.000Z",
        locked_by: "u-3",
        locked_at: "2026-01-06T10:00:00.000Z",
        status: "locked",
      }),
    );
    expect(entries.map((entry) => entry.step)).toEqual([
      "created",
      "submitted",
      "approved",
      "locked",
    ]);
  });

  it("shows a rejection as its own stamp", () => {
    const entries = revisionTimeline(
      revision({
        submitted_by: "u-2",
        submitted_at: "2026-01-03T10:00:00.000Z",
        reviewed_by: "u-4",
        reviewed_at: "2026-01-04T10:00:00.000Z",
        review_comment: "January gas is missing its invoice",
        status: "rejected",
      }),
    );
    expect(entries.map((entry) => entry.step)).toEqual([
      "created",
      "submitted",
      "reviewed",
    ]);
    expect(entries[2].userId).toBe("u-4");
  });

  it("never invents an entry for a stamp with an actor but no time", () => {
    const entries = revisionTimeline(
      revision({ approved_by: "u-3", approved_at: null }),
    );
    expect(entries.some((entry) => entry.step === "approved")).toBe(false);
  });

  it("covers exactly the five stamped moments of §5.1", () => {
    const entries = revisionTimeline(
      revision({
        submitted_by: "u",
        submitted_at: "2026-01-03T10:00:00.000Z",
        reviewed_by: "u",
        reviewed_at: "2026-01-04T10:00:00.000Z",
        approved_by: "u",
        approved_at: "2026-01-05T10:00:00.000Z",
        locked_by: "u",
        locked_at: "2026-01-06T10:00:00.000Z",
      }),
    );
    expect(entries.map((entry) => entry.step)).toEqual([...TIMELINE_STEPS]);
  });
});
