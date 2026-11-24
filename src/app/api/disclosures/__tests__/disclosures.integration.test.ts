// [LOCAL-DB] T3.3 — DISCLOSURE RECORDS (DM-18, DM-19, §4.12, S1) and the
// Comprehensive module gate (PG-6, AC-14), over the SAME append-only service
// T3.1 built, against a real Postgres via the T1.7 harness.
//
// The properties this file exists to prove:
//
//   • THE TYPED VALUE IS DECIDED BY THE CATALOGUE, NOT BY THE CLIENT. Every
//     `DataType` in the seeded 141 is posted through the API and lands in the
//     column DM-19 assigns it; the same value posted through any OTHER value
//     field is refused. `value_type` itself is never accepted from a body — a
//     request that spells it out gets the catalogue's answer stored anyway.
//   • EXACTLY ONE VALUE FIELD IS NON-EMPTY, AND "EMPTY" MEANS NULL. Two filled
//     fields are refused, none is refused — and `false`, `0` and a genuine zero
//     percentage are ACCEPTED, because a falsy answer is an answer. An empty
//     string is not: it clears the field, and the row is then refused for having
//     no value.
//   • DM-19 SURVIVES A PATCH. The rule is about the ROW, so a delta is judged
//     against the version it supersedes: filling a second field in a second
//     request fails exactly like filling two in one.
//   • A METRIC WITH `breakdown_dimensions` LIVES WHOLLY IN `value_json` (S1).
//     The same figure offered through `value_numeric` is refused; inside the
//     json, the total, the declared dimensions and the parts are checked, and a
//     missing split is allowed because the workbook asks for it "if obtainable".
//   • PG-6 IS ORTHOGONAL TO THE LIMITS (AC-14). On `starter` with ONE legal
//     entity and ONE facility — inside every limit that plan has, as the test
//     asserts by counting them — a `comprehensive` metric is refused 422
//     `VALIDATION`, while a `basic` metric of the same shape, same company, same
//     request goes through. On `pro` the same comprehensive body is accepted.
//     The refusal is never 402: a module is not a quota.
//   • THE FOURTH TABLE GETS THE WHOLE PROTOCOL. Draft → version → approve →
//     tombstone → history, with no line of `rows.ts` changed.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so this file is
// a green no-op in a DB-less CI.
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  beforeAll,
  beforeEach,
  afterAll,
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
  DELETE as disclosureDELETE,
  GET as disclosureGET,
  PATCH as disclosurePATCH,
} from "@/app/api/disclosures/[id]/route";
import { POST as approvePOST } from "@/app/api/disclosures/[id]/approve/route";
import { GET as historyGET } from "@/app/api/disclosures/[id]/history/route";
import {
  GET as listGET,
  OPTIONS as listOPTIONS,
  POST as listPOST,
} from "@/app/api/disclosures/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertFacility,
  insertLegalEntity,
  insertPaidCompany,
  insertPeriod,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  companies,
  disclosureRecord,
  facility,
  legalEntity,
  metricCatalog,
} from "@/server/db/schema";
import { VALUE_FIELD_BY_TYPE } from "@/server/inventory/disclosures";
import { DATA_TYPES, type DataType } from "@/shared/enums";

// ─── Request plumbing (same shape as the T3.1/T3.2 suites) ───────────────────

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
 * One company on `plan`, one `esg_admin`, EXACTLY ONE legal entity and EXACTLY
 * ONE facility — which is what makes the AC-14 assertion below meaningful:
 * `starter` allows one entity and three facilities, so this graph is inside
 * every limit the plan has and the module refusal cannot be a limit refusal.
 */
