// CALC-3 unit tests — NO DATABASE. Every assertion is a property of a pure
// function over a literal array, which is the point: the conversion rules decide
// whether 1000 m³ of gas becomes 11 MWh or stays 1000 "kWh", and that must be
// breakable by a DB-less CI.
//
// Two of the fixtures are the REAL seeded table (`unitConversionRows()` is pure
// data in the tree — the same rows `0004_data_model.sql` and `seed.ts` write),
// so these tests fail if the seed loses an edge the calculation depends on. The
// hand-built sets exist only for the cases the seed deliberately cannot express
// (a pair present on several rungs, a pair present on none, and — since 0010 —
// a pair a FACTOR SET states differently from the shared table).
import { describe, expect, it } from "vitest";

import { unitConversionRows } from "@/server/db/seed-data/unit-conversions";

import {
  convertUnit,
  reachableUnits,
  UNIT_CONVERSION_BASES_INDEX,
  type ConversionCandidate,
} from "../units";

/**
 * The seeded `unit_conversion` table in the shape the calculation reads it.
 *
 * Every seeded row is SHARED — `factorSetId: null`. That is the seed's whole
 * content and not an omission here: the set-scoped rows ship in
 * `drizzle/0010_set_scoped_conversions.sql`, which no TypeScript module mirrors
 * (О-13), so they are proved against a migrated database in
 * `db/__tests__/factor-set-si-2025.integration.test.ts`.
 */
const SEEDED: readonly ConversionCandidate[] = unitConversionRows().map(
  (row) => ({
    id: row.id,
    fromUnit: row.from_unit,
    toUnit: row.to_unit,
    multiplier: row.multiplier,
    activityContext: row.activity_context,
    factorSetId: null,
  }),
);

/** A period's pinned set (К-24), for the tests that need one. */
const PINNED = "11111111-1111-4111-8111-111111111111";
/** Some OTHER set, whose rows must be invisible to a run pinned to `PINNED`. */
const OTHER = "22222222-2222-4222-8222-222222222222";

/** A conversion row, for the cases the seed cannot express. */
function conv(
  id: string,
  fromUnit: string,
  toUnit: string,
  multiplier: string,
  activityContext: string | null = null,
  factorSetId: string | null = null,
): ConversionCandidate {
  return { id, fromUnit, toUnit, multiplier, activityContext, factorSetId };
}

describe("convertUnit — contextual before universal (CALC-3)", () => {
  it("picks the CONTEXTUAL row for m3 → kWh of natural gas", () => {
    const result = convertUnit("m3", "kWh", "natural_gas", PINNED, SEEDED);

    expect(result.status).toBe("ok");
    expect(result.conversion?.basis).toBe("contextual");
    // The calorific value of a cubic metre — not a physical identity.
    expect(result.conversion?.multiplier).toBe("11.0342");
    expect(result.conversion?.conversionId).not.toBeNull();
  });

  it("picks the UNIVERSAL row for kWh → MWh", () => {
    const result = convertUnit("kWh", "MWh", "natural_gas", PINNED, SEEDED);

    expect(result.status).toBe("ok");
    expect(result.conversion?.basis).toBe("universal");
    expect(result.conversion?.multiplier).toBe("0.001");
  });

  it("prefers the contextual row when BOTH bases offer the same pair", () => {
    const rows = [
      conv("universal", "m3", "kWh", "3"),
      conv("contextual", "m3", "kWh", "11.0342", "natural_gas"),
    ];

    const gas = convertUnit("m3", "kWh", "natural_gas", PINNED, rows);
    expect(gas.conversion?.conversionId).toBe("contextual");
    expect(gas.conversion?.multiplier).toBe("11.0342");

    // …and a DIFFERENT activity falls through to the universal row.
    const other = convertUnit("m3", "kWh", "district_heating", PINNED, rows);
    expect(other.conversion?.conversionId).toBe("universal");
    expect(other.conversion?.basis).toBe("universal");
  });

  it("does not lend one fuel's calorific value to another", () => {
    // `m3 → kWh` is seeded for natural_gas ONLY. LPG in m³ has no path, and the
    // honest answer is a refusal rather than the gas number.
    const result = convertUnit("m3", "kWh", "lpg", PINNED, SEEDED);
    expect(result.status).toBe("failed_unit");
  });
});

