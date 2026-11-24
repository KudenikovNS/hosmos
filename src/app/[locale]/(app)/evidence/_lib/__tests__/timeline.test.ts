// =============================================================================
// THE CHANGE TIMELINE, PINNED WITHOUT A DOM (T4.5 — LC-10).
//
// What is worth testing about a merge of two lists is not that it renders. It is
// that it says only what the server stored, in the right order, and that it
// knows what it does NOT know:
//
//   • an `audit_log` row about ANOTHER row's version never lands on this row's
//     timeline — the filter is by `entity_id`, and the failure it prevents is a
//     report-level transition or a neighbouring approval appearing as history of
//     a figure it has nothing to do with;
//   • a version and the audit row written in the SAME request (an approval
//     writes both) keep a deterministic order, so the timeline does not shuffle
//     between reloads;
//   • the audit window is disclosed when it is shorter than the row's life,
//     because `/api/audit` returns the company's most recent rows only and a
//     prefix presented as a whole trail is the quiet lie an audit trail cannot
//     afford.
// =============================================================================
import { describe, expect, it } from "vitest";

import type { AuditEntryDto, RowMixinDto } from "../api";
import { auditWindowIncomplete, buildTimeline } from "../timeline";

function version(
  id: string,
  at: string,
  over: Partial<RowMixinDto> = {},
): RowMixinDto {
  return {
    id,
    revision_id: "rev-1",
    legal_entity_id: "entity-1",
    facility_id: null,
    asset_id: null,
    metric_key: null,
    year_month: "2026-01",
    unit: "kWh",
    state: "draft",
    approved_by: null,
    approved_at: null,
    notes: null,
    previous_version_id: null,
    superseded_by_id: null,
    change_reason: null,
    is_deleted: false,
    actor_id: "user-1",
    actor_role: "contributor",
    created_at: at,
    ...over,
  };
}

function audit(id: string, entityId: string | null, at: string): AuditEntryDto {
  return {
    id,
    entity: "emission_activity",
    action: "update",
    entityId,
    actorRole: "esg_admin",
    summary: { self_approved: false },
    createdAt: at,
    userName: "Ana",
    userEmail: "ana@example.com",
  };
}

describe("buildTimeline — only this row's history, oldest first", () => {
  it("numbers the versions in chain order", () => {
    const entries = buildTimeline(
      [
        version("v1", "2026-01-01T10:00:00.000Z"),
        version("v2", "2026-02-01T10:00:00.000Z", {
          previous_version_id: "v1",
        }),
      ],
      [],
    );
    expect(entries.map((e) => e.kind === "version" && e.no)).toEqual([1, 2]);
  });

  it("drops audit rows that are about another row's version", () => {
    const entries = buildTimeline(
      [version("v1", "2026-01-01T10:00:00.000Z")],
      [
        audit("a1", "v1", "2026-01-01T10:00:00.000Z"),
        audit("a2", "somebody-elses-row", "2026-01-01T11:00:00.000Z"),
        audit("a3", null, "2026-01-01T12:00:00.000Z"),
      ],
    );
    expect(entries.filter((e) => e.kind === "audit").map((e) => e.key)).toEqual(
      ["audit:a1"],
    );
  });

  it("puts the version before the audit row written in the same request", () => {
    // An approval writes the new version and its audit row inside one
    // transaction, so both can carry the same millisecond. The act comes first.
    const sameInstant = "2026-03-01T09:00:00.000Z";
    const entries = buildTimeline(
      [version("v1", sameInstant, { state: "approved" })],
      [audit("a1", "v1", sameInstant)],
    );
    expect(entries.map((e) => e.kind)).toEqual(["version", "audit"]);
  });

  it("interleaves by time across versions", () => {
    const entries = buildTimeline(
      [
        version("v1", "2026-01-01T10:00:00.000Z"),
        version("v2", "2026-03-01T10:00:00.000Z"),
      ],
      [audit("a1", "v1", "2026-02-01T10:00:00.000Z")],
    );
    expect(entries.map((e) => e.key)).toEqual(["v1", "audit:a1", "v2"]);
  });

  it("marks the live head and nothing else", () => {
    const entries = buildTimeline(
      [
        version("v1", "2026-01-01T10:00:00.000Z", { superseded_by_id: "v2" }),
        version("v2", "2026-02-01T10:00:00.000Z"),
      ],
      [],
    );
    expect(entries.map((e) => e.kind === "version" && e.head)).toEqual([
      false,
      true,
    ]);
  });

  it("does not call a tombstone the head", () => {
    const entries = buildTimeline(
      [version("v1", "2026-01-01T10:00:00.000Z", { is_deleted: true })],
      [],
    );
    expect(entries[0].kind === "version" && entries[0].head).toBe(false);
  });

  it("adds nothing of its own to an empty chain", () => {
    expect(
      buildTimeline([], [audit("a1", "v1", "2026-01-01T10:00:00.000Z")]),
    ).toEqual([]);
  });
});

describe("auditWindowIncomplete — the timeline says what it could not read", () => {
  const LIMIT = 3;

  it("is false when fewer rows came back than the limit (that IS the trail)", () => {
    expect(
      auditWindowIncomplete(
        [version("v1", "2020-01-01T00:00:00.000Z")],
        [audit("a1", "v1", "2026-01-01T00:00:00.000Z")],
        LIMIT,
      ),
    ).toBe(false);
  });

  it("is true when the window starts after the row's first version", () => {
    expect(
      auditWindowIncomplete(
        [version("v1", "2020-01-01T00:00:00.000Z")],
        [
          audit("a1", "v1", "2026-01-01T00:00:00.000Z"),
          audit("a2", "v1", "2026-01-02T00:00:00.000Z"),
          audit("a3", "v1", "2026-01-03T00:00:00.000Z"),
        ],
        LIMIT,
      ),
    ).toBe(true);
  });

  it("is false when the window already reaches past the row's first version", () => {
    expect(
      auditWindowIncomplete(
        [version("v1", "2026-06-01T00:00:00.000Z")],
        [
          audit("a1", "v1", "2026-01-01T00:00:00.000Z"),
          audit("a2", "v1", "2026-01-02T00:00:00.000Z"),
          audit("a3", "v1", "2026-01-03T00:00:00.000Z"),
        ],
        LIMIT,
      ),
    ).toBe(false);
  });
});
