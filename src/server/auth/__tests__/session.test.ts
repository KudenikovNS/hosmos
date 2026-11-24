// T-11 / USERS-ROLES T1.2b: getSession() on Drizzle + better-auth (PG-IMPL-SPEC
// §1.2, §8.1/§8.2). DB-free unit test of the IDENTITY layer and the assembly of
// the `DbSession` from the resolver's output — better-auth, the members resolver
// and the db are mocked. The resolver itself (D10) is proven against a real
// Postgres in `session.integration.test.ts`; this file only pins that
//   - `null` better-auth session → `null`, and the request headers are forwarded;
//   - a resolved membership is assembled into `{company, membership, capabilities,
//     memberships}` (the additive T1.2b fields, D12) with `company` still projected
//     to the exact `DbCompany` shape;
//   - no active membership → null company/membership + empty capabilities.
import { beforeEach, describe, expect, it, vi } from "vitest";

// session.ts starts with `import "server-only"`; the package throws outside RSC.
vi.mock("server-only", () => ({}));

const getSessionApi = vi.fn();
vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => getSessionApi(...a) } },
}));

// The D10 resolver is mocked here (it has its own integration suite). getSession
// only orchestrates these three calls, so pinning their outputs pins the assembly.
const resolveActiveMembershipMock = vi.fn();
const listMembershipsMock = vi.fn();
const countMembersMock = vi.fn();
vi.mock("@/server/db/members", () => ({
  resolveActiveMembership: (...a: unknown[]) =>
    resolveActiveMembershipMock(...a),
  listMemberships: (...a: unknown[]) => listMembershipsMock(...a),
  countMembers: (...a: unknown[]) => countMembersMock(...a),
}));

// Chainable Drizzle mock for the single company projection select: the next queued
// rows batch resolves from `.from().where().limit()`.
let selectResults: unknown[][] = [];
let selectCall = 0;
const selectMock = vi.fn(() => {
  const rows = selectResults[selectCall++] ?? [];
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain;
});
vi.mock("@/server/db", () => ({ db: { select: () => selectMock() } }));

const headersMock = vi.fn(async () => new Headers({ cookie: "session=abc" }));
vi.mock("next/headers", () => ({ headers: () => headersMock() }));

import { getSession } from "@/server/auth/session";

const company = {
  id: "company-1",
  name: "Acme Manufacturing",
  industry: "Manufacturing",
  nace_code: "C25",
  country: "Slovenia",
  country_code: "SI",
  headcount: 42,
  plan: "pro",
  reporting_year: "2024",
  currency: "EUR",
};

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [];
  selectCall = 0;
  // Default: a resolvable identity with no membership (overridden per test).
  resolveActiveMembershipMock.mockResolvedValue(null);
  listMembershipsMock.mockResolvedValue([]);
  countMembersMock.mockResolvedValue({ approvers: 0, members: 0 });
});

describe("getSession", () => {
  it("returns null when there is no better-auth session", async () => {
    getSessionApi.mockResolvedValue(null);

    expect(await getSession()).toBeNull();
    expect(resolveActiveMembershipMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("passes the request headers to better-auth", async () => {
    getSessionApi.mockResolvedValue(null);

    await getSession();

    expect(getSessionApi).toHaveBeenCalledTimes(1);
    const arg = getSessionApi.mock.calls[0][0] as { headers: unknown };
    expect(arg.headers).toBeInstanceOf(Headers);
  });

  it("returns userId/email/name with null company/membership for a user with no active membership", async () => {
    getSessionApi.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "John Doe" },
    });
    // resolveActiveMembership → null (default); no company projection is queried.

    const result = await getSession();

    expect(result).toEqual({
      userId: "user-1",
      email: "user@example.com",
      name: "John Doe",
      company: null,
      membership: null,
      capabilities: [],
      memberships: [],
    });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("assembles the DbSession from the resolved membership (company shape 1:1 + additive fields)", async () => {
    getSessionApi.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "John Doe" },
    });
    resolveActiveMembershipMock.mockResolvedValue({
      companyId: "company-1",
      companyName: "Acme Manufacturing",
      role: "contributor",
      status: "active",
    });
    listMembershipsMock.mockResolvedValue([
      {
        companyId: "company-1",
        companyName: "Acme Manufacturing",
        role: "contributor",
      },
    ]);
    countMembersMock.mockResolvedValue({ approvers: 1, members: 3 });
    selectResults = [[company]]; // company projection

    const result = await getSession();

    expect(result).toEqual({
      userId: "user-1",
      email: "user@example.com",
      name: "John Doe",
      company, // DbCompany shape preserved 1:1
      membership: {
        companyId: "company-1",
        role: "contributor",
        status: "active",
        hasIndependentApprover: true, // approvers > 0
        activeMemberCount: 3,
      },
      // effectiveCapabilities('contributor', 1) — the matrix row (no D13 grant).
      capabilities: ["data.write", "data.submit", "data.read"],
      memberships: [
        {
          companyId: "company-1",
          companyName: "Acme Manufacturing",
          role: "contributor",
        },
      ],
    });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the non-null `plan` guarantee when the company row has a null plan", async () => {
    getSessionApi.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "John Doe" },
    });
    resolveActiveMembershipMock.mockResolvedValue({
      companyId: "company-1",
      companyName: "Acme Manufacturing",
      role: "esg_admin",
      status: "active",
    });
    listMembershipsMock.mockResolvedValue([
      {
        companyId: "company-1",
        companyName: "Acme Manufacturing",
        role: "esg_admin",
      },
    ]);
    countMembersMock.mockResolvedValue({ approvers: 0, members: 1 });
    selectResults = [[{ ...company, plan: null }]];

    const result = await getSession();

    expect(result?.company?.plan).toBe("trial");
    // Solo esg_admin with no approver → the D13 compensating grant fires.
    expect(result?.capabilities).toContain("data.approve");
    expect(result?.membership?.hasIndependentApprover).toBe(false);
  });
});
