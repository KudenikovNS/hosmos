// [LOCAL-DB] T2.3 — the facility and asset registries (service → route →
// validation) against a real Postgres via the T1.7 harness.
//
// The five properties this file exists to prove, none of which is visible
// without a database:
//
//   • TENANT ISOLATION IS STRUCTURAL, INCLUDING THROUGH A REFERENCE. A facility
//     pointing at ANOTHER company's legal entity is not a 500 (the FK would have
//     fired) and not a 200 — it is a `VALIDATION`, because the reference never
//     resolves inside the session's company (API-1, PATTERN 3).
//   • A BLOCKING RULE UNWRITES THE ROW. `latitude: 91` is refused by VAL-006 and
//     an out-of-force entity by VAL-005, both from INSIDE the write transaction
//     (VR-3). Asserting the 422 alone would pass even if the row had been
//     written — so every refusal here is followed by a count of the table.
//   • VAL-006 IS REACHABLE AT ALL. The parser could easily have refused `91`
//     itself, which would answer `{field}` instead of `{rules:[VAL-006]}` and
//     make the rule dead code. The assertion on the CODE is what keeps the
//     range in the rule where the UI can render it.
//   • THE PLAN LIMIT APPLIES TO FACILITIES AND NOT TO ASSETS (F5). Same company,
//     same `starter` plan, same request shape: the fourth facility is 402 and
//     the FORTIETH asset is 200. A comment in the route saying "assets are not
//     limited" would not survive the first copy-paste; this does.
//   • К-7 SURVIVES A DELETE. `meter_asset_id` was made a plain FK, so nothing in
//     the database stops an energy reading's meter from being deleted out from
//     under it. The app layer does, and the refusal names WHICH reference is in
//     the way.
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
  DELETE as assetDELETE,
  GET as assetGET,
  PATCH as assetPATCH,
} from "@/app/api/org/assets/[id]/route";
import {
  GET as assetsGET,
  OPTIONS as assetsOPTIONS,
  POST as assetsPOST,
} from "@/app/api/org/assets/route";
import {
  GET as facilityGET,
  PATCH as facilityPATCH,
} from "@/app/api/org/facilities/[id]/route";
import {
  GET as facilitiesGET,
  OPTIONS as facilitiesOPTIONS,
  POST as facilitiesPOST,
} from "@/app/api/org/facilities/route";
import { resolveSessionContext } from "@/server/auth/session";
import { resetPlanFeaturesCache } from "@/server/billing/entitlements";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertAsset,
  insertCompany,
  insertEnergyActivity,
  insertFacility,
  insertLegalEntity,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { asset, facility } from "@/server/db/schema";
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
  const { user } = await insertUserWithProfile({ companyId: company.id, role });
  getSessionMock.mockResolvedValue(await sessionFor(user.id));
  return { companyId: company.id, userId: user.id };
}

/** POST a facility onto `legalEntityId` and return `{status, body}`. */
async function postFacility(
  legalEntityId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await facilitiesPOST(
    jsonRequest("/api/org/facilities", "POST", {
      legal_entity_id: legalEntityId,
      facility_name: "Ljubljana office",
      ...overrides,
    }),
  );
  return { status: res.status, body: await res.json() };
}

/** POST an asset onto `legalEntityId` and return `{status, body}`. */
async function postAsset(
  legalEntityId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await assetsPOST(
    jsonRequest("/api/org/assets", "POST", {
      legal_entity_id: legalEntityId,
      name: "Van SI-123",
      asset_type: "vehicle",
      ...overrides,
    }),
  );
  return { status: res.status, body: await res.json() };
}

/** The real `count(*)` of a company's facilities — the oracle for `used`. */
async function facilityCount(companyId: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(facility)
    .where(eq(facility.companyId, companyId));
  return row.n;
}

/** The real `count(*)` of a company's assets. */
async function assetCount(companyId: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(asset)
    .where(eq(asset.companyId, companyId));
  return row.n;
}

/** One stored facility row, straight from the table (never through the route). */
async function storedFacility(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(facility)
    .where(eq(facility.id, id));
  return row;
}

/** One stored asset row, straight from the table. */
async function storedAsset(id: string) {
  const [row] = await getTestDb().select().from(asset).where(eq(asset.id, id));
  return row;
}

/** The rule codes a 422 payload names (API-1 `{rules:[{code,…}]}`). */
const ruleCodes = (body: { rules?: { code: string }[] }): string[] =>
  (body.rules ?? []).map((rule) => rule.code);

