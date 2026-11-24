// =============================================================================
// T1.3 acceptance — the Phase-1 enums against the REAL factor data.
//
// `enums.test.ts` proves the lists are well-formed. This file proves they are
// TRUE: every `activity_type` literal a user can pick has a factor behind it,
// every factor has a literal in front of it, and the legacy→enum normalisation
// that T1.5 will seed with is the one the `activities.ts` header describes.
//
// WHY IT MATTERS MORE THAN A TYPO CHECK. CALC-2 resolves by EQUALITY on
// `(activity_type, geography, input_unit, applicable_year)`, and §0.7 forbids
// substituting a zero: an `activity_type` with no factor is a hard
// `failed_missing_factor`, and two factors on one key are a VAL-031 unique
// violation at seed time / `FACTORS_AMBIGUOUS` at runtime. Both failure modes
// are invisible until a real calculation runs — this file makes them a unit
// test.
//
// NO DATABASE. The factor arrays are code (`seed-data/legacy-factors.ts`, T1.3)
// and the normalisation is a pure function (`seed-data/legacy-normalisation.ts`),
// so the whole contract is checkable without a migration.
//
// THE HELPER IS THE SUBJECT, NOT A COPY OF IT. Every derivation below goes
// through `legacy-normalisation.ts` — the same module T1.5 seeds
// `emission_factor` from. A second transcription of the mapping table here
// would pass forever while the seed drifted.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  REFRIGERANTS,
  STATIONARY,
  VEHICLE_ENERGY,
  VEHICLES,
} from "@/server/db/seed-data/legacy-factors";
import {
  decomposeFuelKey,
  LEGACY_CATEGORY_UNITS,
  LEGACY_UNIT_TO_CODE,
  normaliseLegacyFactors,
  resolveKey,
  unitCodeFor,
  type NormalisedFactorRow,
} from "@/server/db/seed-data/legacy-normalisation";
import {
  FUEL_TYPES,
  isUnitCode,
  PROCESS_TYPES,
  REFRIGERANT_TYPES,
  UNIT_CODES,
  VEHICLE_TYPES,
  type UnitCode,
} from "@/shared/enums";

import { SI_2025_R2_ONLY_ACTIVITY_TYPES } from "@/server/db/seed-data/factor-set-si-2025-r2";

const ROWS = normaliseLegacyFactors();

/**
 * Literals that NO legacy row prices and that exist because `si-2025-r2`
 * (0015) prices them. The list is imported from the data module the migration
 * is generated from, so a literal added to an enum without a factor behind it
 * still fails below — it just has two places it may be reached from now.
 */
const SI_R2_ONLY = new Set<string>(SI_2025_R2_ONLY_ACTIVITY_TYPES);

const sorted = (v: Iterable<string>): string[] => [...new Set(v)].sort();

const activityTypesOf = (
  ...categories: NormalisedFactorRow["legacyCategory"][]
) =>
  sorted(
    ROWS.filter((r) => categories.includes(r.legacyCategory)).map(
      (r) => r.activityType,
    ),
  );

// =============================================================================
// 1. Set equality — RefrigerantType ↔ REFRIGERANTS
// =============================================================================
// The one list that needed NO normalisation: the legacy keys are already clean
// domain literals. So the assertion is the strongest form — equality, not
// containment. A value with no factor fails CALC-2 for every row that picks it;
// a factor with no value is a priced gas the UI cannot offer.

describe("REFRIGERANT_TYPES ↔ REFRIGERANTS", () => {
  const seedKeys = REFRIGERANTS.map(([key]) => key);

  it("is the seed's key set exactly — no extra value, none lost", () => {
    expect(sorted(REFRIGERANT_TYPES.filter((r) => !SI_R2_ONLY.has(r)))).toEqual(
      sorted(seedKeys),
    );
  });

  it("keeps the seed's order, so the two files read as one list", () => {
    expect(REFRIGERANT_TYPES.filter((r) => !SI_R2_ONLY.has(r))).toEqual(
      seedKeys,
    );
  });

  it("every value with no legacy row is one si-2025-r2 prices", () => {
    const legacy = new Set(seedKeys);
    expect(
      REFRIGERANT_TYPES.filter((r) => !legacy.has(r) && !SI_R2_ONLY.has(r)),
    ).toEqual([]);
  });

  it("resolves every value on input_unit `kg`", () => {
    const byUnit = sorted(
      ROWS.filter((r) => r.legacyCategory === "refrigerant").map(
        (r) => r.inputUnit,
      ),
    );
    expect(byUnit).toEqual(["kg"]);
    expect(unitCodeFor(LEGACY_CATEGORY_UNITS.refrigerant)).toBe("kg");
  });
});

// =============================================================================
// 2. Reachability under the normalisation contract
// =============================================================================
// Rule 1 (the key bundles the unit → split it out) and rule 2 (the key bundles a
// dimension with no column → the literal keeps it) are what make these two
// lists derivable from the arrays at all. Asserting BOTH directions is the
// point: containment one way alone would let a fuel with no factor through, and
// containment the other way alone would let a priced fuel stay unreachable from
// the UI.

