// [LOCAL-DB] F05: a new methodology version keeps its own conversion semantics.
import { and, eq, like, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
vi.mock("server-only", () => ({}));

import { calculateRevision } from "@/server/calc/run";
import { convertUnit } from "@/server/calc/units";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertEmissionActivity,
  insertLegalEntity,
  insertPeriod,
  insertRevision,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { emissionFactor, factorSet, unitConversion } from "@/server/db/schema";
import { createFactorSet, updateFactorSet } from "../factor-sets";

const PREFIX = "f05-test-";

async function create(suffix: string, copyFrom?: string) {
  const result = await createFactorSet(getTestDb(), {
    code: PREFIX + suffix,
    name: suffix,
    copyFrom,
  });
  if (!result.ok) throw new Error("fixture create failed");
  return result.row;
}

describeIntegration("factor-set copy conversions [LOCAL-DB]", () => {
  beforeAll(setupSchema);
  beforeEach(resetAppTables);
  afterEach(async () => {
    // Calculations/periods reference the copied factors/set; remove these first.
    await resetAppTables();
    await getTestDb()
      .delete(factorSet)
      .where(like(factorSet.code, `${PREFIX}%`));
  });
  afterAll(closeTestDb);

  it("calculates the same natural-gas emissions with r5 and its released copy", async () => {
    const db = getTestDb();
    const [original] = await db
      .select()
      .from(factorSet)
      .where(eq(factorSet.code, "si-2025-r5"));
    if (!original) throw new Error("r5 is not seeded");
    const copied = await create("calculation", original.id);
    expect(
      (await updateFactorSet(db, copied.id, { status: "active" })).ok,
    ).toBe(true);
    const company = await insertCompany();
    const entity = await insertLegalEntity(company.id, {
      country: "SI",
      turnover: "1000",
    });
    const calculate = async (setId: string) => {
      const { period } = await insertPeriod(company.id, {
        legalEntityId: entity.id,
        factorSetId: setId,
      });
      const revision = await insertRevision(company.id, {
        periodId: period.id,
      });
      await insertEmissionActivity(company.id, {
        revisionId: revision.id,
        legalEntityId: entity.id,
        activityType: "natural_gas",
        activityValue: "1000",
        unit: "kWh",
        state: "approved",
      });
      const result = await calculateRevision(db, company.id, revision);
      if (!result.ok)
        throw new Error(`fixture calculate failed: ${JSON.stringify(result)}`);
      expect(result.run.status).toBe("ok");
      expect(result.lines).toHaveLength(1);
      return { ...result, revision };
    };
    const before = await calculate(original.id);
    const after = await calculate(copied.id);
    expect(before.lines[0].conversionFactor).toBe("1");
    expect(after.lines[0].conversionFactor).toBe(
      before.lines[0].conversionFactor,
    );
    expect(after.lines[0].factorId).not.toBe(before.lines[0].factorId);
    expect(after.aggregates).toEqual(before.aggregates);
    expect(Number(after.lines[0].co2eResult)).toBe(203.4);

    // Control: a previously created incomplete r5 copy falls back to shared
    // conversions and makes the same gas calculation ambiguous.
    await db
      .delete(unitConversion)
      .where(eq(unitConversion.factorSetId, copied.id));
    const incomplete = await calculateRevision(db, company.id, after.revision);
    expect(incomplete).toMatchObject({ ok: false, error: "FACTORS_AMBIGUOUS" });
  });

  it("keeps scoped precedence, null metadata and independent copies across versions", async () => {
    const db = getTestDb();
    const original = await create("source");
    await db.insert(unitConversion).values([
      {
        factorSetId: original.id,
        fromUnit: "kWh",
        toUnit: "kWh_net",
        multiplier: "1",
        activityContext: "natural_gas",
        source: "Measured source",
        notes: "Original explanation",
      },
      {
        factorSetId: original.id,
        fromUnit: "kWh",
        toUnit: "kWh_net",
        multiplier: "2",
        activityContext: null,
        source: null,
        notes: null,
      },
    ]);
    const sourceRows = await db
      .select()
      .from(unitConversion)
      .where(eq(unitConversion.factorSetId, original.id))
      .orderBy(unitConversion.id);
    const copied = await create("independent", original.id);
    const convert = async (setId: string, activity = "natural_gas") => {
      const result = convertUnit(
        "kWh",
        "kWh_net",
        activity,
        setId,
        await db.select().from(unitConversion),
      );
      if (result.status !== "ok") throw new Error("conversion missing");
      return result.conversion;
    };
    expect(await convert(copied.id)).toMatchObject({
      multiplier: "1",
      basis: "set_contextual",
    });
    expect(await convert(copied.id, "lpg")).toMatchObject({
      multiplier: "2",
      basis: "set_universal",
    });
    expect(
      await db
        .select()
        .from(unitConversion)
        .where(
          and(
            eq(unitConversion.factorSetId, copied.id),
            eq(unitConversion.multiplier, "2"),
          ),
        ),
    ).toMatchObject([{ activityContext: null, source: null, notes: null }]);
    await db
      .update(unitConversion)
      .set({ multiplier: "0.5", notes: "Changed in copy" })
      .where(
        and(
          eq(unitConversion.factorSetId, copied.id),
          eq(unitConversion.activityContext, "natural_gas"),
        ),
      );
    expect(await convert(copied.id)).toMatchObject({ multiplier: "0.5" });
    expect(await convert(original.id)).toMatchObject({ multiplier: "1" });
    const next = await create("next", copied.id);
    expect(await convert(next.id)).toMatchObject({
      multiplier: "0.5",
      basis: "set_contextual",
    });
    await db.delete(factorSet).where(eq(factorSet.id, copied.id));
    expect(await convert(next.id)).toMatchObject({
      multiplier: "0.5",
      basis: "set_contextual",
    });
    expect(
      await db
        .select()
        .from(unitConversion)
        .where(eq(unitConversion.factorSetId, original.id))
        .orderBy(unitConversion.id),
    ).toEqual(sourceRows);
  });

  it("rolls back the set and factors when a conversion insert fails", async () => {
    const db = getTestDb();
    const [source] = await db
      .select()
      .from(factorSet)
      .where(eq(factorSet.code, "si-2025-r5"));
    if (!source) throw new Error("r5 is not seeded");
    const before = {
      sets: await db.select().from(factorSet).orderBy(factorSet.id),
      factors: await db
        .select()
        .from(emissionFactor)
        .orderBy(emissionFactor.id),
      conversions: await db
        .select()
        .from(unitConversion)
        .orderBy(unitConversion.id),
    };
    // Existing rows remain valid for this test; every new scoped conversion fails.
    await db.execute(
      sql`ALTER TABLE unit_conversion ADD CONSTRAINT f05_copy_failure CHECK (factor_set_id IS NULL) NOT VALID`,
    );
    try {
      await expect(
        createFactorSet(db, {
          code: PREFIX + "rollback",
          name: "Must roll back",
          copyFrom: source.id,
        }),
      ).rejects.toThrow();
      expect(await db.select().from(factorSet).orderBy(factorSet.id)).toEqual(
        before.sets,
      );
      expect(
        await db.select().from(emissionFactor).orderBy(emissionFactor.id),
      ).toEqual(before.factors);
      expect(
        await db.select().from(unitConversion).orderBy(unitConversion.id),
      ).toEqual(before.conversions);
    } finally {
      await db.execute(
        sql`ALTER TABLE unit_conversion DROP CONSTRAINT f05_copy_failure`,
      );
    }
  });
});
