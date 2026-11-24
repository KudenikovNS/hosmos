// [LOCAL-DB] T2.8 — the factor library (service → route → validation) against a
// real Postgres via the T1.7 harness, plus the two reference read APIs.
//
// The properties this file exists to prove, none of which is visible without a
// database:
//
//   • A RELEASE IS ONLY EVER A NEW VERSION (DM-21). A PATCH against a factor of
//     the ACTIVE seeded set is refused 422 with an intelligible token
//     (`NEW_VERSION_ONLY`) AND the stored value is re-read to prove nothing
//     moved. So is re-opening the set itself. That refusal is what К-24's pin —
//     and therefore AC-8 — actually rests on.
//   • THE NEW VERSION CARRIES ITS PREDECESSOR FORWARD. `copy_from` produces a
//     DRAFT holding a byte-copy of all 440 factors (every DM-22 column but `id`
//     and `factor_set_id`), the source set is untouched, and the copies do not
//     collide on VAL-031 — the key leads with `factor_set_id`.
//   • VAL-031 IS A 422, NOT A DRIVER 500 (О-18). A duplicate is refused with the
//     rule code, INCLUDING the case the unique index exists for: a factor whose
//     `applicable_year` is NULL. A plain UNIQUE could not have rejected that at
//     all (Postgres counts NULLs as distinct), and the COALESCE(-1) sentinel is
//     asserted twice over — the duplicate is refused, and `-1` itself cannot be
//     stored as a real year.
//   • A ZERO NEEDS A REASON (VAL-033, §0.7, AC-6). `factor_value = 0` with no
//     explicit marker is refused and leaves NOTHING behind; the same factor with
//     `source_locator: "explicit-zero: …"` is accepted; and the two SEEDED zeros
//     (ammonia, bicycle) still pass their own rule, so a copied set stays
//     editable.
//   • THE CAPABILITY SPLIT IS REAL (§12.2). A contributor reads the library
//     (200) and cannot write it (403) — decided by the route, not by the screen.
//   • THE CATALOGUE IS WHOLE (DM-20). 141 metrics, 70 basic + 71 comprehensive,
//     and the conversion table (DM-23) answers a `from_unit` lookup.
//
// WHAT THIS SUITE MUST NOT DO, and the reason it is stated here: the harness
// NEVER truncates the reference tables (`factor_set`, `emission_factor`,
// `metric_catalog`, `unit_conversion`) — they are seeded once and every other
// suite reads them. So every set this file creates carries the `t28-` code
// prefix and is deleted in `afterEach` (the FK is ON DELETE CASCADE, so its
// factors go with it), and `afterAll` asserts the library is back to exactly
// what the seed left: one set, and its factor count unchanged. A leaked draft
// would make `resolveFactorSet` non-deterministic for every period test that
// runs afterwards.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so the DB half
// of this file is a green no-op in a DB-less CI. The i18n parity block below is
// deliberately OUTSIDE it: message files do not need a database.
import { readFileSync } from "node:fs";
import path from "node:path";

import { eq, isNull, like, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
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

import { PATCH as factorPATCH } from "@/app/api/factor-sets/[id]/factors/[factorId]/route";
import {
  GET as factorsGET,
  POST as factorsPOST,
} from "@/app/api/factor-sets/[id]/factors/route";
import {
  GET as setGET,
  PATCH as setPATCH,
} from "@/app/api/factor-sets/[id]/route";
import {
  GET as setsGET,
  OPTIONS as setsOPTIONS,
  POST as setsPOST,
} from "@/app/api/factor-sets/route";
import { GET as metricsGET } from "@/app/api/metrics/route";
import { GET as conversionsGET } from "@/app/api/unit-conversions/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  emissionFactor,
  factorSet,
  unitConversion,
  validationResult,
} from "@/server/db/schema";
import { EXPLICIT_ZERO_ACTIVITY_TYPES } from "@/server/db/seed-data/explicit-zeros";
import { EXPLICIT_ZERO_PREFIX } from "@/server/validation/evaluators/factors";
import type { CompanyRole } from "@/shared/roles";

/** The seeded Phase-1 set (T1.5) — the ACTIVE one every period pins by default. */
const LEGACY_SET_CODE = "legacy-v1";

/** Every set this suite creates wears it, and `afterEach` deletes by it. */
const TEST_CODE_PREFIX = "t28-";

/** A GET request the route handlers accept. */
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
const factorCtx = (id: string, factorId: string) => ({
  params: Promise.resolve({ id, factorId }),
});

