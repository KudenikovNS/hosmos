// =============================================================================
// [LOCAL-DB] T5.7 — IMMUTABLE RENDERS: THE GATE, THE STAMP AND THE BYTES
// (REN-3, REN-4, REN-5, DM-30, DM-31, D14, PG-2, PG-4, О-14, AC-12).
//
// The T5.6 suite proved the renderer says the right words. This one proves the
// four things that only exist once a render is PERSISTED, and each of them
// guards a different way the feature could be quietly wrong:
//
//   • THE GATE (REN-3). A draft revision and a revision whose run did not price
//     every line are both 422. Without this a report could be published from
//     numbers nobody approved, or from a run with a hole in it.
//   • THE FORMAT GATE (PG-2). `xlsx` is 402 on trial and 200 on starter. This is
//     the ONLY plan refusal on the route, and the next test is why that matters.
//   • THE STAMP (D14/AC-12). Five sites against a plan limit of three does NOT
//     refuse: it renders, lists the two over-limit sites in `excluded_by_plan`
//     and forces `coverage_claim='partial'`. "We do not block — we stamp."
//     And the DM-31 CHECK is asserted DIRECTLY, with SQL that bypasses every
//     line of application code, because the argument of D14 is that the
//     dishonest combination is physically unwritable rather than merely
//     un-written.
//   • THE ARTEFACT (REN-5, О-14). The bytes go through `DocumentStorage`, the
//     stored `file_hash` IS the sha256 of what comes back down the download, a
//     re-render appends a row instead of touching the first, the LANGUAGE is
//     part of the identity (two languages, two rows, two hashes), and another
//     tenant's render is a 404 rather than a 403.
//
// FILE ISOLATION (T1.7): `setupDocumentsDir()` gives the suite its own
// `DOCUMENTS_DIR` under `os.tmpdir()`. The file-level `afterAll` at the bottom
// runs AFTER the suite's own cleanup and asserts that neither the render nor the
// directory survived it — the acceptance criterion "nothing is left behind" is
// checked, not assumed.
// =============================================================================
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
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

import { GET as downloadGET } from "@/app/api/renders/[id]/download/route";
import { GET as rendersGET } from "@/app/api/renders/route";
import {
  GET as previewGET,
  POST as renderPOST,
} from "@/app/api/revisions/[id]/render/route";
import { resolveSessionContext } from "@/server/auth/session";
import { resetPlanFeaturesCache } from "@/server/billing/entitlements";
import { calculateRevision } from "@/server/calc/run";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertEmissionActivity,
  insertFacility,
  insertLegalEntity,
  insertPeriod,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupDocumentsDir,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { reportRender, reportRevision } from "@/server/db/schema";
import { RENDER_SECTIONS } from "@/server/render/sections";
import { sheetNames } from "@/server/render/xlsx";
import type { RenderSection } from "@/server/render/sections";

// ─── The pure half: worksheet names ──────────────────────────────────────────
//
// A workbook whose sheet names collide, or carry a character Excel forbids, does
// not open AT ALL — so the sanitiser is worth its own DB-free test. The headings
// are TRANSLATED strings, which is exactly why this cannot be left to inspection
// of today's `messages/*.json`.

describe("sheetNames (xlsx)", () => {
  const section = (id: string, heading: string): RenderSection =>
    ({ id, heading, blocks: [] }) as unknown as RenderSection;

  it("strips the characters Excel refuses in a worksheet name", () => {
    expect(sheetNames([section("a", "Scope 1/2 [2024]: energy?")])).toEqual([
      "Scope 1 2  2024   energy",
    ]);
  });

  it("truncates to 31 characters", () => {
    const [name] = sheetNames([section("a", "x".repeat(60))]);
    expect(name).toHaveLength(31);
  });

  it("disambiguates two headings that truncate to the same 31 characters", () => {
    const long = "Podatki o porabi energije in izpustih";
    const names = sheetNames([
      section("a", `${long} A`),
      section("b", `${long} B`),
    ]);
    expect(names[0]).not.toBe(names[1]);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => name.length <= 31)).toBe(true);
  });

  it("falls back to the section id for a heading that sanitises to nothing", () => {
    expect(sheetNames([section("disclaimer", "///")])).toEqual(["disclaimer"]);
  });
});

