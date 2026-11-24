// CALC-2 unit tests — NO DATABASE. Candidate sets are literal arrays, which is
// what makes the two REFUSALS testable at all:
//
//   - a missing factor must return a STATUS and never a 0 (§0.7, AC-6). A zero
//     here is indistinguishable from a genuine zero, sums into a plausible
//     total and reaches a signed report, so every failure case below asserts
//     `value` is not 0 as well as the status.
//   - a surviving tie must THROW with both candidate ids (§12.1). Picking
//     `candidates[0]` would make a reported figure a function of SQL row order,
//     so the tie-break test asserts the ids, not merely that "something failed".
//
// The last block resolves against the REAL 440 factors of `legacy-v1` (pure data
// in the tree), proving the shipped set never reaches the ambiguity branch.
import { describe, expect, it } from "vitest";

import { statusForError } from "@/server/api/handler";
import {
  LEGACY_FACTOR_SET,
  legacyFactorRows,
} from "@/server/db/seed-data/factor-set-v1";
import { unitConversionRows } from "@/server/db/seed-data/unit-conversions";

import {
  FACTOR_PRIORITY_TIERS,
  FORMULA_DEFINITION,
  FORMULA_VERSION,
  ROUNDING_DECIMALS,
  ROUNDING_RULE,
  UNIT_CONVERSION_BASES,
  UNIT_CONVERSION_DISTANCES,
  VAL_034_TOLERANCE,
} from "../formula-version";
import {
  FactorsAmbiguousError,
  isFactorsAmbiguousError,
  resolveFactor,
  type FactorCandidate,
  type FactorQuery,
} from "../factors";
import type { ConversionCandidate } from "../units";

const PINNED_SET = "11111111-1111-1111-1111-111111111111";
const OTHER_SET = "22222222-2222-2222-2222-222222222222";

/**
 * The seeded `unit_conversion` table, as the calculation reads it. Every seeded
 * row is SHARED (`factorSetId: null`) — the set-scoped ones ship in migration
 * 0010 and are proved against a database, not against this module.
 */
const CONVERSIONS: readonly ConversionCandidate[] = unitConversionRows().map(
  (row) => ({
    id: row.id,
    fromUnit: row.from_unit,
    toUnit: row.to_unit,
    multiplier: row.multiplier,
    activityContext: row.activity_context,
    factorSetId: null,
  }),
);

/** A factor candidate: an active, unexpired GLOBAL row unless overridden. */
function factor(
  id: string,
  overrides: Partial<FactorCandidate> = {},
): FactorCandidate {
  return {
    id,
    factorSetId: PINNED_SET,
    activityType: "natural_gas",
    geography: "GLOBAL",
    inputUnit: "kWh_gross",
    applicableYear: 2025,
    publicationDate: "2025-06-01",
    sourceName: "DEFRA",
    sourceVersion: "2025 v1.0",
    supplierName: null,
    factorValue: "0.18290",
    outputUnit: "kgCO2e",
    status: "active",
    validFrom: null,
    validTo: null,
    ...overrides,
  };
}

/** The matching query: gas burnt at a Slovenian site in 2025, entered in kWh. */
function query(overrides: Partial<FactorQuery> = {}): FactorQuery {
  return {
    factorSetId: PINNED_SET,
    activityType: "natural_gas",
    geography: "SI",
    inputUnit: "kWh_gross",
    applicableYear: 2025,
    asOf: "2025-12-31",
    ...overrides,
  };
}

