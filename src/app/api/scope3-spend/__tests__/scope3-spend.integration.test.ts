// T2.4 integration tests — the Scope-3 spend write route runs against a REAL
// Postgres via the T-13 harness. Proves §Q3(b)/§Q3-FX (spend lines persist +
// currency-aware) + §Q6 (audit) + the server-side entitlement close + the
// cross-tenant DELETE guard + the server-is-source-of-truth trust boundary:
//   • trial company (scope3=false) → 402 PLAN_REQUIRED on POST (UI bypass blocked);
//   • a scope3-entitled plan (starter) → a EUR line + an RSD line persist, the
//     recalculation runs, and scope3_results cat 1/2 reflect the FX-converted tCO2e;
//   • a commodity_key NOT in the seeded EXIOBASE spend set → 422, nothing written;
//   • a client-sent bogus `category`/`factor` is IGNORED (the server derives the
//     category from the commodity);
//   • a cross-tenant DELETE → 404 NO_DATA, the owner's line survives;
//   • a currency with no FX rate → the line saves, a warning surfaces, it adds 0.
//
// `getSession` is mocked so a test controls identity; `@/server/db` and the recalc
// singleton both point at DATABASE_URL, so committed writes are cross-visible.
// `describeIntegration` self-skips with no DB — a green no-op in a DB-less CI.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getSessionMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  getSession: () => getSessionMock(),
}));

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return {
    get db() {
      return harness.getTestDb();
    },
  };
});

import {
  DELETE as spendDELETE,
  GET as spendGET,
  POST as spendPOST,
} from "@/app/api/scope3-spend/route";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertPeriod,
  insertUserWithProfile,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  auditLog,
  currencies,
  factorSet,
  scope3Results,
  scope3Spend,
} from "@/server/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbCompany, DbSession } from "@/server/db/types";
import type { PlanId } from "@/shared/plans";
import { SI_2025_R3 } from "@/server/db/seed-data/factor-set-si-2025-r3";

/** Insert a company on `plan` + a real user/profile, and build the DbSession. */
async function setupSession(plan: PlanId): Promise<DbSession> {
  const company = await insertCompany({
    plan,
    countryCode: "SI",
    reportingYear: "2024",
    headcount: 10,
  });
  const { user } = await insertUserWithProfile({ companyId: company.id });
  const dbCompany: DbCompany = {
    id: company.id,
    name: "Acme",
    industry: "Manufacturing",
    nace_code: "C25",
    country: "Slovenia",
    country_code: "SI",
    headcount: 10,
    plan: company.plan ?? "trial",
    reporting_year: "2024",
    currency: "EUR",
  };
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    company: dbCompany,
    // esg_admin membership that production getSession() always resolves (§8, §14.1).
    membership: {
      companyId: dbCompany.id,
      role: "esg_admin",
      status: "active",
      hasIndependentApprover: true,
      activeMemberCount: 1,
    },
  };
}