async function setup(plan = "starter"): Promise<Fixture> {
  const company =
    plan === "starter"
      ? await insertPaidCompany()
      : await insertCompany({ plan });
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

// ─── Metric fixtures, read out of the seeded catalogue ───────────────────────
//
// Resolved by QUERY rather than written as `VSME-005` literals: the subject of
// these tests is "what the catalogue says about a metric", so a suite that
// hard-coded the keys would keep passing after the catalogue moved underneath
// it — and the one thing it must notice is exactly that.

/**
 * The first metric matching `value_type` + `module`, with/without a breakdown.
 *
 * `module` defaults to `basic` so that a test about DM-19 cannot accidentally
 * pick a Comprehensive metric and start measuring PG-6 instead.
 */
async function metricKey(opts: {
  valueType: DataType;
  module?: "basic" | "comprehensive" | "simplified_esrs";
  breakdown?: boolean;
}): Promise<string> {
  const wanted = opts.module ?? "basic";
  const [row] = await getTestDb()
    .select({ key: metricCatalog.metricKey })
    .from(metricCatalog)
    .where(
      and(
        eq(metricCatalog.valueType, opts.valueType),
        eq(metricCatalog.module, wanted),
        opts.breakdown === undefined
          ? undefined
          : opts.breakdown
            ? isNotNull(metricCatalog.breakdownDimensions)
            : isNull(metricCatalog.breakdownDimensions),
      ),
    )
    .orderBy(asc(metricCatalog.sortOrder))
    .limit(1);
  if (!row) {
    throw new Error(
      `metric_catalog holds no ${wanted} ${opts.valueType} metric` +
        (opts.breakdown === undefined
          ? ""
          : ` with breakdown=${opts.breakdown}`),
    );
  }
  return row.key;
}

/**
 * Move a company onto another plan and refresh the signed-in session, which is
 * where `getEntitlements` reads the plan from when there is no subscription row.
 */
async function downgrade(fx: Fixture, plan: string): Promise<void> {
  await getTestDb()
    .update(companies)
    .set({ plan })
    .where(eq(companies.id, fx.companyId));
  await signIn(fx.userId);
}

/** The dimensions a breakdown metric declares (S1). */
async function dimensionsOf(key: string): Promise<string[]> {
  const [row] = await getTestDb()
    .select({ breakdown: metricCatalog.breakdownDimensions })
    .from(metricCatalog)
    .where(eq(metricCatalog.metricKey, key));
  const spec = row?.breakdown as { dimensions?: string[] } | null;
  return spec?.dimensions ?? [];
}

/** A minimal disclosure body: placement plus whatever value the caller sends. */
function body(fx: Fixture, overrides: Record<string, unknown>) {
  return {
    revision_id: fx.revisionId,
    legal_entity_id: fx.legalEntityId,
    year_month: "2024-01",
    ...overrides,
  };
}

// ─── Route callers ───────────────────────────────────────────────────────────

async function post(input: unknown) {
  const res = await listPOST(jsonRequest("/api/disclosures", "POST", input));
  return { status: res.status, body: await res.json() };
}

async function list(query = "") {
  const res = await listGET(request(`/api/disclosures${query}`));
  return { status: res.status, body: await res.json() };
}

async function patch(id: string, input: unknown) {
  const res = await disclosurePATCH(
    jsonRequest(`/api/disclosures/${id}`, "PATCH", input),
    ctxFor(id),
  );
  return { status: res.status, body: await res.json() };
}

async function remove(id: string, input?: unknown) {
  const res = await disclosureDELETE(
    jsonRequest(`/api/disclosures/${id}`, "DELETE", input),
    ctxFor(id),
  );
  return { status: res.status, body: await res.json() };
}

async function read(id: string) {
  const res = await disclosureGET(
    request(`/api/disclosures/${id}`),
    ctxFor(id),
  );
  return { status: res.status, body: await res.json() };
}

async function approve(id: string) {
  const res = await approvePOST(
    jsonRequest(`/api/disclosures/${id}/approve`, "POST"),
    ctxFor(id),
  );
  return { status: res.status, body: await res.json() };
}

async function history(id: string) {
  const res = await historyGET(
    request(`/api/disclosures/${id}/history`),
    ctxFor(id),
  );
  return { status: res.status, body: await res.json() };
}

/** The stored row — the five value columns are only visible from here. */
async function storedRow(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(disclosureRecord)
    .where(eq(disclosureRecord.id, id));
  return row;
}

// ─── DM-19 is a claim about the whole DataType list ──────────────────────────

describe("DM-19 — the 12 DataTypes fan onto five value columns", () => {
  it("maps every DataType to exactly one value column", () => {
    for (const type of DATA_TYPES) {
      expect(VALUE_FIELD_BY_TYPE[type], type).toBeDefined();
    }
    expect(Object.keys(VALUE_FIELD_BY_TYPE).sort()).toEqual(
      [...DATA_TYPES].sort(),
    );
    expect(new Set(Object.values(VALUE_FIELD_BY_TYPE))).toEqual(
      new Set([
        "value_numeric",
        "value_text",
        "value_boolean",
        "value_date",
        "value_json",
      ]),
    );
  });
});

describeIntegration("disclosure records (T3.3) [LOCAL-DB]", () => {
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

  // ─── The protocol, on the fourth table ────────────────────────────────────

  describe("the append-only protocol (LC-3…LC-7)", () => {
    it("creates, edits, approves, tombstones and keeps the chain", async () => {
      const fx = await setup();
      const key = await metricKey({ valueType: "text", module: "basic" });

      const created = await post(
        body(fx, { metric_key: key, value_text: "We have a policy." }),
      );
      expect(created.status).toBe(200);
      expect(created.body.data.state).toBe("draft");
      expect(created.body.data.metric_key).toBe(key);
      expect(created.body.data.value_text).toBe("We have a policy.");

      const edited = await patch(created.body.data.id, {
        value_text: "We have a written policy.",
      });
      expect(edited.status).toBe(200);
      expect(edited.body.data.id).not.toBe(created.body.data.id);
      expect(edited.body.data.previous_version_id).toBe(created.body.data.id);
      expect((await storedRow(created.body.data.id)).supersededById).toBe(
        edited.body.data.id,
      );

      const approved = await approve(edited.body.data.id);
      expect(approved.status).toBe(200);
      expect(approved.body.data.state).toBe("approved");
      expect(approved.body.data.approved_by).toBe(fx.userId);
      // The value carries forward untouched across an approval version.
      expect(approved.body.data.value_text).toBe("We have a written policy.");
      expect(approved.body.data.value_type).toBe("text");

      const listed = await list(`?revision_id=${fx.revisionId}`);
      expect(listed.body.data.disclosures).toHaveLength(1);
      expect(listed.body.data.disclosures[0].id).toBe(approved.body.data.id);

      const gone = await remove(approved.body.data.id, {
        change_reason: "withdrawn after review",
      });
      expect(gone.status).toBe(200);
      expect(gone.body.data.is_deleted).toBe(true);
      expect(
        (await list(`?revision_id=${fx.revisionId}`)).body.data.disclosures,
      ).toHaveLength(0);

      const chain = await history(gone.body.data.id);
      expect(chain.status).toBe(200);
      expect(chain.body.data.versions).toHaveLength(4);
      expect(chain.body.data.truncated).toBe(false);
      // Any version of the chain reaches the same history (API-2).
      expect(
        (await history(created.body.data.id)).body.data.versions,
      ).toHaveLength(4);
      expect((await read(created.body.data.id)).status).toBe(200);
    });

    it("answers OPTIONS with the CORS contract (PATTERN 2)", async () => {
      const res = await listOPTIONS(request("/api/disclosures"));
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-methods")).toBeTruthy();
    });
  });

  // ─── DM-19: the typed value ───────────────────────────────────────────────

  describe("DM-19 — the typed value (§4.12, S1)", () => {
    it("stores every seeded DataType in the column DM-19 assigns it", async () => {
      const fx = await setup();
      // Ten of the twelve: the seeded 141 hold no `datetime` and no `reference`
      // metric, so those two are covered by the mapping test above and cannot
      // be exercised end to end until a catalogue revision introduces one.
      const samples: Partial<Record<DataType, unknown>> = {
        text: "A narrative answer.",
        string: "A short answer",
        decimal: 12.5,
        integer: 7,
        percentage: 42,
        boolean: true,
        date: "2024-06-30",
        enum: "yes",
        multi_enum: ["a", "b"],
        multi_reference: ["VSME-001", "VSME-002"],
      };

      for (const [type, value] of Object.entries(samples)) {
        const field = VALUE_FIELD_BY_TYPE[type as DataType];
        const key = await metricKey({
          valueType: type as DataType,
          breakdown: false,
        });
        const created = await post(
          body(fx, { metric_key: key, [field]: value }),
        );
        expect(created.status, `${type} → ${field}`).toBe(200);

        const row = await storedRow(created.body.data.id);
        // The catalogue decides the type; the body never states it.
        expect(row.valueType, type).toBe(type);
        const filled = [
          row.valueNumeric,
          row.valueText,
          row.valueBoolean,
          row.valueDate,
          row.valueJson,
        ].filter((v) => v !== null);
        expect(filled, `${type}: exactly one column filled`).toHaveLength(1);
      }
    });

    it("refuses a Decimal metric answered in value_text", async () => {
      const fx = await setup();
      const key = await metricKey({ valueType: "decimal", breakdown: false });

      const refused = await post(
        body(fx, { metric_key: key, value_text: "about twelve" }),
      );
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        ok: false,
        error: "VALIDATION",
        field: "value_text",
        reason: "value_type_mismatch",
        value_type: "decimal",
        expected_field: "value_numeric",
      });

      // The same figure in the right field is accepted.
      expect(
        (await post(body(fx, { metric_key: key, value_numeric: 12 }))).status,
      ).toBe(200);
    });

    it("refuses two non-empty value fields", async () => {
      const fx = await setup();
      const key = await metricKey({ valueType: "decimal", breakdown: false });

      const refused = await post(
        body(fx, { metric_key: key, value_numeric: 12, value_text: "twelve" }),
      );
      expect(refused.status).toBe(422);
      expect(refused.body.reason).toBe("one_value_only");
      expect(refused.body.provided).toEqual(["value_numeric", "value_text"]);
      expect(await getTestDb().select().from(disclosureRecord)).toHaveLength(0);
    });

    it("refuses a row with no value at all, and treats '' as no value", async () => {
      const fx = await setup();
      const key = await metricKey({ valueType: "text", module: "basic" });

      const empty = await post(body(fx, { metric_key: key }));
      expect(empty.status).toBe(422);
      expect(empty.body).toMatchObject({
        field: "value_text",
        reason: "value_required",
        value_type: "text",
      });

      // `""` CLEARS a field (`textOrNull`), so it is the same refusal — an
      // empty text box is not an answer.
      const blank = await post(body(fx, { metric_key: key, value_text: "" }));
      expect(blank.status).toBe(422);
      expect(blank.body.reason).toBe("value_required");
    });

    it("accepts the falsy answers: false, 0 and 0%", async () => {
      const fx = await setup();

      const no = await post(
        body(fx, {
          metric_key: await metricKey({ valueType: "boolean" }),
          value_boolean: false,
        }),
      );
      expect(no.status).toBe(200);
      expect(no.body.data.value_boolean).toBe(false);
      expect((await storedRow(no.body.data.id)).valueBoolean).toBe(false);

      const zero = await post(
        body(fx, {
          metric_key: await metricKey({
            valueType: "decimal",
            breakdown: false,
          }),
          value_numeric: 0,
        }),
      );
      expect(zero.status).toBe(200);
      expect(zero.body.data.value_numeric).toBe(0);

      const nothing = await post(
        body(fx, {
          metric_key: await metricKey({ valueType: "percentage" }),
          value_numeric: 0,
        }),
      );
      expect(nothing.status).toBe(200);
      expect(nothing.body.data.value_numeric).toBe(0);
    });

    it("holds the numeric types to their own shape", async () => {
      const fx = await setup();
      const integer = await metricKey({ valueType: "integer" });
      const percentage = await metricKey({ valueType: "percentage" });

      const fraction = await post(
        body(fx, { metric_key: integer, value_numeric: 1.5 }),
      );
      expect(fraction.status).toBe(422);
      expect(fraction.body).toMatchObject({
        field: "value_numeric",
        reason: "value_type_mismatch",
        value_type: "integer",
      });

      const overflow = await post(
        body(fx, { metric_key: percentage, value_numeric: 140 }),
      );
      expect(overflow.status).toBe(422);
      expect(overflow.body.value_type).toBe("percentage");

      expect(
        (await post(body(fx, { metric_key: integer, value_numeric: 2 })))
          .status,
      ).toBe(200);
      expect(
        (await post(body(fx, { metric_key: percentage, value_numeric: 100 })))
          .status,
      ).toBe(200);
    });

    it("holds the json types to their own shape", async () => {
      const fx = await setup();
      const single = await metricKey({ valueType: "enum" });
      const many = await metricKey({ valueType: "multi_enum" });

      expect(
        (await post(body(fx, { metric_key: single, value_json: [] }))).status,
      ).toBe(422);
      expect(
        (await post(body(fx, { metric_key: many, value_json: "one" }))).status,
      ).toBe(422);
      expect(
        (await post(body(fx, { metric_key: many, value_json: [] }))).status,
      ).toBe(422);
      expect(
        (await post(body(fx, { metric_key: single, value_json: "yes" })))
          .status,
      ).toBe(200);
    });

    it("never takes value_type from the body", async () => {
      const fx = await setup();
      const key = await metricKey({ valueType: "decimal", breakdown: false });

      const created = await post(
        body(fx, { metric_key: key, value_numeric: 5, value_type: "text" }),
      );
      expect(created.status).toBe(200);
      expect((await storedRow(created.body.data.id)).valueType).toBe("decimal");
    });

    it("refuses an unknown metric_key, and a body with none at all", async () => {
      const fx = await setup();

      const unknown = await post(
        body(fx, { metric_key: "VSME-999", value_text: "x" }),
      );
      expect(unknown.status).toBe(422);
      expect(unknown.body).toMatchObject({
        ok: false,
        error: "VALIDATION",
        field: "metric_key",
        reason: "unknown_metric",
      });

      // DM-18's NOT NULL, refused on the wire rather than by the constraint.
      const none = await post(body(fx, { value_text: "x" }));
      expect(none.status).toBe(422);
      expect(none.body.field).toBe("metric_key");
    });
  });

  // ─── DM-19 across a version (LC-5) ────────────────────────────────────────

  describe("DM-19 survives an edit", () => {
    it("judges a PATCH against the version it supersedes", async () => {
      const fx = await setup();
      const key = await metricKey({ valueType: "decimal", breakdown: false });
      const created = await post(
        body(fx, { metric_key: key, value_numeric: 10 }),
      );
      const id = created.body.data.id;

      // A second field, added in a SECOND request, is the same violation.
      const second = await patch(id, { value_text: "ten" });
      expect(second.status).toBe(422);
      expect(second.body.reason).toBe("one_value_only");
      expect(second.body.provided).toEqual(["value_numeric", "value_text"]);

      // Clearing the only value leaves the row with nothing to disclose.
      const cleared = await patch(id, { value_numeric: null });
      expect(cleared.status).toBe(422);
      expect(cleared.body.reason).toBe("value_required");

      // Swapping the value in place is fine, and carries the type forward.
      const changed = await patch(id, { value_numeric: 11 });
      expect(changed.status).toBe(200);
      expect(changed.body.data.value_numeric).toBe(11);
      expect((await storedRow(changed.body.data.id)).valueType).toBe("decimal");

      // A PATCH that touches neither the metric nor the value is still legal.
      const noted = await patch(changed.body.data.id, { notes: "checked" });
      expect(noted.status).toBe(200);
      expect(noted.body.data.value_numeric).toBe(11);
    });

    it("re-judges the value when a PATCH moves the row to another metric", async () => {
      const fx = await setup();
      const decimal = await metricKey({
        valueType: "decimal",
        breakdown: false,
      });
      const text = await metricKey({ valueType: "text", module: "basic" });
      const created = await post(
        body(fx, { metric_key: decimal, value_numeric: 10 }),
      );

      const moved = await patch(created.body.data.id, { metric_key: text });
      expect(moved.status).toBe(422);
      expect(moved.body).toMatchObject({
        field: "value_numeric",
        reason: "value_type_mismatch",
        expected_field: "value_text",
      });

      const both = await patch(created.body.data.id, {
        metric_key: text,
        value_numeric: null,
        value_text: "ten",
      });
      expect(both.status).toBe(200);
      expect((await storedRow(both.body.data.id)).valueType).toBe("text");
    });
  });

  // ─── S1: a metric with a breakdown lives wholly in value_json ─────────────

  describe("breakdown metrics (S1, DM-19)", () => {
    it("refuses the scalar field and accepts {total, breakdown}", async () => {
      const fx = await setup();
      const key = await metricKey({ valueType: "decimal", breakdown: true });
      const [dimension] = await dimensionsOf(key);
      expect(dimension).toBeTruthy();

      // Its `value_type` is `decimal`, and `value_numeric` is STILL refused:
      // the total and its split may not live in two fields (S1).
      const scalar = await post(
        body(fx, { metric_key: key, value_numeric: 1000 }),
      );
      expect(scalar.status).toBe(422);
      expect(scalar.body).toMatchObject({
        field: "value_numeric",
        reason: "breakdown_requires_json",
        value_type: "decimal",
        expected_field: "value_json",
      });

      const whole = await post(
        body(fx, {
          metric_key: key,
          value_json: {
            total: 1000,
            breakdown: { [dimension]: { electricity: 600, gas: 400 } },
          },
        }),
      );
      expect(whole.status).toBe(200);
      const row = await storedRow(whole.body.data.id);
      expect(row.valueNumeric).toBeNull();
      expect(row.valueJson).toEqual({
        total: 1000,
        breakdown: { [dimension]: { electricity: 600, gas: 400 } },
      });
    });

    it("checks the json's own shape", async () => {
      const fx = await setup();
      const key = await metricKey({ valueType: "decimal", breakdown: true });
      const [dimension] = await dimensionsOf(key);

      const noTotal = await post(
        body(fx, {
          metric_key: key,
          value_json: { breakdown: { [dimension]: { electricity: 1 } } },
        }),
      );
      expect(noTotal.status).toBe(422);
      expect(noTotal.body.reason).toBe("breakdown_total_required");

      const wrongTotal = await post(
        body(fx, { metric_key: key, value_json: { total: "a lot" } }),
      );
      expect(wrongTotal.status).toBe(422);
      expect(wrongTotal.body.reason).toBe("breakdown_total_type");

      const inventedAxis = await post(
        body(fx, {
          metric_key: key,
          value_json: { total: 10, breakdown: { moon_phase: { full: 10 } } },
        }),
      );
      expect(inventedAxis.status).toBe(422);
      expect(inventedAxis.body).toMatchObject({
        reason: "breakdown_unknown_dimension",
        dimension: "moon_phase",
      });

      const wrongPart = await post(
        body(fx, {
          metric_key: key,
          value_json: {
            total: 10,
            breakdown: { [dimension]: { gas: "some" } },
          },
        }),
      );
      expect(wrongPart.status).toBe(422);
      expect(wrongPart.body.reason).toBe("breakdown_part_type");

      // "breakdown if obtainable" (S1): the total alone is a complete answer,
      // and the split can be added later WITHOUT moving the total anywhere.
      const totalOnly = await post(
        body(fx, { metric_key: key, value_json: { total: 10 } }),
      );
      expect(totalOnly.status).toBe(200);
      const split = await patch(totalOnly.body.data.id, {
        value_json: { total: 10, breakdown: { [dimension]: { gas: 10 } } },
      });
      expect(split.status).toBe(200);
      expect((await storedRow(split.body.data.id)).valueNumeric).toBeNull();
    });
  });

  // ─── PG-6 / AC-14: the module gate ────────────────────────────────────────

  describe("PG-6 — the Comprehensive module gate (AC-14)", () => {
    it("refuses a comprehensive metric on starter — inside every limit", async () => {
      const fx = await setup("starter");
      const comprehensive = await metricKey({
        valueType: "text",
        module: "comprehensive",
      });
      const basic = await metricKey({ valueType: "text", module: "basic" });

      // AC-14's premise, asserted rather than assumed: `starter` allows one
      // legal entity and three facilities, and this company has one of each.
      const entities = await getTestDb()
        .select()
        .from(legalEntity)
        .where(eq(legalEntity.companyId, fx.companyId));
      const sites = await getTestDb()
        .select()
        .from(facility)
        .where(eq(facility.companyId, fx.companyId));
      expect(entities).toHaveLength(1);
      expect(sites).toHaveLength(1);

      const refused = await post(
        body(fx, { metric_key: comprehensive, value_text: "C-module answer" }),
      );
      expect(refused.status).toBe(422); // NOT 402: a module is not a quota
      expect(refused.body).toMatchObject({
        ok: false,
        error: "VALIDATION",
        field: "metric_key",
        reason: "comprehensive_module_unavailable",
        module: "comprehensive",
        metric_key: comprehensive,
        required_feature: "vsmeComprehensive",
      });
      expect(await getTestDb().select().from(disclosureRecord)).toHaveLength(0);

      // The SAME company, the same request shape, a `basic` metric: accepted.
      // That is the orthogonality AC-14 asserts — nothing about the size of the
      // organisation changed between these two calls.
      const allowed = await post(
        body(fx, { metric_key: basic, value_text: "B-module answer" }),
      );
      expect(allowed.status).toBe(200);
    });

    it("accepts the same comprehensive metric on pro", async () => {
      const fx = await setup("pro");
      const comprehensive = await metricKey({
        valueType: "text",
        module: "comprehensive",
      });

      const created = await post(
        body(fx, { metric_key: comprehensive, value_text: "C-module answer" }),
      );
      expect(created.status).toBe(200);
      expect(created.body.data.metric_key).toBe(comprehensive);
      expect((await storedRow(created.body.data.id)).valueType).toBe("text");
    });

    it("does not strand comprehensive rows a downgraded plan already holds", async () => {
      const fx = await setup("pro");
      const comprehensive = await metricKey({
        valueType: "text",
        module: "comprehensive",
      });
      const created = await post(
        body(fx, { metric_key: comprehensive, value_text: "before" }),
      );
      expect(created.status).toBe(200);

      // The plan lapses to starter. The row must stay correctable and
      // withdrawable — the gate stops new Comprehensive DATA, it does not lock
      // the customer out of what it already recorded.
      await downgrade(fx, "starter");
      const edited = await patch(created.body.data.id, { value_text: "after" });
      expect(edited.status).toBe(200);
      expect((await remove(edited.body.data.id)).status).toBe(200);

      // A NEW comprehensive row is refused, though.
      const blocked = await post(
        body(fx, { metric_key: comprehensive, value_text: "new" }),
      );
      expect(blocked.status).toBe(422);
      expect(blocked.body.reason).toBe("comprehensive_module_unavailable");
    });

    // Партия 9 — the second module, gated by the same hook (0019 rows, 0021
    // flag). Starter is inside every limit and is refused; Pro is accepted;
    // and the refusal is the module's own wording, not Comprehensive's.
    it("refuses a simplified-ESRS metric on starter and accepts it on pro", async () => {
      const fx = await setup("starter");
      const esrs = await metricKey({
        valueType: "text",
        module: "simplified_esrs",
      });
      const refused = await post(
        body(fx, { metric_key: esrs, value_text: "ESRS answer" }),
      );
      expect(refused.status).toBe(422); // a module, not a quota
      expect(refused.body).toMatchObject({
        ok: false,
        error: "VALIDATION",
        field: "metric_key",
        reason: "simplified_esrs_module_unavailable",
        module: "simplified_esrs",
        metric_key: esrs,
        required_feature: "simplifiedEsrs",
      });
      expect(await getTestDb().select().from(disclosureRecord)).toHaveLength(0);

      await downgrade(fx, "pro"); // an upgrade, by the same helper
      const allowed = await post(
        body(fx, { metric_key: esrs, value_text: "ESRS answer" }),
      );
      expect(allowed.status).toBe(200);
      expect(allowed.body.data.metric_key).toBe(esrs);
    });
  });

  // ─── PATTERN 3 ────────────────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("does not list or read another company's disclosures", async () => {
      const fx = await setup();
      const key = await metricKey({ valueType: "text", module: "basic" });
      const mine = await post(
        body(fx, { metric_key: key, value_text: "mine" }),
      );

      const other = await setup();
      expect(
        (await list()).body.data.disclosures.map((r: { id: string }) => r.id),
      ).not.toContain(mine.body.data.id);
      expect((await read(mine.body.data.id)).status).toBe(404);
      expect((await history(mine.body.data.id)).status).toBe(404);
      expect((await patch(mine.body.data.id, { value_text: "x" })).status).toBe(
        422,
      );
      expect(other.companyId).not.toBe(fx.companyId);
    });
  });
});
