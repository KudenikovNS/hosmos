/**
 * [LOCAL-DB] 0009 — factor set `si-2025`, THE DEFAULT SET, read back out of a
 * migrated database (DM-21/DM-22, CALC-2/CALC-3, К-24).
 *
 * It reads the DATABASE and never a TypeScript module, on purpose. `si-2025`
 * has no `seed-data/*` twin — it ships only inside
 * `drizzle/0009_factor_set_si_2025.sql`, because `deploy.yml` ships neither
 * `seed.ts` nor `tsx` (О-13, MIG-6) — so a suite that imported a module would be
 * checking a file production never runs. Everything below therefore asserts
 * against the rows the migrator actually wrote.
 *
 * What this file exists to prove, and why each half would otherwise be invisible
 * until a customer's calculation run:
 *
 *   1. THE SET RESOLVES TO ITSELF. Every row, asked for by its own resolve key,
 *      comes back as itself with the identity conversion and NO ambiguity — the
 *      same sweep `calc/__tests__/factors.test.ts` runs over `legacy-v1`'s 440
 *      rows. Unlike `legacy-v1`, every row here carries a `publication_date`, so
 *      a tie would be broken by a date rather than by luck; the sweep is what
 *      says no tie is reached at all.
 *   2. IT IS THE DEFAULT, AND `legacy-v1` IS STILL PINNABLE. "Default" is not a
 *      column: `resolveFactorSet` takes the ACTIVE set with the greatest
 *      `published_at`. So the property is asserted as the two data facts that
 *      produce it — both sets active, `si-2025` published later — plus the
 *      ordering itself, run as the query the service runs.
 *   3. THE VOCABULARY IS THE ONE THE FORMS EMIT. An `activity_type` outside
 *      `FUEL_TYPES` / `REFRIGERANT_TYPES` / the two Scope-2 constants of
 *      `calc/scope2.ts`, or an `input_unit` outside `UNIT_CODES`, is a factor no
 *      screen can reach — decoration that makes the set look complete. There is
 *      no CHECK constraint on either column (§0.8), so this is the only thing
 *      holding that line.
 *   4. THE SET IS DELIBERATELY NARROW, AND THAT IS ASSERTED RATHER THAN
 *      REGRETTED. `legacy-v1` prices 163 activity types; this one prices 14, and
 *      a fuel it does not price MUST fail with `failed_missing_factor` instead
 *      of falling back to a British number (§0.7, AC-6). The refusals are
 *      asserted as explicitly as the hits — they are the feature.
 *   5. ITS CALORIFIC VALUE IS ITS OWN (0010). The shared `unit_conversion` table
 *      holds DEFRA's UK gas figures; this set holds ARSO's, derived from the
 *      workbook's `conversion_to_gj` column and scoped to it by `factor_set_id`.
 *      Before that column existed a Slovenian gas bill in `kWh` reached this
 *      set's factors through British numbers, by two routes 3.69% apart that
 *      tied into FACTORS_AMBIGUOUS. Section 4b prices the bill, proves every
 *      route now lands on the source's own 0.19980 kg/kWh in exact decimal, and
 *      proves the ten rows are invisible to any other pin — which is what keeps
 *      `legacy-v1` and every period pinned to it byte-identical.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// `scope3/factors.ts` is `server-only` (it is a request-path module); the last
// test of this file calls it directly. Same stub the Scope-3 suites use.
vi.mock("server-only", () => ({}));

import {
  compare,
  formatDecimal,
  multiply,
  parseDecimal,
  roundHalfUp,
  subtract,
} from "@/server/calc/decimal";
import {
  isFactorsAmbiguousError,
  resolveFactor,
  type FactorCandidate,
} from "@/server/calc/factors";
import { ROUNDING_DECIMALS } from "@/server/calc/formula-version";
import { buildFactorSnapshot } from "@/server/calc/run";
import {
  computeScope1,
  type Scope1Factor,
  type Scope1Row,
} from "@/server/calc/scope1";
import { convertUnit, type ConversionCandidate } from "@/server/calc/units";
import {
  activeFactorSetId,
  loadSpendFactorRows,
} from "@/server/scope3/factors";
import { FUEL_TYPES, REFRIGERANT_TYPES, UNIT_CODES } from "@/shared/enums";

import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  setupSchema,
} from "./harness";
import { SI_2025_R5 } from "@/server/db/seed-data/factor-set-si-2025-r5";

/** The set 0009 publishes, and the set it takes the default away from. */
const SET_CODE = "si-2025";
const LEGACY_SET_CODE = "legacy-v1";

/** 0009's own count. A literal, because the migration's row list IS the source. */
const EXPECTED_ROWS = 23;

/**
 * The whole vocabulary this set is allowed to speak, as the FORMS produce it.
 *
 * `FUEL_TYPES` and `REFRIGERANT_TYPES` are what `inventory/_lib/tabs.ts` builds
 * the `stationary`/`onsite` and `fugitive` selects from. The two Scope-2 strings
 * are NOT free text either: they are `LOCATION_ACTIVITY_TYPES.electricity` and
 * `RESIDUAL_MIX_ACTIVITY_TYPES.electricity` in `server/calc/scope2.ts`, written
 * out here rather than imported because importing that module pulls the drizzle
 * schema into a data test for two string literals.
 */
