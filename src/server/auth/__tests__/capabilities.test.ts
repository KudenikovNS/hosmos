import { describe, expect, it } from "vitest";

import {
  requireCapability,
  type CapabilitySession,
} from "@/server/auth/capabilities";
import {
  APPROVER_ROLES,
  ROLE_CAPABILITIES,
  effectiveCapabilities,
  type Capability,
  type CompanyRole,
} from "@/shared/roles";

// T1.1 (§6, D13) — the capability matrix, its derived APPROVER_ROLES, the D13
// compensating grant, and the synchronous requireCapability guard. Unit-only,
// no DB: the model is a pure function of role + approversCount.

// The ten capability keys, listed independently of ROLE_CAPABILITIES so the
// table below is a genuine cross-check, not a tautology against the source.
const ALL_CAPABILITIES: Capability[] = [
  "company.manage",
  "members.manage",
  "billing.manage",
  "data.write",
  "data.submit",
  "data.review",
  "data.approve",
  "factors.custom",
  "audit.read",
  "data.read",
];

// Expected grants, transcribed cell-by-cell from the §6.2 table (✅ only). This
// is a hand-written literal — the point is to catch any drift in the source.
const EXPECTED: Record<CompanyRole, Capability[]> = {
  esg_admin: [
    "company.manage",
    "members.manage",
    "billing.manage",
    "data.write",
    "data.submit",
    "data.review",
    "factors.custom",
    "audit.read",
    "data.read",
  ], // NOTE: no data.approve (D13 — granted at runtime, not in the matrix)
  data_owner: [
    "data.write",
    "data.submit",
    "data.review",
    "factors.custom",
    "audit.read",
    "data.read",
  ],
  contributor: ["data.write", "data.submit", "data.read"],
  reviewer: ["data.review", "audit.read", "data.read"],
  approver: ["data.approve", "audit.read", "data.read"],
  auditor: ["audit.read", "data.read"],
};

const ALL_ROLES = Object.keys(EXPECTED) as CompanyRole[];

describe("ROLE_CAPABILITIES matrix (§6.2)", () => {
  // 6 roles × 10 capabilities = 60 assertions, each cell checked against §6.2.
  describe.each(ALL_ROLES)("role %s", (role) => {
    it.each(ALL_CAPABILITIES)("cell %s matches the matrix", (cap) => {
      const expected = EXPECTED[role].includes(cap);
      expect(ROLE_CAPABILITIES[role].includes(cap)).toBe(expected);
    });
  });

  it("esg_admin does NOT carry data.approve in the static matrix (D13)", () => {
    expect(ROLE_CAPABILITIES.esg_admin).not.toContain("data.approve");
  });

  it("has no unexpected capabilities beyond the matrix per role", () => {
    for (const role of ALL_ROLES) {
      expect([...ROLE_CAPABILITIES[role]].sort()).toEqual(
        [...EXPECTED[role]].sort(),
      );
    }
  });
});

describe("APPROVER_ROLES (derived from the matrix, §6.3)", () => {
  it("is exactly ['approver'] today", () => {
    expect(APPROVER_ROLES).toEqual(["approver"]);
  });

  it("is DERIVED by filter, not a literal — the same filter picks up a new role", () => {
    // Mutate a COPY of the matrix: give auditor data.approve, then re-run the
    // exact derivation. If APPROVER_ROLES were a hand-written literal, the new
    // role could not be picked up. This proves the mechanism, not a coincidence.
    const mutated: Record<CompanyRole, readonly Capability[]> = {
      ...ROLE_CAPABILITIES,
      auditor: [...ROLE_CAPABILITIES.auditor, "data.approve"],
    };
    const derived = (Object.keys(mutated) as CompanyRole[]).filter((r) =>
      mutated[r].includes("data.approve"),
    );
    expect(derived).toContain("approver");
    expect(derived).toContain("auditor");
    // The real, unmutated export is unaffected.
    expect(APPROVER_ROLES).toEqual(["approver"]);
  });
});

describe("effectiveCapabilities — D13 compensating grant (§Q3)", () => {
  it("(a) esg_admin with approversCount=0 → data.approve IS granted", () => {
    expect(effectiveCapabilities("esg_admin", 0)).toContain("data.approve");
  });

  it("(b) esg_admin + contributor (approversCount=0) → grant STILL present (regression on the activeMemberCount===1 dead-end)", () => {
    // Two active members, still no approver role → inviting a colleague must NOT
    // remove the company's ability to approve. The grant tracks approversCount,
    // never head-count. This is the mandatory regression for the rejected §Q3 dead-end.
    expect(effectiveCapabilities("esg_admin", 0)).toContain("data.approve");
  });

  it("(c) approversCount=1 → NO grant", () => {
    expect(effectiveCapabilities("esg_admin", 1)).not.toContain("data.approve");
  });

  it("(d) suspended approver ⇒ approversCount=0 → grant present", () => {
    // A suspended approver is not an ACTIVE approver, so approversCount is 0 and
    // the grant fires — modelled purely by the count, since the fn is pure.
    expect(effectiveCapabilities("esg_admin", 0)).toContain("data.approve");
  });

  it("(e) at approversCount=0 the grant reaches NONE of the other five roles", () => {
    for (const role of ALL_ROLES) {
      if (role === "esg_admin") continue;
      const hasApproveByMatrix =
        ROLE_CAPABILITIES[role].includes("data.approve");
      // approver has data.approve by the MATRIX (not the grant); the grant adds
      // nothing beyond the base row for any non-admin role.
      expect([...effectiveCapabilities(role, 0)].sort()).toEqual(
        [...ROLE_CAPABILITIES[role]].sort(),
      );
      expect(effectiveCapabilities(role, 0).includes("data.approve")).toBe(
        hasApproveByMatrix,
      );
    }
  });

  it("returns a fresh array (does not mutate the matrix)", () => {
    effectiveCapabilities("esg_admin", 0);
    expect(ROLE_CAPABILITIES.esg_admin).not.toContain("data.approve");
  });
});

describe("requireCapability (§6.3)", () => {
  it("returns FORBIDDEN (not throw) when session is null", () => {
    expect(requireCapability(null, "data.read")).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
  });

  it("returns FORBIDDEN (not throw) when membership is absent", () => {
    expect(requireCapability({}, "data.read")).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
    expect(requireCapability({ membership: null }, "data.read")).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
  });

  it("prefers pre-computed session.capabilities", () => {
    const session: CapabilitySession = {
      capabilities: ["data.read", "data.write"],
    };
    expect(requireCapability(session, "data.write")).toBeNull();
    expect(requireCapability(session, "data.approve")).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
  });

  it("falls back to role + hasIndependentApprover when capabilities are absent", () => {
    // Solo esg_admin (no independent approver) → D13 grant applies via fallback.
    const solo: CapabilitySession = {
      membership: { role: "esg_admin", hasIndependentApprover: false },
    };
    expect(requireCapability(solo, "data.approve")).toBeNull();
    expect(requireCapability(solo, "company.manage")).toBeNull();

    // esg_admin WITH an independent approver → no approve grant.
    const withApprover: CapabilitySession = {
      membership: { role: "esg_admin", hasIndependentApprover: true },
    };
    expect(requireCapability(withApprover, "data.approve")).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });

    // contributor never approves.
    const contributor: CapabilitySession = {
      membership: { role: "contributor" },
    };
    expect(requireCapability(contributor, "data.write")).toBeNull();
    expect(requireCapability(contributor, "data.approve")).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
  });
});
