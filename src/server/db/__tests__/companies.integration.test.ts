// T-13 example integration test — proves the Drizzle harness end-to-end against a
// real Postgres (docker-compose DB). It is the template phase-C data-access tests
// (T-14…T-17) follow: bootstrap schema+seed once, truncate between tests, use the
// fixture factories, assert on a real round-trip.
//
// Gating: `describeIntegration` is `describe.skip` when Postgres is unreachable,
// so this file is a no-op (green) in a DB-less CI while pure engine tests run
// normally. With docker Postgres up, it really executes.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { companies } from "../schema";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "./harness";

describeIntegration("Drizzle integration harness", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it("selects a company back after inserting a fixture", async () => {
    const inserted = await insertCompany({
      name: "Acme d.o.o.",
      countryCode: "SI",
    });

    const db = getTestDb();
    const rows = await db.select().from(companies);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(inserted.id);
    expect(rows[0].name).toBe("Acme d.o.o.");
    expect(rows[0].countryCode).toBe("SI");
    // app-generated UUID PK
    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("isolates tenant state between tests (truncate ran)", async () => {
    const db = getTestDb();
    const rows = await db.select().from(companies);
    expect(rows).toHaveLength(0); // previous test's company was truncated
  });

  it("wires the user → profile → company fixtures with FK integrity", async () => {
    const company = await insertCompany();
    const { user, profile, membership } = await insertUserWithProfile({
      companyId: company.id,
    });

    expect(profile.id).toBe(user.id); // FK profiles.id → user.id (uuid→uuid)
    expect(profile.companyId).toBe(company.id);
    expect(profile.activeCompanyId).toBe(company.id); // D11: both columns agree
    // The membership row the fixture creates alongside the profile: FK
    // company_members.user_id → "user".id and .company_id → companies.id, both
    // satisfied by rows this test inserted (T3.9 replaced the `monthly_emissions_data`
    // round-trip that used to stand here — the table is gone in 0005).
    expect(membership?.companyId).toBe(company.id);
    expect(membership?.userId).toBe(user.id);
  });

  // T3.9 moved this from the legacy `emission_factors` to the factor library that
  // replaced it: the assertion is about the harness (reference rows survive the
  // per-test TRUNCATE), so it must point at a table that still exists.
  it("keeps the factor reference tables seeded across truncation", async () => {
    const db = getTestDb();
    const [{ n }] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM emission_factor`,
    );
    expect(Number(n)).toBeGreaterThan(0);
  });
});