/** The session `getSession()` would resolve for a user (PATTERN 3 identity). */
async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

/** A company plus a signed-in member with `role`; installs the session. */
async function actor(
  role: CompanyRole = "esg_admin",
): Promise<{ companyId: string; userId: string }> {
  const company = await insertCompany({ plan: "pro" });
  const { user } = await insertUserWithProfile({ companyId: company.id, role });
  getSessionMock.mockResolvedValue(await sessionFor(user.id));
  return { companyId: company.id, userId: user.id };
}

/** `{status, body}` of any handler call — the shape every assertion reads. */
async function answer(res: Response) {
  return { status: res.status, body: await res.json() };
}

/** The VAL-* codes a refusal named (empty when none owns it). */
const ruleCodes = (body: unknown): string[] =>
  ((body as { rules?: { code: string }[] }).rules ?? []).map((r) => r.code);

/** The named business refusal a 422 carried (`NEW_VERSION_ONLY`, …). */
const refusalOf = (body: unknown): string | undefined =>
  (body as { refusal?: string }).refusal;

/** The seeded set row, straight from the table. */
async function legacySet() {
  const [row] = await getTestDb()
    .select()
    .from(factorSet)
    .where(eq(factorSet.code, LEGACY_SET_CODE));
  return row;
}

/** How many factors a set holds, read directly (never through the route). */
async function factorCount(setId: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(emissionFactor)
    .where(eq(emissionFactor.factorSetId, setId));
  return row.total;
}

/** Every factor of a set, ordered by id so two sets compare element-wise. */
async function factorsOf(setId: string) {
  return getTestDb()
    .select()
    .from(emissionFactor)
    .where(eq(emissionFactor.factorSetId, setId));
}

/** POST a new set (always draft) and return `{status, body}`. */
async function postSet(body: Record<string, unknown>) {
  return answer(await setsPOST(jsonRequest("/api/factor-sets", "POST", body)));
}

/** PATCH a set (release / archive / rename) and return `{status, body}`. */
async function patchSet(id: string, body: Record<string, unknown>) {
  return answer(
    await setPATCH(
      jsonRequest(`/api/factor-sets/${id}`, "PATCH", body),
      ctxFor(id),
    ),
  );
}

/** POST a factor into a set and return `{status, body}`. */
async function postFactor(setId: string, body: Record<string, unknown>) {
  return answer(
    await factorsPOST(
      jsonRequest(`/api/factor-sets/${setId}/factors`, "POST", body),
      ctxFor(setId),
    ),
  );
}

/** PATCH one factor of a set and return `{status, body}`. */
async function patchFactor(
  setId: string,
  factorId: string,
  body: Record<string, unknown>,
) {
  return answer(
    await factorPATCH(
      jsonRequest(
        `/api/factor-sets/${setId}/factors/${factorId}`,
        "PATCH",
        body,
      ),
      factorCtx(setId, factorId),
    ),
  );
}

/** A minimally valid new factor — the eight NOT NULL columns, plus a year. */
function newFactorBody(overrides: Record<string, unknown> = {}) {
  return {
    factor_code: "t28_probe",
    factor_name: "T2.8 probe factor",
    source_name: "custom",
    source_version: "t28 2026",
    activity_type: "t28_probe_activity",
    geography: "GLOBAL",
    input_unit: "kWh",
    factor_value: 0.25,
    applicable_year: 2024,
    ...overrides,
  };
}

/**
 * A DRAFT set of this suite, optionally copied from another. Returns the id.
 * Every code carries {@link TEST_CODE_PREFIX} so `afterEach` can find it again.
 */
async function draftSet(
  suffix: string,
  copyFrom?: string,
): Promise<{ id: string; body: Record<string, unknown> }> {
  const result = await postSet({
    code: `${TEST_CODE_PREFIX}${suffix}`,
    name: `T2.8 ${suffix}`,
    ...(copyFrom ? { copy_from: copyFrom } : {}),
  });
  expect(result.status).toBe(200);
  return { id: result.body.data.id as string, body: result.body.data };
}

// ─── i18n (no database — the message files are files) ─────────────────────────

