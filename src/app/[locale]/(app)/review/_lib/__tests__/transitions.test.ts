// =============================================================================
// WHAT THIS SUITE PROVES (T4.6).
//
//   1. THE RESTATED §5.1 MATRIX EQUALS THE SERVER'S, row for row. `/review`
//      cannot import `ALLOWED_TRANSITIONS` for its VALUE — the module reaches
//      `server-only` and the drizzle schema — so it restates it, and this is
//      what stops the copy drifting. A seventh row added to the machine fails
//      here rather than producing a screen that quietly stops offering an action.
//   2. `actionOffers` NEVER PERMITS AN ACTION WITHOUT ITS CAPABILITY, over the
//      whole (status × role) matrix. That is the §0.1 statement about an
//      ABSENCE, and the suite is `environment: "node"` with no DOM to assert "the
//      button is not in the document" against — so the predicate is what is
//      pinned, exactly as `inventory/_lib/__tests__/actions.test.ts` pins its own.
//   3. THE LOCK 402 IS A BRANCH OF ITS OWN and cannot be reached by any other
//      refusal, nor shadowed by one. This is the acceptance criterion "the 402 on
//      Lock shows as an upgrade, not an error" reduced to the decision behind it.
// =============================================================================
import { describe, expect, it, vi } from "vitest";

// The state machine is reached for its VALUE here — that is the whole point of
// this file — and it transitively imports `server-only`, which throws outside a
// React Server Component. The established stub (see
// `api/revisions/__tests__/periods-revisions.integration.test.ts`) makes the
// module loadable in the node suite; NOTHING here touches a database, and the
// screen itself still imports this module type-only.
vi.mock("server-only", () => ({}));

import {
  ALLOWED_TRANSITIONS as SERVER_TRANSITIONS,
  TRANSITION_PRECONDITIONS,
  WIRE_ACTIONS as SERVER_WIRE_ACTIONS,
} from "@/server/revisions/transition";
import type { WorkflowStatus } from "@/shared/enums";
import { ROLE_CAPABILITIES, type CompanyRole } from "@/shared/roles";

import {
  ACTIONS_NEEDING_COMMENT,
  ALLOWED_TRANSITIONS,
  actionOffers,
  transitionNotice,
  WIRE_ACTIONS,
} from "../transitions";

const STATUSES: WorkflowStatus[] = [
  "draft",
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "locked",
];

const ROLES = Object.keys(ROLE_CAPABILITIES) as CompanyRole[];

/** The two numbers F1's sentence needs; irrelevant to every other branch. */
const GATE = { facilities: 4, limit: 3 };

describe("the restated §5.1 matrix", () => {
  it("is row for row the machine's own", () => {
    expect(ALLOWED_TRANSITIONS).toEqual(SERVER_TRANSITIONS);
  });

  it("names the same wire actions the API accepts", () => {
    expect(WIRE_ACTIONS).toEqual(SERVER_WIRE_ACTIONS);
  });

  it("does not offer `resume` — it is a service action, not a wire one", () => {
    // The row EXISTS in the matrix (a service performs it) and is deliberately
    // absent from what a client may send.
    expect(ALLOWED_TRANSITIONS.some((row) => row.action === "resume")).toBe(
      true,
    );
    expect(WIRE_ACTIONS).not.toContain("resume");
  });

  it("demands a comment exactly where the machine registers the precondition", () => {
    const withCommentCheck = (
      Object.keys(
        TRANSITION_PRECONDITIONS,
      ) as (keyof typeof TRANSITION_PRECONDITIONS)[]
    ).filter((action) =>
      TRANSITION_PRECONDITIONS[action].some(
        (check) => check.name === "review_comment_required",
      ),
    );
    expect([...ACTIONS_NEEDING_COMMENT]).toEqual(withCommentCheck);
  });

  it("leaves `plan_facility_limit` as the ONE precondition that can 402", () => {
    // The reason `transitionNotice` may classify a 402 as F1 from the status
    // alone: no other action registers the check that returns `PLAN_REQUIRED`.
    const withPlanCheck = (
      Object.keys(
        TRANSITION_PRECONDITIONS,
      ) as (keyof typeof TRANSITION_PRECONDITIONS)[]
    ).filter((action) =>
      TRANSITION_PRECONDITIONS[action].some(
        (check) => check.name === "plan_facility_limit",
      ),
    );
    expect(withPlanCheck).toEqual(["lock"]);
  });
});

describe("actionOffers", () => {
  it("offers nothing while the revision is unknown", () => {
    expect(
      actionOffers({ capabilities: ["data.approve"], status: null }),
    ).toEqual([]);
  });

  it("offers exactly the wire actions the matrix allows from each status", () => {
    for (const status of STATUSES) {
      const expected = ALLOWED_TRANSITIONS.filter(
        (row) => row.from === status && WIRE_ACTIONS.includes(row.action),
      ).map((row) => row.action);
      const offers = actionOffers({ capabilities: [], status });
      expect(offers.map((offer) => offer.action).sort()).toEqual(
        [...expected].sort(),
      );
    }
  });

  it("offers nothing at all from `locked` — a locked revision is immutable", () => {
    expect(
      actionOffers({
        capabilities: ["data.approve", "data.write"],
        status: "locked",
      }),
    ).toEqual([]);
  });

  it("never permits an action without its capability, for any role or status", () => {
    for (const role of ROLES) {
      const capabilities = [...ROLE_CAPABILITIES[role]];
      for (const status of STATUSES) {
        for (const offer of actionOffers({ capabilities, status })) {
          expect(offer.permitted).toBe(capabilities.includes(offer.capability));
          if (offer.permitted) expect(capabilities).toContain(offer.capability);
        }
      }
    }
  });

  it("permits nothing at all for a session with no capabilities", () => {
    for (const status of STATUSES) {
      const offers = actionOffers({ capabilities: [], status });
      expect(offers.every((offer) => !offer.permitted)).toBe(true);
    }
  });

  it("marks `reject` as the action that must state why", () => {
    const offers = actionOffers({
      capabilities: ["data.review", "data.approve"],
      status: "in_review",
    });
    expect(
      offers.find((offer) => offer.action === "reject")?.needsComment,
    ).toBe(true);
    expect(
      offers.find((offer) => offer.action === "approve")?.needsComment,
    ).toBe(false);
  });
});

