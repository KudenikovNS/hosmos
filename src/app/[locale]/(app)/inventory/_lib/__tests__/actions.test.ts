// =============================================================================
// THE APPROVE BUTTON'S ABSENCE, PINNED WITHOUT A DOM (T3.5 acceptance).
//
// The suite is `environment: "node"` and `include: ["src/**/__tests__/**/
// *.test.ts"]` — no jsdom, no `.tsx`. So "the approve button is hidden without
// `data.approve`" cannot be asserted by querying a document, and asserting it by
// eye in review is exactly the check that stops being true six months later.
//
// `rowActionGates` exists so it CAN be asserted: the drawer holds one reference
// to `gates.canApprove` and one to `gates.canSaveDraft`, and everything that
// decides them is data. What follows is the whole matrix — the six roles'
// capability sets from `ROLE_CAPABILITIES`, every workflow status, and every
// shape a version can be in.
//
// WHY THE ROLE MATRIX IS THE *INPUT* AND NOT THE SUBJECT. The acceptance also
// says no line of the UI may derive a right from a role. `rowActionGates` takes
// a capability LIST and has no way to see a role at all; the roles appear here
// only to generate realistic capability sets and to state the expectation in the
// terms a reader recognises. `ROLE_CAPABILITIES` is `@/shared/roles`' — the same
// matrix the server resolves the session from — so a role that gains or loses
// `data.approve` moves this test with it and needs no edit.
// =============================================================================
import { describe, expect, it } from "vitest";

import { WORKFLOW_STATUSES, type WorkflowStatus } from "@/shared/enums";
import {
  ROLE_CAPABILITIES,
  type Capability,
  type CompanyRole,
} from "@/shared/roles";

import {
  MUTABLE_REVISION_STATUSES,
  rowActionGates,
  type GatedRow,
} from "../actions";

const ROLES = Object.keys(ROLE_CAPABILITIES) as CompanyRole[];

/** Every shape a version the drawer can be looking at can take. */
const ROWS: { name: string; row: GatedRow | null }[] = [
  { name: "the create form (no row yet)", row: null },
  {
    name: "a live draft head",
    row: { state: "draft", superseded_by_id: null, is_deleted: false },
  },
  {
    name: "a live approved head",
    row: { state: "approved", superseded_by_id: null, is_deleted: false },
  },
  {
    name: "a superseded version",
    row: { state: "draft", superseded_by_id: "other", is_deleted: false },
  },
  {
    name: "a tombstone",
    row: { state: "draft", superseded_by_id: null, is_deleted: true },
  },
];

describe("rowActionGates — the approve button", () => {
  it("is never offered to a capability set without `data.approve`", () => {
    const offered: string[] = [];
    for (const role of ROLES) {
      const capabilities = ROLE_CAPABILITIES[role];
      if (capabilities.includes("data.approve")) continue;
      for (const status of WORKFLOW_STATUSES) {
        for (const { name, row } of ROWS) {
          const gates = rowActionGates({
            capabilities,
            revisionStatus: status,
            row,
          });
          if (gates.canApprove) offered.push(`${role} / ${status} / ${name}`);
        }
      }
    }
    // Named, not counted: a failure has to say which combination leaked.
    expect(offered).toEqual([]);
  });

  it("is never offered while the capabilities are still unknown", () => {
    // `useCapabilities()` returns an empty set while the session loads and for a
    // logged-out user — a safe default that must not over-grant for one render.
    for (const status of WORKFLOW_STATUSES) {
      for (const { row } of ROWS) {
        expect(
          rowActionGates({ capabilities: [], revisionStatus: status, row })
            .canApprove,
        ).toBe(false);
      }
    }
  });

  it("is offered to a capability set WITH `data.approve`, on a live draft of an open revision", () => {
    const approvers = ROLES.filter((role) =>
      ROLE_CAPABILITIES[role].includes("data.approve"),
    );
    // If this ever empties, the test above would pass vacuously.
    expect(approvers.length).toBeGreaterThan(0);
    for (const role of approvers) {
      expect(
        rowActionGates({
          capabilities: ROLE_CAPABILITIES[role],
          revisionStatus: "draft",
          row: { state: "draft", superseded_by_id: null, is_deleted: false },
        }).canApprove,
      ).toBe(true);
    }
  });

  it("is withheld from an approver on everything that is not a live draft head", () => {
    const capabilities: readonly Capability[] = ["data.approve", "data.read"];
    const notADraftHead = ROWS.filter(
      ({ row }) =>
        row?.state !== "draft" ||
        row.superseded_by_id !== null ||
        row.is_deleted,
    );
    for (const { row } of notADraftHead) {
      expect(
        rowActionGates({ capabilities, revisionStatus: "draft", row })
          .canApprove,
      ).toBe(false);
    }
  });

  it("is withheld once the revision is closed (LC-5, VAL-010)", () => {
    const capabilities: readonly Capability[] = ["data.approve", "data.read"];
    const closed = WORKFLOW_STATUSES.filter(
      (status) => !MUTABLE_REVISION_STATUSES.includes(status),
    );
    expect(closed.length).toBeGreaterThan(0);
    for (const status of closed) {
      expect(
        rowActionGates({
          capabilities,
          revisionStatus: status,
          row: { state: "draft", superseded_by_id: null, is_deleted: false },
        }).canApprove,
      ).toBe(false);
    }
  });
});

describe("rowActionGates — writing", () => {
  it("needs `data.write`, and only that", () => {
    for (const role of ROLES) {
      const capabilities = ROLE_CAPABILITIES[role];
      expect(
        rowActionGates({
          capabilities,
          revisionStatus: "draft",
          row: null,
        }).canSaveDraft,
      ).toBe(capabilities.includes("data.write"));
    }
  });

  it("is allowed against a REJECTED revision — the edit resumes it (LC-1)", () => {
    // The seventh row of §5.1: editing a row of a rejected revision puts the
    // revision back into `draft`. A screen that refused the edit would leave the
    // reviewer's comment unanswerable.
    expect(MUTABLE_REVISION_STATUSES).toContain("rejected");
    expect(
      rowActionGates({
        capabilities: ["data.write"],
        revisionStatus: "rejected",
        row: null,
      }).canSaveDraft,
    ).toBe(true);
  });

  it("is refused while the revision status is still unknown", () => {
    expect(
      rowActionGates({
        capabilities: ["data.write", "data.approve"],
        revisionStatus: null,
        row: null,
      }),
    ).toMatchObject({
      revisionOpen: false,
      canSaveDraft: false,
      canApprove: false,
    });
  });
});

describe("rowActionGates — LC-5's change reason", () => {
  it("is demanded exactly when the version being superseded is approved", () => {
    for (const status of [
      null,
      ...WORKFLOW_STATUSES,
    ] as (WorkflowStatus | null)[]) {
      for (const { row } of ROWS) {
        expect(
          rowActionGates({
            capabilities: ["data.write"],
            revisionStatus: status,
            row,
          }).needsChangeReason,
        ).toBe(row?.state === "approved");
      }
    }
  });

  it("is not demanded on a create — there is no predecessor to explain", () => {
    expect(
      rowActionGates({
        capabilities: ["data.write"],
        revisionStatus: "draft",
        row: null,
      }).needsChangeReason,
    ).toBe(false);
  });
});