describe("i18n — the `factors` namespace of T2.8", () => {
  const REPO_ROOT = path.resolve(__dirname, "../../../../..");
  const load = (file: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(path.join(REPO_ROOT, "messages", file), "utf8"),
    ) as Record<string, unknown>;

  /** Every leaf VALUE by dotted key — the same shape `i18n-parity` flattens. */
  const flatten = (node: unknown, prefix = ""): Record<string, string> => {
    if (typeof node === "string") return prefix ? { [prefix]: node } : {};
    if (!node || typeof node !== "object" || Array.isArray(node)) return {};
    return Object.entries(node as Record<string, unknown>).reduce<
      Record<string, string>
    >(
      (acc, [key, value]) =>
        Object.assign(acc, flatten(value, prefix ? `${prefix}.${key}` : key)),
      {},
    );
  };

  const en = flatten(load("en.json"));
  const sl = flatten(load("sl.json"));
  const keys = Object.keys(en).filter((key) => key.startsWith("factors."));

  it("exists in both locales with the same keys", () => {
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.filter((key) => !(key in sl))).toEqual([]);
    expect(
      Object.keys(sl)
        .filter((key) => key.startsWith("factors."))
        .filter((key) => !(key in en)),
    ).toEqual([]);
  });

  it("names the DM-21 refusal in both locales", () => {
    expect(en["factors.refusals.NEW_VERSION_ONLY"]).toBeTruthy();
    expect(sl["factors.refusals.NEW_VERSION_ONLY"]).toBeTruthy();
  });

  it("has no Slovenian value copied verbatim from the English one", () => {
    expect(keys.filter((key) => en[key] === sl[key])).toEqual([]);
  });

  it("has the nav label of /admin/factors in both locales", () => {
    expect(en["nav.factors"]).toBeTruthy();
    expect(sl["nav.factors"]).toBeTruthy();
    expect(en["nav.factors"]).not.toBe(sl["nav.factors"]);
  });
});

// ─── The library itself ──────────────────────────────────────────────────────