describe("transitionNotice", () => {
  it("reports a success with the status it landed in", () => {
    expect(
      transitionNotice(
        {
          ok: true,
          data: { revision: "r", from: "in_review", to: "approved" },
        },
        "approve",
        GATE,
      ),
    ).toEqual({
      kind: "done",
      action: "approve",
      from: "in_review",
      to: "approved",
    });
  });

  it("renders the 402 as a PLAN branch carrying both numbers", () => {
    const notice = transitionNotice(
      {
        ok: false,
        refusal: { kind: "plan_required" },
        detail: {
          action: "lock",
          from: "approved",
          allowed: ["lock"],
          precondition: "plan_facility_limit",
          reason: "facility_limit",
          period_id: "p1",
        },
      },
      "lock",
      GATE,
    );
    expect(notice).toEqual({ kind: "plan", facilities: 4, limit: 3 });
  });

  it("keeps the 402 a plan answer even when the payload also names rules", () => {
    // `plan_facility_limit` DOES send `rules: [VAL-105]`. A classifier that read
    // the rule list first would render F1 in the error register — the one thing
    // the acceptance criterion forbids.
    const notice = transitionNotice(
      {
        ok: false,
        refusal: { kind: "plan_required" },
        detail: { reason: "facility_limit" } as never,
      },
      "lock",
      GATE,
    );
    expect(notice.kind).toBe("plan");
  });

  it("never produces a plan branch from a 422, whatever it says", () => {
    for (const reason of [
      "blocking_rules",
      "rows_not_approved",
      "reject_needs_comment",
      "transition_not_allowed",
      "facility_limit",
    ]) {
      const notice = transitionNotice(
        {
          ok: false,
          refusal: {
            kind: "rules",
            rules: [{ code: "VAL-105", message: "", scope: "period" }],
          },
          detail: { reason } as never,
        },
        "lock",
        GATE,
      );
      expect(notice.kind).not.toBe("plan");
    }
  });

  it("says how many rows are still pending", () => {
    expect(
      transitionNotice(
        {
          ok: false,
          refusal: { kind: "rejected" },
          detail: {
            reason: "rows_not_approved",
            rows: 15,
            approved: 8,
            pending: 7,
          } as never,
        },
        "submit",
        GATE,
      ),
    ).toEqual({ kind: "rowsPending", total: 15, approved: 8, pending: 7 });
  });

  it("names the missing comment rather than a bare refusal", () => {
    expect(
      transitionNotice(
        {
          ok: false,
          refusal: { kind: "rejected" },
          detail: { reason: "reject_needs_comment", field: "comment" } as never,
        },
        "reject",
        GATE,
      ),
    ).toEqual({ kind: "needsComment" });
  });

  it("carries the blocking codes AND the per-object failures", () => {
    const notice = transitionNotice(
      {
        ok: false,
        refusal: {
          kind: "rules",
          rules: [{ code: "VAL-036", message: "m", scope: "record" }],
        },
        detail: {
          reason: "blocking_rules",
          scopes: ["record"],
          failures: [
            { code: "VAL-036", scope: "record", object: "row-1" },
            { code: "VAL-036", scope: "record", object: "row-2" },
            { bad: true },
          ],
        } as never,
      },
      "submit",
      GATE,
    );
    expect(notice.kind).toBe("blocked");
    if (notice.kind !== "blocked") throw new Error("unreachable");
    expect(notice.rules.map((rule) => rule.code)).toEqual(["VAL-036"]);
    // One entry per OBJECT, and the malformed entry is dropped rather than
    // rendered as a line about `undefined`.
    expect(notice.failures).toEqual([
      { code: "VAL-036", scope: "record", object: "row-1" },
      { code: "VAL-036", scope: "record", object: "row-2" },
    ]);
  });

  it("turns a forbidden pair into what WOULD be legal", () => {
    expect(
      transitionNotice(
        {
          ok: false,
          refusal: { kind: "rejected" },
          detail: {
            action: "approve",
            from: "draft",
            allowed: ["submit", "abandon"],
            reason: "transition_not_allowed",
          },
        },
        "approve",
        GATE,
      ),
    ).toEqual({
      kind: "notAllowed",
      from: "draft",
      allowed: ["submit", "abandon"],
    });
  });

  it("distinguishes a lost race from a rule failure", () => {
    expect(
      transitionNotice(
        {
          ok: false,
          refusal: { kind: "rejected" },
          detail: { reason: "concurrent_transition" } as never,
        },
        "approve",
        GATE,
      ),
    ).toEqual({ kind: "raced" });
  });

  it("treats a 401/403 as the benign access-changed event, not as data", () => {
    expect(
      transitionNotice(
        { ok: false, refusal: { kind: "access_changed" }, detail: null },
        "approve",
        GATE,
      ),
    ).toEqual({ kind: "refused", refusal: { kind: "access_changed" } });
  });

  it("falls back to the classified refusal when the server names no reason", () => {
    expect(
      transitionNotice(
        { ok: false, refusal: { kind: "unknown" }, detail: null },
        "submit",
        GATE,
      ),
    ).toEqual({ kind: "refused", refusal: { kind: "unknown" } });
  });
});