// ─── 0010 — the pinned set's own rows come first ─────────────────────────────

describe("convertUnit — the pinned set outranks the shared table (0010)", () => {
  // The real shape of the defect 0010 closes: the SHARED table states DEFRA's
  // UK calorific value for natural gas, and `si-2025` states ARSO's own. The
  // two differ by 3.69%, so which row is read is not a nicety.
  const SHARED_CV = conv("shared-cv", "m3", "kWh_net", "9.9594", "natural_gas");
  const SET_CV = conv(
    "set-cv",
    "m3",
    "kWh_net",
    "10.3269444444444",
    "natural_gas",
    PINNED,
  );
  const OTHER_CV = conv(
    "other-cv",
    "m3",
    "kWh_net",
    "999",
    "natural_gas",
    OTHER,
  );

  it("reads the pinned set's calorific value, not the shared one", () => {
    const result = convertUnit("m3", "kWh_net", "natural_gas", PINNED, [
      SHARED_CV,
      SET_CV,
    ]);

    expect(result.conversion?.conversionId).toBe("set-cv");
    expect(result.conversion?.multiplier).toBe("10.3269444444444");
    expect(result.conversion?.basis).toBe("set_contextual");
  });

  it("falls back to the shared row where the set states none", () => {
    // The set says nothing about kWh → MWh, so physics answers — this is the
    // half of the rule that keeps 0010 from emptying the shared table.
    const result = convertUnit("kWh", "MWh", "natural_gas", PINNED, SEEDED);
    expect(result.status).toBe("ok");
    expect(result.conversion?.basis).toBe("universal");
    expect(result.conversion?.multiplier).toBe("0.001");
  });

  it("never lets ANOTHER set's row leak into this one", () => {
    // A run pinned to `PINNED` must not see `OTHER`'s row at all — not as a
    // winner, and not as a fallback when the shared table is empty either.
    const withShared = convertUnit("m3", "kWh_net", "natural_gas", PINNED, [
      OTHER_CV,
      SHARED_CV,
    ]);
    expect(withShared.conversion?.conversionId).toBe("shared-cv");

    const alone = convertUnit("m3", "kWh_net", "natural_gas", PINNED, [
      OTHER_CV,
    ]);
    expect(alone.status).toBe("failed_unit");

    // …and the same table, pinned to `OTHER`, DOES see it. The rows are not
    // broken; the pin is what selects them.
    const theirs = convertUnit("m3", "kWh_net", "natural_gas", OTHER, [
      OTHER_CV,
    ]);
    expect(theirs.conversion?.conversionId).toBe("other-cv");
  });

  it("puts a set-scoped UNIVERSAL row above a shared CONTEXTUAL one", () => {
    // The outer question is WHOSE methodology this is; the inner one is how
    // specific the row is. So a statement the pinned set makes about every
    // activity beats a calorific value the shared table states for this one.
    const rows = [
      conv("shared-contextual", "kWh", "kWh_net", "0.90259", "natural_gas"),
      conv("set-universal", "kWh", "kWh_net", "1", null, PINNED),
    ];
    const result = convertUnit("kWh", "kWh_net", "natural_gas", PINNED, rows);

    expect(result.conversion?.conversionId).toBe("set-universal");
    expect(result.conversion?.basis).toBe("set_universal");
    expect(result.conversion?.multiplier).toBe("1");
  });

  it("still prefers the set's CONTEXTUAL row to the set's own universal one", () => {
    const rows = [
      conv("set-universal", "m3", "kWh_net", "1", null, PINNED),
      conv(
        "set-contextual",
        "m3",
        "kWh_net",
        "10.3269444444444",
        "natural_gas",
        PINNED,
      ),
    ];
    const result = convertUnit("m3", "kWh_net", "natural_gas", PINNED, rows);

    expect(result.conversion?.conversionId).toBe("set-contextual");
    expect(result.conversion?.basis).toBe("set_contextual");
  });
});

