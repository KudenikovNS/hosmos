// T-19 PATTERN 1 unit tests — the central camel→snake mapper. Pure (no DB, no
// server-only): it takes a native Drizzle row (camelCase, NUMERIC as string) and
// must produce the OLD Supabase snake_case shape (NUMERIC as number | null) that
// the frontend was built against (PG COORDINATION note #44).
//
// TRIMMED IN T3.8 alongside its subject: the `toDbMonthly`, `toDbEmissionResults`
// and `toDbPeople` blocks left with those mappers, which left with the wide-table
// routes (`/api/emissions/*`, `/api/people`, `/api/reports`). `toDbCompany` is the
// one mapper that survived — `companies` is the tenant profile, not the reporting
// model (О-10) — so it is the one mapper still under test here.
import { describe, expect, it } from "vitest";

import { toDbCompany } from "../normalize";

// A full native row built once, so each test overrides only what it asserts on.
const companyRow = {
  id: "c1",
  name: "Acme d.o.o.",
  industry: "Manufacturing",
  naceCode: "C25",
  country: "Slovenia",
  countryCode: "SI",
  headcount: 42,
  plan: "pro",
  planStart: null,
  reportingYear: "2024",
  currency: "EUR",
  logoUrl: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
  status: "active",
  employeeCount: null,
  foundedDate: null,
  registeredAt: null,
  lastActivityAt: null,
  dataCompletion: 0,
  stripeCustomerId: null,
  subscriptionStartedAt: null,
  nextPaymentAt: null,
  monthlyPrice: "0",
  governanceData: { boardIndependence: true },
} as unknown as Parameters<typeof toDbCompany>[0];

describe("toDbCompany", () => {
  it("maps camelCase columns to the old snake_case DbCompany keys", () => {
    const out = toDbCompany(companyRow);
    expect(out).toMatchObject({
      id: "c1",
      name: "Acme d.o.o.",
      industry: "Manufacturing",
      nace_code: "C25",
      country: "Slovenia",
      country_code: "SI",
      headcount: 42,
      plan: "pro",
      reporting_year: "2024",
      currency: "EUR",
    });
    // snake_case only — the camelCase source keys must be gone.
    expect(out).not.toHaveProperty("naceCode");
    expect(out).not.toHaveProperty("countryCode");
    expect(out).not.toHaveProperty("reportingYear");
  });

  it("exposes governance_data (snake_case) for reports/governance", () => {
    expect(toDbCompany(companyRow).governance_data).toEqual({
      boardIndependence: true,
    });
  });

  it("defaults plan to 'trial' when the column is null (NOT-NULL guarantee)", () => {
    const out = toDbCompany({ ...companyRow, plan: null });
    expect(out.plan).toBe("trial");
  });
});
