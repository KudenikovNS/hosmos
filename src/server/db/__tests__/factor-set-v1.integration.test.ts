/**
 * [LOCAL-DB] T1.5 — factor set `legacy-v1`, its 440 factors and the unit
 * conversions they need (MIG-4, MIG-5, DM-21…DM-23, CALC-2/CALC-3).
 *
 * Risk R-2, second half: a silently dropped factor is invisible for two stages
 * and then surfaces as a calculation that cannot run — and §0.7 forbids the one
 * thing that would hide it, substituting a zero. Nothing in the application
 * reads `emission_factor` yet, so this suite is the only thing holding the seed
 * honest. It therefore restates the set's shape INDEPENDENTLY of the module that
 * produced it:
 *
 *   1. THE SET IS COMPLETE. The expected row count is RE-DERIVED HERE from the
 *      nine legacy arrays (`EXPECTED_BY_CATEGORY` below) — never a literal, and
 *      never `legacyFactorRows().length`, which would agree with itself no
 *      matter what it lost. Losing a whole category keeps every other invariant
 *      intact; only the per-category arithmetic notices.
 *   2. THE KEY HOLDS. VAL-031 is proven by INSERTING A DUPLICATE and watching
 *      the database refuse it, not by trusting the DDL.
 *   3. NO UNIT CAN FAIL. `failed_unit` (CALC-3) would only appear in S5, so the
 *      conversion graph is built here and every `input_unit` in the set is
 *      proven reachable from every unit an activity row may legitimately carry.
 *   4. NO SILENT ZERO. Every zero factor is on a reviewed exemption list
 *      (VAL-033), checked in BOTH directions so the list cannot rot.
 *   5. PRODUCTION LOOKS LIKE THIS, AND PRODUCTION NEVER SEEDS. `deploy.yml`
 *      ships neither `seed.ts` nor `tsx` (О-13), so the set reaches the server
 *      inside `drizzle/0004_data_model.sql` or not at all. The generated blocks
 *      are compared with the seed modules AND executed against temp tables that
 *      shadow the real ones — the only way to observe "migrated but never
 *      seeded" from inside a suite sharing one warm database.
 *
 * The pure comparisons need no Postgres and deliberately sit outside
 * `describeIntegration`: seed/migration drift is a risk on every commit, not
 * only where a database happens to be running.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UNIT_CODES } from "@/shared/enums";

import type { EmissionFactorSeed } from "../seed-data/factor-set-v1";
import {
  EXPLICIT_ZERO_ACTIVITY_TYPES,
  legacyFactorRows,
  LEGACY_FACTOR_SET,
} from "../seed-data/factor-set-v1";
import {
  FLIGHTS,
  GRID,
  HEAT,
  REFRIGERANTS,
  SCOPE3,
  STATIONARY,
  VEHICLE_ENERGY,
  VEHICLES,
} from "../seed-data/legacy-factors";
import { normaliseLegacyFactors } from "../seed-data/legacy-normalisation";
import { unitConversionRows } from "../seed-data/unit-conversions";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  setupSchema,
} from "./harness";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SQL_FILE = path.join(REPO_ROOT, "drizzle/0004_data_model.sql");

// ─── The set, restated from the arrays ───────────────────────────────────────

/**
 * The row count each legacy array MUST contribute, counted here from the tuples
 * themselves. This is the assertion the task turns on: a category that stops
 * being seeded leaves every other invariant in this file green.
 */
const EXPECTED_BY_CATEGORY = {
  stationary_fuel: STATIONARY.reduce((n, [, , , years]) => n + years.length, 0),
  vehicle:
    VEHICLES.reduce((n, [, , , , years]) => n + years.length, 0) +
    VEHICLE_ENERGY.reduce((n, [, , , years]) => n + years.length, 0),
  flight: FLIGHTS.reduce((n, [, , , years]) => n + years.length, 0),
  // Year-agnostic: one row per gas, keyed by GWP version (the seed is AR5-only).
  refrigerant: REFRIGERANTS.length,
  grid: GRID.reduce((n, [, , years]) => n + years.length, 0),
  heat: HEAT.reduce((n, [, , , , , , , years]) => n + years.length, 0),
  scope3: SCOPE3.reduce((n, [, , , , , , , years]) => n + years.length, 0),
} as const;

const EXPECTED_TOTAL = Object.values(EXPECTED_BY_CATEGORY).reduce(
  (a, b) => a + b,
  0,
);

/** The legacy `unit` that marks a Scope-3 row as spend-based (О-8). */
const SPEND_LEGACY_UNIT = "EUR 1000 spent";

/** `scope3_spend:*` rows, counted from `SCOPE3` rather than from the seed. */
const EXPECTED_SPEND = SCOPE3.filter(
  ([, , , , unit]) => unit === SPEND_LEGACY_UNIT,
).reduce((n, [, , , , , , , years]) => n + years.length, 0);