const post = (body: unknown) =>
  new Request("http://api.example.com/api/scope3-spend", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const del = (query = "") =>
  new Request(`http://api.example.com/api/scope3-spend${query}`, {
    method: "DELETE",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const get = (query = "") =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new Request(`http://api.example.com/api/scope3-spend${query}`) as any;

/**
 * Run `fn` against a platform where NO ACTIVE factor set carries per-€1000
 * spend factors — the state migration 0011 leaves behind, since the 16
 * `scope3_spend:*` rows existed only in `legacy-v1` and the client's `si-2025`
 * carries none by design.
 *
 * IT ARCHIVES RATHER THAN DELETES, and restores in a `finally`. The factor
 * catalogues are reference data that `resetAppTables` deliberately does NOT
 * truncate (they are seeded once per database), so a test that removed them
 * would silently break every later suite in the run. Flipping `status` is the
 * smallest change that makes `activeFactorSetId` answer `null` — it is the only
 * column that function filters sets on — and it is reversible to the row.
 *
 * The sets are found by the SAME three predicates `spendFactorsOf` uses, so
 * "the factor library cannot price spend" is established the way the code
 * defines it, not by naming `legacy-v1` and hoping that is the only one.
 */
async function withoutSpendFactors<T>(fn: () => Promise<T>): Promise<T> {
  const db = getTestDb();
  const rows = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT s.id
      FROM factor_set s
      JOIN emission_factor f ON f.factor_set_id = s.id
     WHERE s.status = 'active'
       AND f.status = 'active'
       AND f.activity_type LIKE 'scope3_spend:%'
       AND f.input_unit = 'EUR_1000'
  `);
  const ids = [...rows].map((r) => r.id);
  if (ids.length > 0) {
    await db
      .update(factorSet)
      .set({ status: "archived" })
      .where(inArray(factorSet.id, ids));
  }
  try {
    return await fn();
  } finally {
    if (ids.length > 0) {
      await db
        .update(factorSet)
        .set({ status: "active" })
        .where(inArray(factorSet.id, ids));
    }
  }
}

describeIntegration(
  "T2.4 /api/scope3-spend (session-guarded spend persist + FX recalc + audit)",
  () => {
    beforeAll(async () => {
      await setupSchema();
    });
    beforeEach(async () => {
      await resetAppTables();
      vi.clearAllMocks();
    });
    afterAll(async () => {
      await closeTestDb();
    });

    it("trial company (scope3=false) → 402 PLAN_REQUIRED on POST (UI bypass blocked)", async () => {
      getSessionMock.mockResolvedValue(await setupSession("trial"));

      const res = await spendPOST(
        post({
          commodityKey: "s3_c1_electronics",
          spendAmount: 10000,
          currency: "EUR",
        }),
      );

      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ ok: false, error: "PLAN_REQUIRED" });
    });

    it("GET returns the DB-derived commodity + currency catalogues", async () => {
      getSessionMock.mockResolvedValue(await setupSession("starter"));
      const res = await spendGET(get());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      // Exactly the 8 seeded EXIOBASE per-€1000 commodities, category derived.
      expect(body.data.commodities).toHaveLength(8);
      const el = body.data.commodities.find(
        (c: { commodityKey: string }) => c.commodityKey === "s3_c1_electronics",
      );
      expect(el.category).toBe(1);
      const mach = body.data.commodities.find(
        (c: { commodityKey: string }) => c.commodityKey === "s3_c2_machinery",
      );
      expect(mach.category).toBe(2);
      expect(body.data.currencies.length).toBeGreaterThan(0);
      expect(body.data.defaultCurrency).toBe("EUR");
      // THE REGRESSION GUARD for the refusal added below: while a spend-capable
      // set exists there is nothing to refuse, and the screen must be told so
      // explicitly rather than by the absence of a key.
      expect(body.data.spendRefusal).toBeNull();
    });

    it("starter → EUR + RSD lines persist, recalc runs, scope3_results reflect FX-converted tCO2e", async () => {
      const session = await setupSession("starter");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      // €10 000 × 350 ÷ 1e6 = 3.5 (cat 1, electronics).
      const eur = await spendPOST(
        post({
          commodityKey: "s3_c1_electronics",
          spendAmount: 10000,
          currency: "EUR",
        }),
      );
      expect(eur.status).toBe(200);
      // RSD 5 000 000 × 0.008541 × 450 ÷ 1e6 = 19.21725 (cat 2, machinery).
      const rsd = await spendPOST(
        post({
          commodityKey: "s3_c2_machinery",
          spendAmount: 5_000_000,
          currency: "RSD",
        }),
      );
      expect(rsd.status).toBe(200);
      const rsdBody = await rsd.json();
      expect(rsdBody.data.lines).toHaveLength(2);

      // Both lines persisted with the SERVER-derived category.
      const lines = await db
        .select()
        .from(scope3Spend)
        .where(eq(scope3Spend.companyId, companyId));
      expect(lines).toHaveLength(2);
      const byKey = Object.fromEntries(lines.map((l) => [l.commodityKey, l]));
      expect(byKey["s3_c1_electronics"].category).toBe(1);
      expect(byKey["s3_c2_machinery"].category).toBe(2);

      // Recalc folded the spend into scope3_results cat 1 and cat 2.
      const results = await db
        .select()
        .from(scope3Results)
        .where(eq(scope3Results.companyId, companyId));
      const cat1 = results.find((r) => r.categoryId === 1);
      const cat2 = results.find((r) => r.categoryId === 2);
      expect(cat1).toBeTruthy();
      expect(cat2).toBeTruthy();
      expect(Number(cat1!.tco2e)).toBeCloseTo(3.5, 2);
      expect(Number(cat2!.tco2e)).toBeCloseTo(19.22, 2);

      // One audit row per upsert.
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(audits).toHaveLength(2);
      expect(audits.every((a) => a.entity === "scope3_spend")).toBe(true);
    });

    it("a commodity_key NOT in the seeded spend set → 422, nothing written", async () => {
      const session = await setupSession("starter");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      // s3_c1_paper is a real scope-3 factor but priced per-tonne, not EUR 1000 spent.
      const res = await spendPOST(
        post({
          commodityKey: "s3_c1_paper",
          spendAmount: 1000,
          currency: "EUR",
        }),
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ ok: false, error: "VALIDATION" });
      expect(
        await db
          .select()
          .from(scope3Spend)
          .where(eq(scope3Spend.companyId, companyId)),
      ).toHaveLength(0);
    });

    it("negative spend and unknown currency → 422", async () => {
      getSessionMock.mockResolvedValue(await setupSession("starter"));
      const neg = await spendPOST(
        post({
          commodityKey: "s3_c1_electronics",
          spendAmount: -5,
          currency: "EUR",
        }),
      );
      expect(neg.status).toBe(422);
      const badCcy = await spendPOST(
        post({
          commodityKey: "s3_c1_electronics",
          spendAmount: 100,
          currency: "ZZZ",
        }),
      );
      expect(badCcy.status).toBe(422);
    });

    it("ignores a client-sent bogus category/factor — the server derives the category", async () => {
      const session = await setupSession("starter");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      // electronics is cat 1; the body lies (category 2, a forged factor + rate).
      const res = await spendPOST(
        post({
          commodityKey: "s3_c1_electronics",
          spendAmount: 10000,
          currency: "EUR",
          category: 2,
          factor: 999999,
          rate: 12345,
        }),
      );
      expect(res.status).toBe(200);

      const [line] = await db
        .select()
        .from(scope3Spend)
        .where(eq(scope3Spend.companyId, companyId));
      expect(line.category).toBe(1); // derived, not the body's 2
      // The forged factor/rate never touched the number: 10 000 × 350 ÷ 1e6 = 3.5.
      const results = await db
        .select()
        .from(scope3Results)
        .where(
          and(
            eq(scope3Results.companyId, companyId),
            eq(scope3Results.categoryId, 1),
          ),
        );
      // T3.6 INVERTS THIS: it used to read "No monthly data → recalc is skipped,
      // but the persisted category proves it", because `recalculateEmissions`
      // threw `NoMonthlyDataError` and the route swallowed it. The narrow
      // `recalculateScope3Spend` needs no monthly data at all, so with NO monthly
      // rows the line is priced: 200 and cat 1 = 3.5 t, from the derived category.
      expect(results).toHaveLength(1);
      expect(Number(results[0].tco2e)).toBeCloseTo(3.5, 2);
    });

    it("cross-tenant DELETE → 404 NO_DATA, the owner's line survives", async () => {
      // Owner creates a line.
      const owner = await setupSession("starter");
      getSessionMock.mockResolvedValue(owner);
      await spendPOST(
        post({
          commodityKey: "s3_c1_electronics",
          spendAmount: 10000,
          currency: "EUR",
        }),
      );
      const db = getTestDb();

      // Attacker tries to delete the owner's commodity for the same year.
      const attacker = await setupSession("starter");
      getSessionMock.mockResolvedValue(attacker);
      const res = await spendDELETE(
        del("?year=2024&commodityKey=s3_c1_electronics"),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "NO_DATA" });

      // Owner's line is untouched.
      const survivors = await db
        .select()
        .from(scope3Spend)
        .where(eq(scope3Spend.companyId, owner.company!.id));
      expect(survivors).toHaveLength(1);
    });

    it("owned DELETE removes the line + writes a delete audit", async () => {
      const session = await setupSession("starter");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();

      await spendPOST(
        post({
          commodityKey: "s3_c1_electronics",
          spendAmount: 10000,
          currency: "EUR",
        }),
      );
      const res = await spendDELETE(
        del("?year=2024&commodityKey=s3_c1_electronics"),
      );
      expect(res.status).toBe(200);

      expect(
        await db
          .select()
          .from(scope3Spend)
          .where(eq(scope3Spend.companyId, companyId)),
      ).toHaveLength(0);
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.companyId, companyId));
      expect(audits.map((a) => a.action)).toContain("delete");
    });

    it("missing FX rate → line saves, a warning surfaces, it contributes 0 (D4)", async () => {
      const session = await setupSession("starter");
      getSessionMock.mockResolvedValue(session);
      const companyId = session.company!.id;
      const db = getTestDb();
      // A currency that exists in `currencies` but has NO fx_rates row.
      await db
        .insert(currencies)
        .values({ code: "XXX", name: "No-rate test", symbol: "¤", decimals: 2 })
        .onConflictDoNothing();

      const res = await spendPOST(
        post({
          commodityKey: "s3_c1_electronics",
          spendAmount: 10000,
          currency: "XXX",
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      // Line is saved…
      expect(
        await db
          .select()
          .from(scope3Spend)
          .where(eq(scope3Spend.companyId, companyId)),
      ).toHaveLength(1);
      // …but it warns and contributes 0 — no cat 1 result row.
      expect(body.data.warnings.some((w: string) => /XXX/.test(w))).toBe(true);
      const cat1 = await db
        .select()
        .from(scope3Results)
        .where(
          and(
            eq(scope3Results.companyId, companyId),
            eq(scope3Results.categoryId, 1),
          ),
        );
      expect(cat1).toHaveLength(0);
    });

    // ── NO ACTIVE SET CAN PRICE SPEND (post-0011) ──────────────────────────
    // The four tests below are the whole of the conditional branch: the GET says
    // WHY and names the set, the POST refuses BY NAME, the money already entered
    // survives, and none of it fires while a spend-capable set exists.

    it("GET names the refusal and the factor set in force when nothing can price spend", async () => {
      getSessionMock.mockResolvedValue(await setupSession("starter"));
      await withoutSpendFactors(async () => {
        const res = await spendGET(get());
        // Still a 200 with an empty catalogue — the read is not an error…
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.commodities).toEqual([]);
        // …but the emptiness now carries its reason, and the set it is about.
        expect(body.data.spendRefusal.refusal).toBe("NO_SPEND_FACTORS");
        expect(body.data.spendRefusal.factor_set).toEqual({
          code: SI_2025_R3.code,
          name: SI_2025_R3.name,
        });
      });
    });

    it("POST stays 422 but carries NO_SPEND_FACTORS + the set, not a bare validation failure", async () => {
      const session = await setupSession("starter");
      getSessionMock.mockResolvedValue(session);
      const db = getTestDb();

      await withoutSpendFactors(async () => {
        const res = await spendPOST(
          post({
            commodityKey: "s3_c1_electronics",
            spendAmount: 10000,
            currency: "EUR",
          }),
        );
        // NOT weakened into a 200: the write is still refused, with the status
        // it always had. What is new is that the body says why.
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({
          ok: false,
          error: "VALIDATION",
          refusal: "NO_SPEND_FACTORS",
          factor_set: { code: SI_2025_R3.code, name: SI_2025_R3.name },
        });
      });

      // Nothing was written, and no audit row was invented for a refused write.
      expect(
        await db
          .select()
          .from(scope3Spend)
          .where(eq(scope3Spend.companyId, session.company!.id)),
      ).toHaveLength(0);
    });

    it("money already entered survives and is still returned beside the refusal", async () => {
      const session = await setupSession("starter");
      getSessionMock.mockResolvedValue(session);

      // Entered while the feature worked…
      expect(
        (
          await spendPOST(
            post({
              commodityKey: "s3_c1_electronics",
              spendAmount: 10000,
              currency: "EUR",
            }),
          )
        ).status,
      ).toBe(200);

      await withoutSpendFactors(async () => {
        const body = await (await spendGET(get())).json();
        // …is still there, at the amount and in the currency it was entered in.
        // The screen marks it UNPRICED off `spendRefusal`; what it must never do
        // is stop showing it, or show it as a line that came to zero.
        expect(body.data.lines).toHaveLength(1);
        expect(body.data.lines[0].commodityKey).toBe("s3_c1_electronics");
        expect(body.data.lines[0].spendAmount).toBe(10000);
        expect(body.data.lines[0].currency).toBe("EUR");
        expect(body.data.spendRefusal.refusal).toBe("NO_SPEND_FACTORS");
      });
    });

    it("the refusal names an ACTIVE set — never a period's pin that was archived", async () => {
      const session = await setupSession("starter");
      getSessionMock.mockResolvedValue(session);
      // A period pinned to `legacy-v1` (the harness default) for the very year
      // the editor is showing. `withoutSpendFactors` archives that set, so the
      // pin now names a set the refusal cannot truthfully describe — and the
      // sentence ("this set carries no spend factors") is only provable of the
      // ACTIVE ones. The fallback is what keeps it true.
      await insertPeriod(session.company!.id, { reportingYear: 2024 });

      await withoutSpendFactors(async () => {
        const body = await (await spendGET(get("?year=2024"))).json();
        expect(body.data.spendRefusal.factor_set).toEqual({
          code: SI_2025_R3.code,
          name: SI_2025_R3.name,
        });
      });
    });

    it("unauthenticated → 401", async () => {
      getSessionMock.mockResolvedValue(null);
      const res = await spendPOST(
        post({
          commodityKey: "s3_c1_electronics",
          spendAmount: 100,
          currency: "EUR",
        }),
      );
      expect(res.status).toBe(401);
    });
  },
);