describeIntegration("factor sets — API and lifecycle (T2.8)", () => {
  /** What the seed left behind, captured once so `afterAll` can compare. */
  let seededSetCount = 0;
  let seededFactorCount = 0;
  let legacyId = "";

  beforeAll(async () => {
    await setupSchema();
    const [counted] = await getTestDb()
      .select({ total: sql<number>`count(*)::int` })
      .from(factorSet);
    seededSetCount = counted.total;
    const legacy = await legacySet();
    legacyId = legacy.id;
    seededFactorCount = await factorCount(legacyId);
  });

  beforeEach(async () => {
    await resetAppTables();
    getSessionMock.mockReset();
  });

  // The reference tables are NEVER truncated by the harness (see the header) —
  // so this suite cleans up after itself, or every later period test would see
  // extra sets.
  afterEach(async () => {
    await getTestDb()
      .delete(factorSet)
      .where(like(factorSet.code, `${TEST_CODE_PREFIX}%`));
  });

  afterAll(async () => {
    const [counted] = await getTestDb()
      .select({ total: sql<number>`count(*)::int` })
      .from(factorSet);
    expect(counted.total).toBe(seededSetCount);
    expect(await factorCount(legacyId)).toBe(seededFactorCount);
    await closeTestDb();
  });

  describe("the seeded library", () => {
    it("lists `legacy-v1` as the released set, with its factor count", async () => {
      await actor();
      const { status, body } = await answer(
        await setsGET(request("/api/factor-sets")),
      );
      expect(status).toBe(200);
      const sets = body.data.factor_sets as {
        code: string;
        status: string;
        factor_count: number;
        editable: boolean;
      }[];
      const legacy = sets.find((set) => set.code === LEGACY_SET_CODE);
      expect(legacy).toBeDefined();
      expect(legacy?.status).toBe("active");
      expect(legacy?.editable).toBe(false);
      expect(legacy?.factor_count).toBe(seededFactorCount);
      expect(seededFactorCount).toBeGreaterThan(400);
    });

    it("answers the OPTIONS preflight (PATTERN 2)", async () => {
      const res = setsOPTIONS(request("/api/factor-sets", "OPTIONS"));
      expect(res.status).toBeLessThan(300);
    });

    it("reports the set's sources and licences (UI-4)", async () => {
      await actor();
      const { status, body } = await answer(
        await setGET(request(`/api/factor-sets/${legacyId}`), ctxFor(legacyId)),
      );
      expect(status).toBe(200);
      const provenance = body.data.provenance as {
        source_name: string;
        licence: string | null;
        factors: number;
      }[];
      expect(provenance.length).toBeGreaterThan(0);
      // Every factor is accounted for by exactly one provenance group.
      expect(provenance.reduce((sum, row) => sum + row.factors, 0)).toBe(
        seededFactorCount,
      );
      // MIG-4 says the missing licence is stated, not left blank.
      expect(provenance.every((row) => row.licence !== null)).toBe(true);
    });

    it("pages the factor list rather than shipping 440 rows", async () => {
      await actor();
      const { status, body } = await answer(
        await factorsGET(
          request(`/api/factor-sets/${legacyId}/factors?limit=10&offset=0`),
          ctxFor(legacyId),
        ),
      );
      expect(status).toBe(200);
      expect(body.data.factors).toHaveLength(10);
      expect(body.data.total).toBe(seededFactorCount);
    });
  });

  describe("a released set is closed (DM-21)", () => {
    it("refuses a PATCH of one of its factors, with an intelligible code", async () => {
      await actor();
      const [factor] = await factorsOf(legacyId);
      const { status, body } = await patchFactor(legacyId, factor.id, {
        factor_value: 999,
      });

      expect(status).toBe(422);
      expect(body.error).toBe("VALIDATION");
      expect(refusalOf(body)).toBe("NEW_VERSION_ONLY");
      expect(body.factor_set).toMatchObject({
        code: LEGACY_SET_CODE,
        status: "active",
      });
      // No VAL-* code owns this refusal — the payload says so explicitly.
      expect(ruleCodes(body)).toEqual([]);

      // And the number did not move, which is the whole point (К-24 / AC-8).
      const [after] = await getTestDb()
        .select()
        .from(emissionFactor)
        .where(eq(emissionFactor.id, factor.id));
      expect(after.factorValue).toBe(factor.factorValue);
    });

    it("refuses a POST of a new factor into it", async () => {
      await actor();
      const { status, body } = await postFactor(legacyId, newFactorBody());
      expect(status).toBe(422);
      expect(refusalOf(body)).toBe("NEW_VERSION_ONLY");
      expect(await factorCount(legacyId)).toBe(seededFactorCount);
    });

    it("refuses re-opening the set itself (`active → draft`)", async () => {
      await actor();
      const { status, body } = await patchSet(legacyId, { status: "draft" });
      expect(status).toBe(422);
      expect(refusalOf(body)).toBe("NEW_VERSION_ONLY");
      expect((await legacySet()).status).toBe("active");
    });

    it("refuses renaming it", async () => {
      await actor();
      const { status, body } = await patchSet(legacyId, { name: "Renamed" });
      expect(status).toBe(422);
      expect(refusalOf(body)).toBe("NEW_VERSION_ONLY");
      expect((await legacySet()).name).not.toBe("Renamed");
    });
  });

  describe("a new version carries its predecessor forward", () => {
    it("accepts tCO2e and refuses unsupported output units without changing a factor", async () => {
      await actor();
      const set = await draftSet("output-units");
      const created = await postFactor(
        set.id,
        newFactorBody({ factor_value: 1, output_unit: "tCO2e" }),
      );
      expect(created.status).toBe(200);
      expect(created.body.data).toMatchObject({
        factor_value: 1,
        output_unit: "tCO2e",
      });
      const id = created.body.data.id as string;
      for (const unit of [
        "",
        "kg",
        "gCO2e",
        "unknown",
        "kWh",
        "tCO2e/kWh",
        null,
      ]) {
        const rejected = await postFactor(
          set.id,
          newFactorBody({ output_unit: unit, factor_code: "bad" }),
        );
        expect(rejected.status).toBe(422);
        expect(rejected.body.field).toBe("output_unit");
        const patch = await patchFactor(set.id, id, { output_unit: unit });
        expect(patch.status).toBe(422);
        expect(patch.body.field).toBe("output_unit");
      }
      expect(await factorsOf(set.id)).toMatchObject([
        { id, outputUnit: "tCO2e", factorValue: "1" },
      ]);
      expect(
        (await patchFactor(set.id, id, { output_unit: "kgCO2e" })).status,
      ).toBe(200);
    });

    it("reserves kWh output for the EV energy intensity, including partial patches", async () => {
      await actor();
      const set = await draftSet("energy-output");
      const created = await postFactor(
        set.id,
        newFactorBody({
          activity_type: "car_bev_kwh_per_km",
          input_unit: "km",
          output_unit: "kWh",
        }),
      );
      expect(created.status).toBe(200);
      const id = created.body.data.id as string;
      for (const patch of [
        { activity_type: "natural_gas" },
        { input_unit: "kWh" },
      ]) {
        const refused = await patchFactor(set.id, id, patch);
        expect(refused.status).toBe(422);
        expect(refused.body.field).toBe("output_unit");
      }
      expect(await factorsOf(set.id)).toMatchObject([
        {
          id,
          activityType: "car_bev_kwh_per_km",
          inputUnit: "km",
          outputUnit: "kWh",
        },
      ]);
      expect(
        (
          await patchFactor(set.id, id, {
            activity_type: "natural_gas",
            input_unit: "kWh",
            output_unit: "kgCO2e",
          })
        ).status,
      ).toBe(200);
    });

    it("copies r5's scoped conversions with fresh IDs and preserves shared rows", async () => {
      await actor();
      const [source] = await getTestDb()
        .select()
        .from(factorSet)
        .where(eq(factorSet.code, "si-2025-r5"));
      if (!source) throw new Error("r5 is not seeded");
      const original = await getTestDb()
        .select()
        .from(unitConversion)
        .where(eq(unitConversion.factorSetId, source.id))
        .orderBy(unitConversion.id);
      const shared = await getTestDb()
        .select()
        .from(unitConversion)
        .where(isNull(unitConversion.factorSetId))
        .orderBy(unitConversion.id);
      expect(original).toHaveLength(10);
      const created = await draftSet("r5-conversions", source.id);
      const copied = await getTestDb()
        .select()
        .from(unitConversion)
        .where(eq(unitConversion.factorSetId, created.id));
      const contents = (rows: typeof original) =>
        rows
          .map(({ id: _id, factorSetId: _set, ...rest }) => rest)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      expect(contents(copied)).toEqual(contents(original));
      const originalIds = new Set(original.map((row) => row.id));
      expect(copied.every((row) => !originalIds.has(row.id))).toBe(true);
      expect(new Set(copied.map((row) => row.id)).size).toBe(original.length);
      expect(
        await getTestDb()
          .select()
          .from(unitConversion)
          .where(eq(unitConversion.factorSetId, source.id))
          .orderBy(unitConversion.id),
      ).toEqual(original);
      expect(
        await getTestDb()
          .select()
          .from(unitConversion)
          .where(isNull(unitConversion.factorSetId))
          .orderBy(unitConversion.id),
      ).toEqual(shared);
    });

    it("copies every factor, leaves the source untouched, and starts as a draft", async () => {
      await actor();
      const created = await draftSet("copy", legacyId);

      expect(created.body.status).toBe("draft");
      expect(created.body.editable).toBe(true);
      expect(created.body.published_at).toBeNull();
      expect(created.body.factor_count).toBe(seededFactorCount);

      // The source is exactly as it was.
      expect(await factorCount(legacyId)).toBe(seededFactorCount);

      // Every DM-22 column is carried over; only `id` and `factor_set_id` differ.
      const source = await factorsOf(legacyId);
      const copy = await factorsOf(created.id);
      const key = (row: (typeof source)[number]) =>
        [
          row.factorCode,
          row.sourceName,
          row.sourceVersion,
          row.activityType,
          row.geography,
          row.inputUnit,
          row.applicableYear ?? "any",
        ].join("|");
      const strip = (row: (typeof source)[number]) => {
        const { id: _id, factorSetId: _setId, ...rest } = row;
        return rest;
      };
      const sourceByKey = new Map(source.map((row) => [key(row), strip(row)]));
      expect(copy).toHaveLength(source.length);
      for (const row of copy) {
        expect(sourceByKey.get(key(row))).toEqual(strip(row));
      }
    });

    it("accepts an empty new set with no `copy_from`", async () => {
      await actor();
      const created = await draftSet("empty");
      expect(created.body.factor_count).toBe(0);
    });

    it("refuses a duplicate set code by field, not by driver error", async () => {
      await actor();
      await draftSet("dupe");
      const second = await postSet({
        code: `${TEST_CODE_PREFIX}dupe`,
        name: "Another",
      });
      expect(second.status).toBe(422);
      expect(refusalOf(second.body)).toBe("CODE_TAKEN");
      expect(second.body.field).toBe("code");
    });

    it("refuses copying from a set that does not exist", async () => {
      await actor();
      const result = await postSet({
        code: `${TEST_CODE_PREFIX}nosource`,
        name: "No source",
        copy_from: "00000000-0000-0000-0000-000000000001",
      });
      expect(result.status).toBe(422);
      expect(refusalOf(result.body)).toBe("COPY_SOURCE_UNKNOWN");
    });

    it("releases the draft, stamps `published_at`, and then freezes it", async () => {
      await actor();
      const created = await draftSet("release");
      const posted = await postFactor(created.id, newFactorBody());
      expect(posted.status).toBe(200);
      const factorId = posted.body.data.id as string;

      // A draft's factor IS editable — the other half of DM-21.
      const edited = await patchFactor(created.id, factorId, {
        factor_value: 0.5,
      });
      expect(edited.status).toBe(200);
      expect(edited.body.data.factor_value).toBe(0.5);

      const released = await patchSet(created.id, { status: "active" });
      expect(released.status).toBe(200);
      expect(released.body.data.status).toBe("active");
      expect(released.body.data.published_at).not.toBeNull();
      expect(released.body.data.editable).toBe(false);

      const refused = await patchFactor(created.id, factorId, {
        factor_value: 0.9,
      });
      expect(refused.status).toBe(422);
      expect(refusalOf(refused.body)).toBe("NEW_VERSION_ONLY");
    });
  });

  describe("VAL-031 — the resolution key (О-18)", () => {
    it("refuses a duplicate with the rule code, not a 500", async () => {
      await actor();
      const created = await draftSet("val031");
      const first = await postFactor(created.id, newFactorBody());
      expect(first.status).toBe(200);

      // Same (source, version, activity, geography, unit, year); everything the
      // key does NOT contain is deliberately different, so a pass here would
      // mean the key was widened rather than that the row is a duplicate.
      const second = await postFactor(
        created.id,
        newFactorBody({
          factor_code: "t28_probe_other",
          factor_name: "Another name",
          factor_value: 9.9,
        }),
      );
      expect(second.status).toBe(422);
      expect(ruleCodes(second.body)).toContain("VAL-031");
      expect(await factorCount(created.id)).toBe(1);
    });

    it("refuses a duplicate whose `applicable_year` is NULL — the COALESCE case", async () => {
      await actor();
      const created = await draftSet("val031null");
      // No `applicable_year` at all: this is the row a plain UNIQUE could not
      // have rejected, because Postgres counts NULLs as DISTINCT.
      const body = newFactorBody({ applicable_year: null });
      expect((await postFactor(created.id, body)).status).toBe(200);

      const second = await postFactor(created.id, {
        ...body,
        factor_code: "t28_probe_other",
      });
      expect(second.status).toBe(422);
      expect(ruleCodes(second.body)).toContain("VAL-031");
      expect(await factorCount(created.id)).toBe(1);
    });

    it("separates two SUPPLIERS on the key rather than calling them duplicates (0007)", async () => {
      await actor();
      const created = await draftSet("val031supplier");
      const body = newFactorBody({
        source_name: "supplier",
        supplier_name: "Elektro Ljubljana",
      });
      expect((await postFactor(created.id, body)).status).toBe(200);

      // Same everything except WHOSE factor it is. These are not duplicates —
      // they are two sellers' own numbers for the same product — and CALC-2
      // now tells them apart, so the key must too.
      const rival = await postFactor(created.id, {
        ...body,
        factor_code: "t28_probe_rival",
        supplier_name: "Zelena Energija d.o.o.",
        factor_value: 0.1,
      });
      expect(rival.status).toBe(200);
      expect(rival.body.data.supplier_name).toBe("Zelena Energija d.o.o.");
      expect(await factorCount(created.id)).toBe(2);

      // …and the SAME supplier twice is still a duplicate.
      const twin = await postFactor(created.id, {
        ...body,
        factor_code: "t28_probe_twin",
      });
      expect(twin.status).toBe(422);
      expect(ruleCodes(twin.body)).toContain("VAL-031");
    });

    it("refuses a supplier-sourced factor that names no supplier, by field (0007)", async () => {
      await actor();
      const created = await draftSet("val031unnamed");
      // The CHECK would answer a driver error (500) for a mistake that has a
      // name; the service refuses it first, exactly as it does `CODE_TAKEN`.
      const refused = await postFactor(
        created.id,
        newFactorBody({ source_name: "supplier" }),
      );
      expect(refused.status).toBe(422);
      expect(refusalOf(refused.body)).toBe("SUPPLIER_NAME_REQUIRED");
      expect(await factorCount(created.id)).toBe(0);
    });

    it("lets the same key live in two different sets", async () => {
      await actor();
      const a = await draftSet("val031a");
      const b = await draftSet("val031b");
      expect((await postFactor(a.id, newFactorBody())).status).toBe(200);
      expect((await postFactor(b.id, newFactorBody())).status).toBe(200);
    });

    it("refuses an edit that would move a factor onto another's key", async () => {
      await actor();
      const created = await draftSet("val031patch");
      const first = await postFactor(created.id, newFactorBody());
      const second = await postFactor(
        created.id,
        newFactorBody({ applicable_year: 2023, factor_code: "t28_2023" }),
      );
      expect(second.status).toBe(200);

      // The PATCH names only the year — the rest of the key comes from the row.
      const moved = await patchFactor(
        created.id,
        second.body.data.id as string,
        { applicable_year: 2024 },
      );
      expect(moved.status).toBe(422);
      expect(ruleCodes(moved.body)).toContain("VAL-031");

      // An edit that does NOT touch the key is not a self-collision.
      const renamed = await patchFactor(
        created.id,
        first.body.data.id as string,
        { factor_name: "Renamed probe" },
      );
      expect(renamed.status).toBe(200);
    });
  });

  describe("VAL-032 — the validity of a factor", () => {
    it("refuses an inverted validity window", async () => {
      await actor();
      const created = await draftSet("val032dates");
      const { status, body } = await postFactor(
        created.id,
        newFactorBody({ valid_from: "2024-12-31", valid_to: "2024-01-01" }),
      );
      expect(status).toBe(422);
      expect(ruleCodes(body)).toContain("VAL-032");
      expect(await factorCount(created.id)).toBe(0);
    });

    it("refuses the resolution-key sentinel as a real year", async () => {
      await actor();
      const created = await draftSet("val032sentinel");
      const { status, body } = await postFactor(
        created.id,
        newFactorBody({ applicable_year: -1 }),
      );
      expect(status).toBe(422);
      expect(ruleCodes(body)).toContain("VAL-032");
    });

    it("refuses a year that cannot be a year", async () => {
      await actor();
      const created = await draftSet("val032year");
      const far = new Date().getUTCFullYear() + 50;
      expect(
        ruleCodes(
          (
            await postFactor(
              created.id,
              newFactorBody({ applicable_year: far }),
            )
          ).body,
        ),
      ).toContain("VAL-032");
    });

    it("refuses a year outside the validity window it declares", async () => {
      await actor();
      const created = await draftSet("val032window");
      const { status, body } = await postFactor(
        created.id,
        newFactorBody({
          applicable_year: 2023,
          valid_from: "2024-01-01",
          valid_to: "2024-12-31",
        }),
      );
      expect(status).toBe(422);
      expect(ruleCodes(body)).toContain("VAL-032");
    });

    it("accepts an open-ended window", async () => {
      await actor();
      const created = await draftSet("val032open");
      expect(
        (
          await postFactor(
            created.id,
            newFactorBody({ valid_from: "2024-01-01", valid_to: null }),
          )
        ).status,
      ).toBe(200);
    });
  });

  describe("VAL-033 — a zero needs a reason (§0.7, AC-6)", () => {
    it("refuses `factor_value = 0` with no explicit marker, and stores nothing", async () => {
      await actor();
      const created = await draftSet("val033");
      const { status, body } = await postFactor(
        created.id,
        newFactorBody({ factor_value: 0 }),
      );
      expect(status).toBe(422);
      expect(ruleCodes(body)).toContain("VAL-033");
      expect(await factorCount(created.id)).toBe(0);
    });

    it("accepts a zero whose `source_locator` states why", async () => {
      await actor();
      const created = await draftSet("val033ok");
      const { status } = await postFactor(
        created.id,
        newFactorBody({
          factor_value: 0,
          source_locator: `${EXPLICIT_ZERO_PREFIX} NH3 has no GWP (IPCC AR5)`,
        }),
      );
      expect(status).toBe(200);
      expect(await factorCount(created.id)).toBe(1);
    });

    it("refuses the marker with nothing after it", async () => {
      await actor();
      const created = await draftSet("val033blank");
      const { status, body } = await postFactor(
        created.id,
        newFactorBody({
          factor_value: 0,
          source_locator: EXPLICIT_ZERO_PREFIX,
        }),
      );
      expect(status).toBe(422);
      expect(ruleCodes(body)).toContain("VAL-033");
    });

    it("keeps the SEEDED legitimate zeros editable in a copied set", async () => {
      await actor();
      const created = await draftSet("val033seed", legacyId);
      const copies = await factorsOf(created.id);
      const zeros = copies.filter(
        (row) =>
          Number(row.factorValue) === 0 &&
          EXPLICIT_ZERO_ACTIVITY_TYPES.includes(row.activityType),
      );
      expect(zeros.length).toBeGreaterThan(0);

      // Editing an exempt zero must not be refused by the rule that exists to
      // catch a MISSING factor written as zero.
      const edited = await patchFactor(created.id, zeros[0].id, {
        factor_name: "Ammonia (edited)",
      });
      expect(edited.status).toBe(200);
    });
  });

  describe("what a successful write records", () => {
    it("stores a passing result per factor rule, owned by the session company", async () => {
      const { companyId } = await actor();
      const created = await draftSet("results");
      const posted = await postFactor(created.id, newFactorBody());
      expect(posted.status).toBe(200);

      const stored = await getTestDb()
        .select()
        .from(validationResult)
        .where(eq(validationResult.objectId, posted.body.data.id as string));
      const codes = stored.map((row) => row.ruleCode).sort();
      expect(codes).toEqual(["VAL-031", "VAL-032", "VAL-033"]);
      expect(stored.every((row) => row.passed)).toBe(true);
      expect(stored.every((row) => row.companyId === companyId)).toBe(true);
      expect(stored.every((row) => row.objectType === "emission_factor")).toBe(
        true,
      );
      expect(stored.every((row) => row.scope === "reference_org")).toBe(true);
    });

    it("leaves no result behind when the write was refused (VR-3)", async () => {
      await actor();
      const created = await draftSet("norows");
      expect(
        (await postFactor(created.id, newFactorBody({ factor_value: 0 })))
          .status,
      ).toBe(422);
      const stored = await getTestDb().select().from(validationResult);
      expect(stored).toHaveLength(0);
    });
  });

  describe("the capability split (§12.2)", () => {
    it("lets a contributor read the library and refuses the write", async () => {
      await actor("contributor");

      const read = await answer(await setsGET(request("/api/factor-sets")));
      expect(read.status).toBe(200);

      const written = await postSet({
        code: `${TEST_CODE_PREFIX}forbidden`,
        name: "Nope",
      });
      expect(written.status).toBe(403);
      expect(written.body.error).toBe("FORBIDDEN");

      const [factor] = await factorsOf(legacyId);
      const patched = await patchFactor(legacyId, factor.id, {
        factor_value: 1,
      });
      // 403 BEFORE the DM-21 refusal — the guard order of §0.2.
      expect(patched.status).toBe(403);
    });

    it("refuses an unauthenticated read", async () => {
      getSessionMock.mockResolvedValue(null);
      const { status } = await answer(
        await setsGET(request("/api/factor-sets")),
      );
      expect(status).toBe(401);
    });
  });

  describe("the reference catalogues (DM-20, DM-23)", () => {
    it("returns 141 metrics, 70 basic and 71 comprehensive", async () => {
      await actor();
      const all = await answer(await metricsGET(request("/api/metrics")));
      expect(all.status).toBe(200);
      expect(all.body.data.total).toBe(141);

      const basic = await answer(
        await metricsGET(request("/api/metrics?module=basic")),
      );
      expect(basic.body.data.metrics).toHaveLength(70);

      const comprehensive = await answer(
        await metricsGET(request("/api/metrics?module=comprehensive")),
      );
      expect(comprehensive.body.data.metrics).toHaveLength(71);
    });

    it("filters by pillar and answers an unknown filter with an empty list", async () => {
      await actor();
      const environmental = await answer(
        await metricsGET(request("/api/metrics?pillar=environmental")),
      );
      expect(environmental.body.data.total).toBeGreaterThan(0);
      expect(
        (environmental.body.data.metrics as { pillar: string }[]).every(
          (row) => row.pillar === "environmental",
        ),
      ).toBe(true);

      const nonsense = await answer(
        await metricsGET(request("/api/metrics?module=nope")),
      );
      expect(nonsense.status).toBe(200);
      expect(nonsense.body.data.total).toBe(0);
    });

    it("returns the unit conversions and narrows them by `from_unit`", async () => {
      await actor();
      const all = await answer(
        await conversionsGET(request("/api/unit-conversions")),
      );
      expect(all.status).toBe(200);
      expect(all.body.data.total).toBeGreaterThan(0);

      const kwh = await answer(
        await conversionsGET(request("/api/unit-conversions?from_unit=kWh")),
      );
      expect(
        (kwh.body.data.conversions as { from_unit: string }[]).every(
          (row) => row.from_unit === "kWh",
        ),
      ).toBe(true);
    });

    it("refuses both catalogues without a session", async () => {
      getSessionMock.mockResolvedValue(null);
      expect(
        (await answer(await metricsGET(request("/api/metrics")))).status,
      ).toBe(401);
      expect(
        (await answer(await conversionsGET(request("/api/unit-conversions"))))
          .status,
      ).toBe(401);
    });
  });
});
