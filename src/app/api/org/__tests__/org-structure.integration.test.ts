// [LOCAL-DB] T2.2 — the legal-entity slice (service → route → validation) against
// a real Postgres via the T1.7 harness.
//
// The four properties this file exists to prove, none of which is visible without
// a database:
//
//   • TENANT ISOLATION IS STRUCTURAL. Another company's entity is not a 404 story
//     and not a 500 — it is a `VALIDATION`, because the id never resolves inside
//     the session's company (API-1, PATTERN 3). The same holds for a foreign id
//     used as `parent_organisation_id`.
//   • A BLOCKING RULE UNWRITES THE ROW. The write path validates INSIDE its
//     transaction and rolls back (VR-3), so a cycle or an inverted effective
//     range leaves the table exactly as it was. Asserting the 422 alone would
//     pass even if the row had been written — hence every refusal here is
//     followed by a read of the stored row.
//   • 403 COMES BEFORE 402, and the proof is not "both happen". The same company,
//     in the SAME state (limit already exhausted), answers 403 to a contributor
//     and 402 to an esg_admin: the only variable is the ROLE, so the capability
//     gate demonstrably runs first. A test that only showed a 403 for a
//     contributor would also pass if the plan gate ran first and happened to
//     allow the request.
//   • THE COUNTERS ARE REAL. `{used, limit}` is compared against `count(*)`, not
//     against the number the test itself created.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so this file is
// a green no-op in a DB-less CI.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

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
  DELETE as entityDELETE,
  GET as entityGET,
  PATCH as entityPATCH,
} from "@/app/api/org/entities/[id]/route";
import {
  GET as entitiesGET,
  OPTIONS as entitiesOPTIONS,
  POST as entitiesPOST,
} from "@/app/api/org/entities/route";
import { resolveSessionContext } from "@/server/auth/session";
import { resetPlanFeaturesCache } from "@/server/billing/entitlements";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertEmissionActivity,
  insertFacility,
  insertLegalEntity,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { legalEntity } from "@/server/db/schema";
import type { PlanId } from "@/shared/plans";
import type { CompanyRole } from "@/shared/roles";

/** A GET/DELETE request the route handlers accept. */
const request = (path: string, method = "GET"): NextRequest =>
  new Request(`http://api.example.com${path}`, { method }) as NextRequest;