// ─── The persisted half ──────────────────────────────────────────────────────

/** Captured so the file-level `afterAll` can prove the suite left nothing. */
let capturedRoot = "";
let capturedFile = "";

const enc = (url: string, init?: RequestInit): NextRequest =>
  new Request(`http://api.example.com${url}`, init) as NextRequest;

const jsonRequest = (url: string, body: unknown): NextRequest =>
  enc(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const answer = async (res: Response) => ({
  status: res.status,
  body: (await res.json()) as Record<string, unknown>,
});

type RenderDtoLike = {
  id: string;
  format: string;
  language: string;
  file_hash: string;
  coverage_claim: string;
  completeness_note: string | null;
  excluded_by_plan: { type: string; id: string; name: string }[];
  disclaimer_text: string;
  calc_run_id: string;
  file_name: string;
};

const renderOf = (body: Record<string, unknown>): RenderDtoLike =>
  (body.data as { render: RenderDtoLike }).render;

/** The T5.8 preview, reduced to what the `/reports` wizard reads off it. */
type PreviewDtoLike = {
  revision_id: string;
  language: string;
  renderable: boolean;
  gate_reason: string | null;
  gate_detail: Record<string, unknown> | null;
  coverage_claim: string;
  completeness_note: string | null;
  excluded_by_plan: { type: string; id: string; name: string }[];
  lock_gate: {
    plan: string;
    applies: boolean;
    limit: number;
    facilities: number;
    passed: boolean;
  };
};

describeIntegration("api/renders — immutable renders [LOCAL-DB]", () => {
  const documentsDir = setupDocumentsDir();

  beforeAll(async () => {
    await setupSchema();
  });

  beforeEach(async () => {
    await resetAppTables();
    getSessionMock.mockReset();
    resetPlanFeaturesCache();
  });

  afterAll(async () => {
    await closeTestDb();
    resetPlanFeaturesCache();
  });

  async function sessionFor(userId: string) {
    const ctx = await resolveSessionContext(getTestDb(), userId);
    return { userId, email: "u@example.com", name: "U", ...ctx };
  }

  /**
   * Run a statement that must violate a CHECK, and return the constraint's NAME.
   *
   * Drizzle wraps the postgres.js error, and the wrapper's message is the query
   * text — so `toThrow(/name/)` passes for any failure at all. The name lives on
   * `.cause.constraint_name`, and asserting it is what makes a DM-31 test about
   * DM-31 rather than about "some SQL error happened".
   */
  async function constraintViolation(
    statement: Parameters<ReturnType<typeof getTestDb>["execute"]>[0],
  ): Promise<string | undefined> {
    const err = await getTestDb()
      .execute(statement)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err, "the statement was expected to be refused").not.toBeNull();
    return (err as { cause?: { constraint_name?: string } })?.cause
      ?.constraint_name;
  }

  interface Fixture {
    companyId: string;
    userId: string;
    entityId: string;
    periodId: string;
    revisionId: string;
  }

  /**
   * A company on `plan` with one entity, one site, one approved gas row, and a
   * GREEN calculation run — the smallest thing REN-3 lets through.
   *
   * The revision is calculated as a `draft` and promoted afterwards, which is
   * the order the product uses (T2.6 approves a revision that already has a
   * green run) and keeps the fixture out of the state machine's way.
   */
  async function fixture(plan = "starter"): Promise<Fixture> {
    const company = await insertCompany({ plan });
    const { user } = await insertUserWithProfile({ companyId: company.id });
    const entity = await insertLegalEntity(company.id, {
      turnover: "5000000",
      reportingCurrency: "EUR",
    });
    const site = await insertFacility(company.id, {
      legalEntityId: entity.id,
    });
    const { period } = await insertPeriod(company.id, {
      legalEntityId: entity.id,
      reportingYear: 2024,
    });
    const revision = await insertRevision(company.id, { periodId: period.id });
    await insertEmissionActivity(company.id, {
      revisionId: revision.id,
      legalEntityId: entity.id,
      facilityId: site.id,
      activityCategory: "stationary_combustion",
      activityType: "natural_gas",
      activityValue: "1000",
      unit: "kWh_gross",
      yearMonth: "2024-03",
      state: "approved",
    });

    const db = getTestDb();
    const [row] = await db
      .select()
      .from(reportRevision)
      .where(eq(reportRevision.id, revision.id));
    const run = await calculateRevision(db, company.id, row);
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.run.status).toBe("ok");

    await db
      .update(reportRevision)
      .set({ status: "approved", approvedAt: new Date() })
      .where(eq(reportRevision.id, revision.id));

    getSessionMock.mockResolvedValue(await sessionFor(user.id));
    return {
      companyId: company.id,
      userId: user.id,
      entityId: entity.id,
      periodId: period.id,
      revisionId: revision.id,
    };
  }

  const renderCall = (revisionId: string, body: unknown) =>
    renderPOST(jsonRequest(`/api/revisions/${revisionId}/render`, body), {
      params: Promise.resolve({ id: revisionId }),
    });

  const downloadCall = (renderId: string) =>
    downloadGET(enc(`/api/renders/${renderId}/download`), {
      params: Promise.resolve({ id: renderId }),
    });

  const previewCall = (revisionId: string, language?: string) =>
    previewGET(
      enc(
        `/api/revisions/${revisionId}/render${
          language === undefined ? "" : `?language=${language}`
        }`,
      ),
      { params: Promise.resolve({ id: revisionId }) },
    );

  const previewOf = (body: Record<string, unknown>): PreviewDtoLike =>
    (body.data as { preview: PreviewDtoLike }).preview;

  // ── REN-3: the gate ────────────────────────────────────────────────────────

  it("refuses a revision that is still a draft (REN-3) — 422", async () => {
    const f = await fixture();
    await getTestDb()
      .update(reportRevision)
      .set({ status: "draft", approvedAt: null })
      .where(eq(reportRevision.id, f.revisionId));

    const { status, body } = await answer(
      await renderCall(f.revisionId, { format: "pdf" }),
    );
    expect(status).toBe(422);
    expect(body.error).toBe("VALIDATION");
    expect(body.reason).toBe("revision_not_approved");
    expect(body.status).toBe("draft");

    const rows = await getTestDb().select().from(reportRender);
    expect(rows).toHaveLength(0);
  });

  it("refuses a revision whose run did not price every line (REN-3) — 422", async () => {
    const f = await fixture();
    const db = getTestDb();

    // A second activity nothing in the factor set can price. The next run is
    // therefore `failed`, and a failed run publishes no total (T5.4) — which is
    // exactly the report REN-3 must not let out of the building.
    await insertEmissionActivity(f.companyId, {
      revisionId: f.revisionId,
      legalEntityId: f.entityId,
      activityCategory: "stationary_combustion",
      activityType: "unobtainium",
      activityValue: "10",
      unit: "kWh",
      yearMonth: "2024-04",
      state: "approved",
    });
    const [row] = await db
      .select()
      .from(reportRevision)
      .where(eq(reportRevision.id, f.revisionId));
    const run = await calculateRevision(db, f.companyId, row);
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.run.status).toBe("failed");

    const { status, body } = await answer(
      await renderCall(f.revisionId, { format: "pdf" }),
    );
    expect(status).toBe(422);
    expect(body.reason).toBe("no_green_run");
    expect(await db.select().from(reportRender)).toHaveLength(0);
  });

  // ── PG-2: the format gate ──────────────────────────────────────────────────

  it("refuses xlsx on trial (reportFormats=['pdf']) with 402, and allows pdf", async () => {
    const f = await fixture("trial");

    const denied = await answer(
      await renderCall(f.revisionId, { format: "xlsx" }),
    );
    expect(denied.status).toBe(402);
    expect(denied.body.error).toBe("PLAN_REQUIRED");

    const allowed = await answer(
      await renderCall(f.revisionId, { format: "pdf" }),
    );
    expect(allowed.status).toBe(200);
    expect(renderOf(allowed.body).format).toBe("pdf");
  });

  it("allows xlsx on starter, and the bytes really are a workbook", async () => {
    const f = await fixture("starter");
    const { status, body } = await answer(
      await renderCall(f.revisionId, { format: "xlsx", language: "en" }),
    );
    expect(status).toBe(200);
    const render = renderOf(body);
    expect(render.format).toBe("xlsx");
    expect(render.file_name.endsWith(".xlsx")).toBe(true);

    const res = await downloadCall(render.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const bytes = Buffer.from(await res.arrayBuffer());

    // An `.xlsx` IS a zip, and a zip stores every member's NAME uncompressed in
    // its local header — so the OOXML package can be verified without unzipping.
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    const raw = bytes.toString("latin1");
    for (const part of [
      "[Content_Types].xml",
      "xl/workbook.xml",
      "xl/styles.xml",
    ]) {
      expect(raw, part).toContain(part);
    }
    // One worksheet per section of `RENDER_SECTIONS` — as many as it lists.
    const sheets = raw.match(/xl\/worksheets\/sheet\d+\.xml/g) ?? [];
    expect(new Set(sheets).size).toBe(RENDER_SECTIONS.length);
  });

  it("refuses a format this product cannot produce, before any plan lookup", async () => {
    const f = await fixture();
    const { status, body } = await answer(
      await renderCall(f.revisionId, { format: "docx" }),
    );
    expect(status).toBe(422);
    expect(body.field).toBe("format");
  });

  // ── D14 / AC-12: the completeness stamp ────────────────────────────────────

  it("AC-12: 5 known sites against a limit of 3 renders, but partial", async () => {
    const f = await fixture("starter"); // maxFacilities = 3
    // Four more sites under the SAME legal entity: only the facility axis is
    // over the limit, so the assertion below is about facilities alone.
    for (let i = 0; i < 4; i += 1) {
      await insertFacility(f.companyId, { legalEntityId: f.entityId });
    }

    const { status, body } = await answer(
      await renderCall(f.revisionId, { format: "pdf", language: "en" }),
    );
    // THE REPORT IS NOT BLOCKED. That is the whole of D14.
    expect(status).toBe(200);

    const render = renderOf(body);
    expect(render.coverage_claim).toBe("partial");
    expect(render.excluded_by_plan).toHaveLength(2);
    expect(render.excluded_by_plan.every((e) => e.type === "facility")).toBe(
      true,
    );
    expect(render.completeness_note).toBeTruthy();
    expect(render.completeness_note).toContain("starter");

    // The excluded pair is the TAIL of the registry in creation order — the two
    // rows the create guard would have refused had the plan always been starter.
    const names = render.excluded_by_plan.map((e) => e.name);
    expect(new Set(names).size).toBe(2);

    // The note reaches the stored disclaimer, so the reader of the FILE learns
    // what is missing and not only the reader of the row (REN-2a point 3).
    expect(render.disclaimer_text).toContain(render.completeness_note ?? "//");
  });

  // ── T5.8: the preview and the stamp are ONE computation ───────────────────
  //
  // The acceptance line is "the completeness preview shows the same exclusions
  // that later land in `excluded_by_plan` (checked against one fixture
  // scenario)", and the scenario is the D14 one directly above: starter, five
  // sites, a limit of three. What makes this a real check rather than a
  // tautology is that the two values travel by completely different routes —
  // one through `GET …/render` and `serialiseRenderPreview`, the other through
  // `POST …/render`, `renderRevision`, an INSERT, a re-read through the join and
  // `serialiseRender`. They agree because `renderPreview` is the only thing that
  // computes them, and this is where that stops being an assertion in a comment.

  it("AC-13: the preview names exactly the exclusions the render then stamps", async () => {
    const f = await fixture("starter"); // maxFacilities = 3
    for (let i = 0; i < 4; i += 1) {
      await insertFacility(f.companyId, { legalEntityId: f.entityId });
    }

    const before = await answer(await previewCall(f.revisionId, "en"));
    expect(before.status).toBe(200);
    const preview = previewOf(before.body);

    // The preview says the report is publishable and partial…
    expect(preview.renderable).toBe(true);
    expect(preview.gate_reason).toBeNull();
    expect(preview.coverage_claim).toBe("partial");
    expect(preview.excluded_by_plan).toHaveLength(2);

    const { status, body } = await answer(
      await renderCall(f.revisionId, { format: "pdf", language: "en" }),
    );
    expect(status).toBe(200);
    const render = renderOf(body);

    // …and the file agrees, field for field. Deep equality on the ARRAY, not a
    // count: an exclusion list with the right length and the wrong sites would
    // be exactly the drift this criterion exists to catch.
    expect(render.coverage_claim).toBe(preview.coverage_claim);
    expect(render.excluded_by_plan).toEqual(preview.excluded_by_plan);
    expect(render.completeness_note).toBe(preview.completeness_note);
    // And the note the screen displayed is the note printed in the document.
    expect(render.disclaimer_text).toContain(preview.completeness_note ?? "//");
  });

  it("AC-13: a `full` preview and a `full` render agree too", async () => {
    const f = await fixture("pro");
    const preview = previewOf(
      (await answer(await previewCall(f.revisionId, "en"))).body,
    );
    const render = renderOf(
      (
        await answer(
          await renderCall(f.revisionId, { format: "pdf", language: "en" }),
        )
      ).body,
    );
    expect(preview.coverage_claim).toBe("full");
    expect(preview.excluded_by_plan).toEqual([]);
    expect(preview.completeness_note).toBeNull();
    expect(render.coverage_claim).toBe(preview.coverage_claim);
    expect(render.excluded_by_plan).toEqual(preview.excluded_by_plan);
    expect(render.completeness_note).toBe(preview.completeness_note);
  });

  it("previews REN-3's refusal instead of enforcing it (a draft still answers)", async () => {
    const f = await fixture();
    await getTestDb()
      .update(reportRevision)
      .set({ status: "draft", approvedAt: null })
      .where(eq(reportRevision.id, f.revisionId));

    const { status, body } = await answer(await previewCall(f.revisionId));
    // 200, not 422: the SCREEN needs the reason in order to explain it, and it
    // still needs the coverage — what the plan leaves out is a fact about the
    // plan, not about whether anyone has approved the numbers yet.
    expect(status).toBe(200);
    const preview = previewOf(body);
    expect(preview.renderable).toBe(false);
    expect(preview.gate_reason).toBe("revision_not_approved");
    expect(preview.gate_detail?.status).toBe("draft");
    expect(preview.coverage_claim).toBe("full");
  });

  it("О-14: the preview's completeness note is written in the language asked for", async () => {
    const f = await fixture("starter");
    for (let i = 0; i < 4; i += 1) {
      await insertFacility(f.companyId, { legalEntityId: f.entityId });
    }
    const en = previewOf(
      (await answer(await previewCall(f.revisionId, "en"))).body,
    );
    const sl = previewOf(
      (await answer(await previewCall(f.revisionId, "sl"))).body,
    );

    expect(en.language).toBe("en");
    expect(sl.language).toBe("sl");
    // The same exclusions, said in two languages — which is precisely why the
    // language is chosen BEFORE the render and not after it.
    expect(sl.excluded_by_plan).toEqual(en.excluded_by_plan);
    expect(sl.completeness_note).not.toBe(en.completeness_note);
  });

  it("refuses a language nobody wrote a report in, rather than coercing it", async () => {
    const f = await fixture();
    const { status, body } = await answer(
      await previewCall(f.revisionId, "de"),
    );
    expect(status).toBe(422);
    expect(body.field).toBe("language");
  });

  it("F1: the preview carries the LOCK verdict, and it never blocks the render", async () => {
    const f = await fixture("starter"); // hard-gated, maxFacilities = 3
    for (let i = 0; i < 4; i += 1) {
      await insertFacility(f.companyId, { legalEntityId: f.entityId });
    }
    const preview = previewOf(
      (await answer(await previewCall(f.revisionId, "en"))).body,
    );
    expect(preview.lock_gate).toEqual({
      plan: "starter",
      applies: true,
      limit: 3,
      facilities: 5,
      passed: false,
    });
    // …and the report is produced anyway. That asymmetry IS D14 (AC-12): a plan
    // limit stamps a render and refuses a LOCK.
    expect(preview.renderable).toBe(true);
    const { status } = await answer(
      await renderCall(f.revisionId, { format: "pdf" }),
    );
    expect(status).toBe(200);
  });

  it("F1: a plan the gate does not apply to reports `applies: false`", async () => {
    // pro is not hard-gated (§11.3), so the wizard must not warn there — and
    // the only way it can know that without copying `HARD_GATED_PLANS` into the
    // browser is for the server to say so.
    const f = await fixture("pro");
    const preview = previewOf(
      (await answer(await previewCall(f.revisionId, "en"))).body,
    );
    expect(preview.lock_gate.applies).toBe(false);
    expect(preview.lock_gate.passed).toBe(true);
  });

  it("another tenant's revision has no preview (API-1)", async () => {
    const f = await fixture();
    const other = await insertCompany({ plan: "starter" });
    const { user: stranger } = await insertUserWithProfile({
      companyId: other.id,
    });
    getSessionMock.mockResolvedValue(await sessionFor(stranger.id));

    const { status, body } = await answer(await previewCall(f.revisionId));
    expect(status).toBe(404);
    expect(body.error).toBe("NO_DATA");
  });

  it("stamps `full` when the registry fits inside the plan", async () => {
    const f = await fixture("pro"); // 3 entities / 15 facilities
    const { body } = await answer(
      await renderCall(f.revisionId, { format: "pdf" }),
    );
    const render = renderOf(body);
    expect(render.coverage_claim).toBe("full");
    expect(render.excluded_by_plan).toEqual([]);
    expect(render.completeness_note).toBeNull();
  });

  it("DM-31: `full` with a non-empty excluded_by_plan is unwritable, even by SQL", async () => {
    const f = await fixture("starter");
    for (let i = 0; i < 4; i += 1) {
      await insertFacility(f.companyId, { legalEntityId: f.entityId });
    }
    const { body } = await answer(
      await renderCall(f.revisionId, { format: "pdf" }),
    );
    const render = renderOf(body);
    expect(render.coverage_claim).toBe("partial");

    // The CHECK, not the code. An UPDATE reaches the row past every service,
    // every route and every guard in this repository — and is still refused.
    // The constraint NAME is asserted (off the wrapped postgres.js error), so
    // this cannot pass because of some unrelated SQL failure.
    expect(
      await constraintViolation(
        sql`UPDATE report_render SET coverage_claim = 'full' WHERE id = ${render.id}`,
      ),
    ).toBe("report_render_coverage_claim_d14_check");

    const [after] = await getTestDb()
      .select()
      .from(reportRender)
      .where(eq(reportRender.id, render.id));
    expect(after.coverageClaim).toBe("partial");
  });

  // ── REN-5 / DM-30: the artefact ────────────────────────────────────────────

  it("writes the bytes through DocumentStorage, into the suite's temporary root", async () => {
    const f = await fixture();
    const { body } = await answer(
      await renderCall(f.revisionId, { format: "pdf" }),
    );
    const render = renderOf(body);

    const [row] = await getTestDb()
      .select()
      .from(reportRender)
      .where(eq(reportRender.id, render.id));

    // `{DOCUMENTS_DIR}/{companyId}/{sha256}` — the layout T1.6 defines. The
    // ROOT is the one `setupDocumentsDir()` made, never a developer's storage.
    expect(row.storageKey).toBe(`${f.companyId}/${row.fileHash}`);
    const onDisk = path.join(documentsDir.path, f.companyId, row.fileHash);
    expect(existsSync(onDisk)).toBe(true);
    expect(documentsDir.path.startsWith(path.resolve("/"))).toBe(true);
    expect(onDisk.startsWith(documentsDir.path + path.sep)).toBe(true);

    capturedRoot = documentsDir.path;
    capturedFile = onDisk;
  });

  it("file_hash is the sha256 of the bytes that come back down the download", async () => {
    const f = await fixture();
    const { body } = await answer(
      await renderCall(f.revisionId, { format: "pdf" }),
    );
    const render = renderOf(body);

    const res = await downloadCall(render.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      render.file_hash,
    );
  });

  it("re-rendering appends a NEW row and leaves the first untouched", async () => {
    const f = await fixture();
    const first = renderOf(
      (await answer(await renderCall(f.revisionId, { format: "pdf" }))).body,
    );
    const before = await getTestDb()
      .select()
      .from(reportRender)
      .where(eq(reportRender.id, first.id));

    const second = renderOf(
      (await answer(await renderCall(f.revisionId, { format: "pdf" }))).body,
    );
    expect(second.id).not.toBe(first.id);

    const rows = await getTestDb()
      .select()
      .from(reportRender)
      .where(eq(reportRender.revisionId, f.revisionId));
    expect(rows).toHaveLength(2);

    const [after] = await getTestDb()
      .select()
      .from(reportRender)
      .where(eq(reportRender.id, first.id));
    expect(after).toEqual(before[0]);
  });

  // ── О-14: the language is part of the identity ─────────────────────────────

  it("О-14: en and sl are TWO rows, with their language and different hashes", async () => {
    const f = await fixture();
    const en = renderOf(
      (
        await answer(
          await renderCall(f.revisionId, { format: "pdf", language: "en" }),
        )
      ).body,
    );
    const sl = renderOf(
      (
        await answer(
          await renderCall(f.revisionId, { format: "pdf", language: "sl" }),
        )
      ).body,
    );

    expect(en.id).not.toBe(sl.id);
    expect(en.language).toBe("en");
    expect(sl.language).toBe("sl");
    // Different words → different bytes → different hash. If these ever matched,
    // the language would not have reached the renderer.
    expect(en.file_hash).not.toBe(sl.file_hash);
    expect(en.disclaimer_text).not.toBe(sl.disclaimer_text);
    expect(en.file_name).not.toBe(sl.file_name);

    const rows = await getTestDb()
      .select()
      .from(reportRender)
      .where(eq(reportRender.revisionId, f.revisionId));
    expect(rows.map((row) => row.language).sort()).toEqual(["en", "sl"]);
  });

  it("О-14: a third language is refused by the request AND by the database", async () => {
    const f = await fixture();
    const refused = await answer(
      await renderCall(f.revisionId, { format: "pdf", language: "de" }),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.field).toBe("language");

    const render = renderOf(
      (await answer(await renderCall(f.revisionId, { format: "pdf" }))).body,
    );
    expect(
      await constraintViolation(
        sql`UPDATE report_render SET language = 'de' WHERE id = ${render.id}`,
      ),
    ).toBe("report_render_language_check");
  });

  it("defaults the language to the acting user's locale when none is given", async () => {
    const f = await fixture();
    await getTestDb().execute(sql`
      UPDATE profiles SET locale = 'sl' WHERE id = ${f.userId}
    `);
    const render = renderOf(
      (await answer(await renderCall(f.revisionId, { format: "pdf" }))).body,
    );
    expect(render.language).toBe("sl");
  });

  // ── Tenancy ────────────────────────────────────────────────────────────────

  it("another tenant's render is a 404, in the list and in the download", async () => {
    const f = await fixture();
    const mine = renderOf(
      (await answer(await renderCall(f.revisionId, { format: "pdf" }))).body,
    );

    const other = await insertCompany({ plan: "starter" });
    const { user: stranger } = await insertUserWithProfile({
      companyId: other.id,
    });
    getSessionMock.mockResolvedValue(await sessionFor(stranger.id));

    const download = await downloadCall(mine.id);
    expect(download.status).toBe(404);
    expect((await download.json()).error).toBe("NO_DATA");

    const list = await answer(await rendersGET(enc("/api/renders")));
    expect(list.status).toBe(200);
    expect((list.body.data as { renders: unknown[] }).renders).toEqual([]);

    // And rendering THEIR view of my revision is a 404, not somebody else's PDF.
    const stolen = await answer(
      await renderCall(f.revisionId, { format: "pdf" }),
    );
    expect(stolen.status).toBe(404);
  });

  it("lists a company's renders newest first, without leaking the storage key", async () => {
    const f = await fixture();
    await renderCall(f.revisionId, { format: "pdf", language: "en" });
    await renderCall(f.revisionId, { format: "xlsx", language: "sl" });

    const { status, body } = await answer(
      await rendersGET(enc(`/api/renders?revision_id=${f.revisionId}`)),
    );
    expect(status).toBe(200);
    const renders = (body.data as { renders: Record<string, unknown>[] })
      .renders;
    expect(renders).toHaveLength(2);
    for (const render of renders) {
      expect(render).not.toHaveProperty("storage_key");
      expect(render.period_name).toBeTruthy();
      expect(render.revision_no).toBe(1);
    }

    // A revision of another company reads as an empty list, not as a 403.
    const foreign = await answer(
      await rendersGET(
        enc("/api/renders?revision_id=11111111-2222-4333-8444-555555555555"),
      ),
    );
    expect((foreign.body.data as { renders: unknown[] }).renders).toEqual([]);
  });

  it("audits the render as a create on `report_render`", async () => {
    const f = await fixture();
    const render = renderOf(
      (await answer(await renderCall(f.revisionId, { format: "pdf" }))).body,
    );
    const rows = await getTestDb().execute<{
      entity: string;
      entity_id: string;
      action: string;
    }>(sql`
      SELECT entity, entity_id, action FROM audit_log
       WHERE company_id = ${f.companyId} AND entity = 'report_render'
    `);
    const audit = [...rows];
    expect(audit).toHaveLength(1);
    expect(audit[0].entity_id).toBe(render.id);
    expect(audit[0].action).toBe("create");
  });

  it("a render survives its revision being superseded by a restatement", async () => {
    // LC-9: a locked report is restated by a NEW revision, never by editing the
    // old one — and `report_render.revision_id` is NO ACTION, so the render of
    // the superseded revision is still there, still downloadable, still hashed.
    const f = await fixture();
    const render = renderOf(
      (await answer(await renderCall(f.revisionId, { format: "pdf" }))).body,
    );

    const db = getTestDb();
    await db
      .update(reportRevision)
      .set({ status: "locked", isCurrent: false, lockedAt: new Date() })
      .where(eq(reportRevision.id, f.revisionId));
    await insertRevision(f.companyId, {
      periodId: f.periodId,
      revisionNo: 2,
      isCurrent: true,
    });

    const res = await downloadCall(render.id);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      render.file_hash,
    );

    const [row] = await db
      .select()
      .from(reportRender)
      .where(
        and(
          eq(reportRender.id, render.id),
          eq(reportRender.companyId, f.companyId),
        ),
      );
    expect(row.revisionId).toBe(f.revisionId);
  });
});

/**
 * FILE-LEVEL, so it runs AFTER the suite's own `afterAll` — including the one
 * `setupDocumentsDir()` registered. Which is the only place from which
 * "`afterAll` leaves nothing behind" can actually be observed.
 */
afterAll(() => {
  if (!capturedRoot) return; // suite skipped (no DATABASE_URL)
  expect(existsSync(capturedFile)).toBe(false);
  expect(existsSync(capturedRoot)).toBe(false);
});