describe("FUEL_TYPES ↔ STATIONARY (rule 1: the unit splits off the key)", () => {
  const decomposed = STATIONARY.map(([key, , unit]) =>
    decomposeFuelKey(key, unit),
  );

  it("decomposes all 22 legacy keys into 17 values, each with a UnitCode", () => {
    expect(decomposed).toHaveLength(22);
    for (const { activityType, inputUnit } of decomposed) {
      expect(activityType).not.toBe("");
      expect(isUnitCode(inputUnit)).toBe(true);
    }
    expect(sorted(decomposed.map((d) => d.activityType))).toHaveLength(17);
  });

  it("every FUEL_TYPES value has ≥1 factor row — in legacy-v1 or in si-2025-r2", () => {
    const reachable = new Set(activityTypesOf("stationary_fuel"));
    expect(
      FUEL_TYPES.filter((f) => !reachable.has(f) && !SI_R2_ONLY.has(f)),
    ).toEqual([]);
  });

  it("every legacy key lands on a FUEL_TYPES value — nothing orphaned", () => {
    const known = new Set<string>(FUEL_TYPES);
    expect(
      decomposed.map((d) => d.activityType).filter((a) => !known.has(a)),
    ).toEqual([]);
  });

  it("keeps `wood_logs_biogenic` apart from `wood_logs` — same unit `t`, no biogenic component in the key", () => {
    // D3/VAL-017: merging them is a VAL-031 violation, not a tidy-up.
    const t = ROWS.filter(
      (r) =>
        r.activityType === "wood_logs" ||
        r.activityType === "wood_logs_biogenic",
    );
    expect(sorted(t.map((r) => r.inputUnit))).toEqual(["t"]);
    expect(sorted(t.map((r) => r.activityType))).toEqual([
      "wood_logs",
      "wood_logs_biogenic",
    ]);
  });

  it("rejects a key whose suffix contradicts its priced unit", () => {
    expect(() => decomposeFuelKey("fuel_oil_tonne", "litre")).toThrow(
      /implies/,
    );
  });
});

describe("VEHICLE_TYPES ↔ VEHICLES + VEHICLE_ENERGY (rule 2: the key IS the type)", () => {
  const seedKeys = [
    ...VEHICLES.map(([key]) => key),
    ...VEHICLE_ENERGY.map(([key]) => key),
  ];

  it("is the seed's key set exactly (35 + 1)", () => {
    expect(sorted(VEHICLE_TYPES)).toEqual(sorted(seedKeys));
    expect(seedKeys).toHaveLength(36);
  });

  it("every VEHICLE_TYPES value has ≥1 factor row", () => {
    const reachable = new Set(activityTypesOf("vehicle"));
    expect(VEHICLE_TYPES.filter((v) => !reachable.has(v))).toEqual([]);
  });

  it("resolves all 36 on input_unit `km` — the ratio's DENOMINATOR", () => {
    const vehicleRows = ROWS.filter((r) => r.legacyCategory === "vehicle");
    expect(sorted(vehicleRows.map((r) => r.inputUnit))).toEqual(["km"]);
  });

  it("gives `car_bev_kwh_per_km` output_unit kWh, not kgCO2e", () => {
    // Energy intensity: km → Scope-2 charging. It also cannot fold into
    // `car_bev_avg`, which already holds (car_bev_avg, GLOBAL, km, year).
    const bev = ROWS.filter((r) => r.activityType === "car_bev_kwh_per_km");
    expect(bev.length).toBeGreaterThan(0);
    expect(sorted(bev.map((r) => r.outputUnit))).toEqual(["kWh"]);
    const avg = ROWS.filter((r) => r.activityType === "car_bev_avg");
    expect(sorted(avg.map((r) => r.outputUnit))).toEqual(["kgCO2e"]);
  });
});

describe("PROCESS_TYPES — the documented gap, asserted so it cannot go quiet", () => {
  it("has no factor in the legacy set at all", () => {
    // NOT a bug being papered over: `activities.ts` says so outright — the seed
    // prices no process emissions, so every `process_emissions` row fails
    // CALC-2 until T1.5 (or a later set) seeds them. Either those factors
    // arrive or the list goes; this assertion is what forces the choice instead
    // of letting the list look reachable.
    const known = new Set(ROWS.map((r) => r.activityType));
    expect(PROCESS_TYPES.filter((p) => known.has(p))).toEqual([]);
  });
});

// =============================================================================
// 3. Unit coverage and the injectivity boundary
// =============================================================================
// Rule 3: units collapse ONLY where collapsing cannot cause a collision. The
// two halves of that sentence are two different assertions, and both are here —
// the collapses that were made are proven harmless, and the one split that was
// kept is proven NECESSARY. Without the second half nothing stops a later
// "cleanup" from folding kWh_gross/kWh_net together and discovering it at seed
// time.