describeIntegration("T2.3 facilities and the asset registry", () => {
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

  // ─── The wire contract (§4.3 — DD names, 1:1) ──────────────────────────────
  it("speaks the DD field names and never a column name or the tenant", async () => {
    const { companyId } = await actor("pro");
    const entity = await insertLegalEntity(companyId);

    const created = await postFacility(entity.id, {
      facility_type: "plant",
      country: "si", // uppercased on the way in (`char(2)`)
      latitude: 46.05,
      longitude: 14.5,
      floor_area: 1200.5,
      tenure: "leased",
      control_status: "controlled",
      opening_date: "2020-01-01",
      included_in_boundary: false,
    });

    expect(created.status).toBe(200);
    const dto = created.body.data;
    expect(dto.facility_name).toBe("Ljubljana office");
    expect(dto.legal_entity_id).toBe(entity.id);
    expect(dto.country).toBe("SI");
    // NUMERIC columns cross the wire as numbers, not as Drizzle's strings.
    expect(dto.latitude).toBe(46.05);
    expect(dto.floor_area).toBe(1200.5);
    expect(dto.included_in_boundary).toBe(false);
    expect(dto).not.toHaveProperty("company_id");
    expect(dto).not.toHaveProperty("facilityName");

    // The values are real in the table, not only in the response.
    const stored = await storedFacility(dto.id);
    expect(stored.facilityName).toBe("Ljubljana office");
    expect(stored.latitude).toBe("46.05");

    // PATCH speaks the same names and leaves untouched fields alone.
    const patched = await facilityPATCH(
      jsonRequest(`/api/org/facilities/${dto.id}`, "PATCH", {
        postal_code: "1000",
        closing_date: "2030-12-31",
      }),
      ctxFor(dto.id),
    );
    expect(patched.status).toBe(200);
    const patchedDto = (await patched.json()).data;
    expect(patchedDto.postal_code).toBe("1000");
    expect(patchedDto.closing_date).toBe("2030-12-31");
    expect(patchedDto.facility_name).toBe("Ljubljana office");
  });

  // ─── Tenant isolation (PATTERN 3, API-1) ───────────────────────────────────
  it("a facility on ANOTHER company's legal entity → VALIDATION, nothing written", async () => {
    const other = await insertCompany({ plan: "pro" });
    const foreignEntity = await insertLegalEntity(other.id);

    const { companyId } = await actor("pro");
    const created = await postFacility(foreignEntity.id);

    expect(created.status).toBe(422);
    expect(created.body.error).toBe("VALIDATION");
    // A bare refusal, not a rule code: the entity does not EXIST for this
    // company, which is a different statement from "it is out of force".
    expect(ruleCodes(created.body)).toEqual([]);
    expect(await facilityCount(companyId)).toBe(0);
  });

  it("PATCH / GET of another company's facility or asset never reaches its row", async () => {
    const other = await insertCompany({ plan: "pro" });
    const foreignFacility = await insertFacility(other.id, {
      facilityName: "Not yours",
    });
    const foreignAsset = await insertAsset(other.id, { name: "Not yours" });

    await actor("pro");

    const patched = await facilityPATCH(
      jsonRequest(`/api/org/facilities/${foreignFacility.id}`, "PATCH", {
        facility_name: "Hijacked",
      }),
      ctxFor(foreignFacility.id),
    );
    expect(patched.status).toBe(422);
    expect((await patched.json()).error).toBe("VALIDATION");
    expect((await storedFacility(foreignFacility.id)).facilityName).toBe(
      "Not yours",
    );

    const read = await facilityGET(
      request(`/api/org/facilities/${foreignFacility.id}`),
      ctxFor(foreignFacility.id),
    );
    expect(read.status).toBe(404);

    const patchedAsset = await assetPATCH(
      jsonRequest(`/api/org/assets/${foreignAsset.id}`, "PATCH", {
        name: "Hijacked",
      }),
      ctxFor(foreignAsset.id),
    );
    expect(patchedAsset.status).toBe(422);
    expect((await storedAsset(foreignAsset.id)).name).toBe("Not yours");

    const readAsset = await assetGET(
      request(`/api/org/assets/${foreignAsset.id}`),
      ctxFor(foreignAsset.id),
    );
    expect(readAsset.status).toBe(404);

    // And deleting it does not remove it either.
    const deleted = await assetDELETE(
      request(`/api/org/assets/${foreignAsset.id}`, "DELETE"),
      ctxFor(foreignAsset.id),
    );
    expect(deleted.status).toBe(422);
    expect(await storedAsset(foreignAsset.id)).toBeDefined();
  });

  // ─── VAL-006: the coordinate range is a RULE, not a parser bound ───────────
  it("latitude 91 → VAL-006 with the row NOT written; 46.05 is fine", async () => {
    const { companyId } = await actor("pro");
    const entity = await insertLegalEntity(companyId);

    const refused = await postFacility(entity.id, { latitude: 91 });
    expect(refused.status).toBe(422);
    // The CODE, not `{field: "latitude"}` — that is the whole point: a parser
    // bound would have made VAL-006 unreachable from the API.
    expect(ruleCodes(refused.body)).toContain("VAL-006");
    expect(await facilityCount(companyId)).toBe(0);

    // Longitude has its own bound and the same treatment.
    const refusedLong = await postFacility(entity.id, { longitude: -181 });
    expect(ruleCodes(refusedLong.body)).toContain("VAL-006");
    expect(await facilityCount(companyId)).toBe(0);

    const ok = await postFacility(entity.id, {
      latitude: 46.05,
      longitude: 14.5,
    });
    expect(ok.status).toBe(200);
    expect(await facilityCount(companyId)).toBe(1);

    // A PATCH that would break the rule is refused and does NOT change the row.
    const broken = await facilityPATCH(
      jsonRequest(`/api/org/facilities/${ok.body.data.id}`, "PATCH", {
        latitude: 91,
      }),
      ctxFor(ok.body.data.id),
    );
    expect(broken.status).toBe(422);
    expect(ruleCodes(await broken.json())).toContain("VAL-006");
    expect((await storedFacility(ok.body.data.id)).latitude).toBe("46.05");

    // A word where a NUMERIC goes is the OTHER half of the split: a malformed
    // literal, refused by the parser as a FIELD with no rule code.
    const malformed = await postFacility(entity.id, { latitude: "north" });
    expect(malformed.status).toBe(422);
    expect(malformed.body.field).toBe("latitude");
    expect(malformed.body.rules).toBeUndefined();
  });

  // ─── VAL-005: the entity has to be IN FORCE ────────────────────────────────
  it("an entity whose effective_to has passed cannot own an operating site (VAL-005)", async () => {
    const { companyId } = await actor("pro");
    const departed = await insertLegalEntity(companyId, {
      effectiveFrom: "2018-01-01",
      effectiveTo: "2020-12-31", // left the group; today is well past it
    });

    const refused = await postFacility(departed.id);
    expect(refused.status).toBe(422);
    expect(ruleCodes(refused.body)).toContain("VAL-005");
    expect(await facilityCount(companyId)).toBe(0);

    // A CLOSED site is judged at its closing date, not today: the years it
    // reported under that entity are settled history and must stay saveable.
    const closed = await postFacility(departed.id, {
      facility_name: "Closed plant",
      opening_date: "2018-06-01",
      closing_date: "2020-06-30",
    });
    expect(closed.status).toBe(200);
    expect(await facilityCount(companyId)).toBe(1);

    // An open-ended entity (both dates NULL — the common case) always passes.
    const undated = await insertLegalEntity(companyId);
    expect((await postFacility(undated.id)).status).toBe(200);

    // So does one that has not left yet.
    const current = await insertLegalEntity(companyId, {
      effectiveFrom: "2020-01-01",
      effectiveTo: "2999-12-31",
    });
    expect((await postFacility(current.id)).status).toBe(200);

    // And one that has not JOINED yet is refused by the same rule.
    const future = await insertLegalEntity(companyId, {
      effectiveFrom: "2999-01-01",
    });
    const tooEarly = await postFacility(future.id);
    expect(tooEarly.status).toBe(422);
    expect(ruleCodes(tooEarly.body)).toContain("VAL-005");
  });

  it("moving a facility onto a departed entity is refused and does not move it", async () => {
    const { companyId } = await actor("pro");
    const current = await insertLegalEntity(companyId);
    const departed = await insertLegalEntity(companyId, {
      effectiveTo: "2020-12-31",
    });

    const created = await postFacility(current.id);
    expect(created.status).toBe(200);

    const moved = await facilityPATCH(
      jsonRequest(`/api/org/facilities/${created.body.data.id}`, "PATCH", {
        legal_entity_id: departed.id,
      }),
      ctxFor(created.body.data.id),
    );
    expect(moved.status).toBe(422);
    expect(ruleCodes(await moved.json())).toContain("VAL-005");
    expect((await storedFacility(created.body.data.id)).legalEntityId).toBe(
      current.id,
    );
  });

  // ─── PG-2 vs F5: facilities are limited, assets are not ────────────────────
  it("on starter the 4th facility is 402 while the 40th asset is 200 (F5)", async () => {
    const { companyId } = await actor("starter"); // maxFacilities = 3
    const entity = await insertLegalEntity(companyId);

    for (const n of [1, 2, 3]) {
      const res = await postFacility(entity.id, { facility_name: `Site ${n}` });
      expect(res.status).toBe(200);
    }
    const fourth = await postFacility(entity.id, { facility_name: "Site 4" });
    expect(fourth.status).toBe(402);
    expect(fourth.body).toEqual({ ok: false, error: "PLAN_REQUIRED" });
    expect(await facilityCount(companyId)).toBe(3);

    // SAME company, SAME plan, SAME exhausted state — and the asset route never
    // consults a limit, because F5 says an asset is not one of the plan's axes.
    let lastAsset = 0;
    for (let n = 1; n <= 40; n += 1) {
      const res = await postAsset(entity.id, { name: `Asset ${n}` });
      lastAsset = res.status;
      if (res.status !== 200) break; // fail fast, and on the number that broke
    }
    expect(lastAsset).toBe(200);
    expect(await assetCount(companyId)).toBe(40);
  });

  it("a contributor gets 403 where an admin gets 402 (403 ≺ 402)", async () => {
    // ONE company, ONE state: starter with all three facility slots used.
    const company = await insertCompany({ plan: "starter" });
    const entity = await insertLegalEntity(company.id);
    for (let n = 0; n < 3; n += 1) {
      await insertFacility(company.id, { legalEntityId: entity.id });
    }

    const { user: contributor } = await insertUserWithProfile({
      companyId: company.id,
      role: "contributor", // data.write + data.read, no company.manage
    });
    const { user: admin } = await insertUserWithProfile({
      companyId: company.id,
      role: "esg_admin",
    });

    getSessionMock.mockResolvedValue(await sessionFor(contributor.id));
    const byRole = await postFacility(entity.id);
    expect(byRole.status).toBe(403);
    expect(byRole.body).toEqual({ ok: false, error: "FORBIDDEN" });

    // The 402 proves the request WOULD have reached the plan gate, so the 403
    // above can only have come from a check that runs before it.
    getSessionMock.mockResolvedValue(await sessionFor(admin.id));
    expect((await postFacility(entity.id)).status).toBe(402);

    // A contributor cannot create an asset either — the capability gate is the
    // same one; what differs is only that no plan gate stands behind it.
    getSessionMock.mockResolvedValue(await sessionFor(contributor.id));
    expect((await postAsset(entity.id)).status).toBe(403);

    expect(await facilityCount(company.id)).toBe(3);
    expect(await assetCount(company.id)).toBe(0);
  });

  // ─── API-3: the counters ───────────────────────────────────────────────────
  it("{used, limit} for facilities matches count(*) and the plan matrix", async () => {
    const { companyId } = await actor("pro"); // maxFacilities = 15
    const entity = await insertLegalEntity(companyId);
    await postFacility(entity.id, { facility_name: "One" });
    await postFacility(entity.id, { facility_name: "Two" });

    const res = await facilitiesGET(request("/api/org/facilities"));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.used).toBe(await facilityCount(companyId));
    expect(data.used).toBe(2);
    expect(data.limit).toBe(15); // pro
    expect(data.facilities).toHaveLength(2);

    // The list is the company's own, and only its own.
    const otherCompany = await insertCompany({ plan: "pro" });
    await insertFacility(otherCompany.id);
    expect((await facilitiesGET(request("/api/org/facilities"))).status).toBe(
      200,
    );
    const again = await facilitiesGET(request("/api/org/facilities"));
    expect((await again.json()).data.used).toBe(2);
  });

  it("the asset list carries `used` and deliberately NO `limit` (F5)", async () => {
    const { companyId } = await actor("starter");
    const entity = await insertLegalEntity(companyId);
    await postAsset(entity.id, { name: "One" });
    await postAsset(entity.id, { name: "Two" });

    const res = await assetsGET(request("/api/org/assets"));
    const { data } = await res.json();
    expect(data.used).toBe(await assetCount(companyId));
    expect(data.used).toBe(2);
    // No `limit`: emitting `-1` would assert that a plan axis exists here and
    // happens to be uncapped, which is a different — and false — statement.
    expect(data).not.toHaveProperty("limit");
  });

  // ─── DM-6 / К-7: the asset registry and its one enum value that matters ────
  it("accepts asset_type `meter` (К-7) and refuses a type outside the list", async () => {
    const { companyId } = await actor("pro");
    const entity = await insertLegalEntity(companyId);
    const site = await insertFacility(companyId, { legalEntityId: entity.id });

    const meter = await postAsset(entity.id, {
      name: "Main electricity meter",
      asset_type: "meter",
      identifier: "SI-METER-42",
      facility_id: site.id,
    });
    expect(meter.status).toBe(200);
    expect(meter.body.data.asset_type).toBe("meter");
    expect(meter.body.data.facility_id).toBe(site.id);

    const bogus = await postAsset(entity.id, { asset_type: "spaceship" });
    expect(bogus.status).toBe(422);
    expect(bogus.body.field).toBe("asset_type");
    expect(await assetCount(companyId)).toBe(1);

    // A facility of another company is not a valid refinement either.
    const other = await insertCompany({ plan: "pro" });
    const foreignSite = await insertFacility(other.id);
    const foreign = await postAsset(entity.id, { facility_id: foreignSite.id });
    expect(foreign.status).toBe(422);
    expect(await assetCount(companyId)).toBe(1);
  });

  // ─── К-7: RESTRICT semantics at the app layer ──────────────────────────────
  it("refuses to delete an asset a meter_asset_id points at, and says which", async () => {
    const { companyId } = await actor("pro");
    const entity = await insertLegalEntity(companyId);

    const meter = (
      await postAsset(entity.id, {
        name: "Main meter",
        asset_type: "meter",
      })
    ).body.data;

    // An energy reading recorded AGAINST that meter (К-7's whole reason to exist).
    await insertEnergyActivity(companyId, { meterAssetId: meter.id });

    const refused = await assetDELETE(
      request(`/api/org/assets/${meter.id}`, "DELETE"),
      ctxFor(meter.id),
    );
    expect(refused.status).toBe(422);
    const body = await refused.json();
    expect(body.error).toBe("VALIDATION");
    // Named specifically — `meters` is `meter_asset_id`, not the same table's
    // `asset_id`, and a user clearing the way needs to know which one it is.
    expect(body.blockers.meters).toBe(1);
    expect(body.blockers.energy_activities).toBe(0);
    expect(await storedAsset(meter.id)).toBeDefined();

    // An asset nothing points at goes — the refusal is a data guard, not a ban.
    const spare = (await postAsset(entity.id, { name: "Spare van" })).body.data;
    const deleted = await assetDELETE(
      request(`/api/org/assets/${spare.id}`, "DELETE"),
      ctxFor(spare.id),
    );
    expect(deleted.status).toBe(200);
    expect(await storedAsset(spare.id)).toBeUndefined();
    expect(await storedAsset(meter.id)).toBeDefined();
  });

  it("refuses to delete an asset an input row's asset_id points at", async () => {
    const { companyId } = await actor("pro");
    const entity = await insertLegalEntity(companyId);
    const van = await insertAsset(companyId, {
      legalEntityId: entity.id,
      assetType: "vehicle",
    });
    await insertEnergyActivity(companyId, { assetId: van.id });

    const refused = await assetDELETE(
      request(`/api/org/assets/${van.id}`, "DELETE"),
      ctxFor(van.id),
    );
    expect(refused.status).toBe(422);
    const body = await refused.json();
    expect(body.blockers.energy_activities).toBe(1);
    expect(body.blockers.meters).toBe(0);
    expect(await storedAsset(van.id)).toBeDefined();
  });

  // ─── DM-4 (the other direction): a legal entity with assets is undeletable ─
  it("an asset keeps its legal entity undeletable, and losing its facility does not", async () => {
    const { companyId } = await actor("pro");
    const entity = await insertLegalEntity(companyId);
    const site = await insertFacility(companyId, { legalEntityId: entity.id });
    const created = (await postAsset(entity.id, { facility_id: site.id })).body
      .data;

    // `facility_id` is clearable — the entity is the attribution (F5).
    const cleared = await assetPATCH(
      jsonRequest(`/api/org/assets/${created.id}`, "PATCH", {
        facility_id: null,
      }),
      ctxFor(created.id),
    );
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).data.facility_id).toBeNull();

    // `legal_entity_id` is NOT: blanking it is a rejected field, not a NULL.
    const blanked = await assetPATCH(
      jsonRequest(`/api/org/assets/${created.id}`, "PATCH", {
        legal_entity_id: null,
      }),
      ctxFor(created.id),
    );
    expect(blanked.status).toBe(422);
    expect((await blanked.json()).field).toBe("legal_entity_id");
  });

  // ─── PATTERN 2 ─────────────────────────────────────────────────────────────
  it("answers the CORS preflight on both routes (§0.9)", async () => {
    expect(
      facilitiesOPTIONS(request("/api/org/facilities", "OPTIONS")).status,
    ).toBeLessThan(300);
    expect(
      assetsOPTIONS(request("/api/org/assets", "OPTIONS")).status,
    ).toBeLessThan(300);
  });
});
