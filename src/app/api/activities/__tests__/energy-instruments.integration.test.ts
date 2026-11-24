// [LOCAL-DB] T3.2 — PURCHASED ENERGY (DM-16, §4.10) AND CONTRACTUAL INSTRUMENTS
// (DM-17, §4.11) over the SAME append-only service T3.1 built, against a real
// Postgres via the T1.7 harness.
//
// The properties this file exists to prove:
//
//   • THE SERVICE REALLY IS GENERIC. The second and third tables get the whole
//     LC-3…LC-7 protocol — draft, edit into a version, approve into a version,
//     tombstone, history — with no line of `rows.ts` changed. If the "table as a
//     parameter" claim were false, this is where it would show.
//   • A CLIENT CANNOT HAND THE SYSTEM A FACTOR. `location_factor_id` and
//     `market_factor_id` are Calculated (§4.10): a POST and a PATCH carrying a
//     REAL, seeded `emission_factor` id leave both columns NULL. The proof is
//     structural — the parser has no path into those columns — and this is the
//     test that says so from the outside.
//   • VAL-021 IS THE GEOGRAPHY GATE OF SCOPE 2. A row on a site with no country
//     is refused; a row with no site at all falls back to the legal entity's
//     country (К-18 allows the row, §0.7 forbids pricing it at nothing), and an
//     entity with no country is refused too.
//   • VAL-020 REFUSES A NEGATIVE CONSUMPTION and accepts a zero.
//   • VAL-023 IS A WARNING ABOUT VINTAGE. An instrument whose generation window
//     misses the reporting period is recorded and NOT refused.
//   • ANOTHER TENANT'S METER IS NOT A ROW (К-7, PATTERN 3). The FK alone would
//     accept it: `asset` carries its own `company_id` and the constraint knows
//     nothing about it.
//   • `all_rows_approved` (§5.1) COUNTS THESE TABLES. A draft energy row blocks
//     submit, which is why both new families have an approve route.
//   • THE MANIFEST REMAINDER IS EXACTLY WHAT T3.2 PROMISED — the three Scope-2
//     `record` rules implemented, VAL-022/VAL-024 still pending against T5.3.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so the DB half
// of this file is a green no-op in a DB-less CI; the manifest assertion below is
// a plain `describe` and runs everywhere.
import { asc, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

const getSessionMock = vi.fn();
vi.mock("@/server/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/session")>(
    "@/server/auth/session",
  );
  return { ...actual, getSession: () => getSessionMock() };
});

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return harness.testDbModule();
});

import type { NextRequest } from "next/server";

import {
  DELETE as energyDELETE,
  GET as energyGET,
  PATCH as energyPATCH,
} from "@/app/api/activities/energy/[id]/route";
import { POST as energyApprovePOST } from "@/app/api/activities/energy/[id]/approve/route";
import { GET as energyHistoryGET } from "@/app/api/activities/energy/[id]/history/route";
import {
  GET as energyListGET,
  OPTIONS as energyOPTIONS,
  POST as energyPOST,
} from "@/app/api/activities/energy/route";
import {
  DELETE as instrumentDELETE,
  PATCH as instrumentPATCH,
} from "@/app/api/activities/instruments/[id]/route";
import { POST as instrumentApprovePOST } from "@/app/api/activities/instruments/[id]/approve/route";
import { GET as instrumentHistoryGET } from "@/app/api/activities/instruments/[id]/history/route";
import {
  GET as instrumentListGET,
  OPTIONS as instrumentOPTIONS,
  POST as instrumentPOST,
} from "@/app/api/activities/instruments/route";
import { POST as transitionPOST } from "@/app/api/revisions/[id]/transition/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertAsset,
  insertFacility,
  insertInstrument,
  insertLegalEntity,
  insertPaidCompany,
  insertPeriod,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  contractualInstrument,
  emissionFactor,
  legalEntity,
  purchasedEnergyActivity,
} from "@/server/db/schema";
import { ENERGY_TYPES } from "@/server/inventory/purchased-energy";
import { EVALUATORS, PENDING_EVALUATORS } from "@/server/validation/registry";
import { runValidation } from "@/server/validation/run";

// ─── Request plumbing (same shape as the T3.1 suite) ─────────────────────────

const request = (path: string): NextRequest =>
  new Request(`http://api.example.com${path}`) as NextRequest;