/** A JSON body request (POST/PATCH read `req.json()`). */
const jsonRequest = (
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
): NextRequest =>
  new Request(`http://api.example.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;

/** The `{ params }` context Next hands a dynamic route. */
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

/** The session `getSession()` would resolve for a user (PATTERN 3 identity). */
async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

/** A company on `plan` plus a signed-in member with `role`; installs the session. */
async function actor(
  plan: PlanId,
  role: CompanyRole = "esg_admin",
): Promise<{ companyId: string; userId: string }> {
  const company = await insertCompany({ plan });
  const { user } = await insertUserWithProfile({
    companyId: company.id,
    role,
  });
  getSessionMock.mockResolvedValue(await sessionFor(user.id));
  return { companyId: company.id, userId: user.id };
}

/** A complete entity body — passes VAL-001/002 so only the field under test fails. */
const entityBody = (overrides: Record<string, unknown> = {}) => ({
  organisation_name: "Hosmos d.o.o.",
  registration_number: "1234567000",
  country: "SI",
  ...overrides,
});

/** POST an entity and return `{status, body}`. */
async function postEntity(overrides: Record<string, unknown> = {}) {
  const res = await entitiesPOST(
    jsonRequest("/api/org/entities", "POST", entityBody(overrides)),
  );
  return { status: res.status, body: await res.json() };
}

/** The real `count(*)` of a company's entities — the oracle for `used`. */
async function storedCount(companyId: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(legalEntity)
    .where(eq(legalEntity.companyId, companyId));
  return row.n;
}

/** One stored entity row, straight from the table (never through the route). */
async function storedEntity(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(legalEntity)
    .where(eq(legalEntity.id, id));
  return row;
}

/** The rule codes a 422 payload names (API-1 `{rules:[{code,…}]}`). */
const ruleCodes = (body: { rules?: { code: string }[] }): string[] =>
  (body.rules ?? []).map((rule) => rule.code);

/**
 * Run `fn` with one plan's `maxLegalEntities` overridden in the CATALOGUE.
 *
 * `plans` is reference data (never truncated by `resetAppTables`), so the row is
 * restored in a `finally` and the process-lifetime feature cache is dropped on
 * both sides of the change. The override exists because the catalogue has no
 * `-1` legal-entity limit today — Enterprise is capped at 10 by the pricing PDF
 * (T1.8) — while `-1` is a value the guard must nevertheless treat as unlimited
 * rather than as "a ceiling of minus one", i.e. as `0 >= -1 → refuse`.
 */
async function withEntityLimit(
  plan: PlanId,
  limit: number,
  fn: () => Promise<void>,
): Promise<void> {
  const conn = getTestDb();
  const [before] = await conn.execute<{ value: number }>(
    sql`SELECT (features->>'maxLegalEntities')::int AS value FROM plans WHERE id = ${plan}`,
  );
  const setLimit = async (value: number) => {
    await conn.execute(
      sql`UPDATE plans SET features = jsonb_set(features, '{maxLegalEntities}', to_jsonb(${value}::int)) WHERE id = ${plan}`,
    );
    resetPlanFeaturesCache();
  };
  await setLimit(limit);
  try {
    await fn();
  } finally {
    await setLimit(before.value);
  }
}

describeIntegration(
  "T2.2 legal entities: hierarchy, dating, plan limits",
  () => {
    beforeAll(async () => {
      await setupSchema();
    });
    beforeEach(async () => {
      await resetAppTables();
      resetPlanFeaturesCache();
      vi.clearAllMocks();
    });
    afterAll(async () => {
      await closeTestDb();
      resetPlanFeaturesCache();
    });

    // ─── The wire contract (К-1, К-2) ──────────────────────────────────────────
    it("speaks organisation_name / parent_organisation_id, never the column names", async () => {
      const { companyId } = await actor("pro");

      const parent = await postEntity({ organisation_name: "Parent" });
      expect(parent.status).toBe(200);
      expect(parent.body.data.organisation_name).toBe("Parent");
      expect(parent.body.data).not.toHaveProperty("name");
      expect(parent.body.data).not.toHaveProperty("parent_legal_entity_id");
      expect(parent.body.data).not.toHaveProperty("company_id");

      const child = await postEntity({
        organisation_name: "Child",
        parent_organisation_id: parent.body.data.id,
        group_structure_type: "subsidiary",
        consolidation_method: "operational_control",
        ownership_percentage: 60,
        average_fte: 12.5,
      });
      expect(child.status).toBe(200);
      expect(child.body.data.parent_organisation_id).toBe(parent.body.data.id);
      // NUMERIC columns cross the wire as numbers, not as Drizzle's strings.
      expect(child.body.data.ownership_percentage).toBe(60);
      expect(child.body.data.average_fte).toBe(12.5);

      // The rename is real in the database, not only in the response.
      const stored = await storedEntity(child.body.data.id);
      expect(stored.name).toBe("Child");
      expect(stored.parentLegalEntityId).toBe(parent.body.data.id);
      expect(await storedCount(companyId)).toBe(2);
    });

    // ─── Tenant isolation (PATTERN 3, API-1) ───────────────────────────────────
    it("PATCH of ANOTHER company's entity → VALIDATION, not 200 and not 500", async () => {
      const other = await insertCompany({ plan: "pro" });
      const foreign = await insertLegalEntity(other.id, { name: "Not yours" });

      await actor("pro");
      const res = await entityPATCH(
        jsonRequest(`/api/org/entities/${foreign.id}`, "PATCH", {
          organisation_name: "Hijacked",
        }),
        ctxFor(foreign.id),
      );

      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe("VALIDATION");
      // The foreign row is untouched — the write never reached it.
      expect((await storedEntity(foreign.id)).name).toBe("Not yours");
    });

    it("a foreign parent_organisation_id → VALIDATION (the reference does not exist here)", async () => {
      const other = await insertCompany({ plan: "pro" });
      const foreignParent = await insertLegalEntity(other.id);

      const { companyId } = await actor("pro");
      const created = await postEntity({
        parent_organisation_id: foreignParent.id,
      });

      expect(created.status).toBe(422);
      expect(created.body.error).toBe("VALIDATION");
      expect(await storedCount(companyId)).toBe(0);
    });

    it("GET of another company's entity → 404, never its data", async () => {
      const other = await insertCompany({ plan: "pro" });
      const foreign = await insertLegalEntity(other.id);

      await actor("pro");
      const res = await entityGET(
        request(`/api/org/entities/${foreign.id}`),
        ctxFor(foreign.id),
      );
      expect(res.status).toBe(404);
    });

    // ─── VAL-003: no cycles in the group hierarchy (DM-3) ──────────────────────
    it("a cycle A→B→A is refused by VAL-003 and the link is NOT written", async () => {
      await actor("pro");
      const a = (await postEntity({ organisation_name: "A" })).body.data;
      const b = (
        await postEntity({
          organisation_name: "B",
          parent_organisation_id: a.id,
        })
      ).body.data;
      expect(b.parent_organisation_id).toBe(a.id);

      // Closing the loop: A's parent becomes B, whose parent is already A.
      const res = await entityPATCH(
        jsonRequest(`/api/org/entities/${a.id}`, "PATCH", {
          parent_organisation_id: b.id,
        }),
        ctxFor(a.id),
      );
      expect(res.status).toBe(422);
      expect(ruleCodes(await res.json())).toContain("VAL-003");
      expect((await storedEntity(a.id)).parentLegalEntityId).toBeNull();
    });

    it("a self-reference A→A is refused by VAL-003 and the link is NOT written", async () => {
      await actor("pro");
      const a = (await postEntity({ organisation_name: "A" })).body.data;

      const res = await entityPATCH(
        jsonRequest(`/api/org/entities/${a.id}`, "PATCH", {
          parent_organisation_id: a.id,
        }),
        ctxFor(a.id),
      );
      expect(res.status).toBe(422);
      expect(ruleCodes(await res.json())).toContain("VAL-003");
      expect((await storedEntity(a.id)).parentLegalEntityId).toBeNull();
    });

    it("a three-level chain A→B→C is fine (depth is not a cycle)", async () => {
      await actor("pro");
      const a = (await postEntity({ organisation_name: "A" })).body.data;
      const b = (
        await postEntity({
          organisation_name: "B",
          parent_organisation_id: a.id,
        })
      ).body.data;
      const c = await postEntity({
        organisation_name: "C",
        parent_organisation_id: b.id,
      });
      expect(c.status).toBe(200);
      expect(c.body.data.parent_organisation_id).toBe(b.id);
    });

    // ─── VAL-004: effective dating (F4) ────────────────────────────────────────
    it("effective_to before effective_from → VAL-004, nothing written", async () => {
      const { companyId } = await actor("pro");
      const res = await postEntity({
        effective_from: "2024-06-01",
        effective_to: "2024-01-01",
      });

      expect(res.status).toBe(422);
      expect(ruleCodes(res.body)).toContain("VAL-004");
      expect(await storedCount(companyId)).toBe(0);

      // The ordered range is accepted, so the rule refused the ORDER, not dating.
      const ok = await postEntity({
        effective_from: "2024-01-01",
        effective_to: "2024-12-31",
      });
      expect(ok.status).toBe(200);
      expect(ok.body.data.effective_to).toBe("2024-12-31");
    });

    // ─── VAL-001 / VAL-002: required fields and the reference lists ────────────
    it("VAL-001 refuses an incomplete entity; VAL-002 refuses values outside the lists", async () => {
      const { companyId } = await actor("pro");

      const incomplete = await entitiesPOST(
        jsonRequest("/api/org/entities", "POST", {
          organisation_name: "No registration number",
        }),
      );
      expect(incomplete.status).toBe(422);
      expect(ruleCodes(await incomplete.json())).toContain("VAL-001");

      // Country: shape is fine (2 letters), membership is not.
      const badCountry = await postEntity({ country: "ZZ" });
      expect(badCountry.status).toBe(422);
      expect(ruleCodes(badCountry.body)).toContain("VAL-002");

      // NACE: a division that exists but not under that section (25 is C, not A).
      const badNace = await postEntity({ nace_code: "A25" });
      expect(badNace.status).toBe(422);
      expect(ruleCodes(badNace.body)).toContain("VAL-002");

      // Currency: refused BEFORE the insert, so it is a 422 with the rule code and
      // not the foreign-key driver error that would surface as a 500.
      const badCurrency = await postEntity({ reporting_currency: "XYZ" });
      expect(badCurrency.status).toBe(422);
      expect(ruleCodes(badCurrency.body)).toContain("VAL-002");

      expect(await storedCount(companyId)).toBe(0);

      const good = await postEntity({
        nace_code: "C25",
        reporting_currency: "EUR",
      });
      expect(good.status).toBe(200);
      expect(await storedCount(companyId)).toBe(1);
    });

    // ─── PG-2: the plan limit, and 403 BEFORE 402 ──────────────────────────────
    it("on trial the second entity is 402 (the parent occupies the single slot)", async () => {
      const { companyId } = await actor("trial"); // maxLegalEntities = 1
      expect((await postEntity({ organisation_name: "Root" })).status).toBe(
        200,
      );

      const second = await postEntity({ organisation_name: "Subsidiary" });
      expect(second.status).toBe(402);
      expect(second.body).toEqual({ ok: false, error: "PLAN_REQUIRED" });
      expect(await storedCount(companyId)).toBe(1);
    });

    it("a contributor gets 403 in the very state where an admin gets 402 (403 ≺ 402)", async () => {
      // ONE company, ONE state: starter (maxLegalEntities = 1) with its slot used.
      const company = await insertCompany({ plan: "starter" });
      await insertLegalEntity(company.id);

      const { user: contributor } = await insertUserWithProfile({
        companyId: company.id,
        role: "contributor", // data.write + data.read, no company.manage
      });
      const { user: admin } = await insertUserWithProfile({
        companyId: company.id,
        role: "esg_admin",
      });

      getSessionMock.mockResolvedValue(await sessionFor(contributor.id));
      const refusedByRole = await postEntity();
      expect(refusedByRole.status).toBe(403);
      expect(refusedByRole.status).not.toBe(402);
      expect(refusedByRole.body).toEqual({ ok: false, error: "FORBIDDEN" });

      // Same company, same exhausted limit, different role → the plan speaks. The
      // 402 proves the request WOULD have reached the plan gate, so the 403 above
      // can only have come from a check that runs before it.
      getSessionMock.mockResolvedValue(await sessionFor(admin.id));
      const refusedByPlan = await postEntity();
      expect(refusedByPlan.status).toBe(402);

      expect(await storedCount(company.id)).toBe(1);
    });

    it("on pro the third entity is fine and the fourth is 402", async () => {
      const { companyId } = await actor("pro"); // maxLegalEntities = 3
      for (const name of ["One", "Two", "Three"]) {
        expect((await postEntity({ organisation_name: name })).status).toBe(
          200,
        );
      }
      expect(await storedCount(companyId)).toBe(3);

      const fourth = await postEntity({ organisation_name: "Four" });
      expect(fourth.status).toBe(402);
      expect(await storedCount(companyId)).toBe(3);
    });

    it("a limit of -1 is unlimited, not a ceiling of zero", async () => {
      await withEntityLimit("enterprise", -1, async () => {
        const { companyId } = await actor("enterprise");
        // The override is in force BEFORE anything is created, so the creates below
        // really are made against a limit of -1.
        const empty = await entitiesGET(request("/api/org/entities"));
        expect((await empty.json()).data).toMatchObject({ used: 0, limit: -1 });

        // The FIRST create is the proof that `-1` is not read as a number to
        // compare against: `0 >= -1` is true, so a missing unlimited branch would
        // refuse this one. The next three take the count past Pro's ceiling of 3.
        for (const name of ["One", "Two", "Three", "Four"]) {
          const res = await postEntity({ organisation_name: name });
          expect(res.status).toBe(200);
        }
        expect(await storedCount(companyId)).toBe(4);
      });
    });

    // ─── API-3: the counters ───────────────────────────────────────────────────
    it("{used, limit} matches count(*) and the plan matrix", async () => {
      const { companyId } = await actor("pro");
      await postEntity({ organisation_name: "One" });
      await postEntity({ organisation_name: "Two" });

      const res = await entitiesGET(request("/api/org/entities"));
      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.used).toBe(await storedCount(companyId));
      expect(data.used).toBe(2);
      expect(data.limit).toBe(3); // pro
      expect(data.entities).toHaveLength(2);
      // The list is the company's own, and only its own.
      const otherCompany = await insertCompany({ plan: "pro" });
      await insertLegalEntity(otherCompany.id);
      const again = await entitiesGET(request("/api/org/entities"));
      expect((await again.json()).data.used).toBe(2);
    });

    // ─── DM-4: deletion is refused for an entity that owns anything ────────────
    it("deleting an entity with facilities or rows is refused; an empty one goes", async () => {
      const { companyId } = await actor("pro");
      const withFacility = await insertLegalEntity(companyId);
      await insertFacility(companyId, { legalEntityId: withFacility.id });

      const refused = await entityDELETE(
        request(`/api/org/entities/${withFacility.id}`, "DELETE"),
        ctxFor(withFacility.id),
      );
      expect(refused.status).toBe(422);
      const refusedBody = await refused.json();
      expect(refusedBody.error).toBe("VALIDATION");
      expect(refusedBody.blockers.facilities).toBe(1);
      expect(await storedEntity(withFacility.id)).toBeDefined();

      // An entity carrying input rows is refused for the same reason.
      const withRows = await insertLegalEntity(companyId);
      await insertEmissionActivity(companyId, { legalEntityId: withRows.id });
      const refusedRows = await entityDELETE(
        request(`/api/org/entities/${withRows.id}`, "DELETE"),
        ctxFor(withRows.id),
      );
      expect(refusedRows.status).toBe(422);
      expect((await refusedRows.json()).blockers.emission_activities).toBe(1);

      // The entity that owns nothing is deletable — that is the whole point of the
      // refusal above: it is a data guard, not a ban on deletion.
      const empty = await insertLegalEntity(companyId);
      const deleted = await entityDELETE(
        request(`/api/org/entities/${empty.id}`, "DELETE"),
        ctxFor(empty.id),
      );
      expect(deleted.status).toBe(200);
      expect(await storedEntity(empty.id)).toBeUndefined();
    });

    it("deleting another company's entity → VALIDATION, and the row survives", async () => {
      const other = await insertCompany({ plan: "pro" });
      const foreign = await insertLegalEntity(other.id);

      await actor("pro");
      const res = await entityDELETE(
        request(`/api/org/entities/${foreign.id}`, "DELETE"),
        ctxFor(foreign.id),
      );
      expect(res.status).toBe(422);
      expect(await storedEntity(foreign.id)).toBeDefined();
    });

    // ─── PATTERN 2 ─────────────────────────────────────────────────────────────
    it("answers the CORS preflight (§0.9)", async () => {
      const res = entitiesOPTIONS(request("/api/org/entities", "OPTIONS"));
      expect(res.status).toBeLessThan(300);
    });
  },
);