describe("resolveFactor — the geography ladder (CALC-2)", () => {
  it("prefers a supplier-specific factor over the site's country", () => {
    const supplierFactor = factor("supplier", {
      sourceName: "supplier",
      supplierName: "Elektro Ljubljana",
      geography: "SI",
    });
    const countryFactor = factor("country", { geography: "SI" });

    const result = resolveFactor(
      query({ supplier: "Elektro Ljubljana" }),
      [countryFactor, supplierFactor],
      CONVERSIONS,
    );

    expect(result.status).toBe("ok");
    expect(result.factor?.id).toBe("supplier");
    expect(result).toMatchObject({ tier: "supplier_specific" });
  });

  it("matches the supplier through case and stray whitespace", () => {
    // The two spellings are the same seller typed by two different people. The
    // normalisation goes exactly this far and no further — see the next test.
    const result = resolveFactor(
      query({ supplier: "  elektro   LJUBLJANA " }),
      [
        factor("supplier", {
          sourceName: "supplier",
          supplierName: "Elektro Ljubljana",
          geography: "SI",
        }),
        factor("country", { geography: "SI" }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("supplier");
  });

  it("prefers the site's country over GLOBAL", () => {
    const result = resolveFactor(
      query(),
      [factor("global"), factor("country", { geography: "SI" })],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("country");
    expect(result).toMatchObject({ tier: "site_country" });
  });

  it("falls back to GLOBAL when the country has no factor", () => {
    const result = resolveFactor(
      query(),
      [factor("global"), factor("elsewhere", { geography: "AT" })],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("global");
    expect(result).toMatchObject({ tier: "global" });
  });

  it("never uses another country's factor", () => {
    const result = resolveFactor(
      query(),
      [factor("elsewhere", { geography: "AT" })],
      CONVERSIONS,
    );

    expect(result.status).toBe("failed_missing_factor");
    expect(result.value).not.toBe(0);
    expect(result.value).toBeNull();
  });

  it("ignores a supplier factor when the row names no supplier", () => {
    // A factor set is shared reference data; one tenant's supplier contract must
    // not price everybody else's gas.
    const candidates = [
      factor("supplier", {
        sourceName: "supplier",
        supplierName: "Elektro Ljubljana",
        geography: "SI",
      }),
      factor("country", { geography: "SI" }),
    ];

    expect(resolveFactor(query(), candidates, CONVERSIONS).factor?.id).toBe(
      "country",
    );
    expect(resolveFactor(query(), [candidates[0]], CONVERSIONS).status).toBe(
      "failed_missing_factor",
    );
  });

  it("does not let a supplier factor stand in as a country average", () => {
    // Supplier named, but the supplier factor is for another country.
    const result = resolveFactor(
      query({ supplier: "Elektro Ljubljana" }),
      [
        factor("supplier-at", {
          sourceName: "supplier",
          supplierName: "Elektro Ljubljana",
          geography: "AT",
        }),
      ],
      CONVERSIONS,
    );

    expect(result.status).toBe("failed_missing_factor");
  });

  it("NEVER prices a row with ANOTHER supplier's factor (0007)", () => {
    // THE DEFECT, as a test. Before `emission_factor.supplier_name` existed the
    // rung matched on two facts that say nothing about identity — the row names
    // SOME supplier, the candidate carries `source_name='supplier'` — so this
    // row was priced at 0.05 by a company it has no contract with.
    const stranger = factor("stranger", {
      sourceName: "supplier",
      supplierName: "Zelena Energija d.o.o.",
      geography: "SI",
      factorValue: "0.05000",
    });

    const alone = resolveFactor(
      query({ supplier: "Totally Different Utility d.o.o." }),
      [stranger],
      CONVERSIONS,
    );
    expect(alone.status).toBe("failed_missing_factor");
    expect(alone.value).toBeNull();

    // …and with a country factor present it is the COUNTRY one that prices the
    // row: an unmatched supplier factor is not a country average either.
    const beside = resolveFactor(
      query({ supplier: "Totally Different Utility d.o.o." }),
      [stranger, factor("country", { geography: "SI" })],
      CONVERSIONS,
    );
    expect(beside.factor?.id).toBe("country");
    expect(beside).toMatchObject({ tier: "site_country" });
  });

  it("puts a supplier-sourced factor that names NOBODY on no rung at all", () => {
    // `emission_factor_supplier_name_check` forbids the row; this is what the
    // resolver does if one reaches it anyway (an unmigrated database, a literal
    // in a test). It must not silently become the country average.
    const result = resolveFactor(
      query({ supplier: "Elektro Ljubljana" }),
      [factor("nameless", { sourceName: "supplier", geography: "SI" })],
      CONVERSIONS,
    );

    expect(result.status).toBe("failed_missing_factor");
  });

  it("does not match a supplier by a near-miss on the name", () => {
    // No suffix stripping, no substrings. The miss falls through to the country
    // factor — a published number — instead of guessing which seller was meant.
    const result = resolveFactor(
      query({ supplier: "Elektro Ljubljana d.o.o." }),
      [
        factor("supplier", {
          sourceName: "supplier",
          supplierName: "Elektro Ljubljana",
          geography: "SI",
        }),
        factor("country", { geography: "SI" }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("country");
  });
});

describe("resolveFactor — the publication tie-break and the refusal to guess", () => {
  it("takes the freshest publication_date at equal geography", () => {
    const result = resolveFactor(
      query(),
      [
        factor("old", { geography: "SI", publicationDate: "2024-01-01" }),
        factor("new", { geography: "SI", publicationDate: "2025-06-01" }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("new");
  });

  it("does NOT let the tie-break choose between two RIVAL suppliers (0007)", () => {
    // THE SECOND HALF OF THE DEFECT. Both factors used to sit on the
    // `supplier_specific` rung for ANY row naming ANY supplier, tie right
    // through the ladder, and the `publication_date` tie-break then picked the
    // newer — a comparison with no meaning between two different sellers, and a
    // silent pick where CALC-2 promises a raise. Now the rung holds only the
    // seller the row actually buys from, so there is nothing to pick BETWEEN.
    const mine = factor("mine", {
      sourceName: "supplier",
      supplierName: "Elektro Ljubljana",
      geography: "SI",
      publicationDate: "2025-01-01",
      factorValue: "0.20000",
    });
    const rival = factor("rival", {
      sourceName: "supplier",
      supplierName: "Zelena Energija d.o.o.",
      geography: "SI",
      publicationDate: "2025-09-01", // newer — used to win, from nowhere
      factorValue: "0.05000",
    });

    const result = resolveFactor(
      query({ supplier: "Elektro Ljubljana" }),
      [mine, rival],
      CONVERSIONS,
    );

    expect(result.status).toBe("ok");
    expect(result.factor?.id).toBe("mine");
    expect(result.value).toBe("0.20000");
  });

  it("STILL raises when ONE supplier's own factors tie (0007)", () => {
    // The rung narrowed; it did not stop raising. Two factors of the SAME
    // seller, same publication date, and the resolver refuses to pick — which is
    // the rule the rival-supplier case above used to break.
    const candidates = [
      factor("disclosure-a", {
        sourceName: "supplier",
        supplierName: "Elektro Ljubljana",
        sourceVersion: "2025 disclosure A",
        geography: "SI",
      }),
      factor("disclosure-b", {
        sourceName: "supplier",
        supplierName: "elektro ljubljana",
        sourceVersion: "2025 disclosure B",
        geography: "SI",
      }),
    ];

    let thrown: unknown;
    try {
      resolveFactor(
        query({ supplier: "Elektro Ljubljana" }),
        candidates,
        CONVERSIONS,
      );
    } catch (e) {
      thrown = e;
    }

    expect(isFactorsAmbiguousError(thrown)).toBe(true);
    const error = thrown as FactorsAmbiguousError;
    expect([...error.candidateIds].sort()).toEqual([
      "disclosure-a",
      "disclosure-b",
    ]);
    // The payload names WHOSE factors collided — the admin's first question.
    expect(error.payload).toMatchObject({
      candidates: [
        expect.objectContaining({ supplier_name: "Elektro Ljubljana" }),
        expect.objectContaining({ supplier_name: "elektro ljubljana" }),
      ],
    });
  });

  it("treats a missing publication_date as the OLDEST, not the newest", () => {
    const result = resolveFactor(
      query(),
      [
        factor("undated", { geography: "SI", publicationDate: null }),
        factor("dated", { geography: "SI", publicationDate: "2020-01-01" }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("dated");
  });

  it("THROWS FACTORS_AMBIGUOUS listing both ids when the dates tie", () => {
    const candidates = [
      factor("defra", { geography: "SI", sourceName: "DEFRA" }),
      factor("iea", { geography: "SI", sourceName: "IEA" }),
    ];

    let thrown: unknown;
    try {
      resolveFactor(query(), candidates, CONVERSIONS);
    } catch (e) {
      thrown = e;
    }

    expect(isFactorsAmbiguousError(thrown)).toBe(true);
    const error = thrown as FactorsAmbiguousError;
    // BOTH ids, not a first-wins pick.
    expect([...error.candidateIds].sort()).toEqual(["defra", "iea"]);
    expect(error.code).toBe("FACTORS_AMBIGUOUS");
    expect(error.calculationStatus).toBe("failed_ambiguous_factor");
    expect(error.payload).toEqual({
      ok: false,
      error: "FACTORS_AMBIGUOUS",
      candidates: [
        expect.objectContaining({ id: "defra", source_name: "DEFRA" }),
        expect.objectContaining({ id: "iea", source_name: "IEA" }),
      ],
    });
  });

  it("ties the same way whichever order the candidates arrive in", () => {
    const a = factor("a", { geography: "SI", sourceName: "DEFRA" });
    const b = factor("b", { geography: "SI", sourceName: "IEA" });

    expect(() => resolveFactor(query(), [a, b], CONVERSIONS)).toThrow(
      FactorsAmbiguousError,
    );
    expect(() => resolveFactor(query(), [b, a], CONVERSIONS)).toThrow(
      FactorsAmbiguousError,
    );
  });

  it("does not tie when the candidates sit on different rungs", () => {
    // Same date, but one is the country's and one is GLOBAL — the ladder ranks
    // them, so there is nothing to refuse.
    const result = resolveFactor(
      query(),
      [factor("global"), factor("country", { geography: "SI" })],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("country");
  });

  it("maps FACTORS_AMBIGUOUS to 503 (§12.1)", () => {
    const error = new FactorsAmbiguousError(query(), []);
    expect(statusForError(error.code)).toBe(503);
  });
});

describe("resolveFactor — archived, expired and unpinned factors", () => {
  it("ignores a factor that is not active (draft or archived)", () => {
    const result = resolveFactor(
      query(),
      [
        factor("draft", { geography: "SI", status: "draft" }),
        factor("archived", { geography: "SI", status: "archived" }),
      ],
      CONVERSIONS,
    );

    expect(result.status).toBe("failed_missing_factor");
    expect(result.value).not.toBe(0);
  });

  it("ignores a factor whose validity window has expired", () => {
    const result = resolveFactor(
      query({ asOf: "2025-12-31" }),
      [factor("expired", { geography: "SI", validTo: "2025-06-30" })],
      CONVERSIONS,
    );

    expect(result.status).toBe("failed_missing_factor");
  });

  it("ignores a factor that is not valid yet", () => {
    const result = resolveFactor(
      query({ asOf: "2025-12-31" }),
      [factor("future", { geography: "SI", validFrom: "2026-01-01" })],
      CONVERSIONS,
    );

    expect(result.status).toBe("failed_missing_factor");
  });

  it("accepts a factor whose window contains asOf, open ends included", () => {
    const result = resolveFactor(
      query({ asOf: "2025-12-31" }),
      [
        factor("open", {
          geography: "SI",
          validFrom: "2025-01-01",
          validTo: null,
        }),
      ],
      CONVERSIONS,
    );

    expect(result.status).toBe("ok");
    expect(result.factor?.id).toBe("open");
  });

  it("never leaves the set the period pinned (К-24, AC-8)", () => {
    // A better factor in ANOTHER set is invisible: the pin is what makes a
    // locked revision reproducible.
    const result = resolveFactor(
      query(),
      [factor("foreign", { geography: "SI", factorSetId: OTHER_SET })],
      CONVERSIONS,
    );

    expect(result.status).toBe("failed_missing_factor");
    expect(result.factor).toBeNull();
  });

  it("does not answer a question about another activity type", () => {
    const result = resolveFactor(
      query({ activityType: "diesel" }),
      [factor("gas", { geography: "SI" })],
      CONVERSIONS,
    );

    expect(result.status).toBe("failed_missing_factor");
  });
});

describe("resolveFactor — applicable_year", () => {
  it("prefers the exact year over a year-agnostic factor", () => {
    const result = resolveFactor(
      query(),
      [
        factor("agnostic", { geography: "SI", applicableYear: null }),
        factor("exact", { geography: "SI", applicableYear: 2025 }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("exact");
  });

  it("uses a year-agnostic factor when the year has none (refrigerant GWPs)", () => {
    const result = resolveFactor(
      query({ activityType: "r410a", applicableYear: 2025, inputUnit: "kg" }),
      [
        factor("gwp", {
          activityType: "r410a",
          geography: "SI",
          applicableYear: null,
          inputUnit: "kg",
        }),
      ],
      CONVERSIONS,
    );

    expect(result.status).toBe("ok");
    expect(result.factor?.id).toBe("gwp");
  });

  it("never substitutes a factor published for a DIFFERENT year", () => {
    const result = resolveFactor(
      query({ applicableYear: 2025 }),
      [factor("y2023", { geography: "SI", applicableYear: 2023 })],
      CONVERSIONS,
    );

    expect(result.status).toBe("failed_missing_factor");
    expect(result.value).not.toBe(0);
  });

  it("ranks the year only INSIDE a rung — geography still decides first", () => {
    const result = resolveFactor(
      query(),
      [
        factor("global-exact", { applicableYear: 2025 }),
        factor("country-agnostic", { geography: "SI", applicableYear: null }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("country-agnostic");
  });
});

describe("resolveFactor — the unit dimension (CALC-3)", () => {
  it("records the conversion that reached the factor's input_unit", () => {
    const result = resolveFactor(
      query({ inputUnit: "m3" }),
      [factor("gas-kwh", { geography: "SI", inputUnit: "kWh_gross" })],
      CONVERSIONS,
    );

    expect(result.status).toBe("ok");
    expect(result.conversion).toMatchObject({
      fromUnit: "m3",
      toUnit: "kWh_gross",
      multiplier: "11.0342",
      basis: "contextual",
    });
  });

  it("prefers the factor it can reach without a conversion", () => {
    const result = resolveFactor(
      query({ inputUnit: "m3" }),
      [
        factor("priced-in-kwh", { geography: "SI", inputUnit: "kWh_gross" }),
        factor("priced-in-m3", { geography: "SI", inputUnit: "m3" }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("priced-in-m3");
    expect(result.conversion?.basis).toBe("identity");
    expect(result.conversion?.multiplier).toBe("1");
  });

  it("prefers a contextual conversion over a universal one", () => {
    const result = resolveFactor(
      query({ inputUnit: "m3" }),
      [
        factor("via-universal", { geography: "SI", inputUnit: "L" }),
        factor("via-contextual", { geography: "SI", inputUnit: "kWh_net" }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("via-contextual");
    expect(result.conversion?.basis).toBe("contextual");
  });

  it("keeps geography above the conversion basis", () => {
    // The Slovenian factor needs a conversion; the GLOBAL one does not. The
    // conversion is exact arithmetic, the geography fallback is a real loss of
    // accuracy — so the country wins.
    const result = resolveFactor(
      query({ inputUnit: "m3" }),
      [
        factor("global-exact-unit", { inputUnit: "m3" }),
        factor("country-converted", { geography: "SI", inputUnit: "kWh_net" }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("country-converted");
  });

  it("returns failed_unit — not a 0 — when no path reaches the factor", () => {
    const result = resolveFactor(
      query({ inputUnit: "km" }),
      [factor("gas", { geography: "SI", inputUnit: "kWh_gross" })],
      CONVERSIONS,
    );

    expect(result.status).toBe("failed_unit");
    expect(result.value).not.toBe(0);
    expect(result.value).toBeNull();
    expect(result.factor).toBeNull();
    expect(result.conversion).toBeNull();
    // The diagnosis names the unit the factor wanted — the fix is a conversion
    // row, which is a different fix from a missing factor.
    expect(result).toMatchObject({ wantedUnits: ["kWh_gross"] });
  });

  it("distinguishes failed_unit from failed_missing_factor", () => {
    const noFactor = resolveFactor(
      query({ activityType: "unknown_fuel", inputUnit: "km" }),
      [factor("gas", { geography: "SI" })],
      CONVERSIONS,
    );

    expect(noFactor.status).toBe("failed_missing_factor");
    expect(noFactor).toMatchObject({ wantedUnits: [] });
  });
});

describe("resolveFactor — unit distance, the 1.3.0 rung", () => {
  // The rung asks ONE question before the contextual/universal basis is
  // consulted at all: does the entered number reach this factor unchanged?
  //   0 `as_entered` — same unit, or one `unit_conversion` renames it onto at ×1
  //   1 `converted`  — a conversion that multiplies by something else
  it("prefers a ×1 RENAMING over a contextual conversion", () => {
    // `kWh → kWh_gross` is ×1 and UNIVERSAL; `kWh → kWh_net` is ×0.90259 and
    // CONTEXTUAL. Before 1.3.0 the basis decided and the calorific route won.
    // Now distance decides first: 0.90259 is a published ratio and 1 is not a
    // conversion at all, so the factor on the entered basis wins.
    const result = resolveFactor(
      query({ inputUnit: "kWh" }),
      [
        factor("gross", { geography: "SI", inputUnit: "kWh_gross" }),
        factor("net", { geography: "SI", inputUnit: "kWh_net" }),
      ],
      CONVERSIONS,
    );

    expect(result.status).toBe("ok");
    expect(result.factor?.id).toBe("gross");
    expect(result.conversion).toMatchObject({
      fromUnit: "kWh",
      toUnit: "kWh_gross",
      multiplier: "1",
      basis: "universal",
    });
  });

  it("does NOT override geography: a converted SI factor beats a GLOBAL one at ×1", () => {
    // THE ORDER OF THE TUPLE, as a test. The GLOBAL factor is priced in the
    // basis the row was entered on and needs no conversion; the Slovenian one
    // needs a calorific value. Geography is still the outer component, because
    // a conversion is arithmetic on the right country's measurement while a
    // GLOBAL fallback is a different measurement entirely.
    const result = resolveFactor(
      query({ inputUnit: "kWh" }),
      [
        factor("global-as-entered", { inputUnit: "kWh_gross" }),
        factor("country-converted", { geography: "SI", inputUnit: "kWh_net" }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("country-converted");
    expect(result).toMatchObject({ tier: "site_country" });
    expect(result.conversion?.multiplier).toBe("0.90259");
  });

  it("still ranks the year INSIDE the rung, never above it", () => {
    // Distance is outside the year, exactly as the basis always was: a factor
    // for the WRONG year is not a candidate at all (`yearRank` excludes it), and
    // between an exact year and a year-agnostic one the nearer unit wins first.
    const result = resolveFactor(
      query({ inputUnit: "kWh" }),
      [
        factor("agnostic-as-entered", {
          geography: "SI",
          inputUnit: "kWh_gross",
          applicableYear: null,
        }),
        factor("exact-converted", {
          geography: "SI",
          inputUnit: "kWh_net",
          applicableYear: 2025,
        }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("agnostic-as-entered");
  });

  it("leaves the contextual/universal preference in force below it", () => {
    // Neither candidate is reachable at ×1, so the rung ties and the basis
    // decides — the 1.2.0 behaviour, unchanged.
    const result = resolveFactor(
      query({ inputUnit: "m3" }),
      [
        factor("via-universal", { geography: "SI", inputUnit: "L" }),
        factor("via-contextual", { geography: "SI", inputUnit: "kWh_net" }),
      ],
      CONVERSIONS,
    );

    expect(result.factor?.id).toBe("via-contextual");
    expect(result.conversion?.basis).toBe("contextual");
  });

  it("still raises when two ×1 factors tie all the way down", () => {
    // The rung narrows; it does not stop refusing. Two factors both priced in
    // the entered unit, same rung, same year, same (absent) date.
    const candidates = [
      factor("a", { geography: "SI", publicationDate: null }),
      factor("b", {
        geography: "SI",
        publicationDate: null,
        sourceName: "IEA",
      }),
    ];

    expect(() =>
      resolveFactor(query({ inputUnit: "kWh_gross" }), candidates, CONVERSIONS),
    ).toThrow(FactorsAmbiguousError);
  });
});

describe("the ladder is declared once (FORMULA_VERSION)", () => {
  // If any of this changes, the version must change with it — and the T5.2
  // golden expectations carry the version, so they go red in the same run.
  it("pins the tier order", () => {
    expect([...FACTOR_PRIORITY_TIERS]).toEqual([
      "supplier_specific",
      "site_country",
      "global",
    ]);
    expect([...UNIT_CONVERSION_BASES]).toEqual([
      "identity",
      "set_contextual",
      "set_universal",
      "contextual",
      "universal",
    ]);
    expect([...UNIT_CONVERSION_DISTANCES]).toEqual(["as_entered", "converted"]);
  });

  it("pins what the version covers", () => {
    // 1.1.0 was T5.3's bump: CALC-5's market-based matching joined the
    // definition (a proration with a rounding of its own, an instrument order,
    // a cap and a market-factor ladder). No Scope-1 figure moved — see the
    // note on FORMULA_VERSION — but the string now names a second methodology
    // and had to say so.
    //
    // 1.2.0 is the supplier rung: it used to admit ANY `source_name='supplier'`
    // factor for ANY row naming ANY supplier, and now demands that the two name
    // the SAME seller (`factorSupplierRule`, migration 0007). That is a change
    // to the factor priority ladder, which is point 2 of what this string
    // covers. Again no shipped figure moves — `legacy-v1` carries no supplier
    // factor at all — but "1.1.0" would otherwise have meant two ladders.
    //
    // 1.3.0 inserts a RUNG: unit distance, between geography and the
    // contextual/universal basis (`unitDistance`, `unitDistanceRule`). Unlike
    // its two predecessors this one moves shipped numbers, and the move is the
    // point — a gas bill in `kWh` used to raise `FACTORS_AMBIGUOUS` and now
    // resolves to the `kWh_gross` factor at ×1 (see the block below). The two
    // golden fixtures were re-checked line by line and neither carries a ×1
    // conversion or an activity type priced in two units, so not one of their
    // hand-worked figures moved; only the version string did.
    //
    // 1.4.0 gives the conversion basis a SCOPE (`unitConversion`,
    // `unitConversionRule`): migration 0010 put a `factor_set_id` on
    // `unit_conversion`, and the pinned set's own rows now outrank the shared
    // table's, contextual before universal inside each. It moves a shipped
    // number too, and a WRONG one rather than only a refusal — a Slovenian gas
    // bill in `kWh` was reaching `si-2025`'s factors through DEFRA's UK
    // calorific values, whose two routes disagreed by 3.69% and tied, and now
    // reaches them through ARSO's own (see
    // `db/__tests__/factor-set-si-2025.integration.test.ts`). `legacy-v1` owns
    // no set-scoped conversion, so its 440 rows are untouched, and neither
    // golden fixture carries one either — only the version string moved there.
    expect(FORMULA_VERSION).toBe("hosmos-calc-1.5.0");
    expect(ROUNDING_RULE).toBe("half_up_6dp");
    expect(ROUNDING_DECIMALS).toBe(6);
    expect(VAL_034_TOLERANCE).toBe(0.005);
    expect(FORMULA_DEFINITION).toEqual({
      version: "hosmos-calc-1.5.0",
      formula:
        "co2e_kg = input_value × conversion_factor × factor_value × output_to_kg",
      outputUnitRule:
        "kgCO2e ×1; tCO2e ×1000; unsupported or energy numerators failed_unit; round only the final line",
      factorPriority: ["supplier_specific", "site_country", "global"],
      factorSupplierRule:
        "the supplier_specific rung admits a factor only when its `supplier_name` " +
        "is the SAME seller as the activity row's `supplier` (compared case- and " +
        "whitespace-insensitively, never fuzzily); a factor of any other supplier " +
        "is on no rung at all and can price no row",
      factorYearRule:
        "exact applicable_year, else a year-agnostic (NULL) factor of the same tier; " +
        "a factor published for a DIFFERENT year never substitutes",
      factorTieBreak:
        "greatest publication_date (NULL counts as the oldest); a surviving tie " +
        "raises FACTORS_AMBIGUOUS and never picks a candidate",
      unitDistance: ["as_entered", "converted"],
      unitDistanceRule:
        "a factor priced in the quantity the row was ENTERED in — the same unit, " +
        "or one `unit_conversion` renames it onto at exactly ×1 — outranks every " +
        "factor reached by a conversion that changes the number, whatever that " +
        "conversion's basis; the rung sits BELOW geography and ABOVE the " +
        "contextual/universal preference",
      unitConversion: [
        "identity",
        "set_contextual",
        "set_universal",
        "contextual",
        "universal",
      ],
      unitConversionRule:
        "a `unit_conversion` row belonging to the period's PINNED factor set " +
        "outranks a shared one (`factor_set_id IS NULL`) whatever their bases, " +
        "because a calorific value is a measurement of one country's fuel and " +
        "therefore part of a methodology; contextual still beats universal INSIDE " +
        "each scope, and a row belonging to any OTHER set is on no rung at all",
      roundingRule: "half_up_6dp",
      roundingDecimals: 6,
      aggregationTolerance: 0.005,
      balanceTolerance: 0.005,
      scope2Matching: {
        granularity: "legal_entity",
        unit: "MWh",
        prorationRule:
          "an instrument's volume is multiplied by (days of its vintage window " +
          "inside the period) / (days of that window); a window with an open end " +
          "is closed at the period's edge, and a window wholly outside the period " +
          "contributes nothing",
        prorationDecimals: 6,
        consumptionOrder: ["facility_bound", "entity_level"],
        cap: "the matched total is capped by the legal entity's period consumption",
        marketFactorLadder: [
          "supplier_specific",
          "residual_mix",
          "grid_average",
        ],
        matchedFactor:
          "a cancelled attribute certificate prices its matched MWh at an explicit " +
          "zero; `supplier_product` is not a volume claim and is priced through the " +
          "supplier_specific rung instead",
      },
    });
  });
});

describe("resolveFactor against the shipped factor set `legacy-v1`", () => {
  // Every row of the real set, asked for by its own resolve key. The set carries
  // NO publication dates, so if any two rows shared a key the resolver would
  // reach the ambiguity branch — which is exactly what this sweep rules out
  // before S5 ever runs a calculation.
  const CANDIDATES: readonly FactorCandidate[] = legacyFactorRows().map(
    (row) => ({
      id: row.id,
      factorSetId: LEGACY_FACTOR_SET.id,
      activityType: row.activity_type,
      geography: row.geography,
      inputUnit: row.input_unit,
      applicableYear: row.applicable_year,
      publicationDate: null,
      sourceName: row.source_name,
      sourceVersion: row.source_version,
      // The shipped set has no supplier's own factor in it — which is why the
      // defect the `supplier_name` column closes was latent (0007).
      supplierName: null,
      factorValue: row.factor_value,
      outputUnit: row.output_unit,
      status: row.status,
      validFrom: null,
      validTo: null,
    }),
  );

  it("resolves emissions factors to themselves and refuses the EV energy intensity", () => {
    expect(CANDIDATES).toHaveLength(440);

    for (const row of CANDIDATES) {
      const result = resolveFactor(
        {
          factorSetId: LEGACY_FACTOR_SET.id,
          activityType: row.activityType,
          geography: row.geography,
          inputUnit: row.inputUnit,
          applicableYear: row.applicableYear,
          asOf: "2026-01-01",
        },
        CANDIDATES,
        CONVERSIONS,
      );

      if (row.outputUnit === "kWh") {
        expect(result.status).toBe("failed_unit");
        expect(result.value).toBeNull();
        continue;
      }
      expect(`${row.id}:${result.status}`).toBe(`${row.id}:ok`);
      expect(result.factor?.id).toBe(row.id);
      expect(result.conversion?.multiplier).toBe("1");
    }
  });

  it("PRICES A GAS BILL IN kWh — it used to refuse one (1.3.0)", () => {
    // THE DEFECT, against the real set. `legacy-v1` prices natural gas in
    // `kWh_gross`, `kWh_net` and `m3` — all GLOBAL, all 2025, all with a NULL
    // publication date — and a `kWh` row reaches `kWh_net` (×0.90259) and `m3`
    // (×0.0906273223251) through two CONTEXTUAL calorific rows. Those two tied
    // on geography, on basis, on year and on the empty date, so the resolver
    // raised FACTORS_AMBIGUOUS and the commonest Scope-1 input there is could
    // not be calculated at all.
    //
    // The unit-distance rung ends it: `kWh → kWh_gross` is the conversion
    // table's ×1 statement that a billed kWh IS Gross CV, so the entered number
    // reaches that factor unchanged and beats both derived routes.
    const result = resolveFactor(
      {
        factorSetId: LEGACY_FACTOR_SET.id,
        activityType: "natural_gas",
        geography: "SI",
        inputUnit: "kWh",
        applicableYear: 2025,
        asOf: "2025-12-31",
      },
      CANDIDATES,
      CONVERSIONS,
    );

    expect(result.status).toBe("ok");
    // WHICH factor, not merely "it did not throw": the 2025 Gross-CV row.
    expect(result.factor?.inputUnit).toBe("kWh_gross");
    expect(result.factor?.applicableYear).toBe(2025);
    expect(result.value).toBe("0.18296");
    // …and at ×1, so 1 500 kWh is priced 1500 × 1 × 0.18296 and nothing about
    // the invoice's number was re-derived on the way.
    expect(result.conversion).toMatchObject({
      fromUnit: "kWh",
      toUnit: "kWh_gross",
      multiplier: "1",
    });
    expect(result).toMatchObject({ tier: "global" });
  });

  it("prices an LPG bill in kWh per kWh, not by way of litres (1.3.0)", () => {
    // The rung's OTHER shipped effect, and the only other one over all 440 rows
    // (a full unit × group sweep was run against both ladders to be sure). LPG
    // is priced in `L`, `t` and `kWh_gross`; a `kWh` row used to take the
    // CONTEXTUAL `kWh → L` (×0.137754328930) and the per-litre factor, i.e. it
    // travelled to litres through a density and back. 0.137754328930 × 1.55713
    // = 0.214501398… against the published 0.21450 per kWh — the same number to
    // six decimals, 1.4 × 10⁻⁷ apart, reached by a round trip nobody asked for.
    // It now takes the factor DEFRA publishes for the unit on the bill.
    const result = resolveFactor(
      {
        factorSetId: LEGACY_FACTOR_SET.id,
        activityType: "lpg",
        geography: "SI",
        inputUnit: "kWh",
        applicableYear: 2025,
        asOf: "2025-12-31",
      },
      CANDIDATES,
      CONVERSIONS,
    );

    expect(result.status).toBe("ok");
    expect(result.factor?.inputUnit).toBe("kWh_gross");
    expect(result.value).toBe("0.21450");
    expect(result.conversion?.multiplier).toBe("1");
  });

  it("prices Slovenian grid electricity from the country row, not GLOBAL", () => {
    const result = resolveFactor(
      {
        factorSetId: LEGACY_FACTOR_SET.id,
        activityType: "grid:grid_electricity",
        geography: "SI",
        inputUnit: "kWh",
        applicableYear: 2024,
        asOf: "2024-12-31",
      },
      CANDIDATES,
      CONVERSIONS,
    );

    expect(result.status).toBe("ok");
    expect(result.factor?.geography).toBe("SI");
    expect(result).toMatchObject({ tier: "site_country" });
  });

  it("refuses a country the set does not price — it does not fall back to 0", () => {
    const result = resolveFactor(
      {
        factorSetId: LEGACY_FACTOR_SET.id,
        activityType: "grid:grid_electricity",
        geography: "ZZ",
        inputUnit: "kWh",
        applicableYear: 2024,
        asOf: "2024-12-31",
      },
      CANDIDATES,
      CONVERSIONS,
    );

    expect(result.status).toBe("failed_missing_factor");
    expect(result.value).not.toBe(0);
    expect(result.value).toBeNull();
  });
});

describe("resolveFactor — the account it gives of itself (provenance)", () => {
  /** The `ok` branch, narrowed — every assertion below reads `provenance`. */
  function resolved(
    candidates: readonly FactorCandidate[],
    overrides: Partial<FactorQuery> = {},
  ) {
    const result = resolveFactor(query(overrides), candidates, CONVERSIONS);
    if (result.status !== "ok") {
      throw new Error(`expected ok, got ${result.status}`);
    }
    return result;
  }

  it("records the rung, the year and the conversion that produced the winner", () => {
    const result = resolved([
      factor("national", { geography: "SI", inputUnit: "m3" }),
    ]);

    // Every component of the rank tuple, in the words the ladder uses for it —
    // and the multiplier, which is what makes the stored figure re-derivable
    // from the account alone rather than from a second run of this module.
    expect(result.provenance).toEqual({
      tier: "site_country",
      yearBasis: "exact",
      requestedYear: 2025,
      geography: "SI",
      enteredUnit: "kWh_gross",
      factorUnit: "m3",
      unitDistance: "converted",
      conversionBasis: "contextual",
      conversionMultiplier: expect.any(String),
      passedOver: [],
    });
  });

  it("names a STRONGER-TIER factor the entered unit cannot reach", () => {
    // The shape of the si-2025 defect, in miniature: the country's own factor is
    // priced in a unit no conversion reaches from the one on the invoice, so the
    // GLOBAL row wins — correctly, and until now silently.
    const result = resolved([
      factor("global", { geography: "GLOBAL", inputUnit: "kWh_gross" }),
      factor("national", {
        geography: "SI",
        inputUnit: "widget",
        sourceName: "ARSO",
        sourceVersion: "2025",
      }),
    ]);

    expect(result.factor.id).toBe("global");
    expect(result.provenance.tier).toBe("global");
    expect(result.provenance.passedOver).toEqual([
      {
        reason: "unit_unreachable",
        tier: "site_country",
        geography: "SI",
        sourceName: "ARSO",
        sourceVersion: "2025",
        applicableYear: 2025,
        inputUnits: ["widget"],
        factorIds: ["national"],
      },
    ]);
  });

  it("names an exact-year factor published for ANOTHER year", () => {
    const result = resolved(
      [
        factor("global", { geography: "GLOBAL", applicableYear: null }),
        factor("national-2025", {
          geography: "SI",
          applicableYear: 2025,
          sourceName: "ARSO",
        }),
      ],
      { applicableYear: 2024 },
    );

    expect(result.factor.id).toBe("global");
    expect(result.provenance).toMatchObject({
      tier: "global",
      yearBasis: "year_agnostic",
      requestedYear: 2024,
    });
    expect(result.provenance.passedOver).toEqual([
      {
        reason: "year_mismatch",
        tier: "site_country",
        geography: "SI",
        sourceName: "ARSO",
        sourceVersion: "2025 v1.0",
        applicableYear: 2025,
        inputUnits: ["kWh_gross"],
        factorIds: ["national-2025"],
      },
    ]);
  });

  it("groups one measurement's denominations into ONE entry", () => {
    // A source publishes the same national measurement per m³, per kWh and per
    // MWh. That is one fact about one year, and three sentences differing only
    // in a unit code would be noise rather than disclosure — so it is one entry
    // carrying every denomination, whichever of them the entered unit reaches.
    const national = (unit: string) =>
      factor(`si-${unit}`, {
        geography: "SI",
        inputUnit: unit,
        applicableYear: 2025,
        sourceName: "ARSO",
      });
    const result = resolved(
      [
        factor("global", { geography: "GLOBAL", applicableYear: null }),
        national("m3"),
        national("kWh_net"),
        national("MWh"),
      ],
      { applicableYear: 2024 },
    );

    expect(result.provenance.passedOver).toHaveLength(1);
    expect(result.provenance.passedOver[0]).toMatchObject({
      reason: "year_mismatch",
      inputUnits: ["MWh", "kWh_net", "m3"],
      factorIds: ["si-MWh", "si-kWh_net", "si-m3"],
    });
  });

  it("says NOTHING about a candidate that merely lost the ladder", () => {
    // Two eligible national factors, both reachable, one of them beaten on the
    // unit-distance rung. The ladder IS the answer for it — it competed and it
    // lost — and repeating that as a disclosure would put a marker on a report
    // whose figures rest on the strongest basis the set holds.
    const result = resolved([
      factor("as-entered", { geography: "SI", inputUnit: "kWh_gross" }),
      factor("converted", { geography: "SI", inputUnit: "m3" }),
    ]);

    expect(result.factor.id).toBe("as-entered");
    expect(result.provenance.passedOver).toEqual([]);
  });

  it("says nothing about a SAME-TIER factor it merely cannot reach", () => {
    // The certainty rule, and the reason it is strict. This unreachable factor
    // sits on the winner's own rung, so nothing is known about where it would
    // have landed on distance or basis — it might have lost anyway. A
    // disclosure that MIGHT be wrong is worse than none, so it is not made.
    const result = resolved([
      factor("reachable", { geography: "SI", inputUnit: "kWh_gross" }),
      factor("unreachable", { geography: "SI", inputUnit: "widget" }),
    ]);

    expect(result.factor.id).toBe("reachable");
    expect(result.provenance.passedOver).toEqual([]);
  });

  it("says nothing about another country's, another set's or an archived row", () => {
    // The line between a LEGITIMATE EXCLUSION and a DISCLOSABLE SUBSTITUTION.
    // A factor for another country was never a candidate for this row; one of
    // another set is outside the pin (К-24); an archived one was withdrawn. None
    // of the three is something this figure was "priced instead of", and
    // listing them would make the marker meaningless by making it universal.
    const result = resolved([
      factor("global", { geography: "GLOBAL", inputUnit: "kWh_gross" }),
      factor("another-country", { geography: "DE", inputUnit: "widget" }),
      factor("another-set", {
        factorSetId: OTHER_SET,
        geography: "SI",
        inputUnit: "widget",
      }),
      factor("archived", {
        geography: "SI",
        inputUnit: "widget",
        status: "archived",
      }),
      factor("expired", {
        geography: "SI",
        inputUnit: "widget",
        validTo: "2024-12-31",
      }),
    ]);

    expect(result.factor.id).toBe("global");
    expect(result.provenance.passedOver).toEqual([]);
  });

  it("orders the entries deterministically, whatever order the pool arrives in", () => {
    // A rendered report is a promise about BYTES (REN-5), and this list reaches
    // the page. Two runs over the same set must produce the same list even when
    // Postgres hands the rows back in a different order.
    const pool = [
      factor("global", { geography: "GLOBAL", applicableYear: null }),
      factor("si-a", {
        geography: "SI",
        inputUnit: "widget",
        sourceName: "ARSO",
      }),
      factor("si-b", {
        geography: "SI",
        inputUnit: "gadget",
        sourceName: "SURS",
      }),
    ];
    const forwards = resolved(pool, { applicableYear: 2024 });
    const backwards = resolved([...pool].reverse(), { applicableYear: 2024 });
    expect(backwards.provenance.passedOver).toEqual(
      forwards.provenance.passedOver,
    );
    expect(
      forwards.provenance.passedOver.map((entry) => entry.sourceName),
    ).toEqual(["ARSO", "SURS"]);
  });
});
