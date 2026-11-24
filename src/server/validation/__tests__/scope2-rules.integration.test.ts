// =============================================================================
// VAL-022 AND VAL-024 AGAINST A REAL DATABASE (T5.3, §6.2, CALC-5). [LOCAL-DB]
//
// `scope2.test.ts` proves the ALGORITHM against hand arithmetic; this file
// proves the two RULES that read it — that they find their subjects through the
// revision, that they file their findings under the objects §6.2 names, that a
// blocking failure is what a preparer actually gets, and that a pass overwrites
// a previous failure instead of leaving it on the screen for ever (§4.18).
//
// It is deliberately short. Everything the rules SAY is decided in
// `calc/scope2.ts` and is already pinned by the golden fixture; what needs a
// Postgres is the reading, the tenant pin and the upsert.
// =============================================================================
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";

import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertEnergyActivity,
  insertFacility,
  insertInstrument,
  insertLegalEntity,
  insertPeriod,
  insertRevision,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  contractualInstrument,
  purchasedEnergyActivity,
} from "@/server/db/schema";

import { EVALUATORS, PENDING_EVALUATORS } from "../registry";
import { findRule } from "../rules";
import { runValidation, type ValidationResultRecord } from "../run";

describe("the evaluator manifest after T5.3 (R-12)", () => {
  it("implements both Scope-2 revision rules and drops them from the manifest", () => {
    for (const code of ["VAL-022", "VAL-024"] as const) {
      expect(EVALUATORS[code]).toBeTypeOf("function");
      expect(PENDING_EVALUATORS[code]).toBeUndefined();
    }
  });

  it("leaves NOTHING in the manifest — T5.4 emptied it", () => {
    // T5.3 pinned the three codes that were still waiting for a `calculation`
    // row; T5.4 wrote the run that produces one and took all three. The list is
    // now EMPTY, which is the end state rather than a gap — every §6.2 rule has
    // an evaluator. The assertion stays: it is what would go red if a later
    // phase added a rule and forgot to own it.
    expect(Object.keys(PENDING_EVALUATORS).sort()).toEqual([]);
    expect(Object.values(PENDING_EVALUATORS)).toEqual([]);
  });

  it("keeps both rules BLOCKING and `revision`-scoped (§6.2)", () => {
    // VAL-022 is what turns the cap from a silent absorption into something a
    // preparer is told about, so it has to stop an approval, not decorate one.
    for (const code of ["VAL-022", "VAL-024"] as const) {
      expect(findRule(code)?.scope).toBe("revision");
      expect(findRule(code)?.severity).toBe("error");
      expect(findRule(code)?.blocking).toBe(true);
    }
  });
});