const EXPECTED_SPEND_COMMODITIES = SCOPE3.filter(
  ([, , , , unit]) => unit === SPEND_LEGACY_UNIT,
).length;

/**
 * Every unit an activity row priced against a factor in `input_unit` may
 * legitimately be entered in — the input to the CALC-3 coverage proof, written
 * out by hand rather than derived from `unit_conversion` (deriving it from the
 * table under test would make the test agree with whatever the table says).
 *
 * The reasoning per entry:
 *   - `kWh` — grid, district heat and Scope-3 c3/c11 are METERED energy with no
 *     calorific basis; §4.10 allows kWh / MWh / GJ on a `purchased_energy_activity`.
 *   - `kWh_gross` / `kWh_net` — the Scope-1 fuel bases. A user reads kWh off a
 *     gas invoice (or MWh/GJ off a large one) and must reach both.
 *   - `kg` / `t`, `L` / `m3` — the two pairs the model can convert exactly.
 *   - the rest are IDENTITY-ONLY: nothing converts a room-night, a parcel or
 *     €1000 of spend into anything else, and `km` is the only distance code in
 *     `UNIT_CODES`. Listing them is the decision; an empty table entry would be
 *     an omission.
 */
const ENTRY_UNITS: Record<string, readonly string[]> = {
  kWh: ["kWh", "MWh", "GJ"],
  // No factor in v1 is priced in MWh or GJ, so these two entries are never
  // exercised by the loops below — they are here because the table has to cover
  // the WHOLE of `UNIT_CODES` (asserted), which is what makes the next factor
  // set arriving in MWh a red test rather than a silent `failed_unit`.
  MWh: ["MWh", "kWh", "GJ"],
  GJ: ["GJ", "kWh", "MWh"],
  kWh_gross: ["kWh_gross", "kWh", "MWh", "GJ"],
  kWh_net: ["kWh_net", "kWh", "MWh", "GJ"],
  kg: ["kg", "t"],
  t: ["t", "kg"],
  L: ["L", "m3"],
  m3: ["m3", "L"],
  km: ["km"],
  tkm: ["tkm"],
  pkm: ["pkm"],
  EUR_1000: ["EUR_1000"],
  unit: ["unit"],
  parcel: ["parcel"],
  room_night: ["room_night"],
  day: ["day"],
  m2_year: ["m2_year"],
};

// ─── The generated blocks of 0004, read as text ──────────────────────────────

function generatedBlock(id: string): string {
  const migration = readFileSync(SQL_FILE, "utf8");
  const begin = migration.indexOf(`-- >>> BEGIN GENERATED: ${id}`);
  const end = migration.indexOf(`-- <<< END GENERATED: ${id}`);
  expect(
    begin,
    `0004_data_model.sql has no generated ${id} block — production would come ` +
      "up with NO factor set at all, so it could not create a reporting period " +
      "(О-13). Run `npx tsx scripts/gen-reference-sql.mjs`.",
  ).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return migration.slice(begin, end);
}

/** Every VALUES tuple of a generated block, as raw text. */
function valueTuples(block: string): string[] {
  const body = block.slice(block.indexOf(") VALUES") + ") VALUES".length);
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("("));
}

