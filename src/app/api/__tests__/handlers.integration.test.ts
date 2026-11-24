// T-19 integration tests — the session route handler runs against a real Postgres
// via the T-13 harness. Covers the phase-D invariants that survive:
//   • session-guard (PATTERN 3): logged out → a null body, not a throw;
//   • the response form matches the OLD shape, snake_case keys present (note #44).
//
// THE DASHBOARD CASES LEFT THIS FILE WITH THEIR SUBJECT (T3.7), AND THE REPORTS
// CASES LEFT WITH THEIRS (T3.8). The dashboard ones asserted the `DashboardData`
// of the wide tables; `/api/dashboard` now answers the revision state and is
// covered by `src/app/api/dashboard/__tests__`. The reports ones asserted
// `GET /api/reports` — 401, NO_DATA, the `scope3_results` breakdown and the ESRS
// E1-4 targets — and that endpoint, its `emission_results` reader and the legacy
// `/reports` page were all deleted in T3.8 (О-6). Its replacement is
// `/api/revisions/[id]/render` in T5.7, which brings its own suite. What is left
// here is the session case, which never depended on the reporting model at all.
//
// `getSession` is mocked so a test controls the identity; `@/server/db` is mocked
// to the harness pool so the routes read the same Postgres the fixtures write to.
// Gating: `describeIntegration` is `describe.skip` with no DB, so this file is a
// green no-op in a DB-less CI. The lazy `db` getter means the mock never touches
// Postgres at import time (skip-safe).
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getSessionMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  getSession: () => getSessionMock(),
}));

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return {
    get db() {
      return harness.getTestDb();
    },
  };
});

import { GET as sessionGET } from "@/app/api/session/route";
import {
  closeTestDb,
  describeIntegration,
  insertCompany,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import type { DbCompany } from "@/server/db/types";

/** Build a DbSession whose company projection matches a harness company row. */
function sessionFor(company: {
  id: string;
  name: string;
  reportingYear?: string | null;
  countryCode?: string | null;
}) {
  const dbCompany: DbCompany = {
    id: company.id,
    name: company.name,
    industry: "Manufacturing",
    nace_code: "C25",
    country: "Slovenia",
    country_code: company.countryCode ?? "SI",
    headcount: 40,
    plan: "pro",
    reporting_year: company.reportingYear ?? "2024",
    currency: "EUR",
  };
  return {
    userId: "u1",
    email: "u@example.com",
    name: "U",
    company: dbCompany,
    // esg_admin membership that production getSession() always resolves (§8, §14.1).
    membership: {
      companyId: dbCompany.id,
      role: "esg_admin" as const,
      status: "active" as const,
      hasIndependentApprover: true,
      activeMemberCount: 1,
    },
  };
}

const request = (path: string, origin?: string) =>
  new Request(`http://api.example.com${path}`, {
    headers: origin ? { origin } : undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describeIntegration("T-19 api route handlers (session)", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  // ─── GET /api/session ──────────────────────────────────────────────────────
  it("GET /api/session returns null (200) when logged out", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await sessionGET(request("/api/session"));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("GET /api/session returns the DbSession with a snake_case company", async () => {
    const company = await insertCompany({ name: "Acme", naceCode: "C25" });
    getSessionMock.mockResolvedValue(sessionFor(company));

    const res = await sessionGET(request("/api/session"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("u1");
    // snake_case form (note #44): nace_code / reporting_year present, not camelCase.
    expect(body.company).toHaveProperty("nace_code");
    expect(body.company).toHaveProperty("reporting_year");
    expect(body.company).not.toHaveProperty("naceCode");
  });
});
