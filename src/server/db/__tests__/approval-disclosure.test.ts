import { describe, it, expect, vi } from "vitest";

// audit.ts starts with `import "server-only"` which throws under node/vitest —
// neutralise it so the pure helper is importable outside the RSC bundle (same
// pattern as index.test.ts).
vi.mock("server-only", () => ({}));

import { approvalDisclosure } from "@/server/db/audit";
import type { CompanyRole } from "@/shared/roles";

// T3.3 (§11.2, D13, §Q3): `approvalDisclosure` is a PURE function — no DB, no
// HTTP. It computes the self-approval disclosure flags the periods layer will
// write into an approval's audit `summary`. The "did the same user_id author
// this?" query is the caller's responsibility and arrives as `actorAlsoAuthored`.
//
// The three flags answer DIFFERENT questions and must not reduce to one another:
//  - approval_grant     — company structure (esg_admin, no dedicated approver)
//  - self_approved      — this action (grant OR same author)
//  - independent_review — report conclusion (!self_approved)

describe("approvalDisclosure — compensating grant (D13, §14.2)", () => {
  // (a) esg_admin alone, no approver → grant fires, self-approved, no review.
  it("(a) esg_admin, approversCount=0 → grant + self_approved, no review", () => {
    const d = approvalDisclosure({
      role: "esg_admin",
      approversCount: 0,
      activeMemberCount: 1,
      actorAlsoAuthored: false,
    });
    expect(d.approval_grant).toBe(true);
    expect(d.self_approved).toBe(true);
    expect(d.independent_review).toBe(false);
    expect(d.approvers_count).toBe(0);
  });

  // (b) MANDATORY regression on the rejected `activeMemberCount === 1` dead-end
  // (§Q3): a colleague who is NOT an approver must not take the grant away.
  it("(b) esg_admin + contributor (approversCount=0, members=2) → grant survives", () => {
    const d = approvalDisclosure({
      role: "esg_admin",
      approversCount: 0,
      activeMemberCount: 2,
      actorAlsoAuthored: false,
    });
    expect(d.approval_grant).toBe(true);
    expect(d.self_approved).toBe(true);
    expect(d.independent_review).toBe(false);
    expect(d.active_member_count).toBe(2);
  });

  // (c) A dedicated approver exists → no grant.
  it("(c) approversCount=1 → no grant", () => {
    const d = approvalDisclosure({
      role: "esg_admin",
      approversCount: 1,
      activeMemberCount: 2,
      actorAlsoAuthored: false,
    });
    expect(d.approval_grant).toBe(false);
  });

  // (d) The only approver is suspended → not counted → grant fires. Suspension is
  // modelled by the caller as approversCount=0 (only ACTIVE approvers count).
  it("(d) suspended approver (approversCount=0) → grant fires", () => {
    const d = approvalDisclosure({
      role: "esg_admin",
      approversCount: 0,
      activeMemberCount: 2,
      actorAlsoAuthored: false,
    });
    expect(d.approval_grant).toBe(true);
  });

  // (e) At approversCount=0 the grant reaches esg_admin ONLY — walk the other 5.
  it("(e) approversCount=0 → grant reaches no role except esg_admin", () => {
    const others: CompanyRole[] = [
      "data_owner",
      "contributor",
      "reviewer",
      "approver",
      "auditor",
    ];
    for (const role of others) {
      const d = approvalDisclosure({
        role,
        approversCount: 0,
        activeMemberCount: 1,
        actorAlsoAuthored: false,
      });
      expect(d.approval_grant).toBe(false);
    }
    // ...and esg_admin, same inputs, DOES get it.
    expect(
      approvalDisclosure({
        role: "esg_admin",
        approversCount: 0,
        activeMemberCount: 1,
        actorAlsoAuthored: false,
      }).approval_grant,
    ).toBe(true);
  });
});

describe("approvalDisclosure — the three flags do not collapse (§11.2)", () => {
  // A dedicated approver who did NOT author the data: fully independent review.
  it("approver, not the author → grant=false, self_approved=false, review=true", () => {
    const d = approvalDisclosure({
      role: "approver",
      approversCount: 1,
      activeMemberCount: 3,
      actorAlsoAuthored: false,
    });
    expect(d.approval_grant).toBe(false);
    expect(d.self_approved).toBe(false);
    expect(d.independent_review).toBe(true);
  });

  // Same approver, but they also entered the data: self_approved via the SECOND
  // condition of §11.2 even though the grant never fired. Proves the flags are
  // independent (grant=false yet self_approved=true).
  it("approver who also authored → grant=false BUT self_approved=true", () => {
    const d = approvalDisclosure({
      role: "approver",
      approversCount: 1,
      activeMemberCount: 3,
      actorAlsoAuthored: true,
    });
    expect(d.approval_grant).toBe(false);
    expect(d.self_approved).toBe(true);
    expect(d.independent_review).toBe(false);
  });

  // esg_admin with no approver AND who also authored: self-approval disclosed via
  // BOTH reasons at once (grant and same author).
  it("esg_admin, approversCount=0 AND actorAlsoAuthored=true → self_approved (both reasons)", () => {
    const d = approvalDisclosure({
      role: "esg_admin",
      approversCount: 0,
      activeMemberCount: 1,
      actorAlsoAuthored: true,
    });
    expect(d.approval_grant).toBe(true);
    expect(d.self_approved).toBe(true);
    expect(d.independent_review).toBe(false);
  });
});
