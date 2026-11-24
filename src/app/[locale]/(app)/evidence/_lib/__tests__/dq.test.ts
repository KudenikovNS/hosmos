// =============================================================================
// THE OVERRIDE CONTROL'S ABSENCE, PINNED WITHOUT A DOM (T4.5 acceptance).
//
// "Без `data.review` контрол скрыт, прямой запрос даёт 403" is two claims with
// two owners. The SERVER half is already proven — `dq.integration.test.ts`
// asserts 403 for an override by a role without `data.review`, 403 for CLEARING
// somebody else's, and 403 BEFORE the 422 the missing reason would have earned
// (§0.2's guard order). This file owns the CLIENT half, and the same way
// `inventory/_lib/__tests__/actions.test.ts` owns the approve button's: the
// suite is `environment: "node"` with no DOM, so the assertion is about the
// PREDICATE the editor holds exactly one reference to.
//
// WHY THE ROLE MATRIX IS THE INPUT AND NOT THE SUBJECT. No line of the UI may
// derive a right from a role; `dqEditorGates` takes a capability LIST and has no
// way to see a role at all. The roles appear here only to generate realistic
// capability sets from `ROLE_CAPABILITIES` — the same matrix the server resolves
// the session from — so a role that gains or loses `data.review` moves this test
// with it and needs no edit.
//
// THE THIRD CASE IS THE ONE WORTH THE FILE. An assessment that is ALREADY
// overridden may not be touched at all without `data.review`, because clearing
// an override is a review act too (`needsReviewCapability`). A screen that
// offered a contributor the score fields on such a row would be offering a Save
// whose every attempt is a 403 — so `canEdit` goes false, and the editor says
// why.
// =============================================================================
import { describe, expect, it } from "vitest";

import { WORKFLOW_STATUSES, type WorkflowStatus } from "@/shared/enums";
import {
  ROLE_CAPABILITIES,
  type Capability,
  type CompanyRole,
} from "@/shared/roles";

import { MUTABLE_REVISION_STATUSES } from "../../../inventory/_lib/actions";
import {
  dqBody,
  dqEditorGates,
  overrideReasonGiven,
  PEDIGREE_SCORES,
  PERCENT_SCORES,
  type GatedAssessment,
} from "../dq";

const ROLES = Object.keys(ROLE_CAPABILITIES) as CompanyRole[];

/** Every shape the stored assessment can be in when the editor opens. */
const ASSESSMENTS: { name: string; assessment: GatedAssessment | null }[] = [
  { name: "no assessment yet", assessment: null },
  { name: "an ordinary assessment", assessment: { is_overridden: false } },
  { name: "a reviewer's override", assessment: { is_overridden: true } },
];

function gatesFor(
  capabilities: readonly Capability[],
  status: WorkflowStatus | null,
  assessment: GatedAssessment | null,
) {
  return dqEditorGates({ capabilities, revisionStatus: status, assessment });
}

describe("dqEditorGates — the override needs `data.review`, always", () => {
  it.each(ROLES)("is never offered to %s without the capability", (role) => {
    const capabilities = ROLE_CAPABILITIES[role];
    if (capabilities.includes("data.review")) return;
    for (const status of [
      ...WORKFLOW_STATUSES,
      null,
    ] as (WorkflowStatus | null)[]) {
      for (const { assessment } of ASSESSMENTS) {
        expect(gatesFor(capabilities, status, assessment).canOverride).toBe(
          false,
        );
      }
    }
  });

  it("is not offered on `data.review` alone — the route wants `data.write` first", () => {
    // A `reviewer` holds review but not write, and the route's FIRST guard is
    // `data.write`: every PUT it could send is a 403 regardless of the body.
    expect(ROLE_CAPABILITIES.reviewer).toContain("data.review");
    expect(ROLE_CAPABILITIES.reviewer).not.toContain("data.write");
    expect(
      gatesFor(ROLE_CAPABILITIES.reviewer, "draft", null).canOverride,
    ).toBe(false);
    expect(gatesFor(ROLE_CAPABILITIES.reviewer, "draft", null).canEdit).toBe(
      false,
    );
  });

  it("is offered to a role holding BOTH, on an open revision", () => {
    const both = ROLE_CAPABILITIES.data_owner;
    expect(both).toEqual(expect.arrayContaining(["data.write", "data.review"]));
    expect(gatesFor(both, "draft", null).canOverride).toBe(true);
  });

  it.each(
    WORKFLOW_STATUSES.filter(
      (status) => !MUTABLE_REVISION_STATUSES.includes(status),
    ),
  )("is withdrawn against a %s revision (§5.3 freeze)", (status) => {
    expect(
      gatesFor(ROLE_CAPABILITIES.data_owner, status, null).canOverride,
    ).toBe(false);
    expect(gatesFor(ROLE_CAPABILITIES.data_owner, status, null).canEdit).toBe(
      false,
    );
  });
});

describe("dqEditorGates — an existing override locks the whole editor", () => {
  it("stops a contributor editing an overridden assessment", () => {
    const contributor = ROLE_CAPABILITIES.contributor;
    expect(contributor).toContain("data.write");
    const gates = gatesFor(contributor, "draft", { is_overridden: true });
    expect(gates.lockedByOverride).toBe(true);
    expect(gates.canEdit).toBe(false);
    expect(gates.canOverride).toBe(false);
  });

  it("leaves an ORDINARY assessment editable by the same contributor", () => {
    const gates = gatesFor(ROLE_CAPABILITIES.contributor, "draft", {
      is_overridden: false,
    });
    expect(gates.lockedByOverride).toBe(false);
    expect(gates.canEdit).toBe(true);
    expect(gates.canOverride).toBe(false);
  });

  it("does not lock a reviewer-capable role out of its own override", () => {
    const gates = gatesFor(ROLE_CAPABILITIES.data_owner, "draft", {
      is_overridden: true,
    });
    expect(gates.lockedByOverride).toBe(false);
    expect(gates.canEdit).toBe(true);
  });
});

describe("dqBody — every PUT states the resulting state", () => {
  it("always carries `is_overridden`, even for a scores-only save", () => {
    expect(dqBody({ reliability_score: "3" }, false)).toMatchObject({
      is_overridden: false,
    });
  });

  it("covers all nine assessable columns of DM-27", () => {
    const body = dqBody({}, false);
    for (const field of [...PEDIGREE_SCORES, ...PERCENT_SCORES]) {
      expect(body).toHaveProperty(field);
    }
    expect(body).toHaveProperty("quality_tier");
    expect(body).toHaveProperty("quality_comment");
  });

  it("sends a reason only with an override", () => {
    expect(
      dqBody({ override_reason: "measured by hand" }, false),
    ).not.toHaveProperty("override_reason");
    expect(dqBody({ override_reason: "measured by hand" }, true)).toMatchObject(
      {
        override_reason: "measured by hand",
      },
    );
  });

  it('passes a blank through as a blank — `""` clears a column', () => {
    expect(dqBody({ reliability_score: "" }, false).reliability_score).toBe("");
  });
});

describe("overrideReasonGiven — VAL-039 in the form", () => {
  it("blocks an override with no reason, and with whitespace only", () => {
    expect(overrideReasonGiven(true, "")).toBe(false);
    expect(overrideReasonGiven(true, "   ")).toBe(false);
  });

  it("allows an ordinary save with no reason at all", () => {
    expect(overrideReasonGiven(false, "")).toBe(true);
  });

  it("allows an override once a reason is there", () => {
    expect(overrideReasonGiven(true, "supplier confirmed by phone")).toBe(true);
  });
});