describe("convertUnit — the identity and the refusal", () => {
  it("returns an exact 1 with no row when the units already agree", () => {
    const result = convertUnit("kWh", "kWh", "electricity", PINNED, SEEDED);

    expect(result.status).toBe("ok");
    expect(result.conversion).toEqual({
      fromUnit: "kWh",
      toUnit: "kWh",
      multiplier: "1",
      basis: "identity",
      // No row was read, so the lineage must not point at one.
      conversionId: null,
    });
  });

  it("fails with failed_unit when no path exists — never an assumed 1", () => {
    const result = convertUnit("kg", "km", "freight", PINNED, SEEDED);

    expect(result.status).toBe("failed_unit");
    expect(result.conversion).toBeNull();
    expect(result).toMatchObject({
      fromUnit: "kg",
      toUnit: "km",
      activityType: "freight",
    });
  });

  it("fails rather than chaining two hops (CALC-3 is a lookup, not a search)", () => {
    // GJ → kWh and kWh → m3(natural_gas) both exist; GJ → m3 does not, and the
    // resolver must not compose them.
    expect(convertUnit("GJ", "kWh", "natural_gas", PINNED, SEEDED).status).toBe(
      "ok",
    );
    expect(convertUnit("kWh", "m3", "natural_gas", PINNED, SEEDED).status).toBe(
      "ok",
    );
    expect(convertUnit("GJ", "m3", "natural_gas", PINNED, SEEDED).status).toBe(
      "failed_unit",
    );
  });

  it("keeps the multiplier a STRING, digit for digit", () => {
    const result = convertUnit("kWh", "m3", "natural_gas", PINNED, SEEDED);

    // 12 significant digits of a reciprocal survive only as text.
    expect(result.conversion?.multiplier).toBe("0.0906273223251");
    expect(typeof result.conversion?.multiplier).toBe("string");
  });
});

describe("reachableUnits", () => {
  it("always contains the identity", () => {
    const reachable = reachableUnits("L", "diesel", PINNED, SEEDED);
    expect(reachable.get("L")).toMatchObject({ basis: "identity" });
  });

  it("reports the BEST basis for a unit both tiers reach", () => {
    const rows = [
      conv("u", "MWh", "kWh_x", "1000"),
      conv("c", "MWh", "kWh_x", "902.59", "natural_gas"),
    ];
    const reachable = reachableUnits("MWh", "natural_gas", PINNED, rows);

    expect(reachable.get("kWh_x")).toMatchObject({
      basis: "contextual",
      multiplier: "902.59",
    });
  });

  it("prefers the pinned set's row and ignores another set's (0010)", () => {
    const rows = [
      conv("shared", "m3", "kWh_net", "9.9594", "natural_gas"),
      conv("mine", "m3", "kWh_net", "10.3269444444444", "natural_gas", PINNED),
      conv("theirs", "m3", "GJ", "0.999", "natural_gas", OTHER),
    ];
    const reachable = reachableUnits("m3", "natural_gas", PINNED, rows);

    expect(reachable.get("kWh_net")).toMatchObject({
      basis: "set_contextual",
      multiplier: "10.3269444444444",
      conversionId: "mine",
    });
    // The other set's edge is not merely outranked — it is not there at all.
    expect(reachable.has("GJ")).toBe(false);
  });

  it("carries a gas row entered in m³ to every unit its factors are priced in", () => {
    const reachable = reachableUnits("m3", "natural_gas", PINNED, SEEDED);

    // The three units `legacy-v1` prices natural gas in.
    expect(reachable.get("kWh_gross")).toMatchObject({ basis: "contextual" });
    expect(reachable.get("kWh_net")).toMatchObject({ basis: "contextual" });
    expect(reachable.get("m3")).toMatchObject({ basis: "identity" });
    // …plus the physical neighbours of a volume.
    expect(reachable.get("L")).toMatchObject({ basis: "universal" });
  });

  it("orders the bases identity < the set's own < the shared table's", () => {
    expect(UNIT_CONVERSION_BASES_INDEX).toEqual({
      identity: 0,
      set_contextual: 1,
      set_universal: 2,
      contextual: 3,
      universal: 4,
    });
  });
});