describe("legacy unit → UnitCode", () => {
  const legacyUnitsInData = sorted([
    ...ROWS.map((r) => r.legacyUnit),
    ...Object.values(LEGACY_CATEGORY_UNITS),
  ]);

  it("covers every distinct legacy unit string in the data (23)", () => {
    expect(legacyUnitsInData).toHaveLength(23);
    for (const u of legacyUnitsInData)
      expect(() => unitCodeFor(u)).not.toThrow();
  });

  it("carries no entry the data no longer contains", () => {
    const inData = new Set(legacyUnitsInData);
    expect(
      Object.keys(LEGACY_UNIT_TO_CODE).filter((u) => !inData.has(u)),
    ).toEqual([]);
  });

  it("maps into UNIT_CODES and nowhere else", () => {
    for (const code of Object.values(LEGACY_UNIT_TO_CODE)) {
      expect(isUnitCode(code)).toBe(true);
    }
  });

  it("throws on an unmapped string rather than inventing a code", () => {
    expect(() => unitCodeFor("therm")).toThrow(/no UnitCode/);
  });

  it("leaves exactly MWh and GJ without a factor — §4.10 activity units, MIG-5 converts them", () => {
    const used = new Set(ROWS.map((r) => r.inputUnit));
    expect(UNIT_CODES.filter((c) => !used.has(c))).toEqual(["MWh", "GJ"]);
  });
});

describe("the CALC-2 resolve key over the whole normalised set", () => {
  it("is unique for all 440 rows — no VAL-031 violation, no FACTORS_AMBIGUOUS", () => {
    // 440 = the row count the legacy flattening produced (and the count
    // `db:seed` reports for factor set `legacy-v1` today); the normalisation is
    // 1:1 with it, not a subset.
    expect(ROWS).toHaveLength(440);
    const seen = new Map<string, string[]>();
    for (const r of ROWS) {
      const k = resolveKey(r);
      seen.set(k, [
        ...(seen.get(k) ?? []),
        `${r.legacyCategory}/${r.legacyKey}`,
      ]);
    }
    expect([...seen].filter(([, v]) => v.length > 1)).toEqual([]);
  });
});

/** Resolve-key duplicates the set WOULD have if `from` were spelled `to`. */
function collisionsAfterMerging(from: UnitCode, to: UnitCode): string[] {
  const seen = new Set<string>();
  const collisions: string[] = [];
  for (const row of ROWS) {
    const key = resolveKey({
      ...row,
      inputUnit: row.inputUnit === from ? to : row.inputUnit,
    });
    if (seen.has(key)) collisions.push(key);
    else seen.add(key);
  }
  return collisions;
}

describe("the map is non-injective EXACTLY where collapsing is safe", () => {
  const groups = Object.entries(LEGACY_UNIT_TO_CODE).reduce<
    Record<string, string[]>
  >((acc, [legacy, code]) => {
    (acc[code] ??= []).push(legacy);
    return acc;
  }, {});

  it("collapses the four groups the contract names, and only those", () => {
    const collapsed = Object.fromEntries(
      Object.entries(groups).filter(([, v]) => v.length > 1),
    );
    expect(collapsed).toEqual({
      kWh: ["kWh", "kWh cooling", "kWh (lifetime)", "kgCO2e/kWh"],
      L: ["litre", "litre (lifetime)"],
      m3: ["m³", "m3"],
      km: ["km", "kgCO2e/km", "kWh/km"],
    });
  });

  it("each collapse is collision-free — the strings differ, the activities do not overlap", () => {
    // Already implied by the uniqueness test above (the set is normalised, so
    // the collapses are in force there), but stated per group so a failure
    // names the group instead of a bare duplicate key. `kWh cooling` is the
    // instructive one: it is the `energy_type` discriminator, not a unit —
    // `cooling_defra` is priced in plain `kWh` while its siblings say
    // `kWh cooling`, so a `kWh_cooling` code would make a cooling row entered
    // in kWh fail to resolve.
    for (const [code, legacyStrings] of Object.entries(groups)) {
      if (legacyStrings.length < 2) continue;
      const rows = ROWS.filter((r) => r.inputUnit === code);
      expect(sorted(rows.map(resolveKey))).toHaveLength(rows.length);
    }
  });

  it("keeps kWh_gross/kWh_net apart BECAUSE merging them collides on natural_gas", () => {
    // The load-bearing half of rule 3. Both belong to activity_type
    // `natural_gas` after rule 1, so one `kWh` code puts two factors on one
    // key — VAL-031 at seed time. If this ever stops throwing collisions the
    // split may be reconsidered; until then it is not cosmetic.
    const collisions = collisionsAfterMerging("kWh_gross", "kWh_net");
    expect(collisions.length).toBeGreaterThan(0);
    for (const key of collisions) expect(key).toContain("natural_gas");
  });
});