const jsonRequest = (
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): NextRequest =>
  new Request(`http://api.example.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as NextRequest;

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

/** The session `getSession()` would resolve for a user (PATTERN 3 identity). */
async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

/** Sign `userId` in for the next route call. */
async function signIn(userId: string): Promise<void> {
  getSessionMock.mockResolvedValue(await sessionFor(userId));
}

// ─── The graph every test starts from ────────────────────────────────────────

interface Fixture {
  companyId: string;
  userId: string;
  legalEntityId: string;
  facilityId: string;
  periodId: string;
  revisionId: string;
}

/**
 * A paid company, one `esg_admin`, one legal entity (country SI) with a facility
 * (country SI), a period covering 2024 and a current DRAFT revision.
 */
async function setup(): Promise<Fixture> {
  const company = await insertPaidCompany();
  const { user } = await insertUserWithProfile({
    companyId: company.id,
    role: "esg_admin",
  });
  const entity = await insertLegalEntity(company.id);
  const site = await insertFacility(company.id, { legalEntityId: entity.id });
  const { period } = await insertPeriod(company.id, {
    legalEntityId: entity.id,
    createdBy: user.id,
  });
  const revision = await insertRevision(company.id, {
    periodId: period.id,
    createdBy: user.id,
  });
  await signIn(user.id);
  return {
    companyId: company.id,
    userId: user.id,
    legalEntityId: entity.id,
    facilityId: site.id,
    periodId: period.id,
    revisionId: revision.id,
  };
}

/** A minimal valid Scope-2 energy body: passes every blocking `record` rule. */
function energyBody(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    revision_id: fx.revisionId,
    legal_entity_id: fx.legalEntityId,
    facility_id: fx.facilityId,
    energy_type: "electricity",
    supplier: "Elektro Ljubljana",
    consumption: 12000,
    unit: "kWh",
    year_month: "2024-01",
    ...overrides,
  };
}

/**
 * A minimal instrument body — vintage inside the 2024 period (VAL-023 passes).
 *
 * `covered_volume` is 10 MWh AGAINST THE 12 MWh `energyBody` buys (12 000 kWh),
 * and the two numbers are a pair: T5.3 gave VAL-022 an evaluator, so a fixture
 * whose certificate claimed more MWh than its energy row consumed would be an
 * over-claim and would block the submit of every scenario that uses both. Same
 * principle the harness states about `registration_number` — a fixture should
 * produce data the APPLICATION accepts, not data that satisfies the columns and
 * fails the first rule to look at it.
 */
function instrumentBody(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    revision_id: fx.revisionId,
    legal_entity_id: fx.legalEntityId,
    instrument_type: "GoO",
    certificate_id: "GOO-2024-0001",
    covered_volume: 10,
    production_country: "si",
    technology: "wind",
    generation_period_start: "2024-01-01",
    generation_period_end: "2024-06-30",
    quality_criteria_status: "pass",
    ...overrides,
  };
}

// ─── Route callers ───────────────────────────────────────────────────────────

const answer = async (res: Response) => ({
  status: res.status,
  body: await res.json(),
});

const postEnergy = (body: unknown) =>
  energyPOST(jsonRequest("/api/activities/energy", "POST", body)).then(answer);

const listEnergy = (query = "") =>
  energyListGET(request(`/api/activities/energy${query}`)).then(answer);

const patchEnergy = (id: string, body: unknown) =>
  energyPATCH(
    jsonRequest(`/api/activities/energy/${id}`, "PATCH", body),
    ctxFor(id),
  ).then(answer);

const deleteEnergy = (id: string, body?: unknown) =>
  energyDELETE(
    jsonRequest(`/api/activities/energy/${id}`, "DELETE", body),
    ctxFor(id),
  ).then(answer);

const approveEnergy = (id: string) =>
  energyApprovePOST(
    jsonRequest(`/api/activities/energy/${id}/approve`, "POST"),
    ctxFor(id),
  ).then(answer);

const energyHistory = (id: string) =>
  energyHistoryGET(
    request(`/api/activities/energy/${id}/history`),
    ctxFor(id),
  ).then(answer);

const postInstrument = (body: unknown) =>
  instrumentPOST(jsonRequest("/api/activities/instruments", "POST", body)).then(
    answer,
  );

const listInstruments = (query = "") =>
  instrumentListGET(request(`/api/activities/instruments${query}`)).then(
    answer,
  );

const patchInstrument = (id: string, body: unknown) =>
  instrumentPATCH(
    jsonRequest(`/api/activities/instruments/${id}`, "PATCH", body),
    ctxFor(id),
  ).then(answer);

const deleteInstrument = (id: string, body?: unknown) =>
  instrumentDELETE(
    jsonRequest(`/api/activities/instruments/${id}`, "DELETE", body),
    ctxFor(id),
  ).then(answer);

const approveInstrument = (id: string) =>
  instrumentApprovePOST(
    jsonRequest(`/api/activities/instruments/${id}/approve`, "POST"),
    ctxFor(id),
  ).then(answer);

const instrumentHistory = (id: string) =>
  instrumentHistoryGET(
    request(`/api/activities/instruments/${id}/history`),
    ctxFor(id),
  ).then(answer);

const postTransition = (revisionId: string, action: string) =>
  transitionPOST(
    jsonRequest(`/api/revisions/${revisionId}/transition`, "POST", { action }),
    ctxFor(revisionId),
  ).then(answer);

// ─── Direct reads ────────────────────────────────────────────────────────────

async function storedEnergy(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(purchasedEnergyActivity)
    .where(eq(purchasedEnergyActivity.id, id));
  return row;
}

async function storedEnergyRows(revisionId: string) {
  return getTestDb()
    .select()
    .from(purchasedEnergyActivity)
    .where(eq(purchasedEnergyActivity.revisionId, revisionId))
    .orderBy(
      asc(purchasedEnergyActivity.createdAt),
      asc(purchasedEnergyActivity.id),
    );
}

async function storedInstrumentRows(revisionId: string) {
  return getTestDb()
    .select()
    .from(contractualInstrument)
    .where(eq(contractualInstrument.revisionId, revisionId));
}

/** Any seeded factor — the value a client must not be able to plant on a row. */
async function anyFactorId(): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: emissionFactor.id })
    .from(emissionFactor)
    .limit(1);
  return row.id;
}

/** The rule codes a 422 payload names. */
function codes(body: { rules?: { code: string }[] }): string[] {
  return (body.rules ?? []).map((rule) => rule.code);
}

/** Run the `record` rules against one row and read one code's verdict. */
async function verdict(
  companyId: string,
  rowId: string,
  code: string,
): Promise<boolean | undefined> {
  const records = await runValidation(getTestDb(), {
    companyId,
    scope: "record",
    targetId: rowId,
  });
  return records.find((record) => record.ruleCode === code)?.passed;
}

// ─── The manifest (no database needed) ───────────────────────────────────────

describe("the evaluator manifest after T3.2 (R-12)", () => {
  it("implements the three Scope-2 record rules", () => {
    for (const code of ["VAL-020", "VAL-021", "VAL-023"] as const) {
      expect(EVALUATORS[code]).toBeTypeOf("function");
      expect(PENDING_EVALUATORS[code]).toBeUndefined();
    }
  });

  it("leaves EXACTLY the codes that wait for something T3.2 does not build", () => {
    // Named one by one rather than counted: a count passes when a code is
    // swapped for another, and the point of the manifest is WHICH gap is
    // scheduled to WHOM. VAL-013 left the manifest in T4.1, which built the
    // upload route that writes the document it judges, VAL-037 in T4.2 with the
    // link route, VAL-038/VAL-039 in T4.3 with the DQ assessment,
    // VAL-036/VAL-040/VAL-041 in T4.4 with the approval gates that judge them,
    // and VAL-022/VAL-024 in T5.3 with CALC-5's matching — the manifest only
    // ever shrinks, so this list loses an entry with every later task rather
    // than gaining one. What is left is the three codes that wait for a
    // `calculation` ROW, which only T5.4's run writes.
    // T5.4 removed the last three (VAL-017, VAL-034, VAL-035) with the run
    // that writes their subject, so the list this task's successors kept
    // shrinking is now EMPTY — which is the end state, not a gap: every §6.2
    // rule has an evaluator. The assertion stays because it is the one that
    // would go red if a later phase added a rule and forgot to own it.
    expect(Object.keys(PENDING_EVALUATORS).sort()).toEqual([]);
  });

  it("hands the two Scope-2 revision rules the ONE matching (T5.3)", () => {
    // T3.2 left both codes pending against T5.3 on the grounds that a rule about
    // "the matched volume" written before CALC-5 existed would be a SECOND
    // matching. T5.3 wrote the algorithm once and both rules read it, so the
    // manifest entry is gone and the evaluators are here instead.
    for (const code of ["VAL-022", "VAL-024"] as const) {
      expect(EVALUATORS[code]).toBeTypeOf("function");
      expect(PENDING_EVALUATORS[code]).toBeUndefined();
    }
  });
});

describeIntegration(
  "activities/energy + activities/instruments [LOCAL-DB]",
  () => {
    beforeAll(async () => {
      await setupSchema();
    });
    beforeEach(async () => {
      await resetAppTables();
      getSessionMock.mockReset();
    });
    afterAll(async () => {
      await closeTestDb();
    });

    // ─── The generic service, over two more tables ─────────────────────────

    describe("purchased energy — the append-only protocol (LC-3…LC-7)", () => {
      it("creates, lists, edits, approves and tombstones with no service change", async () => {
        const fx = await setup();

        const created = await postEnergy(energyBody(fx));
        expect(created.status).toBe(200);
        expect(created.body.data).toMatchObject({
          state: "draft",
          is_deleted: false,
          previous_version_id: null,
          superseded_by_id: null,
          actor_id: fx.userId,
          actor_role: "esg_admin",
          energy_type: "electricity",
          supplier: "Elektro Ljubljana",
          consumption: 12000,
          unit: "kWh",
          // Calculated (§4.10) — nothing has run the calculation yet.
          location_factor_id: null,
          market_factor_id: null,
        });

        const listed = await listEnergy(`?revision_id=${fx.revisionId}`);
        expect(listed.body.data.activities).toHaveLength(1);

        // LC-5 — an edit is a NEW version, the body carries forward.
        const edited = await patchEnergy(created.body.data.id, {
          consumption: 13500,
        });
        expect(edited.status).toBe(200);
        expect(edited.body.data).toMatchObject({
          id: expect.not.stringMatching(created.body.data.id),
          previous_version_id: created.body.data.id,
          consumption: 13500,
          supplier: "Elektro Ljubljana",
          energy_type: "electricity",
        });
        expect((await storedEnergy(created.body.data.id)).supersededById).toBe(
          edited.body.data.id,
        );

        // LC-4 — approve is a version too.
        const approved = await approveEnergy(edited.body.data.id);
        expect(approved.status).toBe(200);
        expect(approved.body.data).toMatchObject({
          state: "approved",
          approved_by: fx.userId,
          previous_version_id: edited.body.data.id,
        });

        // API-2 — the whole chain, from any id.
        const chain = await energyHistory(created.body.data.id);
        expect(
          chain.body.data.versions.map((v: { id: string }) => v.id),
        ).toEqual([
          created.body.data.id,
          edited.body.data.id,
          approved.body.data.id,
        ]);

        // LC-6 — the tombstone leaves the listing, stays in the table.
        const removed = await deleteEnergy(approved.body.data.id, {
          change_reason: "billed to the wrong site",
        });
        expect(removed.status).toBe(200);
        expect(removed.body.data.is_deleted).toBe(true);
        expect(
          (await listEnergy(`?revision_id=${fx.revisionId}`)).body.data
            .activities,
        ).toEqual([]);
        expect(await storedEnergyRows(fx.revisionId)).toHaveLength(4);
      });

      it("answers OPTIONS on both new families (PATTERN 2)", async () => {
        expect(
          (await energyOPTIONS(request("/api/activities/energy"))).status,
        ).toBe(204);
        expect(
          (await instrumentOPTIONS(request("/api/activities/instruments")))
            .status,
        ).toBe(204);
      });

      it("refuses a body naming another company's revision (API-1)", async () => {
        const fx = await setup();
        const other = await insertPaidCompany();
        const foreign = await insertRevision(other.id);

        const created = await postEnergy(
          energyBody(fx, { revision_id: foreign.id }),
        );
        expect(created.status).toBe(422);
        expect(created.body.error).toBe("VALIDATION");
        expect(await storedEnergyRows(foreign.id)).toHaveLength(0);
      });

      it("rejects a body outside the shape of the columns (§0.8)", async () => {
        const fx = await setup();
        // The discriminator is a CHECK-constrained code list…
        expect(
          (await postEnergy(energyBody(fx, { energy_type: "gas" }))).body.field,
        ).toBe("energy_type");
        // …and `renewable_share` is a 0–100 percentage no rule owns (§4.10).
        expect(
          (await postEnergy(energyBody(fx, { renewable_share: 140 }))).body
            .field,
        ).toBe("renewable_share");
        expect(await storedEnergyRows(fx.revisionId)).toHaveLength(0);
      });

      it("keeps the four §4.10 carriers as the discriminator's whole domain", async () => {
        const fx = await setup();
        for (const energyType of ENERGY_TYPES) {
          const created = await postEnergy(
            energyBody(fx, { energy_type: energyType }),
          );
          expect(created.status).toBe(200);
          expect(created.body.data.energy_type).toBe(energyType);
        }
        expect(ENERGY_TYPES).toHaveLength(4);
      });
    });

    // ─── The Calculated fields (§4.10) ─────────────────────────────────────

    describe("location_factor_id / market_factor_id are Calculated (§4.10)", () => {
      it("ignores them in a POST and in a PATCH — a client cannot plant a factor", async () => {
        const fx = await setup();
        const factorId = await anyFactorId();

        const created = await postEnergy(
          energyBody(fx, {
            location_factor_id: factorId,
            market_factor_id: factorId,
          }),
        );
        expect(created.status).toBe(200);
        expect(created.body.data.location_factor_id).toBeNull();
        expect(created.body.data.market_factor_id).toBeNull();

        // The COLUMN, not just the response: the parser never produced a value,
        // so there is nothing for the insert to carry.
        const stored = await storedEnergy(created.body.data.id);
        expect(stored.locationFactorId).toBeNull();
        expect(stored.marketFactorId).toBeNull();

        // A PATCH cannot smuggle one either — and a PATCH that carries ONLY
        // Calculated fields changes nothing at all, so it is refused as empty.
        const onlyFactors = await patchEnergy(created.body.data.id, {
          location_factor_id: factorId,
        });
        expect(onlyFactors.status).toBe(422);
        expect(onlyFactors.body.field).toBe("body");

        const alongsideAChange = await patchEnergy(created.body.data.id, {
          consumption: 9000,
          market_factor_id: factorId,
        });
        expect(alongsideAChange.status).toBe(200);
        expect(alongsideAChange.body.data.consumption).toBe(9000);
        expect(alongsideAChange.body.data.market_factor_id).toBeNull();
        expect(
          (await storedEnergy(alongsideAChange.body.data.id)).marketFactorId,
        ).toBeNull();
      });

      it("carries a factor written by the calculation forward onto a new version", async () => {
        // T5.3 writes these columns; the version chain has to carry them like
        // any other body column, or a re-approval would silently unprice a row.
        const fx = await setup();
        const factorId = await anyFactorId();
        const created = await postEnergy(energyBody(fx));
        await getTestDb()
          .update(purchasedEnergyActivity)
          .set({ locationFactorId: factorId })
          .where(eq(purchasedEnergyActivity.id, created.body.data.id));

        const edited = await patchEnergy(created.body.data.id, {
          consumption: 1,
        });
        expect(edited.body.data.location_factor_id).toBe(factorId);
      });
    });

    // ─── VAL-020 and VAL-021 ───────────────────────────────────────────────

    describe("VAL-020 — the consumption is not negative", () => {
      it("refuses −1 and accepts 0", async () => {
        const fx = await setup();

        const negative = await postEnergy(energyBody(fx, { consumption: -1 }));
        expect(negative.status).toBe(422);
        expect(codes(negative.body)).toContain("VAL-020");
        // VAL-011 says the same thing in the activity domain's words; both
        // being true of one row is the documented overlap, not a bug.
        expect(codes(negative.body)).toContain("VAL-011");
        expect(await storedEnergyRows(fx.revisionId)).toHaveLength(0);

        const zero = await postEnergy(energyBody(fx, { consumption: 0 }));
        expect(zero.status).toBe(200);
        expect(await verdict(fx.companyId, zero.body.data.id, "VAL-020")).toBe(
          true,
        );
      });
    });

    describe("VAL-021 — Scope 2 needs the geography its factor resolves by", () => {
      it("refuses a row whose SITE has no country", async () => {
        const fx = await setup();
        const nowhere = await insertFacility(fx.companyId, {
          legalEntityId: fx.legalEntityId,
          country: null,
        });

        const refused = await postEnergy(
          energyBody(fx, { facility_id: nowhere.id }),
        );
        expect(refused.status).toBe(422);
        expect(codes(refused.body)).toContain("VAL-021");
        expect(await storedEnergyRows(fx.revisionId)).toHaveLength(0);

        // Filling the site's country in is the whole fix.
        const withCountry = await postEnergy(energyBody(fx));
        expect(withCountry.status).toBe(200);
        expect(
          await verdict(fx.companyId, withCountry.body.data.id, "VAL-021"),
        ).toBe(true);
      });

      it("falls back to the legal entity when the row has NO site (К-18)", async () => {
        const fx = await setup();
        // К-18: a row with no facility is legal when it documents why (VAL-104),
        // and its geography is then the entity's registered country.
        const documented = await postEnergy(
          energyBody(fx, {
            facility_id: null,
            notes: "leased office, landlord bills the whole building",
          }),
        );
        expect(documented.status).toBe(200);
        expect(documented.body.data.facility_id).toBeNull();
        expect(
          await verdict(fx.companyId, documented.body.data.id, "VAL-021"),
        ).toBe(true);

        // …and when the entity has no country either, there is no geography at
        // all and the row is refused.
        await getTestDb()
          .update(legalEntity)
          .set({ country: null })
          .where(eq(legalEntity.id, fx.legalEntityId));

        const nowhere = await postEnergy(
          energyBody(fx, { facility_id: null, notes: "same office" }),
        );
        expect(nowhere.status).toBe(422);
        expect(codes(nowhere.body)).toContain("VAL-021");
      });

      it("does NOT fall back when the row HAS a site (the site is the geography)", async () => {
        const fx = await setup();
        const abroad = await insertFacility(fx.companyId, {
          legalEntityId: fx.legalEntityId,
          country: null,
        });
        // The entity keeps its SI country; the row still fails, because a
        // Slovenian parent's foreign plant must not be priced at the SI grid.
        const refused = await postEnergy(
          energyBody(fx, { facility_id: abroad.id }),
        );
        expect(refused.status).toBe(422);
        expect(codes(refused.body)).toContain("VAL-021");
      });
    });

    // ─── К-7: the meter is an asset, and assets have tenants ───────────────

    describe("meter_asset_id (К-7)", () => {
      it("accepts this company's meter and refuses another company's (422)", async () => {
        const fx = await setup();
        const meter = await insertAsset(fx.companyId, {
          legalEntityId: fx.legalEntityId,
          facilityId: fx.facilityId,
          assetType: "meter",
          identifier: "SI-1234567",
        });
        const other = await insertPaidCompany();
        const foreignMeter = await insertAsset(other.id, {
          assetType: "meter",
        });

        const ours = await postEnergy(
          energyBody(fx, { meter_asset_id: meter.id }),
        );
        expect(ours.status).toBe(200);
        expect(ours.body.data.meter_asset_id).toBe(meter.id);

        // The FK alone would accept this: `asset` carries its own `company_id`
        // and `REFERENCES asset(id)` knows nothing about it (§0.4 rule 1).
        const theirs = await postEnergy(
          energyBody(fx, { meter_asset_id: foreignMeter.id }),
        );
        expect(theirs.status).toBe(422);
        expect(theirs.body.error).toBe("VALIDATION");
        expect(theirs.body.field).toBe("meter_asset_id");
        expect(await storedEnergyRows(fx.revisionId)).toHaveLength(1);

        // A PATCH cannot reach across the boundary either.
        const moved = await patchEnergy(ours.body.data.id, {
          meter_asset_id: foreignMeter.id,
        });
        expect(moved.status).toBe(422);
        expect(moved.body.field).toBe("meter_asset_id");
        expect(
          (await storedEnergy(ours.body.data.id)).supersededById,
        ).toBeNull();
      });

      it("refuses another company's facility on the same grounds", async () => {
        const fx = await setup();
        const other = await insertPaidCompany();
        const foreignSite = await insertFacility(other.id);

        const refused = await postEnergy(
          energyBody(fx, { facility_id: foreignSite.id }),
        );
        expect(refused.status).toBe(422);
        expect(refused.body.field).toBe("facility_id");
        expect(await storedEnergyRows(fx.revisionId)).toHaveLength(0);
      });
    });

    // ─── Instruments (DM-17) ───────────────────────────────────────────────

    describe("contractual instruments — the DM-17 body", () => {
      it("round-trips every §4.11 field and versions like any other row", async () => {
        const fx = await setup();
        const created = await postInstrument(instrumentBody(fx));

        expect(created.status).toBe(200);
        expect(created.body.data).toMatchObject({
          state: "draft",
          instrument_type: "GoO",
          certificate_id: "GOO-2024-0001",
          covered_volume: 10,
          // `alphaCodeOrNull` upper-cases a `char(2)` on the way in.
          production_country: "SI",
          technology: "wind",
          generation_period_start: "2024-01-01",
          generation_period_end: "2024-06-30",
          quality_criteria_status: "pass",
          residual_mix_volume: null,
          // §4.11: an instrument covers the period, not a month of it.
          year_month: null,
        });

        const listed = await listInstruments(`?revision_id=${fx.revisionId}`);
        expect(listed.body.data.instruments).toHaveLength(1);

        const edited = await patchInstrument(created.body.data.id, {
          cancellation_date: "2025-03-31",
          residual_mix_volume: 40,
        });
        expect(edited.status).toBe(200);
        expect(edited.body.data).toMatchObject({
          cancellation_date: "2025-03-31",
          residual_mix_volume: 40,
          certificate_id: "GOO-2024-0001",
          previous_version_id: created.body.data.id,
        });

        const approved = await approveInstrument(edited.body.data.id);
        expect(approved.status).toBe(200);
        expect(approved.body.data.state).toBe("approved");

        const chain = await instrumentHistory(created.body.data.id);
        expect(chain.body.data.versions).toHaveLength(3);

        const removed = await deleteInstrument(approved.body.data.id, {
          change_reason: "certificate cancelled by the registry",
        });
        expect(removed.status).toBe(200);
        expect(
          (await listInstruments(`?revision_id=${fx.revisionId}`)).body.data
            .instruments,
        ).toEqual([]);
        expect(await storedInstrumentRows(fx.revisionId)).toHaveLength(4);
      });

      it("rejects values outside the §4.11 code lists", async () => {
        const fx = await setup();
        for (const [field, body] of [
          ["instrument_type", { instrument_type: "GOO" }],
          ["technology", { technology: "fusion" }],
          ["quality_criteria_status", { quality_criteria_status: "maybe" }],
          ["generation_period_start", { generation_period_start: "01/2024" }],
          ["production_country", { production_country: "SLO" }],
          ["covered_volume", { covered_volume: -5 }],
        ] as const) {
          const refused = await postInstrument(instrumentBody(fx, body));
          expect(refused.status).toBe(422);
          expect(refused.body.field).toBe(field);
        }
        expect(await storedInstrumentRows(fx.revisionId)).toHaveLength(0);
      });
    });

    describe("VAL-023 — the certificate's vintage against the period (Warning)", () => {
      it("warns on a window outside the period and never refuses the write", async () => {
        const fx = await setup();
        // The period is 2024; this certificate was generated in 2022.
        const stale = await postInstrument(
          instrumentBody(fx, {
            generation_period_start: "2022-01-01",
            generation_period_end: "2022-12-31",
          }),
        );
        expect(stale.status).toBe(200);
        expect(await verdict(fx.companyId, stale.body.data.id, "VAL-023")).toBe(
          false,
        );

        // Overlap is enough — CALC-5 prorates by exactly this intersection.
        const straddling = await postInstrument(
          instrumentBody(fx, {
            generation_period_start: "2023-10-01",
            generation_period_end: "2024-03-31",
          }),
        );
        expect(
          await verdict(fx.companyId, straddling.body.data.id, "VAL-023"),
        ).toBe(true);

        // A vintage nobody has typed in yet is not a warning.
        const undated = await postInstrument(
          instrumentBody(fx, {
            generation_period_start: null,
            generation_period_end: null,
          }),
        );
        expect(
          await verdict(fx.companyId, undated.body.data.id, "VAL-023"),
        ).toBe(true);
      });

      it("reads an open-ended window as open, not as missing", async () => {
        const fx = await setup();
        const openEnded = await insertInstrument(fx.companyId, {
          revisionId: fx.revisionId,
          legalEntityId: fx.legalEntityId,
          generationPeriodStart: "2023-06-01",
          generationPeriodEnd: null,
        });
        expect(await verdict(fx.companyId, openEnded.id, "VAL-023")).toBe(true);

        const endedBefore = await insertInstrument(fx.companyId, {
          revisionId: fx.revisionId,
          legalEntityId: fx.legalEntityId,
          generationPeriodStart: null,
          generationPeriodEnd: "2023-06-01",
        });
        expect(await verdict(fx.companyId, endedBefore.id, "VAL-023")).toBe(
          false,
        );
      });
    });

    // ─── §5.1: the submit gate now has Scope-2 subjects ────────────────────

    describe("all_rows_approved (§5.1) counts the two new tables", () => {
      it("is blocked by a draft energy row and a draft instrument", async () => {
        const fx = await setup();
        const energy = (await postEnergy(energyBody(fx))).body.data;
        const instrument = (await postInstrument(instrumentBody(fx))).body.data;

        const blocked = await postTransition(fx.revisionId, "submit");
        expect(blocked.status).toBe(422);
        expect(blocked.body.transition).toMatchObject({
          precondition: "all_rows_approved",
          rows: 2,
          approved: 0,
          pending: 2,
        });

        await approveEnergy(energy.id);
        await approveInstrument(instrument.id);
        const allowed = await postTransition(fx.revisionId, "submit");
        expect(allowed.status).toBe(200);
      });
    });

    // ─── VAL-010: the freeze covers the new tables too ─────────────────────

    describe("the freeze (VAL-010) over the new tables", () => {
      it("refuses an energy write and an instrument write once submitted", async () => {
        const fx = await setup();
        const energy = (await postEnergy(energyBody(fx))).body.data;
        const instrument = (await postInstrument(instrumentBody(fx))).body.data;
        await approveEnergy(energy.id);
        await approveInstrument(instrument.id);
        expect((await postTransition(fx.revisionId, "submit")).status).toBe(
          200,
        );

        const newEnergy = await postEnergy(energyBody(fx));
        expect(newEnergy.status).toBe(422);
        expect(codes(newEnergy.body)).toContain("VAL-010");

        const newInstrument = await postInstrument(instrumentBody(fx));
        expect(newInstrument.status).toBe(422);
        expect(codes(newInstrument.body)).toContain("VAL-010");
      });
    });

    // ─── PATTERN 3: another tenant's row is simply not there ───────────────

    describe("tenant isolation", () => {
      it("does not list, read or edit another company's rows", async () => {
        const fx = await setup();
        const other = await insertPaidCompany();
        const foreign = await insertInstrument(other.id);

        expect(
          (await listInstruments()).body.data.instruments.map(
            (row: { id: string }) => row.id,
          ),
        ).not.toContain(foreign.id);
        expect((await instrumentHistory(foreign.id)).status).toBe(404);
        expect(
          (await patchInstrument(foreign.id, { covered_volume: 1 })).status,
        ).toBe(422);

        const foreignEnergy = await getTestDb()
          .insert(purchasedEnergyActivity)
          .values({
            companyId: other.id,
            revisionId: (await insertRevision(other.id)).id,
            legalEntityId: (await insertLegalEntity(other.id)).id,
            energyType: "electricity",
            consumption: "5",
            actorId: fx.userId,
          })
          .returning();
        const read = await energyGET(
          request(`/api/activities/energy/${foreignEnergy[0].id}`),
          ctxFor(foreignEnergy[0].id),
        );
        expect(read.status).toBe(404);
      });
    });

    // ─── §5.4: the capability matrix, on the new routes ────────────────────

    describe("capabilities (§5.4)", () => {
      it("refuses a contributor's approve with 403 before anything else", async () => {
        const fx = await setup();
        const energy = (await postEnergy(energyBody(fx))).body.data;

        // A second member with `data.approve` removes the D13 grant from the
        // admin, so `contributor` is judged on the matrix alone.
        const { user: approver } = await insertUserWithProfile({
          companyId: fx.companyId,
          role: "approver",
        });
        const { user: contributor } = await insertUserWithProfile({
          companyId: fx.companyId,
          role: "contributor",
        });
        await signIn(contributor.id);
        expect((await approveEnergy(energy.id)).status).toBe(403);

        await signIn(approver.id);
        const approved = await approveEnergy(energy.id);
        expect(approved.status).toBe(200);
        expect(approved.body.data.approved_by).toBe(approver.id);
      });

      it("refuses an auditor's write and lets the read through", async () => {
        const fx = await setup();
        const { user: auditor } = await insertUserWithProfile({
          companyId: fx.companyId,
          role: "auditor",
        });
        await signIn(auditor.id);
        expect((await postEnergy(energyBody(fx))).status).toBe(403);
        expect((await listEnergy()).status).toBe(200);
        expect((await postInstrument(instrumentBody(fx))).status).toBe(403);
        expect((await listInstruments()).status).toBe(200);
      });
    });
  },
);