describeIntegration("VAL-022 / VAL-024 [LOCAL-DB]", () => {
  beforeAll(async () => {
    await setupSchema();
  });
  beforeEach(async () => {
    await resetAppTables();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  /** A company with one entity, one site, one 2025 period and one revision. */
  async function fixture() {
    const company = await insertCompany();
    const entity = await insertLegalEntity(company.id);
    const site = await insertFacility(company.id, { legalEntityId: entity.id });
    const { period } = await insertPeriod(company.id, {
      legalEntityId: entity.id,
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      reportingYear: 2025,
    });
    const revision = await insertRevision(company.id, { periodId: period.id });
    return { company, entity, site, period, revision };
  }

  /** 100 MWh of approved electricity for the revision. */
  const energy = async (
    companyId: string,
    revisionId: string,
    legalEntityId: string,
    overrides: Partial<typeof purchasedEnergyActivity.$inferInsert> = {},
  ) =>
    insertEnergyActivity(companyId, {
      revisionId,
      legalEntityId,
      energyType: "electricity",
      consumption: "100",
      unit: "MWh",
      yearMonth: "2025-03",
      state: "approved",
      supplier: null,
      ...overrides,
    });

  /** A full-year GoO for the revision, `coveredVolume` MWh. */
  const instrument = async (
    companyId: string,
    revisionId: string,
    legalEntityId: string,
    coveredVolume: string,
    overrides: Partial<typeof contractualInstrument.$inferInsert> = {},
  ) =>
    insertInstrument(companyId, {
      revisionId,
      legalEntityId,
      coveredVolume,
      generationPeriodStart: "2025-01-01",
      generationPeriodEnd: "2025-12-31",
      state: "approved",
      ...overrides,
    });

  const run = (companyId: string, revisionId: string) =>
    runValidation(getTestDb(), {
      companyId,
      scope: "revision",
      targetId: revisionId,
    });

  const verdicts = (records: ValidationResultRecord[], code: string) =>
    records.filter((record) => record.ruleCode === code);

  const verdictFor = (
    records: ValidationResultRecord[],
    code: string,
    objectId: string,
  ) => verdicts(records, code).find((record) => record.objectId === objectId);

  describe("VAL-022 — over-claiming", () => {
    it("passes when the certificates fit inside the consumption", async () => {
      // 60 MWh of GoO against 100 MWh consumed.
      const fx = await fixture();
      await energy(fx.company.id, fx.revision.id, fx.entity.id);
      const goo = await instrument(
        fx.company.id,
        fx.revision.id,
        fx.entity.id,
        "60",
      );

      const records = await run(fx.company.id, fx.revision.id);
      expect(verdictFor(records, "VAL-022", goo.id)?.passed).toBe(true);
      expect(verdictFor(records, "VAL-022", goo.id)?.objectType).toBe(
        "contractual_instrument",
      );
    });

    it("BLOCKS when they claim 150% of it, and the volume is still capped", async () => {
      const fx = await fixture();
      await energy(fx.company.id, fx.revision.id, fx.entity.id);
      const goo = await instrument(
        fx.company.id,
        fx.revision.id,
        fx.entity.id,
        "150",
      );

      const records = await run(fx.company.id, fx.revision.id);
      const verdict = verdictFor(records, "VAL-022", goo.id);
      expect(verdict?.passed).toBe(false);
      expect(verdict?.blocking).toBe(true);
      expect(verdict?.revisionId).toBe(fx.revision.id);

      // The cap is the other half and lives in the calculation, not the rule:
      // VAL-024's balance still closes, which is only possible BECAUSE the
      // matched volume was capped at 100 MWh rather than left at 150.
      expect(
        verdicts(records, "VAL-024").every((record) => record.passed),
      ).toBe(true);
    });

    it("blames the SET, not a member: every certificate of the entity fails", async () => {
      // Once the certificates add up past the consumption, no individual one is
      // "the excess" — the consumption ORDER makes one of them the one that was
      // cut, and that order is our tie-break rather than a fact about which
      // contract is wrong.
      const fx = await fixture();
      await energy(fx.company.id, fx.revision.id, fx.entity.id);
      const first = await instrument(
        fx.company.id,
        fx.revision.id,
        fx.entity.id,
        "80",
        { certificateId: "GOO-A" },
      );
      const second = await instrument(
        fx.company.id,
        fx.revision.id,
        fx.entity.id,
        "80",
        { certificateId: "GOO-B" },
      );

      const records = await run(fx.company.id, fx.revision.id);
      expect(verdictFor(records, "VAL-022", first.id)?.passed).toBe(false);
      expect(verdictFor(records, "VAL-022", second.id)?.passed).toBe(false);
    });

    it("passes a certificate whose vintage window misses the period", async () => {
      // It prorates to zero, so it cannot push any total over — and a rule that
      // failed it would be reporting an over-claim nobody made.
      const fx = await fixture();
      await energy(fx.company.id, fx.revision.id, fx.entity.id);
      const stale = await instrument(
        fx.company.id,
        fx.revision.id,
        fx.entity.id,
        "9999",
        {
          generationPeriodStart: "2023-01-01",
          generationPeriodEnd: "2023-12-31",
        },
      );

      const records = await run(fx.company.id, fx.revision.id);
      expect(verdictFor(records, "VAL-022", stale.id)?.passed).toBe(true);
    });

    it("overwrites a stored failure when the surplus certificate is deleted", async () => {
      // §4.18: `validation_result` holds the LATEST result per (rule, target),
      // so silence about a removed certificate would leave its blocking failure
      // on the screen for ever. The evaluator writes a PASS for it instead.
      const fx = await fixture();
      await energy(fx.company.id, fx.revision.id, fx.entity.id);
      const goo = await instrument(
        fx.company.id,
        fx.revision.id,
        fx.entity.id,
        "150",
      );
      expect(
        verdictFor(await run(fx.company.id, fx.revision.id), "VAL-022", goo.id)
          ?.passed,
      ).toBe(false);

      // A tombstone, the way LC-6 deletes a row (К-21).
      await getTestDb()
        .update(contractualInstrument)
        .set({ isDeleted: true })
        .where(eq(contractualInstrument.id, goo.id));

      const after = await run(fx.company.id, fx.revision.id);
      expect(verdictFor(after, "VAL-022", goo.id)?.passed).toBe(true);
    });
  });

  describe("VAL-024 — the market-based balance", () => {
    it("closes covered + residual = consumption on every energy row", async () => {
      const fx = await fixture();
      const row = await energy(fx.company.id, fx.revision.id, fx.entity.id);
      await instrument(fx.company.id, fx.revision.id, fx.entity.id, "40");

      const records = await run(fx.company.id, fx.revision.id);
      const verdict = verdictFor(records, "VAL-024", row.id);
      expect(verdict?.passed).toBe(true);
      expect(verdict?.objectType).toBe("purchased_energy_activity");
    });

    it("fails a row whose unit reaches no MWh — a hole the cap cannot see", async () => {
      // The consumption is in neither column, so the entity's covered and
      // residual no longer add up to what it bought. Nothing about certificates
      // is wrong here, which is exactly why this is VAL-024's failure and not
      // VAL-022's.
      const fx = await fixture();
      const row = await energy(fx.company.id, fx.revision.id, fx.entity.id, {
        unit: "therm",
      });

      const records = await run(fx.company.id, fx.revision.id);
      expect(verdictFor(records, "VAL-024", row.id)?.passed).toBe(false);
      expect(verdicts(records, "VAL-022")).toEqual([]);
    });

    it("fails an instrument whose declared residual contradicts the balance", async () => {
      // §4.11 puts `residual_mix_volume` on the instrument expressly for this
      // balance. 100 MWh consumed and 40 covered leaves 60; a preparer who
      // types 25 is contradicting the calculation, and that is the whole point
      // of having the column.
      const fx = await fixture();
      await energy(fx.company.id, fx.revision.id, fx.entity.id);
      const goo = await instrument(
        fx.company.id,
        fx.revision.id,
        fx.entity.id,
        "40",
        { residualMixVolume: "25" },
      );

      const records = await run(fx.company.id, fx.revision.id);
      expect(verdictFor(records, "VAL-024", goo.id)?.passed).toBe(false);
    });

    it("passes when the declared residual agrees with it", async () => {
      const fx = await fixture();
      await energy(fx.company.id, fx.revision.id, fx.entity.id);
      const goo = await instrument(
        fx.company.id,
        fx.revision.id,
        fx.entity.id,
        "40",
        { residualMixVolume: "60" },
      );

      const records = await run(fx.company.id, fx.revision.id);
      expect(verdictFor(records, "VAL-024", goo.id)?.passed).toBe(true);
    });

    it("says nothing at all about another tenant's revision", async () => {
      // The tenant pin, as everywhere else: a foreign `targetId` matches no row
      // and produces no findings — never another company's data, and never an
      // error that confirms the id exists.
      const fx = await fixture();
      await energy(fx.company.id, fx.revision.id, fx.entity.id);
      await instrument(fx.company.id, fx.revision.id, fx.entity.id, "150");

      const intruder = await insertCompany();
      const records = await run(intruder.id, fx.revision.id);
      expect(verdicts(records, "VAL-022")).toEqual([]);
      expect(verdicts(records, "VAL-024")).toEqual([]);
    });
  });
});