const ALLOWED_ACTIVITY_TYPES: ReadonlySet<string> = new Set<string>([
  ...FUEL_TYPES,
  ...REFRIGERANT_TYPES,
  "grid:grid_electricity",
  "grid:residual_mix",
]);

/**
 * What the set covers, spelled out. Not derived from the rows — a derived list
 * would agree with whatever the migration lost. This is the coverage the choice
 * to drop the 23 United Kingdom rows bought, and the number a reviewer should
 * have to change deliberately.
 */
const EXPECTED_COVERAGE: readonly string[] = [
  "butane",
  "coal_industrial",
  "fuel_oil",
  "gas_oil",
  "grid:grid_electricity",
  "grid:residual_mix",
  "lpg",
  "natural_gas",
  "petrol_mineral",
  "propane",
  "r134a",
  "r32",
  "r404a",
  "r410a",
];

type DbFactorRow = {
  id: string;
  factor_set_id: string;
  factor_code: string;
  factor_name: string;
  activity_type: string;
  geography: string;
  input_unit: string;
  applicable_year: number | null;
  publication_date: string | null;
  source_name: string;
  source_version: string;
  supplier_name: string | null;
  factor_value: string;
  output_unit: string;
  co2_value: string | null;
  gwp_basis: string | null;
  biogenic_treatment: string | null;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
};

/** The date every resolution below is judged at — a 2025 period's end. */
const AS_OF = "2025-12-31";