/** The first `'…'` literal of every VALUES tuple — the derived `id` column. */
function idsInBlock(id: string): string[] {
  return valueTuples(generatedBlock(id)).map((line) => {
    const m = /^\('([0-9a-f-]{36})'/.exec(line);
    expect(
      m,
      `tuple does not start with a uuid literal: ${line.slice(0, 80)}`,
    ).not.toBeNull();
    return m![1];
  });
}

// ─── Seed ↔ migration, and the numbers themselves (no database) ──────────────

describe("T1.5 the factor set travels with the migration (О-13)", () => {
  it("carries every row the legacy arrays hold — count re-derived here", () => {
    // Deliberately NOT `legacyFactorRows().length === legacyFactorRows().length`.
    expect(legacyFactorRows()).toHaveLength(EXPECTED_TOTAL);
    expect(idsInBlock("emission_factor")).toHaveLength(EXPECTED_TOTAL);
  });

  it("splits across the legacy categories exactly as the arrays do", () => {
    const rows = normaliseLegacyFactors();
    const actual: Record<string, number> = {};
    for (const r of rows)
      actual[r.legacyCategory] = (actual[r.legacyCategory] ?? 0) + 1;
    expect(actual).toEqual(EXPECTED_BY_CATEGORY);
  });

  it("inserts each derived id exactly once, in both derivations", () => {
    const inMigration = idsInBlock("emission_factor");
    expect(new Set(inMigration).size).toBe(inMigration.length);
    expect([...inMigration].sort()).toEqual(
      legacyFactorRows()
        .map((f) => f.id)
        .sort(),
    );
  });

  it("hangs every factor off the one `legacy-v1` id the seed uses", () => {
    const setBlock = generatedBlock("factor_set");
    expect(setBlock).toContain(`'${LEGACY_FACTOR_SET.id}'`);
    expect(setBlock).toContain("'legacy-v1'");
    // `status='active'`: a period may only pin an active set, and after S2
    // production must be able to create a period on day zero.
    expect(setBlock).toContain("'active'");
    expect(setBlock).toContain("ON CONFLICT (code) DO NOTHING;");
    for (const tuple of valueTuples(generatedBlock("emission_factor")))
      expect(tuple).toContain(`'${LEGACY_FACTOR_SET.id}'`);
  });

  it("is idempotent by construction on both factor tables", () => {
    // No arbiter is named on purpose: the primary key AND
    // `emission_factor_resolution_key` must both be a no-op on a second migrate.
    expect(generatedBlock("emission_factor")).toContain(
      "ON CONFLICT DO NOTHING;",
    );
    expect(generatedBlock("unit_conversion")).toContain(
      "ON CONFLICT DO NOTHING;",
    );
  });

  it("carries the same unit conversions the seed does", () => {
    const conversions = unitConversionRows();
    expect(conversions.length).toBeGreaterThan(0);
    expect([...idsInBlock("unit_conversion")].sort()).toEqual(
      conversions.map((c) => c.id).sort(),
    );
  });

  it("gives the whole set gwp_basis AR5, wtt_included false and licence 'unspecified' (MIG-4)", () => {
    for (const f of legacyFactorRows()) {
      expect(f.gwp_basis, f.factor_code).toBe("AR5");
      expect(f.wtt_included, f.factor_code).toBe(false);
      expect(f.source_url, f.factor_code).toBe("unspecified");
      expect(f.licence, f.factor_code).toBe("unspecified");
      expect(f.factor_name.trim(), f.factor_code).toBeTruthy();
      expect(f.source_name.trim(), f.factor_code).toBeTruthy();
      expect(f.source_version.trim(), f.factor_code).toBeTruthy();
    }
  });

  it("keeps the BEV energy-intensity row in kWh, not kgCO2e", () => {
    // `car_bev_kwh_per_km` prices km of fleet-EV driving as Scope-2 CHARGING.
    // MIG-4's blanket `output_unit='kgCO2e'` would relabel kilowatt-hours as
    // emissions, and the row cannot fold into `car_bev_avg`, which already holds
    // (car_bev_avg, GLOBAL, km, year).
    const byOutput = new Map<string, string[]>();
    for (const f of legacyFactorRows())
      byOutput.set(f.output_unit, [
        ...(byOutput.get(f.output_unit) ?? []),
        f.activity_type,
      ]);
    expect([...byOutput.keys()].sort()).toEqual(["kWh", "kgCO2e"]);
    expect([...new Set(byOutput.get("kWh"))]).toEqual(["car_bev_kwh_per_km"]);
  });

  it("marks the biogenic CO2 row and nothing else (D3/VAL-017)", () => {
    const biogenic = legacyFactorRows().filter(
      (f) => f.biogenic_treatment !== null,
    );
    expect([...new Set(biogenic.map((f) => f.activity_type))]).toEqual([
      "wood_logs_biogenic",
    ]);
    expect([...new Set(biogenic.map((f) => f.biogenic_treatment))]).toEqual([
      "biogenic",
    ]);
  });

  it("marks the flight factors as with-radiative-forcing and nothing else", () => {
    const withRf = legacyFactorRows().filter((f) => f.rf_included === true);
    expect(withRf).toHaveLength(EXPECTED_BY_CATEGORY.flight);
    for (const f of withRf) expect(f.activity_type).toMatch(/^flight:/);
  });
});

describe("T1.5 the Scope-3 spend factors (О-8, precondition for T3.6)", () => {
  it("seeds exactly the spend rows of SCOPE3 as `scope3_spend:*`", () => {
    const spend = legacyFactorRows().filter((f) =>
      f.activity_type.startsWith("scope3_spend:"),
    );
    expect(spend).toHaveLength(EXPECTED_SPEND);
    expect(new Set(spend.map((f) => f.activity_type)).size).toBe(
      EXPECTED_SPEND_COMMODITIES,
    );
  });

  it("uses the legacy factor_key verbatim as the commodity key", () => {
    // `scope3_spend.commodity_key` already stores exactly this string (schema.ts
    // documents it as "→ emission_factors.factor_key"), so T3.6's resolve key is
    // a concatenation, not a second mapping table.
    for (const f of legacyFactorRows()) {
      if (!f.activity_type.startsWith("scope3_spend:")) continue;
      expect(f.activity_type).toBe(`scope3_spend:${f.factor_code}`);
      expect(f.input_unit).toBe("EUR_1000");
    }
  });

  it("leaves every other Scope-3 row on the plain `scope3:` prefix", () => {
    const scope3 = legacyFactorRows().filter(
      (f) =>
        f.activity_type.startsWith("scope3") && f.input_unit !== "EUR_1000",
    );
    expect(scope3.length).toBe(EXPECTED_BY_CATEGORY.scope3 - EXPECTED_SPEND);
    for (const f of scope3) expect(f.activity_type).toMatch(/^scope3:/);
  });
});

describe("T1.5 the zero factors are the reviewed ones (VAL-033, §0.7)", () => {
  const zeros = legacyFactorRows().filter((f) => Number(f.factor_value) === 0);

  it("has no zero outside the explicit exemption list", () => {
    expect([...new Set(zeros.map((f) => f.activity_type))].sort()).toEqual(
      [...EXPLICIT_ZERO_ACTIVITY_TYPES].sort(),
    );
  });

  it("has a real zero behind every entry of the list — it cannot rot", () => {
    const zeroTypes = new Set(zeros.map((f) => f.activity_type));
    expect(
      EXPLICIT_ZERO_ACTIVITY_TYPES.filter((t) => !zeroTypes.has(t)),
    ).toEqual([]);
  });

  it("leaves every other factor strictly positive", () => {
    const exempt = new Set(EXPLICIT_ZERO_ACTIVITY_TYPES);
    for (const f of legacyFactorRows()) {
      if (exempt.has(f.activity_type)) continue;
      expect(
        Number(f.factor_value),
        `${f.factor_code}/${f.applicable_year}`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("T1.5 the contextual conversions are derived from the set, not invented", () => {
  /** A `STATIONARY` factor value, by legacy key and year. */
  const stationary = (key: string, year: string): number => {
    const tuple = STATIONARY.find(([k]) => k === key);
    expect(tuple, key).toBeDefined();
    const entry = tuple![3].find(([y]) => y === year);
    expect(entry, `${key}/${year}`).toBeDefined();
    return Number(entry![1]);
  };

  const seeded = (context: string, from: string, to: string): number => {
    const row = unitConversionRows().find(
      (c) =>
        c.activity_context === context &&
        c.from_unit === from &&
        c.to_unit === to,
    );
    expect(row, `${context}: ${from}→${to}`).toBeDefined();
    return Number(row!.multiplier);
  };

  /** Each ratio holds to 0.3% across every year the arrays price. */
  const expectRatio = (
    seededValue: number,
    numerator: string,
    denominator: string,
    years: readonly string[],
  ) => {
    for (const year of years) {
      const expected =
        stationary(numerator, year) / stationary(denominator, year);
      expect(
        Math.abs(seededValue / expected - 1),
        `${numerator}/${denominator} ${year}: seeded ${seededValue}, data ${expected}`,
      ).toBeLessThan(0.003);
    }
  };

  const GAS_YEARS = ["2023", "2024", "2025"] as const;

  it("prices a cubic metre of natural gas at its own factors' calorific value", () => {
    expectRatio(
      seeded("natural_gas", "m3", "kWh_gross"),
      "natural_gas_m3",
      "natural_gas_kwh_gross",
      GAS_YEARS,
    );
    expectRatio(
      seeded("natural_gas", "m3", "kWh_net"),
      "natural_gas_m3",
      "natural_gas_kwh_net",
      GAS_YEARS,
    );
  });

  it("takes the Gross→Net CV step from the set's own two gas factors", () => {
    expectRatio(
      seeded("natural_gas", "kWh_gross", "kWh_net"),
      "natural_gas_kwh_gross",
      "natural_gas_kwh_net",
      GAS_YEARS,
    );
  });

  it("derives the LPG and fuel-oil volume conversions the same way", () => {
    expectRatio(
      seeded("lpg", "L", "kWh_gross"),
      "lpg_litre",
      "lpg_kwh",
      GAS_YEARS,
    );
    expectRatio(seeded("lpg", "t", "L"), "lpg_tonne", "lpg_litre", GAS_YEARS);
    expectRatio(
      seeded("fuel_oil", "t", "L"),
      "fuel_oil_tonne",
      "fuel_oil_litre",
      GAS_YEARS,
    );
  });

  it("keeps every reversed pair a true reciprocal", () => {
    const rows = unitConversionRows();
    let pairs = 0;
    for (const row of rows) {
      const back = rows.find(
        (r) =>
          r.activity_context === row.activity_context &&
          r.from_unit === row.to_unit &&
          r.to_unit === row.from_unit,
      );
      if (!back) continue;
      pairs += 1;
      expect(
        Math.abs(Number(row.multiplier) * Number(back.multiplier) - 1),
        `${row.activity_context ?? "universal"}: ${row.from_unit}↔${row.to_unit}`,
      ).toBeLessThan(1e-6);
    }
    // Not a vacuous loop: the set is built as reversible pairs throughout.
    expect(pairs).toBe(rows.length);
  });
});

// ─── The database ────────────────────────────────────────────────────────────

type FactorRow = {
  factor_code: string;
  activity_type: string;
  geography: string;
  input_unit: string;
  applicable_year: number | null;
  factor_value: string;
  output_unit: string;
  source_name: string;
  source_version: string;
};

type ConversionRow = {
  id: string;
  from_unit: string;
  to_unit: string;
  multiplier: string;
  activity_context: string | null;
};

/**
 * Units reachable from `start` under CALC-3's rules for one activity: universal
 * edges plus the edges whose `activity_context` is that activity. A breadth-first
 * walk, so the assertion really is "reachability in the graph" and not "one row
 * exists".
 */
function reachableFrom(
  edges: ConversionRow[],
  start: string,
  activityType: string,
): Set<string> {
  const usable = edges.filter(
    (e) => e.activity_context === null || e.activity_context === activityType,
  );
  const seen = new Set([start]); // identity: a unit always reaches itself
  const queue = [start];
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const e of usable) {
      if (e.from_unit !== from || seen.has(e.to_unit)) continue;
      seen.add(e.to_unit);
      queue.push(e.to_unit);
    }
  }
  return seen;
}

/**
 * THE WARM DATABASE IS SHARED. `schema-0004.integration.test.ts` creates its own
 * throwaway `factor_set` rows (`t1.2-*`, `status='active'`) and leaves two
 * `unit_conversion` rows behind per run, and neither table is in the harness's
 * TRUNCATE list. So every assertion below is scoped to what T1.5 OWNS — the
 * `legacy-v1` set and the conversion ids the seed derives. The unscoped
 * cardinality the plan asks for ("exactly one factor_set with status='active'")
 * is a property of the MIGRATION, and that is where it is asserted: against the
 * temp tables at the end of this suite, which nothing else can reach.
 */
const SEEDED_CONVERSION_IDS = new Set(unitConversionRows().map((c) => c.id));

/**
 * Drizzle wraps the driver error, so the Postgres `code`/`constraint_name` sit
 * on `cause`; a raw driver error carries them directly. Same unwrapping as
 * `schema-0004.integration.test.ts`.
 */
function pgError(err: unknown): { code?: string; constraint_name?: string } {
  const wrapped = err as {
    cause?: { code?: string; constraint_name?: string };
    code?: string;
    constraint_name?: string;
  };
  return wrapped.cause ?? wrapped;
}

describeIntegration("T1.5 factor set legacy-v1 in the database", () => {
  let factors: FactorRow[];
  /** Every row of the table — extra rows can only make reachability easier. */
  let conversions: ConversionRow[];
  /** Only the rows this task seeds — the ones whose cardinality is an invariant. */
  let seededConversions: ConversionRow[];

  beforeAll(async () => {
    await setupSchema();
    const db = getTestDb();
    factors = [
      ...(await db.execute<FactorRow>(sql`
        SELECT f.factor_code, f.activity_type, f.geography, f.input_unit,
               f.applicable_year, f.factor_value, f.output_unit,
               f.source_name, f.source_version
        FROM emission_factor f
        JOIN factor_set s ON s.id = f.factor_set_id
        WHERE s.code = ${LEGACY_FACTOR_SET.code}
      `)),
    ];
    conversions = [
      ...(await db.execute<ConversionRow>(sql`
        SELECT id, from_unit, to_unit, multiplier, activity_context
        FROM unit_conversion
      `)),
    ];
    seededConversions = conversions.filter((c) =>
      SEEDED_CONVERSION_IDS.has(c.id),
    );
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // ── Completeness ───────────────────────────────────────────────────────────
  it("is an ACTIVE factor set — a period has something to pin", async () => {
    // `reporting_period.factor_set_id` is NOT NULL and only an ACTIVE set may be
    // pinned (DM-21). No active set = no period can be created at all.
    const db = getTestDb();
    const [{ n }] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM factor_set
      WHERE code = ${LEGACY_FACTOR_SET.code} AND status = 'active'
    `);
    expect(n).toBe(1);
    expect(factors.length).toBeGreaterThan(0);
  });

  it("holds every row of the legacy arrays — no factor lost", () => {
    expect(factors).toHaveLength(EXPECTED_TOTAL);
  });

  it("holds every unit conversion the seed derives", () => {
    expect(seededConversions).toHaveLength(unitConversionRows().length);
  });

  it("carries the same resolve keys the normalisation produces", () => {
    const key = (r: {
      activity_type: string;
      geography: string;
      input_unit: string;
      applicable_year: number | null;
    }) =>
      [
        r.activity_type,
        r.geography,
        r.input_unit,
        r.applicable_year ?? "any",
      ].join("|");
    const inDb = factors.map(key).sort();
    expect(new Set(inDb).size).toBe(inDb.length);
    expect(inDb).toEqual(
      legacyFactorRows()
        .map((f) => key(f))
        .sort(),
    );
  });

  it("has exactly as many `scope3_spend:*` factors as SCOPE3 has spend rows", () => {
    const spend = factors.filter((f) =>
      f.activity_type.startsWith("scope3_spend:"),
    );
    expect(spend).toHaveLength(EXPECTED_SPEND);
    expect(new Set(spend.map((f) => f.activity_type)).size).toBe(
      EXPECTED_SPEND_COMMODITIES,
    );
    for (const f of spend) expect(f.input_unit).toBe("EUR_1000");
  });

  // ── VAL-031 ────────────────────────────────────────────────────────────────
  it("refuses a duplicate on the VAL-031 resolution key", async () => {
    const db = getTestDb();
    const duplicate = legacyFactorRows().find(
      (f) => f.applicable_year !== null && f.activity_type === "natural_gas",
    )!;
    // The DDL is not the proof — the DATABASE refusing the row is. Drizzle wraps
    // the driver error, so the Postgres code and constraint name are read off
    // `cause` (same unwrapping as `schema-0004.integration.test.ts`).
    const err = await db
      .execute(
        sql`
        INSERT INTO emission_factor (
          id, factor_set_id, factor_code, factor_name, source_name,
          source_version, applicable_year, geography, activity_type, input_unit,
          factor_value, output_unit, status
        )
        SELECT gen_random_uuid(), s.id, ${duplicate.factor_code}, 'duplicate',
               ${duplicate.source_name}, ${duplicate.source_version},
               ${duplicate.applicable_year}, ${duplicate.geography},
               ${duplicate.activity_type}, ${duplicate.input_unit},
               '1', 'kgCO2e', 'active'
        FROM factor_set s WHERE s.code = ${LEGACY_FACTOR_SET.code}
      `,
      )
      .then(
        () => null,
        (e: unknown) =>
          e as { cause?: { code?: string; constraint_name?: string } },
      );
    expect(
      err,
      "the duplicate factor was ACCEPTED — VAL-031 is not held",
    ).not.toBeNull();
    expect(err!.cause?.code).toBe("23505");
    expect(err!.cause?.constraint_name).toBe("emission_factor_resolution_key");
  });

  it("protects the year-agnostic rows too — О-18 COALESCE sentinel", async () => {
    // The 14 refrigerant factors carry `applicable_year IS NULL` (a GWP is
    // year-independent), and Postgres treats NULLs as DISTINCT in a UNIQUE — so
    // while the key was a table CONSTRAINT it could not refuse a second copy of
    // one, and only the seed's purity stood between the set and a duplicate.
    // T2.8 hands factor entry to an admin screen, at which point that is no
    // protection at all and CALC-2 meets the duplicate as a runtime
    // FACTORS_AMBIGUOUS. So the key is an EXPRESSION unique index over
    // COALESCE(applicable_year, -1): NULL collapses onto one sentinel slot.
    //
    // Both rows are exercised in one place on purpose. The refrigerant is what
    // changed; the year-bearing row is the CONTROL — the sentinel must not have
    // bought NULL-year uniqueness by disturbing the ordinary year-aware case.
    const db = getTestDb();
    const rows = legacyFactorRows();
    const cases: readonly { label: string; row: EmissionFactorSeed }[] = [
      {
        label: "NULL applicable_year (refrigerant)",
        row: rows.find(
          (f) => f.factor_code === "r134a" && f.applicable_year === null,
        )!,
      },
      {
        label: "a year-bearing row",
        row: rows.find(
          (f) =>
            f.applicable_year !== null && f.activity_type === "natural_gas",
        )!,
      },
    ];

    for (const { label, row } of cases) {
      // Transaction-scoped: on rejection Postgres aborts and drizzle rolls back,
      // so the attempt leaves nothing behind for the assertions above to trip on.
      const err = await db
        .transaction(async (tx) => {
          await tx.execute(sql`
            INSERT INTO emission_factor (
              id, factor_set_id, factor_code, factor_name, source_name,
              source_version, applicable_year, geography, activity_type,
              input_unit, factor_value, output_unit, status
            )
            SELECT gen_random_uuid(), s.id, ${row.factor_code}, 'second copy',
                   ${row.source_name}, ${row.source_version},
                   ${row.applicable_year}, ${row.geography},
                   ${row.activity_type}, ${row.input_unit},
                   '1', 'kgCO2e', 'active'
            FROM factor_set s WHERE s.code = ${LEGACY_FACTOR_SET.code}
          `);
        })
        .then(
          () => null,
          (e: unknown) => pgError(e),
        );
      expect(
        err,
        `${label}: the duplicate factor was ACCEPTED — VAL-031 is not held`,
      ).not.toBeNull();
      expect(err!.code, label).toBe("23505");
      expect(err!.constraint_name, label).toBe(
        "emission_factor_resolution_key",
      );
    }

    // …and the set is exactly as long as it was before either attempt: rejected
    // AND rolled back, not rejected after leaving a partial row behind.
    const [{ n }] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM emission_factor f
      JOIN factor_set s ON s.id = f.factor_set_id
      WHERE s.code = ${LEGACY_FACTOR_SET.code}
    `);
    expect(n).toBe(EXPECTED_TOTAL);
  });

  // ── VAL-033 / §0.7 ─────────────────────────────────────────────────────────
  it("stores no zero factor outside the reviewed exemptions", () => {
    const zeros = factors.filter((f) => Number(f.factor_value) === 0);
    expect([...new Set(zeros.map((f) => f.activity_type))].sort()).toEqual(
      [...EXPLICIT_ZERO_ACTIVITY_TYPES].sort(),
    );
  });

  // ── CALC-3 unit coverage ───────────────────────────────────────────────────
  it("classifies every UnitCode, and every input_unit in the set", () => {
    // Completeness both ways: a factor arriving in a unit nobody classified, or
    // a classification for a unit the vocabulary no longer has, is a decision
    // that has to be made rather than discovered in S5.
    expect(Object.keys(ENTRY_UNITS).sort()).toEqual([...UNIT_CODES].sort());
    const inSet = new Set(factors.map((f) => f.input_unit));
    for (const unit of inSet) expect(ENTRY_UNITS[unit], unit).toBeDefined();
    // Identity: every unit trivially reaches itself.
    for (const [unit, entries] of Object.entries(ENTRY_UNITS))
      expect(entries, unit).toContain(unit);
  });

  it("reaches every input_unit from every unit that may be entered for it", () => {
    expect(conversions.length).toBeGreaterThan(0);
    const pairs = new Set(
      factors.map((f) => `${f.activity_type}|${f.input_unit}`),
    );
    for (const pair of pairs) {
      const [activityType, inputUnit] = pair.split("|");
      for (const entry of ENTRY_UNITS[inputUnit]) {
        expect(
          reachableFrom(conversions, entry, activityType),
          `${activityType}: ${entry} → ${inputUnit} has no conversion path — ` +
            "CALC-3 would return failed_unit",
        ).toContain(inputUnit);
      }
    }
  });

  it("does it in ONE hop — CALC-3 looks a multiplier up, it does not search", () => {
    // Stronger than reachability on purpose: a resolver that performs a single
    // table lookup (which is what CALC-3 describes) must find the row itself, so
    // a two-hop chain would still be `failed_unit` in production.
    const direct = new Set(
      conversions.map(
        (c) => `${c.activity_context ?? ""}|${c.from_unit}|${c.to_unit}`,
      ),
    );
    for (const f of factors) {
      for (const entry of ENTRY_UNITS[f.input_unit]) {
        if (entry === f.input_unit) continue; // identity, never looked up
        const universal = `|${entry}|${f.input_unit}`;
        const contextual = `${f.activity_type}|${entry}|${f.input_unit}`;
        expect(
          direct.has(universal) || direct.has(contextual),
          `${f.activity_type}: no direct ${entry} → ${f.input_unit} row`,
        ).toBe(true);
      }
    }
  });

  it("keeps the contextual calorific rows MIG-5 names", () => {
    const gas = conversions.filter((c) => c.activity_context === "natural_gas");
    expect(gas.length).toBeGreaterThan(0);
    expect(
      gas.some((c) => c.from_unit === "m3" && c.to_unit === "kWh_gross"),
    ).toBe(true);
    // A universal m³→kWh would be nonsense (a cubic metre of water is not
    // energy), so the calorific rows MUST carry a context.
    for (const c of conversions) {
      if (c.from_unit !== "m3" && c.to_unit !== "m3") continue;
      if (["L", "m3"].includes(c.from_unit) && ["L", "m3"].includes(c.to_unit))
        continue; // the exact volume pair
      expect(c.activity_context, `${c.from_unit}→${c.to_unit}`).not.toBeNull();
    }
  });

  // ── Seed idempotency ───────────────────────────────────────────────────────
  it("survives a repeated seed without duplicating or losing a factor", async () => {
    const db = getTestDb();
    const before = factors.length;

    // The statements `seed.ts` runs, in shape: same rows, same ON CONFLICT DO
    // NOTHING. Against an already-seeded database this must be a no-op.
    for (const f of legacyFactorRows()) {
      await db.execute(sql`
        INSERT INTO emission_factor (
          id, factor_set_id, factor_code, factor_name, source_name,
          source_version, applicable_year, geography, activity_type, input_unit,
          factor_value, output_unit, gwp_basis, wtt_included,
          biogenic_treatment, rf_included, source_url, licence, status
        )
        SELECT ${f.id}::uuid, s.id, ${f.factor_code}, ${f.factor_name},
               ${f.source_name}, ${f.source_version}, ${f.applicable_year},
               ${f.geography}, ${f.activity_type}, ${f.input_unit},
               ${f.factor_value}, ${f.output_unit}, ${f.gwp_basis},
               ${f.wtt_included}, ${f.biogenic_treatment}, ${f.rf_included},
               ${f.source_url}, ${f.licence}, ${f.status}
        FROM factor_set s WHERE s.code = ${LEGACY_FACTOR_SET.code}
        ON CONFLICT DO NOTHING
      `);
    }
    for (const c of unitConversionRows()) {
      await db.execute(sql`
        INSERT INTO unit_conversion (
          id, from_unit, to_unit, multiplier, activity_context, source, notes
        ) VALUES (
          ${c.id}::uuid, ${c.from_unit}, ${c.to_unit}, ${c.multiplier},
          ${c.activity_context}, ${c.source}, ${c.notes}
        )
        ON CONFLICT DO NOTHING
      `);
    }

    const [{ sets_n, factors_n }] = await db.execute<{
      sets_n: number;
      factors_n: number;
    }>(sql`
      SELECT (SELECT count(*)::int FROM factor_set
               WHERE code = ${LEGACY_FACTOR_SET.code}) AS sets_n,
             (SELECT count(*)::int FROM emission_factor f
                JOIN factor_set s ON s.id = f.factor_set_id
               WHERE s.code = ${LEGACY_FACTOR_SET.code}) AS factors_n
    `);
    expect(sets_n).toBe(1);
    expect(factors_n).toBe(before);

    const after = [
      ...(await db.execute<{ id: string }>(
        sql`SELECT id FROM unit_conversion`,
      )),
    ].filter((c) => SEEDED_CONVERSION_IDS.has(c.id));
    expect(after).toHaveLength(unitConversionRows().length);
  });

  // ── The production path: migrate, never seed ───────────────────────────────
  it("is populated by the MIGRATION alone, idempotently, to the same counts", async () => {
    const db = getTestDb();
    // TEMP tables shadow the real ones for this session (pg_temp is searched
    // before public), so the blocks below run against empty copies regardless of
    // what the seed has already done. `LIKE … INCLUDING ALL` copies the CHECKs
    // and the unique indexes — including `unit_conversion`'s hand-written
    // COALESCE index — but never foreign keys, which is what lets the temp
    // `emission_factor` accept the literal `factor_set_id` of the real set.
    await db.transaction(async (tx) => {
      for (const table of ["factor_set", "emission_factor", "unit_conversion"])
        await tx.execute(
          sql.raw(
            `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`,
          ),
        );

      const counts = async () =>
        (
          await tx.execute<{ s: number; f: number; c: number }>(sql`
            SELECT (SELECT count(*)::int FROM pg_temp.factor_set) AS s,
                   (SELECT count(*)::int FROM pg_temp.emission_factor) AS f,
                   (SELECT count(*)::int FROM pg_temp.unit_conversion) AS c
          `)
        )[0];

      expect(await counts()).toEqual({ s: 0, f: 0, c: 0 });

      const blocks = [
        generatedBlock("factor_set"),
        generatedBlock("emission_factor"),
        generatedBlock("unit_conversion"),
      ];
      for (const block of blocks) await tx.execute(sql.raw(block));

      const migrated = await counts();
      expect(migrated).toEqual({
        s: 1,
        f: EXPECTED_TOTAL,
        c: unitConversionRows().length,
      });
      // The counts after `db:seed` — seed and migration have not diverged.
      // (`s: 1` above is also the plan's "exactly one factor_set with
      // status='active' after db:migrate alone": the temp table sees only what
      // the migration wrote, so no other suite's throwaway set can inflate it.)
      expect(migrated.f).toBe(factors.length);
      expect(migrated.c).toBe(seededConversions.length);

      // A second `db:migrate` must not double anything.
      for (const block of blocks) await tx.execute(sql.raw(block));
      expect(await counts()).toEqual(migrated);

      const [active] = await tx.execute<{ code: string; status: string }>(
        sql`SELECT code, status FROM pg_temp.factor_set`,
      );
      expect(active.code).toBe(LEGACY_FACTOR_SET.code);
      expect(active.status).toBe("active");
    });
  });
});
