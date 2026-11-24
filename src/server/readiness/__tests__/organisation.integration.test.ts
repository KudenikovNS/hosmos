import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertLegalEntity,
  insertPeriod,
  insertRevision,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { legalEntity, periodScope } from "@/server/db/schema";

import { loadReadiness } from "../readiness";

describeIntegration("readiness organisation setup", () => {
  beforeAll(setupSchema);
  beforeEach(resetAppTables);
  afterAll(closeTestDb);

  it("asks for a legal entity before a reporting period", async () => {
    const company = await insertCompany();

    const readiness = await loadReadiness(getTestDb(), company.id);

    expect(readiness.has_legal_entity).toBe(false);
    expect(readiness.period).toBeNull();
    expect(readiness.next).toBe("organisation");
    expect(readiness.can_decide).toBe(false);
  });

  it("detects a deleted last legal entity even when a period and draft remain", async () => {
    const db = getTestDb();
    const company = await insertCompany();
    const { period, scope } = await insertPeriod(company.id);
    const revision = await insertRevision(company.id, { periodId: period.id });
    const before = await loadReadiness(db, company.id);
    expect(before.has_legal_entity).toBe(true);
    expect(before.can_decide).toBe(true);

    await db.delete(periodScope).where(eq(periodScope.id, scope.id));
    await db.delete(legalEntity).where(eq(legalEntity.id, scope.legalEntityId));

    const readiness = await loadReadiness(db, company.id);

    expect(readiness.has_legal_entity).toBe(false);
    expect(readiness.period?.id).toBe(period.id);
    expect(readiness.revision?.id).toBe(revision.id);
    expect(readiness.next).toBe("organisation");
    expect(readiness.can_decide).toBe(false);

    await insertLegalEntity(company.id);
    expect((await loadReadiness(db, company.id)).has_legal_entity).toBe(true);
  });

  it("does not use another company's legal entity as proof of setup", async () => {
    const company = await insertCompany();
    const other = await insertCompany();
    await insertLegalEntity(other.id);

    expect(
      (await loadReadiness(getTestDb(), company.id)).has_legal_entity,
    ).toBe(false);
    expect((await loadReadiness(getTestDb(), other.id)).has_legal_entity).toBe(
      true,
    );
  });
});