describeIntegration("0009 factor set si-2025 in the database", () => {
  let setId: string;
  /** `legacy-v1`'s id — the pin a set-scoped conversion must NOT reach (0010). */
  let legacySetId: string;
  let rows: DbFactorRow[];
  let candidates: FactorCandidate[];
  /** The WHOLE `unit_conversion` table: shared rows and every set's own. */
  let conversions: ConversionCandidate[];
  /** The subset 0010 gives to THIS set. */
  let mine: ConversionCandidate[];

  beforeAll(async () => {
    await setupSchema();
    const db = getTestDb();

    const sets = await db.execute<{ id: string }>(
      sql`SELECT id FROM factor_set WHERE code = ${SET_CODE}`,
    );
    expect(sets).toHaveLength(1);
    setId = sets[0].id;

    const legacy = await db.execute<{ id: string }>(
      sql`SELECT id FROM factor_set WHERE code = ${LEGACY_SET_CODE}`,
    );
    expect(legacy).toHaveLength(1);
    legacySetId = legacy[0].id;

    rows = await db.execute<DbFactorRow>(sql`
      SELECT id, factor_set_id, factor_code, factor_name, activity_type, geography,
             input_unit, applicable_year, publication_date::text AS publication_date,
             source_name, source_version, supplier_name, factor_value::text AS factor_value,
             output_unit, co2_value::text AS co2_value, gwp_basis, biogenic_treatment,
             status, valid_from::text AS valid_from, valid_to::text AS valid_to
      FROM emission_factor WHERE factor_set_id = ${setId}
      ORDER BY geography DESC, activity_type, input_unit
    `);

    candidates = rows.map((r) => ({
      id: r.id,
      factorSetId: r.factor_set_id,
      activityType: r.activity_type,
      geography: r.geography,
      inputUnit: r.input_unit,
      applicableYear: r.applicable_year,
      publicationDate: r.publication_date,
      sourceName: r.source_name,
      sourceVersion: r.source_version,
      supplierName: r.supplier_name,
      factorValue: r.factor_value,
      outputUnit: r.output_unit,
      status: r.status,
      validFrom: r.valid_from,
      validTo: r.valid_to,
    }));

    // THE WHOLE TABLE, shared rows and set-scoped rows alike — the scope filter
    // belongs to `calc/units.ts` and is one of the things under test (0010).
    const conversionRows = await db.execute<{
      id: string;
      from_unit: string;
      to_unit: string;
      multiplier: string;
      activity_context: string | null;
      factor_set_id: string | null;
    }>(sql`
      SELECT id, from_unit, to_unit, multiplier::text AS multiplier,
             activity_context, factor_set_id
      FROM unit_conversion
    `);
    conversions = conversionRows.map((c) => ({
      id: c.id,
      fromUnit: c.from_unit,
      toUnit: c.to_unit,
      multiplier: c.multiplier,
      activityContext: c.activity_context,
      factorSetId: c.factor_set_id,
    }));
    mine = conversions.filter((c) => c.factorSetId === setId);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // ─── 1. The set is what 0009 says it is ────────────────────────────────────

  it("ships exactly 23 active factors, every one of them dated", () => {
    expect(rows).toHaveLength(EXPECTED_ROWS);
    expect(rows.every((r) => r.status === "active")).toBe(true);
    // THE LOAD-BEARING ONE. All 440 rows of `legacy-v1` have a NULL publication
    // date, so a set mixing dated and undated rows on one resolution key would
    // hand every tie to the dated row for a reason nobody chose. Dating all 23
    // is what keeps CALC-2's last tie-break meaningful inside this set.
    expect(rows.filter((r) => r.publication_date === null)).toEqual([]);
    // …and NO validity window: CALC-2 judges `valid_from`/`valid_to` against the
    // period's END DATE, so the workbook's source vintages (IPCC 2006, DESNZ
    // 2026) copied verbatim would have made 10 of these 23 rows unreachable by
    // construction. The year lives in `applicable_year` (О-18) instead.
    expect(
      rows.filter((r) => r.valid_from !== null || r.valid_to !== null),
    ).toEqual([]);
    // No supplier's own factor here, so the 0007 rung is unreachable by
    // construction and cannot silently price anybody's electricity.
    expect(rows.every((r) => r.supplier_name === null)).toBe(true);
  });

  it("states its gases where DM-22 puts them, not in a second output unit", () => {
    // One output unit set-wide: `calculation.co2e_result` sums these, and two
    // output units inside one set would add two different quantities.
    expect([...new Set(rows.map((r) => r.output_unit))]).toEqual(["kgCO2e"]);
    // The workbook's `gas` column, expressed as DM-22's gas split: the 19
    // combustion/electricity rows are CO2 only, the 4 refrigerant GWPs are not.
    const co2Only = rows.filter((r) => r.co2_value !== null);
    const aggregate = rows.filter((r) => r.co2_value === null);
    expect(co2Only).toHaveLength(19);
    expect(aggregate.map((r) => r.activity_type).sort()).toEqual([
      "r134a",
      "r32",
      "r404a",
      "r410a",
    ]);
    // A CO2-only factor's CO2 component IS the whole factor.
    for (const r of co2Only) {
      expect(`${r.factor_code}:${r.co2_value}`).toBe(
        `${r.factor_code}:${r.factor_value}`,
      );
    }
    // AR5 set-wide, as on `legacy-v1`. Load-bearing on the four gases above:
    // 677 / 1300 / 3943 / 1924 are the AR5 GWP-100 values (AR6 differs).
    expect([...new Set(rows.map((r) => r.gwp_basis))]).toEqual(["AR5"]);
  });

  // ─── 2. Nothing here is decoration ─────────────────────────────────────────

  it("files every row under an activity_type and unit the input forms produce", () => {
    for (const r of rows) {
      expect(`${r.factor_code}: ${r.activity_type}`).toBe(
        `${r.factor_code}: ${ALLOWED_ACTIVITY_TYPES.has(r.activity_type) ? r.activity_type : "NOT IN THE FORM VOCABULARY"}`,
      );
      expect(`${r.factor_code}: ${r.input_unit}`).toBe(
        `${r.factor_code}: ${(UNIT_CODES as readonly string[]).includes(r.input_unit) ? r.input_unit : "NOT A UnitCode"}`,
      );
      expect(`${r.factor_code}: ${r.geography}`).toBe(
        `${r.factor_code}: ${["SI", "GLOBAL"].includes(r.geography) ? r.geography : "NOT A GEOGRAPHY THIS SET USES"}`,
      );
    }
  });

  it("covers 14 activity types and says so out loud", () => {
    expect([...new Set(rows.map((r) => r.activity_type))].sort()).toEqual([
      ...EXPECTED_COVERAGE,
    ]);
  });

  // ─── 3. THE SWEEP — every row resolves to itself, with no ambiguity ────────

  it("resolves every one of the 23 rows to ITSELF, with no ambiguity", () => {
    expect(candidates).toHaveLength(EXPECTED_ROWS);
    expect(conversions.length).toBeGreaterThan(0);

    for (const row of candidates) {
      let outcome: string;
      try {
        const result = resolveFactor(
          {
            factorSetId: setId,
            activityType: row.activityType,
            geography: row.geography,
            inputUnit: row.inputUnit,
            applicableYear: row.applicableYear,
            asOf: AS_OF,
          },
          candidates,
          conversions,
        );
        outcome =
          result.status === "ok"
            ? `ok ${result.factor.id} x${result.conversion.multiplier}`
            : result.status;
      } catch (e) {
        outcome = isFactorsAmbiguousError(e)
          ? `FACTORS_AMBIGUOUS ${e.candidateIds.join(" + ")}`
          : String(e);
      }
      // One assertion carrying the row's identity, so a failure names the row
      // rather than reporting that two booleans differ.
      expect(
        `${row.inputUnit} ${row.activityType}@${row.geography}: ${outcome}`,
      ).toBe(
        `${row.inputUnit} ${row.activityType}@${row.geography}: ok ${row.id} x1`,
      );
    }
  });

  it("prices a Slovenian site from the SI row and everyone else from GLOBAL", () => {
    // Natural gas in GJ: Slovenia gets ARSO's 55.5, a German site gets the IPCC
    // default 56.1 through the `global` rung. Both are numbers the client chose;
    // neither is a British one.
    const si = resolveFactor(
      {
        factorSetId: setId,
        activityType: "natural_gas",
        geography: "SI",
        inputUnit: "GJ",
        applicableYear: 2025,
        asOf: AS_OF,
      },
      candidates,
      conversions,
    );
    expect(si.status).toBe("ok");
    expect(si).toMatchObject({ tier: "site_country" });
    expect(si.value).toBe("55.5");

    const de = resolveFactor(
      {
        factorSetId: setId,
        activityType: "natural_gas",
        geography: "DE",
        inputUnit: "GJ",
        applicableYear: 2025,
        asOf: AS_OF,
      },
      candidates,
      conversions,
    );
    expect(de.status).toBe("ok");
    expect(de).toMatchObject({ tier: "global" });
    expect(de.value).toBe("56.1");
  });

  it("keeps the year-specific rows out of another year, and the GWPs in every year", () => {
    // ARSO publishes a table PER YEAR: the 2025 number is not an approximation
    // of 2024's, so a 2024 Slovenian site does NOT get it. It falls to the IPCC
    // default at the `global` rung — priced in GJ, so a tonne of coal there has
    // no path and fails as `failed_unit`, which is the honest answer.
    const gas2024 = resolveFactor(
      {
        factorSetId: setId,
        activityType: "natural_gas",
        geography: "SI",
        inputUnit: "m3",
        applicableYear: 2024,
        asOf: AS_OF,
      },
      candidates,
      conversions,
    );
    expect(gas2024.status).toBe("failed_unit");

    // A refrigerant GWP does not depend on a year (О-18), so `applicable_year`
    // is NULL and the same row answers 2024 and 2025 alike.
    for (const year of [2024, 2025]) {
      const gwp = resolveFactor(
        {
          factorSetId: setId,
          activityType: "r134a",
          geography: "SI",
          inputUnit: "kg",
          applicableYear: year,
          asOf: AS_OF,
        },
        candidates,
        conversions,
      );
      expect(`${year}: ${gwp.status} ${gwp.value}`).toBe(`${year}: ok 1300`);
    }
  });

  // ─── 4. The refusals ARE the feature ───────────────────────────────────────

  it("refuses every fuel it does not price — never a zero, never a UK number", () => {
    // The five the decision to drop the United Kingdom rows was taken over,
    // plus the per-km fleet factors. All of them exist in `legacy-v1`; none of
    // them is priced here, and §0.7 forbids the alternative.
    const unpriced: ReadonlyArray<[string, string]> = [
      ["wood_pellets", "t"],
      ["wood_chips", "t"],
      ["wood_logs", "t"],
      ["coal_domestic", "t"],
      ["burning_oil", "L"],
      ["diesel_mineral", "L"],
      ["petrol_biofuel", "L"],
      ["car_petrol_avg", "km"],
      ["van_diesel_avg", "km"],
      ["r407c", "kg"],
      ["r22", "kg"],
      ["sf6", "kg"],
    ];
    for (const [activityType, inputUnit] of unpriced) {
      const result = resolveFactor(
        {
          factorSetId: setId,
          activityType,
          geography: "SI",
          inputUnit,
          applicableYear: 2025,
          asOf: AS_OF,
        },
        candidates,
        conversions,
      );
      expect(`${activityType}: ${result.status} ${String(result.value)}`).toBe(
        `${activityType}: failed_missing_factor null`,
      );
    }
  });

  // ─── 4b. 0010 — THE SET'S OWN CALORIFIC VALUE ─────────────────────────────

  it("owns exactly the 10 natural-gas conversions 0010 derives, and no others", () => {
    // Every one of them is `natural_gas` and belongs to THIS set. The list is a
    // literal because the migration's row list IS the source: losing one is a
    // route back to a British calorific value, and an eleventh is either a
    // number nobody derived from `conversion_to_gj` or — worse — a NEW edge,
    // which would price a row this set correctly refuses today (see the
    // 2024/m³ case below, and 0010's "a correction, never a widening").
    //
    // These ten ARE the shared table's natural-gas contextual edges, restated:
    // `seed-data/unit-conversions.ts` states fourteen, and the four this set
    // omits are the ones touching `kWh_gross`, whose basis ARSO does not publish.
    expect(mine.every((c) => c.activityContext === "natural_gas")).toBe(true);
    expect(
      mine
        .map((c) => `${c.fromUnit}→${c.toUnit}=${c.multiplier}`)
        .sort()
        .join("\n"),
    ).toBe(
      [
        "GJ→kWh_net=277.777777777778",
        "MWh→kWh_net=1000",
        "kWh_net→GJ=0.0036",
        "kWh_net→MWh=0.001",
        "kWh_net→kWh=1",
        "kWh_net→m3=0.0968340640718724",
        "kWh→kWh_net=1",
        "kWh→m3=0.0968340640718724",
        "m3→kWh=10.3269444444444",
        "m3→kWh_net=10.3269444444444",
      ].join("\n"),
    );
    expect(mine).toHaveLength(10);

    // NOTHING BUT natural gas, and nothing that was not already an edge. The
    // second half is the invariant that keeps 0010 a correction: every pair
    // below also exists in the shared table, so no route was created.
    const shared = new Set(
      conversions
        .filter((c) => c.factorSetId === null)
        .map((c) => `${c.activityContext ?? ""}|${c.fromUnit}|${c.toUnit}`),
    );
    for (const c of mine) {
      expect(
        `${c.fromUnit}→${c.toUnit}`,
        "0010 restates shared edges; it must not create one",
      ).toBe(
        shared.has(`natural_gas|${c.fromUnit}|${c.toUnit}`)
          ? `${c.fromUnit}→${c.toUnit}`
          : "A NEW EDGE THE SHARED TABLE DOES NOT HAVE",
      );
    }
  });

  it("PRICES A SLOVENIAN GAS BILL IN kWh, and both routes agree", () => {
    // THE DEFECT 0010 CLOSES, against the migrated set. `si-2025` prices gas per
    // m³ (2.0633235), per net kWh (0.1998), per MWh and per GJ; before 0010 a
    // `kWh` row reached the first two through the SHARED table's DEFRA rows —
    // ×0.0906273223251 (1/11.0342 kWh/m³) and ×0.90259 — which give
    // 0.186993483895… and 0.180337482, 3.69% apart. They tied on tier, distance,
    // basis, year and publication date, so the run refused with
    // FACTORS_AMBIGUOUS. Correctly: neither number is ARSO's.
    const result = resolveFactor(
      {
        factorSetId: setId,
        activityType: "natural_gas",
        geography: "SI",
        inputUnit: "kWh",
        applicableYear: 2025,
        asOf: AS_OF,
      },
      candidates,
      conversions,
    );

    // WHICH factor, not merely "it stopped throwing": the net-CV row, reached by
    // the set's own ×1 rename (a billed kWh IS a net kWh on a net-CV set), so it
    // sits on the `as_entered` rung and the invoice's number is not re-derived.
    expect(result.status).toBe("ok");
    expect(result.factor?.inputUnit).toBe("kWh_net");
    expect(result.value).toBe("0.1998");
    expect(result.conversion).toMatchObject({
      fromUnit: "kWh",
      toUnit: "kWh_net",
      multiplier: "1",
      basis: "set_contextual",
    });

    // ── AND THE OTHER ROUTE AGREES — the repair, not merely the refusal ──────
    // Worked in exact decimal (`calc/decimal.ts`), never in float, and under the
    // engine's own rounding rule. 1 kWh, priced four ways:
    //   kWh_net : 1                  × 0.1998    = 0.199800
    //   m3      : 0.0968340640718724 × 2.0633235 = 0.19980000000000001192…
    //   MWh     : 0.001              × 199.8     = 0.199800   (shared physics)
    //   GJ      : 0.0036             × 55.5      = 0.199800   (shared physics)
    const ONE_KWH = parseDecimal("1");
    const priced = (from: string, to: string, factorValue: string): string => {
      const path = convertUnit(from, to, "natural_gas", setId, conversions);
      expect(path.status, `${from} → ${to}`).toBe("ok");
      return formatDecimal(
        roundHalfUp(
          multiply(
            multiply(ONE_KWH, parseDecimal(path.conversion!.multiplier)),
            parseDecimal(factorValue),
          ),
          ROUNDING_DECIMALS,
        ),
        ROUNDING_DECIMALS,
      );
    };

    // The source's own kg CO2 per kWh, to the digit — 0.1998 is what ARSO
    // publishes and 55.5 kg/GJ × 0.0036 GJ/kWh restates.
    expect(priced("kWh", "kWh_net", "0.1998")).toBe("0.199800");
    expect(priced("kWh", "m3", "2.0633235")).toBe("0.199800");
    expect(priced("kWh", "MWh", "199.8")).toBe("0.199800");
    expect(priced("kWh", "GJ", "55.5")).toBe("0.199800");

    // …and the exact products of the two contextual routes, unrounded, differ by
    // 1.2 × 10⁻¹⁷ — the truncation of 0.0036/0.037177 at 15 significant digits
    // and nothing else. Before 0010 the same comparison was 3.69%.
    const viaNet = multiply(parseDecimal("1"), parseDecimal("0.1998"));
    const viaM3 = multiply(
      parseDecimal("0.0968340640718724"),
      parseDecimal("2.0633235"),
    );
    expect(
      compare(subtract(viaM3, viaNet), parseDecimal("0.00000000000000002")) <=
        0,
    ).toBe(true);
    expect(compare(subtract(viaM3, viaNet), parseDecimal("0")) >= 0).toBe(true);
  });

  it("still uses a SHARED conversion where the set states none", () => {
    // 0010 scopes conversions; it does not empty the shared table. Coal is
    // priced per tonne here and the workbook publishes no energy content for it,
    // so a coal row entered in kg is converted by physics — `kg → t ×0.001`,
    // `factor_set_id IS NULL` — exactly as before.
    const path = convertUnit("kg", "t", "coal_industrial", setId, conversions);
    expect(path.status).toBe("ok");
    expect(path.conversion).toMatchObject({
      multiplier: "0.001",
      basis: "universal",
    });

    const result = resolveFactor(
      {
        factorSetId: setId,
        activityType: "coal_industrial",
        geography: "SI",
        inputUnit: "kg",
        applicableYear: 2025,
        asOf: AS_OF,
      },
      candidates,
      conversions,
    );
    expect(result.status).toBe("ok");
    expect(result.value).toBe("2440.68");
    expect(result.conversion?.multiplier).toBe("0.001");
  });

  it("never leaks its calorific value into another set", () => {
    // The SAME table, read under two pins. `legacy-v1` must still get DEFRA's
    // 1/11.0342 and must not get ARSO's: a set-scoped row belongs to its set,
    // and a run pinned elsewhere is not entitled to it — which is what keeps the
    // 440-row set (and every period already pinned to it) byte-identical.
    const mineKwhM3 = convertUnit(
      "kWh",
      "m3",
      "natural_gas",
      setId,
      conversions,
    );
    expect(mineKwhM3.conversion).toMatchObject({
      multiplier: "0.0968340640718724",
      basis: "set_contextual",
    });

    const theirs = convertUnit(
      "kWh",
      "m3",
      "natural_gas",
      legacySetId,
      conversions,
    );
    expect(theirs.conversion).toMatchObject({
      multiplier: "0.0906273223251",
      basis: "contextual",
    });

    // …and the ten rows are invisible to a pin that is neither set, so a third
    // set inherits the SHARED table and nothing else.
    const stranger = convertUnit(
      "m3",
      "kWh_net",
      "natural_gas",
      "00000000-0000-4000-8000-00000000dead",
      conversions,
    );
    expect(stranger.conversion).toMatchObject({
      multiplier: "9.9594",
      basis: "contextual",
    });
  });

  // ─── 5. It is the default, and legacy-v1 is still pinnable ────────────────

  // Since 0015/0020 the newest active set is a LATER revision of this one
  // (`si-2025-r3`, DM-21: a release is a new set, never an edit). What stays
  // true of `si-2025` is that it is active, published after `legacy-v1` and
  // still pinnable; what the ordering now yields is the r4 code (0023).
  it("stays active and pinnable; `resolveFactorSet` picks the newest revision, without archiving legacy-v1", async () => {
    const db = getTestDb();
    // The two data facts that MAKE it the default, asserted as facts.
    const both = await db.execute<{
      code: string;
      status: string;
      published_at: string;
    }>(sql`
      SELECT code, status, published_at::text AS published_at
      FROM factor_set WHERE code IN (${SET_CODE}, ${LEGACY_SET_CODE})
    `);
    const byCode = new Map(both.map((s) => [s.code, s]));
    expect(byCode.get(SET_CODE)?.status).toBe("active");
    expect(byCode.get(LEGACY_SET_CODE)?.status).toBe("active");
    expect(
      byCode.get(SET_CODE)!.published_at >
        byCode.get(LEGACY_SET_CODE)!.published_at,
    ).toBe(true);

    // …and the ordering itself, run exactly as `resolveFactorSet` runs it.
    // Scoped to nothing: other suites leave active sets behind, and the point is
    // that NONE of them displaces this one on a real database.
    const [winner] = await db.execute<{ code: string }>(sql`
      SELECT code FROM factor_set WHERE status = 'active'
      ORDER BY published_at DESC NULLS LAST, code ASC LIMIT 1
    `);
    expect(winner.code).toBe(SI_2025_R5.code);
  });

  it("does NOT become the set Scope-3 spend is priced from", async () => {
    // THE REGRESSION 0009 ALMOST SHIPPED. `scope3/factors.ts` resolved spend
    // against "the newest active set" — the same query as `resolveFactorSet` —
    // which was true-by-accident while `legacy-v1` was the only active set. This
    // set carries no `scope3_spend:*` row (it is a national Scope-1/2 set), so
    // as the newest set it emptied the commodity dropdown, made the spend route
    // refuse every write, and priced every stored line at 0. Nobody would have
    // been told, because a spend line that cannot be priced contributes nothing
    // rather than failing.
    const db = getTestDb();
    const mine = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM emission_factor
      WHERE factor_set_id = ${setId} AND activity_type LIKE 'scope3_spend:%'
    `);
    expect(mine[0].n).toBe(0);

    // So spend must resolve to the newest active set that CAN price it — since
    // 0023 that is `si-2025-r4` and since 0024 `si-2025-r5`, which carry the
    // eight EXIOBASE rows (before them, `legacy-v1`) — asserted through the function the recalculation and
    // the dropdown both call, not by re-deriving the query here.
    const spendSetId = await activeFactorSetId(db);
    expect(spendSetId).not.toBe(setId);
    const [spendSet] = await db.execute<{ code: string }>(
      sql`SELECT code FROM factor_set WHERE id = ${spendSetId}`,
    );
    expect(spendSet.code).toBe(SI_2025_R5.code);
    expect(await loadSpendFactorRows(db, spendSetId!)).not.toHaveLength(0);
  });
  // ─── 6. WHY THIS FACTOR — the account, on the set that needed it ───────────
  //
  // THE DEFECT THIS SECTION IS THE PROOF FOR. An independent verification found
  // that on this set a Slovenian site is priced by a 2006 IPCC GLOBAL default in
  // 45 (activity, unit, year) combinations, and that NOTHING SAID SO. Two shapes
  // produce it and both are visible in the rows above:
  //
  //   • THE UNIT. `gas_oil` is held nationally per LITRE (ARSO, 2.6673777 kg/L)
  //     and internationally per GJ (IPCC, 74.1 kg/GJ). From `L` the ladder finds
  //     the national factor; from `kWh` it finds only the global one, because no
  //     conversion turns kilowatt-hours into litres of diesel. The two answers
  //     are about 7% apart and both used to report `ok`.
  //   • THE YEAR. All 13 Slovenian rows carry `applicable_year = 2025`, and a
  //     factor published for another year is a different measurement, not an
  //     approximation (T5.1). So a 2024 Slovenian gas bill in GJ falls to the
  //     IPCC 56.1 while ARSO's 55.5 sits in the same set, one year away.
  //
  // NEITHER IS WRONG. The ladder took the only candidate it could reach, and
  // refusing the report would be worse than pricing it. What was wrong was the
  // SILENCE, and these tests are about the silence: the figures below are
  // asserted to be UNCHANGED, and the account beside them to be present.

  it("prices diesel in LITRES nationally, with nothing to disclose", () => {
    const litres = resolveFactor(
      {
        factorSetId: setId,
        activityType: "gas_oil",
        geography: "SI",
        inputUnit: "L",
        applicableYear: 2025,
        asOf: AS_OF,
      },
      candidates,
      conversions,
    );

    expect(litres.status).toBe("ok");
    expect(litres).toMatchObject({ tier: "site_country" });
    expect(litres.value).toBe("2.6673777");

    // THE NOISE FLOOR. The national factor IS the best the set holds for this
    // row, so there is nothing to pass over and the account says so with an
    // EMPTY list — not with a reassurance, and not with the global factor listed
    // as "also considered". Every marker downstream is this list being
    // non-empty, so a false entry here would put an amber flag on a report that
    // deserves none.
    if (litres.status !== "ok") throw new Error("unreachable");
    expect(litres.provenance).toMatchObject({
      tier: "site_country",
      yearBasis: "exact",
      requestedYear: 2025,
      geography: "SI",
      enteredUnit: "L",
      factorUnit: "L",
      unitDistance: "as_entered",
      conversionBasis: "identity",
      conversionMultiplier: "1",
      passedOver: [],
    });
  });

  it("prices the SAME diesel in kWh globally, and NAMES what it could not reach", () => {
    const kwh = resolveFactor(
      {
        factorSetId: setId,
        activityType: "gas_oil",
        geography: "SI",
        inputUnit: "kWh",
        applicableYear: 2025,
        asOf: AS_OF,
      },
      candidates,
      conversions,
    );

    // THE FIGURE HAS NOT MOVED. This task changes what is SAID, not what is
    // computed: the global default still wins, because it is still the only
    // candidate `kWh` reaches, and 1000 kWh still price at
    // 1000 × 0.0036 × 74.1 = 266.760000 kgCO2e.
    expect(kwh.status).toBe("ok");
    expect(kwh).toMatchObject({ tier: "global" });
    expect(kwh.value).toBe("74.1");
    if (kwh.status !== "ok") throw new Error("unreachable");
    expect(kwh.factor.geography).toBe("GLOBAL");
    expect(kwh.conversion.multiplier).toBe("0.0036");

    // AND NOW IT SAYS SO. One passed-over group: ARSO's own Slovenian factor,
    // on the STRONGER rung, published per litre — which `kWh` reaches through no
    // conversion in this set or the shared table.
    expect(kwh.provenance).toMatchObject({
      tier: "global",
      yearBasis: "year_agnostic",
      requestedYear: 2025,
      geography: "GLOBAL",
      enteredUnit: "kWh",
      factorUnit: "GJ",
      unitDistance: "converted",
    });
    expect(kwh.provenance.passedOver).toHaveLength(1);
    expect(kwh.provenance.passedOver[0]).toMatchObject({
      reason: "unit_unreachable",
      tier: "site_country",
      geography: "SI",
      sourceName: "Slovenian Environment Agency (ARSO)",
      applicableYear: 2025,
      inputUnits: ["L"],
    });
    // It names the ROW, not merely the country — the disclosure has to survive
    // the factor library moving on, and an id is what a later reader can chase.
    expect(kwh.provenance.passedOver[0].factorIds).toEqual([
      rows.find((r) => r.factor_code === "arso_si_2025_gas_oil_litre")!.id,
    ]);
  });

  it("prices Slovenian gas in ITS year nationally and in another year globally, saying which", () => {
    const query = (year: number) => ({
      factorSetId: setId,
      activityType: "natural_gas",
      geography: "SI",
      inputUnit: "GJ",
      applicableYear: year,
      asOf: AS_OF,
    });

    const y2025 = resolveFactor(query(2025), candidates, conversions);
    expect(y2025.status).toBe("ok");
    expect(y2025.value).toBe("55.5");
    if (y2025.status !== "ok") throw new Error("unreachable");
    expect(y2025.provenance).toMatchObject({
      tier: "site_country",
      yearBasis: "exact",
      passedOver: [],
    });

    const y2024 = resolveFactor(query(2024), candidates, conversions);
    expect(y2024.status).toBe("ok");
    expect(y2024.value).toBe("56.1");
    if (y2024.status !== "ok") throw new Error("unreachable");
    // Priced by a YEAR-AGNOSTIC GLOBAL factor — both halves stated, because
    // "global" and "for no particular year" are two different weaknesses and a
    // reader has to be able to tell which one this line has.
    expect(y2024.provenance).toMatchObject({
      tier: "global",
      yearBasis: "year_agnostic",
      requestedYear: 2024,
    });

    // …while an EXACT-YEAR NATIONAL factor exists, for another year. One entry,
    // not four and not two: ARSO publishes ONE measurement in m³, kWh_net, MWh
    // and GJ, the wrong year disqualifies all four alike, and a list that split
    // them by which denomination `GJ` happens to reach would be two sentences
    // about one fact.
    expect(y2024.provenance.passedOver).toHaveLength(1);
    const passed = y2024.provenance.passedOver[0];
    expect(passed).toMatchObject({
      reason: "year_mismatch",
      tier: "site_country",
      geography: "SI",
      sourceName: "Slovenian Environment Agency (ARSO)",
      applicableYear: 2025,
    });
    expect(passed.inputUnits).toEqual(["GJ", "MWh", "kWh_net", "m3"]);
  });

  it("says nothing about another country's row, or about a year-free GWP", () => {
    // A GERMAN site. The Slovenian factors are on NO rung for this query — a
    // factor for another country is not something this row was "priced instead
    // of" — so the account is empty even though the figure is a global default.
    // The line between "a legitimate exclusion" and "a disclosable substitution"
    // is exactly this, and getting it wrong would put a marker on every line of
    // every report outside Slovenia.
    const de = resolveFactor(
      {
        factorSetId: setId,
        activityType: "natural_gas",
        geography: "DE",
        inputUnit: "GJ",
        applicableYear: 2025,
        asOf: AS_OF,
      },
      candidates,
      conversions,
    );
    expect(de.status).toBe("ok");
    if (de.status !== "ok") throw new Error("unreachable");
    expect(de.provenance).toMatchObject({ tier: "global", passedOver: [] });

    // A refrigerant GWP has no year (О-18) and one unit. `year_agnostic` is the
    // ACCURATE description of it and is NOT a downgrade: there is no year-
    // specific GWP anywhere in the set for it to have missed.
    const gwp = resolveFactor(
      {
        factorSetId: setId,
        activityType: "r134a",
        geography: "SI",
        inputUnit: "kg",
        applicableYear: 2024,
        asOf: AS_OF,
      },
      candidates,
      conversions,
    );
    expect(gwp.status).toBe("ok");
    if (gwp.status !== "ok") throw new Error("unreachable");
    expect(gwp.provenance).toMatchObject({
      yearBasis: "year_agnostic",
      passedOver: [],
    });
  });

  it("carries the account into `factor_snapshot`, through the engine", () => {
    // END TO END, through the two layers that stand between the resolver and a
    // stored row: `computeScope1` (which must hand the account on rather than
    // drop it) and `buildFactorSnapshot` (which must freeze it). A locked report
    // explains itself years later out of THIS object and nothing else.
    const factors: Scope1Factor[] = rows.map((r) => ({
      id: r.id,
      factorSetId: r.factor_set_id,
      activityType: r.activity_type,
      geography: r.geography,
      inputUnit: r.input_unit,
      applicableYear: r.applicable_year,
      publicationDate: r.publication_date,
      sourceName: r.source_name,
      sourceVersion: r.source_version,
      supplierName: r.supplier_name,
      factorValue: r.factor_value,
      outputUnit: r.output_unit,
      status: r.status,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      factorCode: r.factor_code,
      factorName: r.factor_name,
      gwpBasis: r.gwp_basis,
      biogenicTreatment: r.biogenic_treatment,
    }));

    const row = (id: string, unit: string): Scope1Row => ({
      id,
      legalEntityId: "le-1",
      facilityId: "fac-1",
      yearMonth: "2025-06",
      unit,
      state: "approved",
      isDeleted: false,
      supersededById: null,
      activityCategory: "stationary_combustion",
      activityType: "gas_oil",
      activityValue: "1000",
      method: "average_data",
      biogenicFlag: false,
      refrigerantAdded: null,
      refrigerantRecovered: null,
      equipmentCapacity: null,
      openingStock: null,
      closingStock: null,
      leakageRate: null,
      geography: "SI",
    });

    const result = computeScope1(
      [row("row-litres", "L"), row("row-kwh", "kWh")],
      factors,
      conversions,
      {
        startDate: "2025-01-01",
        endDate: AS_OF,
        factorSetId: setId,
      },
    );

    expect(result.runStatus).toBe("ok");
    const [litres, kwh] = result.lines;

    // The arithmetic, unchanged and checkable with a pencil:
    //   1000 L × 1 × 2.6673777 = 2667.377700
    //   1000 kWh × 0.0036 × 74.1 = 266.760000  — about 7% apart, as reported.
    expect(litres.co2eResult).toBe("2667.377700");
    expect(kwh.co2eResult).toBe("266.760000");

    const clean = buildFactorSnapshot(
      litres.factor,
      litres.calculationStatus,
      litres.wantedUnits,
      litres.provenance,
    );
    const downgraded = buildFactorSnapshot(
      kwh.factor,
      kwh.calculationStatus,
      kwh.wantedUnits,
      kwh.provenance,
    );
    if (!clean.resolved || !downgraded.resolved) {
      throw new Error("both lines resolved a factor");
    }

    // NO COLUMN WAS ADDED: this is `calculation.factor_snapshot`, which is
    // `jsonb`, and the account is a key of it in the same snake_case as the rest.
    expect(clean.provenance).toMatchObject({
      tier: "site_country",
      year_basis: "exact",
      entered_unit: "L",
      factor_unit: "L",
      unit_distance: "as_entered",
      conversion_basis: "identity",
      conversion_multiplier: "1",
      passed_over: [],
    });
    expect(downgraded.provenance).toMatchObject({
      tier: "global",
      year_basis: "year_agnostic",
      requested_year: 2025,
      entered_unit: "kWh",
      factor_unit: "GJ",
      unit_distance: "converted",
      conversion_multiplier: "0.0036",
      passed_over: [
        {
          reason: "unit_unreachable",
          tier: "site_country",
          geography: "SI",
          source_name: "Slovenian Environment Agency (ARSO)",
          applicable_year: 2025,
          input_units: ["L"],
        },
      ],
    });

    // And it survives the one thing a `jsonb` column does to an object.
    expect(JSON.parse(JSON.stringify(downgraded))).toEqual(downgraded);
  });
});
