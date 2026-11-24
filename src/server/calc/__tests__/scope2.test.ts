// =============================================================================
// SCOPE 2 — GOLDEN TESTS (T5.3, CALC-5, TEST-3, О-11). NO DATABASE.
//
// The expectations live in `./golden/scope2-dual.json`, each with the hand
// arithmetic that produced it. They were NOT produced by running this engine
// and recording the output — that would only prove the code agrees with itself.
// The arithmetic string next to every number is the proof, and it is checkable
// with a pencil by someone who trusts neither the author nor the code.
//
// This file's job is therefore narrow: feed the fixture in, compare every
// field, and add the assertions the fixture cannot make about ITSELF —
//   - that one energy row yields exactly two lines and they differ only in
//     `reporting_basis` (К-20);
//   - that the cap and VAL-022's over-claim flag are BOTH present, by computing
//     what the uncapped arithmetic would have produced and showing it negative;
//   - that the matching is a function of the DATA and not of array order;
//   - that a market-based figure can never come out below zero.
// =============================================================================
import { describe, expect, it } from "vitest";

import { formatDecimal, multiply, parseDecimal, subtract } from "../decimal";
import {
  FORMULA_VERSION,
  PRORATION_DECIMALS,
  ROUNDING_DECIMALS,
  ROUNDING_RULE,
  type InstrumentConsumptionRank,
  type MarketFactorBasis,
} from "../formula-version";
import {
  computeScope2,
  matchInstruments,
  type InstrumentSkipReason,
  type Scope2EnergyRow,
  type Scope2Factor,
  type Scope2Instrument,
  type Scope2Period,
} from "../scope2";
import type { Calc1ExclusionReason } from "../selection";
import type { ConversionCandidate } from "../units";

import goldenJson from "./golden/scope2-dual.json";

/** The fixture's shape. Declared here so the JSON is checked, not trusted. */
interface GoldenFixture {
  readonly formulaVersion: string;
  readonly roundingRule: string;
  readonly roundingDecimals: number;
  readonly prorationDecimals: number;
  readonly period: Scope2Period;
  readonly conversions: readonly ConversionCandidate[];
  readonly factors: readonly Scope2Factor[];
  readonly rows: readonly Scope2EnergyRow[];
  readonly instruments: readonly Scope2Instrument[];
  readonly expectedExcludedRows: readonly {
    readonly rowId: string;
    readonly reason: Calc1ExclusionReason;
  }[];
  readonly expectedExcludedInstruments: readonly {
    readonly rowId: string;
    readonly reason: Calc1ExclusionReason;
  }[];
  readonly expectedSkippedInstruments: readonly {
    readonly instrumentId: string;
    readonly reason: InstrumentSkipReason;
  }[];
  readonly expectedRowVolumes: readonly {
    readonly energyRowId: string;
    readonly consumptionMwh: string;
    readonly coveredMwh: string;
    readonly residualMwh: string;
  }[];
  readonly expectedMatches: readonly {
    readonly instrumentId: string;
    readonly legalEntityId: string;
    readonly rank: InstrumentConsumptionRank;
    readonly sequence: number;
    readonly declaredVolumeMwh: string;
    readonly windowDays: number;
    readonly overlapDays: number;
    readonly proratedVolumeMwh: string;
    readonly matchedVolumeMwh: string;
    readonly allocations: readonly {
      readonly energyRowId: string;
      readonly volumeMwh: string;
      readonly pass: "own_facility" | "entity_spill";
    }[];
  }[];
  readonly expectedEntities: readonly {
    readonly legalEntityId: string;
    readonly consumptionMwh: string;
    readonly claimedMwh: string;
    readonly coveredMwh: string;
    readonly residualMwh: string;
    readonly overClaimed: boolean;
    readonly declaredResidualMwh: string | null;
    readonly unconvertibleRowIds: readonly string[];
  }[];
  readonly expectedLines: readonly {
    readonly activityRowId: string;
    readonly reportingBasis: "location_based" | "market_based";
    readonly calculationStatus: string;
    readonly methodCode: string;
    readonly inputValue: string | null;
    readonly inputUnit: string;
    readonly conversionFactor: string;
    readonly conversionId: string | null;
    readonly factorId: string | null;
    readonly marketFactorBasis: MarketFactorBasis | null;
    readonly coveredMwh: string | null;
    readonly co2eResult: string | null;
  }[];
  readonly expectedWriteBacks: readonly {
    readonly energyRowId: string;
    readonly locationFactorId: string | null;
    readonly marketFactorId: string | null;
  }[];
  readonly expectedTotals: {
    readonly locationBasedCo2e: string;
    readonly marketBasedCo2e: string;
    readonly lineCount: number;
    readonly okCount: number;
    readonly failedCount: number;
    readonly runStatus: "ok" | "failed";
  };
}

const golden = goldenJson as unknown as GoldenFixture;

const result = computeScope2(
  golden.rows,
  golden.instruments,
  golden.factors,
  golden.conversions,
  golden.period,
);

/** The entity whose certificates claim 150% of its consumption. */
const OVER_CLAIMING_ENTITY = "00000000-0000-4000-8000-00000000e002";
/** Its single energy row — 200 MWh against a 300 MWh claim. */
const OVER_CLAIMED_ROW = "00000000-0000-4000-8000-00000000ea03";
/** AC-5's row: 120 MWh, covered 100% by a guarantee of origin. */
const FULLY_COVERED_ROW = "00000000-0000-4000-8000-00000000ea06";
/** The row whose instrument's vintage window half-overlaps the period. */
const HALF_VINTAGE_ROW = "00000000-0000-4000-8000-00000000ea04";
/** The instrument bound to a facility — consumed before the entity-level one. */
const FACILITY_BOUND_INSTRUMENT = "00000000-0000-4000-8000-00000000c101";
const ENTITY_LEVEL_INSTRUMENT = "00000000-0000-4000-8000-00000000c102";
/** The 2023 certificate: its vintage window misses the period entirely. */
const STALE_VINTAGE_INSTRUMENT = "00000000-0000-4000-8000-00000000c105";
/** The German residual-mix factor, which prices the over-claiming entity. */
const DE_RESIDUAL_FACTOR_VALUE = "0.620";

const lineFor = (activityRowId: string, basis: string) => {
  const line = result.lines.find(
    (l) => l.activityRowId === activityRowId && l.reportingBasis === basis,
  );
  if (!line) throw new Error(`no ${basis} line for ${activityRowId}`);
  return line;
};

const matchFor = (instrumentId: string) => {
  const match = result.matching.matches.find(
    (m) => m.instrumentId === instrumentId,
  );
  if (!match) throw new Error(`no match for ${instrumentId}`);
  return match;
};

const entityFor = (legalEntityId: string) => {
  const entity = result.matching.entities.find(
    (e) => e.legalEntityId === legalEntityId,
  );
  if (!entity) throw new Error(`no balance for ${legalEntityId}`);
  return entity;
};

const volumeFor = (energyRowId: string) => {
  const volume = result.matching.rows.find(
    (r) => r.energyRowId === energyRowId,
  );
  if (!volume) throw new Error(`no volumes for ${energyRowId}`);
  return volume;
};

describe("golden fixture — the version is part of the expectations", () => {
  // Same mechanism as T5.2: FORMULA_VERSION now also covers CALC-5's matching
  // (the proration and its rounding, the instrument order, the cap, the market
  // ladder), every one of which can move a figure below without any input
  // changing. A bump has to be accompanied by a fresh look at these numbers,
  // and this assertion is what forces the look.
  it("pins FORMULA_VERSION, the rounding rule and both precisions", () => {
    expect(FORMULA_VERSION).toBe(golden.formulaVersion);
    expect(ROUNDING_RULE).toBe(golden.roundingRule);
    expect(ROUNDING_DECIMALS).toBe(golden.roundingDecimals);
    expect(PRORATION_DECIMALS).toBe(golden.prorationDecimals);
    expect(result.formulaVersion).toBe(golden.formulaVersion);
    expect(result.roundingRule).toBe(golden.roundingRule);
  });

  it("stamps every line with the version and the rounding rule (VAL-035)", () => {
    for (const line of result.lines) {
      expect(line.formulaVersion).toBe(golden.formulaVersion);
      expect(line.roundingRule).toBe(golden.roundingRule);
    }
  });
});

describe("CALC-5 / К-20 — two lines per row, and only two", () => {
  it("gives every included row exactly two lines, one per basis", () => {
    const included = golden.rows.length - golden.expectedExcludedRows.length;
    expect(result.lines).toHaveLength(included * 2);

    for (const volume of result.matching.rows) {
      const bases = result.lines
        .filter((l) => l.activityRowId === volume.energyRowId)
        .map((l) => l.reportingBasis);
      expect(bases).toEqual(["location_based", "market_based"]);
    }
  });

  it("never emits a third line, and never a `null` basis (К-20)", () => {
    // Scope 1 stores NULL there; Scope 2's whole point is that it does not.
    for (const line of result.lines) {
      expect(line.scope).toBe("scope2");
      expect(line.reportingBasis).not.toBeNull();
      expect(line.biogenicCo2Result).toBeNull();
      expect(line.activityTable).toBe("purchased_energy_activity");
    }
  });

  it("writes NO line at all for a row CALC-1 excluded", () => {
    for (const excluded of golden.expectedExcludedRows) {
      expect(
        result.lines.filter((l) => l.activityRowId === excluded.rowId),
      ).toEqual([]);
    }
  });
});

describe("golden fixture — every line, against the hand arithmetic", () => {
  it("produces exactly the expected lines, in order", () => {
    expect(
      result.lines.map((l) => `${l.activityRowId}:${l.reportingBasis}`),
    ).toEqual(
      golden.expectedLines.map((e) => `${e.activityRowId}:${e.reportingBasis}`),
    );
  });

  it.each(golden.expectedLines)(
    "$activityRowId $reportingBasis → $co2eResult kgCO2e",
    (expected) => {
      const line = lineFor(expected.activityRowId, expected.reportingBasis);

      expect(line.calculationStatus).toBe(expected.calculationStatus);
      expect(line.methodCode).toBe(expected.methodCode);
      expect(line.inputValue).toBe(expected.inputValue);
      expect(line.inputUnit).toBe(expected.inputUnit);
      expect(line.conversionFactor).toBe(expected.conversionFactor);
      expect(line.conversionId).toBe(expected.conversionId);
      expect(line.factorId).toBe(expected.factorId);
      expect(line.marketFactorBasis).toBe(expected.marketFactorBasis);
      expect(line.coveredMwh).toBe(expected.coveredMwh);
      expect(line.co2eResult).toBe(expected.co2eResult);
    },
  );

  it("matches the expected totals and run status", () => {
    expect(result.totals.locationBasedCo2e).toBe(
      golden.expectedTotals.locationBasedCo2e,
    );
    expect(result.totals.marketBasedCo2e).toBe(
      golden.expectedTotals.marketBasedCo2e,
    );
    expect(result.totals.lineCount).toBe(golden.expectedTotals.lineCount);
    expect(result.totals.okCount).toBe(golden.expectedTotals.okCount);
    expect(result.totals.failedCount).toBe(golden.expectedTotals.failedCount);
    expect(result.runStatus).toBe(golden.expectedTotals.runStatus);
  });

  it("re-derives every OK line from its own stored columns", () => {
    // DM-29 stores `input_value`, `conversion_factor` and `factor_id`; the
    // market-based line's covered share is priced at an explicit zero and is
    // therefore ABSENT from `input_value` rather than added afterwards. This is
    // the assertion that keeps that true: if a future change ever folded a
    // non-zero covered term into the result, the row would stop reproducing.
    for (const line of result.lines) {
      if (line.calculationStatus !== "ok") continue;
      const redone = multiply(
        multiply(
          parseDecimal(line.inputValue as string),
          parseDecimal(line.conversionFactor),
        ),
        parseDecimal(line.factor?.factorValue as string),
      );
      expect(formatDecimal(redone, ROUNDING_DECIMALS)).toBe(line.co2eResult);
    }
  });
});

describe("§9 — the matching, instrument by instrument", () => {
  it("matches exactly the expected instruments, in the expected order", () => {
    expect(result.matching.matches.map((m) => m.instrumentId)).toEqual(
      golden.expectedMatches.map((e) => e.instrumentId),
    );
  });

  it.each(golden.expectedMatches)(
    "$instrumentId ($rank, seq $sequence) → $matchedVolumeMwh MWh",
    (expected) => {
      const match = matchFor(expected.instrumentId);
      expect(match.legalEntityId).toBe(expected.legalEntityId);
      expect(match.rank).toBe(expected.rank);
      expect(match.sequence).toBe(expected.sequence);
      expect(match.declaredVolumeMwh).toBe(expected.declaredVolumeMwh);
      expect(match.vintage.windowDays).toBe(expected.windowDays);
      expect(match.vintage.overlapDays).toBe(expected.overlapDays);
      expect(match.proratedVolumeMwh).toBe(expected.proratedVolumeMwh);
      expect(match.matchedVolumeMwh).toBe(expected.matchedVolumeMwh);
      expect(match.allocations).toEqual(expected.allocations);
    },
  );

  it("consumes the facility-bound instrument BEFORE the entity-level one", () => {
    // The acceptance asks for the ORDER, not only the total — and the total
    // would not have shown it here, since the entity has enough consumption for
    // both certificates either way. Three things say it:
    const bound = matchFor(FACILITY_BOUND_INSTRUMENT);
    const entity = matchFor(ENTITY_LEVEL_INSTRUMENT);

    // 1. the rank each was given;
    expect(bound.rank).toBe("facility_bound");
    expect(entity.rank).toBe("entity_level");
    // 2. the position in the entity's consumption order;
    expect(bound.sequence).toBeLessThan(entity.sequence);
    // 3. and the pass each allocation was taken on — the facility-bound one
    //    ate its OWN site's row first, which is the behaviour the order buys.
    expect(bound.allocations.map((a) => a.pass)).toEqual(["own_facility"]);
    expect(entity.allocations.map((a) => a.pass)).toEqual([
      "entity_spill",
      "entity_spill",
    ]);
    expect(bound.allocations[0].energyRowId).toBe(
      "00000000-0000-4000-8000-00000000ea02",
    );
  });

  it("prorates a half-overlapping vintage to exactly half the volume", () => {
    // 2024-07-04…2025-06-30 is 362 days, of which 181 fall in the period:
    // 200 MWh × 181 ÷ 362 = 100 MWh, and 181/362 is exactly 1/2.
    const match = matchFor("00000000-0000-4000-8000-00000000c104");
    expect(match.vintage.windowDays).toBe(362);
    expect(match.vintage.overlapDays).toBe(181);
    expect(match.proratedVolumeMwh).toBe("100.000000");
    expect(match.declaredVolumeMwh).toBe("200");

    // And it really is HALF — asserted against the declared volume rather than
    // against a literal, so the claim survives a change to the fixture's MWh.
    const half = multiply(
      parseDecimal(match.declaredVolumeMwh),
      parseDecimal("0.5"),
    );
    expect(formatDecimal(half, PRORATION_DECIMALS)).toBe(
      match.proratedVolumeMwh,
    );
    expect(volumeFor(HALF_VINTAGE_ROW).coveredMwh).toBe("100.000000");
  });

  it("gives a vintage window that misses the period entirely NOTHING", () => {
    const match = matchFor(STALE_VINTAGE_INSTRUMENT);
    expect(match.vintage.overlapDays).toBe(0);
    expect(match.proratedVolumeMwh).toBe("0.000000");
    expect(match.matchedVolumeMwh).toBe("0.000000");
    expect(match.allocations).toEqual([]);
    // AND it does not inflate VAL-022's numerator: an instrument that cannot be
    // claimed is not an over-claim. e003 claims 100 MWh, not 150.
    expect(entityFor(match.legalEntityId).claimedMwh).toBe("100.000000");
    expect(entityFor(match.legalEntityId).overClaimed).toBe(false);
  });

  it("keeps a `supplier_product` out of the matching, loudly", () => {
    expect(result.matching.skippedInstruments).toEqual(
      golden.expectedSkippedInstruments.map((e) => ({
        instrumentId: e.instrumentId,
        reason: e.reason,
      })),
    );
    // It is not silently dropped: the row it belongs to is priced by the
    // supplier rung of the ladder instead, which is where a supplier's own
    // factor belongs.
    expect(
      lineFor("00000000-0000-4000-8000-00000000ea05", "market_based")
        .marketFactorBasis,
    ).toBe("supplier_specific");
  });

  it("applies CALC-1 to instruments as well as to rows", () => {
    expect(result.matching.excludedRows).toEqual(
      golden.expectedExcludedRows.map((e) => ({
        rowId: e.rowId,
        reason: e.reason,
      })),
    );
    expect(result.matching.excludedInstruments).toEqual(
      golden.expectedExcludedInstruments.map((e) => ({
        rowId: e.rowId,
        reason: e.reason,
      })),
    );
    // The excluded certificates carry 9 999 MWh each and none of it is claimed.
    expect(entityFor("00000000-0000-4000-8000-00000000e001").claimedMwh).toBe(
      "700.000000",
    );
  });
});

describe("§9 — the volumes, row by row and entity by entity", () => {
  it.each(golden.expectedRowVolumes)(
    "$energyRowId → covered $coveredMwh of $consumptionMwh MWh",
    (expected) => {
      const volume = volumeFor(expected.energyRowId);
      expect(volume.consumptionMwh).toBe(expected.consumptionMwh);
      expect(volume.coveredMwh).toBe(expected.coveredMwh);
      expect(volume.residualMwh).toBe(expected.residualMwh);
    },
  );

  it.each(golden.expectedEntities)(
    "$legalEntityId → claimed $claimedMwh, covered $coveredMwh",
    (expected) => {
      const entity = entityFor(expected.legalEntityId);
      expect(entity.consumptionMwh).toBe(expected.consumptionMwh);
      expect(entity.claimedMwh).toBe(expected.claimedMwh);
      expect(entity.coveredMwh).toBe(expected.coveredMwh);
      expect(entity.residualMwh).toBe(expected.residualMwh);
      expect(entity.overClaimed).toBe(expected.overClaimed);
      expect(entity.declaredResidualMwh).toBe(expected.declaredResidualMwh);
      expect(entity.unconvertibleRowIds).toEqual(expected.unconvertibleRowIds);
    },
  );

  it("balances every entity: covered + residual = consumption (VAL-024)", () => {
    // Not "within a tolerance" — EXACTLY, because the split is subtraction in
    // exact decimal and never a quotient. The tolerance VAL-024 carries is for
    // last-place drift in the stored strings, and there is none to absorb here.
    for (const entity of result.matching.entities) {
      const covered = parseDecimal(entity.coveredMwh);
      const residual = parseDecimal(entity.residualMwh);
      const consumption = parseDecimal(entity.consumptionMwh);
      expect(
        formatDecimal(
          subtract(subtract(consumption, covered), residual),
          PRORATION_DECIMALS,
        ),
      ).toBe("0.000000");
    }
  });

  it("balances every ROW the same way, and never below zero", () => {
    for (const volume of result.matching.rows) {
      const covered = parseDecimal(volume.coveredMwh);
      const consumption = parseDecimal(volume.consumptionMwh as string);
      const residual = parseDecimal(volume.residualMwh as string);
      expect(
        formatDecimal(
          subtract(subtract(consumption, covered), residual),
          PRORATION_DECIMALS,
        ),
      ).toBe("0.000000");
      expect(residual.units < BigInt(0)).toBe(false);
      expect(covered.units < BigInt(0)).toBe(false);
    }
  });

  it("counts only ELECTRICITY towards an entity's matchable consumption", () => {
    // e005 buys 120 MWh of electricity and 40 MWh of district heating; a GoO
    // cannot cover heat, so the denominator §9 names is 120, not 160.
    const entity = entityFor("00000000-0000-4000-8000-00000000e005");
    expect(entity.consumptionMwh).toBe("120.000000");
    expect(volumeFor("00000000-0000-4000-8000-00000000ea07").coveredMwh).toBe(
      "0.000000",
    );
  });
});

describe("AC-5 — a guarantee of origin covering 100% of consumption", () => {
  const location = () => lineFor(FULLY_COVERED_ROW, "location_based");
  const market = () => lineFor(FULLY_COVERED_ROW, "market_based");

  it("drives the market-based figure to zero", () => {
    expect(market().co2eResult).toBe("0.000000");
    expect(market().inputValue).toBe("0.000000");
    expect(market().coveredMwh).toBe("120.000000");
    expect(market().calculationStatus).toBe("ok");
  });

  it("leaves the location-based figure ABOVE zero", () => {
    // The half AC-5 is really about: a contract does not change the physics of
    // the wire, and a dual report where both figures went to zero would be the
    // defect the criterion guards against.
    expect(location().co2eResult).toBe("28800.000000");
    expect(parseDecimal(location().co2eResult as string).units).toBeGreaterThan(
      BigInt(0),
    );
  });

  it("makes the zero AUDITABLE rather than assumed", () => {
    // It is a genuine zero (VAL-033's kind), and the instrument that produced
    // it is named — contrast the unpriced row, whose result is NULL.
    const covering = result.matching.matches.filter((m) =>
      m.allocations.some((a) => a.energyRowId === FULLY_COVERED_ROW),
    );
    expect(covering.map((m) => m.instrumentId)).toEqual([
      "00000000-0000-4000-8000-00000000c107",
    ]);
    expect(market().factorId).not.toBeNull();
  });
});

describe("the cap and VAL-022 are not alternatives", () => {
  const entity = () => entityFor(OVER_CLAIMING_ENTITY);

  it("caps the matched volume at the entity's consumption", () => {
    expect(entity().claimedMwh).toBe("300.000000"); // 150% of consumption
    expect(entity().consumptionMwh).toBe("200.000000");
    expect(entity().coveredMwh).toBe("200.000000"); // capped
    expect(entity().residualMwh).toBe("0.000000");
    // And on the instrument: it claimed 300 and got 200.
    const match = matchFor("00000000-0000-4000-8000-00000000c103");
    expect(match.proratedVolumeMwh).toBe("300.000000");
    expect(match.matchedVolumeMwh).toBe("200.000000");
  });

  it("STILL reports the over-claim — the cap does not absorb it", () => {
    // The flag VAL-022 reads. Without it the cap would swallow 100 MWh of
    // certificates that cover nothing and the report would look perfect.
    expect(entity().overClaimed).toBe(true);
    // …and nobody else is flagged, so the rule is about this set of
    // certificates rather than about certificates in general.
    expect(
      result.matching.entities
        .filter((e) => e.overClaimed)
        .map((e) => e.legalEntityId),
    ).toEqual([OVER_CLAIMING_ENTITY]);
  });

  it("would produce a NEGATIVE market-based figure without the cap", () => {
    // The other half of the interplay, computed rather than asserted from a
    // comment: uncapped, the residual is 200 − 300 = −100 MWh and the German
    // residual mix turns that into −62 000 kgCO2e, a negative emission that
    // would net against real ones in any total that summed the column.
    const uncapped = subtract(
      parseDecimal(entity().consumptionMwh),
      parseDecimal(entity().claimedMwh),
    );
    expect(formatDecimal(uncapped, PRORATION_DECIMALS)).toBe("-100.000000");

    const wouldBe = multiply(
      multiply(uncapped, parseDecimal("1000")),
      parseDecimal(DE_RESIDUAL_FACTOR_VALUE),
    );
    expect(formatDecimal(wouldBe, ROUNDING_DECIMALS)).toBe("-62000.000000");

    // What the engine actually stored, instead:
    expect(lineFor(OVER_CLAIMED_ROW, "market_based").co2eResult).toBe(
      "0.000000",
    );
  });

  it("never lets ANY market-based figure fall below zero", () => {
    for (const line of result.lines) {
      if (line.reportingBasis !== "market_based") continue;
      if (line.co2eResult === null) continue;
      expect(parseDecimal(line.co2eResult).units < BigInt(0)).toBe(false);
    }
  });
});

describe("§4.10 — the two factor ids are written back", () => {
  it("hands back one write-back per calculated row, with both ids", () => {
    expect(result.writeBacks).toEqual(golden.expectedWriteBacks);
  });

  it("agrees with the ids on the lines themselves", () => {
    for (const writeBack of result.writeBacks) {
      expect(writeBack.locationFactorId).toBe(
        lineFor(writeBack.energyRowId, "location_based").factorId,
      );
      expect(writeBack.marketFactorId).toBe(
        lineFor(writeBack.energyRowId, "market_based").factorId,
      );
    }
  });

  it("writes NULL rather than a stale id when a row could not be priced", () => {
    const unpriced = result.writeBacks.find(
      (w) => w.energyRowId === "00000000-0000-4000-8000-00000000ea08",
    );
    expect(unpriced).toEqual({
      energyRowId: "00000000-0000-4000-8000-00000000ea08",
      locationFactorId: null,
      marketFactorId: null,
    });
  });
});

describe("§0.7 — a missing factor is never a zero, on either basis", () => {
  const failed = () => result.lines.filter((l) => l.calculationStatus !== "ok");

  it("fails BOTH lines of the unpriced row and writes no number", () => {
    expect(failed()).toHaveLength(2);
    for (const line of failed()) {
      expect(line.activityRowId).toBe("00000000-0000-4000-8000-00000000ea08");
      expect(line.calculationStatus).toBe("failed_missing_factor");
      expect(line.factorId).toBeNull();
      expect(line.co2eResult).toBeNull();
      expect(line.co2eResult).not.toBe(0);
      expect(line.co2eResult).not.toBe("0");
      expect(line.co2eResult).not.toBe("0.000000");
    }
  });

  it("fails the whole run, which is what blocks approve/render/lock", () => {
    expect(result.runStatus).toBe("failed");
  });
});

// =============================================================================
// Branches the fixture cannot express without becoming unreadable.
// =============================================================================

const compute = (
  rows: readonly Scope2EnergyRow[],
  instruments: readonly Scope2Instrument[] = golden.instruments,
) =>
  computeScope2(
    rows,
    instruments,
    golden.factors,
    golden.conversions,
    golden.period,
  );

const rowFor = (id: string): Scope2EnergyRow => {
  const row = golden.rows.find((r) => r.id === id);
  if (!row) throw new Error(`no fixture row ${id}`);
  return row;
};

const instrumentFor = (id: string): Scope2Instrument => {
  const instrument = golden.instruments.find((i) => i.id === id);
  if (!instrument) throw new Error(`no fixture instrument ${id}`);
  return instrument;
};

describe("the matching is a function of the data, not of array order", () => {
  // T5.1's lesson, restated for CALC-5: taking `candidates[0]` makes a reported
  // figure depend on the physical order of an index, so the same revision
  // reproduces differently after a VACUUM (AC-8, silently).
  const reversed = computeScope2(
    [...golden.rows].reverse(),
    [...golden.instruments].reverse(),
    golden.factors,
    golden.conversions,
    golden.period,
  );

  it("produces identical entity balances from reversed inputs", () => {
    expect(reversed.matching.entities).toEqual(result.matching.entities);
  });

  it("produces identical instrument matches, in the same order", () => {
    expect(reversed.matching.matches).toEqual(result.matching.matches);
  });

  it("produces identical totals", () => {
    expect(reversed.totals.locationBasedCo2e).toBe(
      result.totals.locationBasedCo2e,
    );
    expect(reversed.totals.marketBasedCo2e).toBe(result.totals.marketBasedCo2e);
  });

  it("breaks a tie between two identical certificates by certificate id", () => {
    // Two facility-bound instruments, same entity, same facility, same vintage,
    // same volume: everything §9 names is equal. The order must still be fixed,
    // and it is fixed by the registry's own identifier before the primary key.
    const base = instrumentFor(FACILITY_BOUND_INSTRUMENT);
    const twins: Scope2Instrument[] = [
      {
        ...base,
        id: "00000000-0000-4000-8000-00000000cc02",
        certificateId: "GOO-ZZZ",
        coveredVolume: "10",
      },
      {
        ...base,
        id: "00000000-0000-4000-8000-00000000cc01",
        certificateId: "GOO-AAA",
        coveredVolume: "10",
      },
    ];
    const forwards = compute(
      [rowFor("00000000-0000-4000-8000-00000000ea02")],
      twins,
    );
    const backwards = compute(
      [rowFor("00000000-0000-4000-8000-00000000ea02")],
      [...twins].reverse(),
    );

    const order = (run: typeof forwards) =>
      run.matching.matches.map((m) => m.instrumentId);
    expect(order(forwards)).toEqual([
      "00000000-0000-4000-8000-00000000cc01", // GOO-AAA
      "00000000-0000-4000-8000-00000000cc02", // GOO-ZZZ
    ]);
    expect(order(backwards)).toEqual(order(forwards));
  });
});

describe("§9 — the vintage window, at its edges", () => {
  const only = (overrides: Partial<Scope2Instrument>) =>
    compute(
      [rowFor("00000000-0000-4000-8000-00000000ea04")],
      [
        {
          ...instrumentFor("00000000-0000-4000-8000-00000000c104"),
          ...overrides,
        },
      ],
    ).matching.matches[0];

  it("claims the FULL volume when both bounds are NULL", () => {
    // §4.11: an instrument normally covers the period. VAL-023 already reads a
    // missing bound as open, and the proration reads it the same way, so the
    // Warning a preparer saw and the volume granted describe one window.
    const match = only({
      generationPeriodStart: null,
      generationPeriodEnd: null,
      residualMixVolume: null,
    });
    expect(match.vintage.windowStart).toBe(golden.period.startDate);
    expect(match.vintage.windowEnd).toBe(golden.period.endDate);
    expect(match.vintage.windowDays).toBe(365);
    expect(match.vintage.overlapDays).toBe(365);
    expect(match.proratedVolumeMwh).toBe("200.000000");
  });

  it("closes an open START at the period's edge, not at infinity", () => {
    const match = only({
      generationPeriodStart: null,
      generationPeriodEnd: "2025-06-30",
      residualMixVolume: null,
    });
    // 2025-01-01…2025-06-30 is the whole effective window, so nothing is lost:
    // an open start means "from before this period", not "from the big bang".
    expect(match.vintage.windowDays).toBe(181);
    expect(match.vintage.overlapDays).toBe(181);
    expect(match.proratedVolumeMwh).toBe("200.000000");
  });

  it("rounds a non-terminating proration half-up at 6 places", () => {
    // A window of the whole of 2024 (a leap year) plus one day into 2025
    // overlaps the period by 1 day out of 367:
    //   200 × 1 ÷ 367 = 0.544 959 128 065…
    // The seventh decimal is a 1, so half-up leaves the sixth alone. This is
    // the ONE quotient in the engine and the only place a volume is rounded.
    const match = only({
      generationPeriodStart: "2024-01-01",
      generationPeriodEnd: "2025-01-01",
      residualMixVolume: null,
    });
    expect(match.vintage.windowDays).toBe(367);
    expect(match.vintage.overlapDays).toBe(1);
    expect(match.proratedVolumeMwh).toBe("0.544959");
  });

  it("treats an inverted window as claiming nothing", () => {
    const match = only({
      generationPeriodStart: "2025-12-31",
      generationPeriodEnd: "2025-01-01",
      residualMixVolume: null,
    });
    expect(match.vintage.windowDays).toBe(0);
    expect(match.proratedVolumeMwh).toBe("0.000000");
  });
});

describe("VAL-024's other failure — consumption in neither column", () => {
  it("fails the market-based line and reports the row as unconvertible", () => {
    // A row entered in a unit no `unit_conversion` reaches from: the matching
    // cannot denominate it in MWh, so it is in neither the covered nor the
    // residual column and the entity's balance has a hole. THIS is what VAL-024
    // catches that the cap cannot — the location-based line is perfectly fine.
    const row: Scope2EnergyRow = {
      ...rowFor("00000000-0000-4000-8000-00000000ea01"),
      unit: "therm",
      consumption: "1000",
    };
    const run = compute([row], []);

    expect(run.matching.rows[0].consumptionMwh).toBeNull();
    expect(run.matching.rows[0].residualMwh).toBeNull();
    expect(run.matching.entities[0].unconvertibleRowIds).toEqual([row.id]);
    expect(run.matching.entities[0].consumptionMwh).toBe("0.000000");

    const market = run.lines.find((l) => l.reportingBasis === "market_based");
    expect(market?.calculationStatus).toBe("failed_unit");
    expect(market?.inputValue).toBeNull();
    expect(market?.co2eResult).toBeNull();
    expect(market?.wantedUnits).toEqual(["MWh"]);
  });
});

describe("the market-factor ladder", () => {
  it("prefers a supplier factor to the residual mix", () => {
    const line = lineFor(
      "00000000-0000-4000-8000-00000000ea05",
      "market_based",
    );
    expect(line.marketFactorBasis).toBe("supplier_specific");
    expect(line.methodCode).toBe("supplier_specific");
    expect(line.factor?.sourceName).toBe("supplier");
  });

  it("does NOT call a country grid factor 'supplier-specific'", () => {
    // A German site naming a supplier. The set's only supplier-sourced factor
    // is Slovenian, so CALC-2's supplier rung is unreachable — but
    // `resolveFactor` still ANSWERS, with the German grid row, and labelling
    // that supplier-specific would put a market-based badge on a
    // location-based number. The ladder therefore checks the TIER it came back
    // on, not merely that something came back, and falls through to the German
    // residual mix.
    const row: Scope2EnergyRow = {
      ...rowFor("00000000-0000-4000-8000-00000000ea03"),
      supplier: "Ein Versorger Ohne Faktor",
    };
    const line = compute([row], []).lines.find(
      (l) => l.reportingBasis === "market_based",
    );
    expect(line?.marketFactorBasis).toBe("residual_mix");
    expect(line?.methodCode).toBe("average_data");
    expect(line?.factorId).toBe("00000000-0000-4000-8000-0000000000f6");
  });

  it("falls to the location factor where no residual mix exists, and says so", () => {
    const line = lineFor(
      "00000000-0000-4000-8000-00000000ea07",
      "market_based",
    );
    expect(line.marketFactorBasis).toBe("grid_average");
    expect(line.factorId).toBe(
      lineFor("00000000-0000-4000-8000-00000000ea07", "location_based")
        .factorId,
    );
    // Reaching the same factor by two different conversion chains
    // (kWh × 1 and kWh × 0.001 × 1000) gives EXACTLY the same figure in decimal.
    expect(line.co2eResult).toBe(
      lineFor("00000000-0000-4000-8000-00000000ea07", "location_based")
        .co2eResult,
    );
  });
});

describe("matchInstruments — the surface the evaluators read", () => {
  it("needs no geography, so a rule never has to invent one", () => {
    // VAL-022/VAL-024 balance volumes and resolve no factor; handing them a row
    // type with a `geography` they would have to fill in is how a placeholder
    // ends up in a factor query.
    const matching = matchInstruments(
      golden.rows,
      golden.instruments,
      golden.conversions,
      golden.period,
    );
    expect(matching.entities).toEqual(result.matching.entities);
    expect(matching.matches).toEqual(result.matching.matches);
  });

  it("reads a declared residual off an instrument that claims no volume", () => {
    // `residual_mix_volume` is a statement about the ENTITY's balance (§4.11),
    // so a `supplier_product` — which claims no MWh — may still carry one.
    const matching = matchInstruments(
      [rowFor("00000000-0000-4000-8000-00000000ea05")],
      [
        {
          ...instrumentFor("00000000-0000-4000-8000-00000000c106"),
          residualMixVolume: "50",
        },
      ],
      golden.conversions,
      golden.period,
    );
    expect(matching.skippedInstruments[0].reason).toBe("not_a_volume_claim");
    expect(matching.entities[0].declaredResidualMwh).toBe("50.000000");
    expect(matching.entities[0].residualMwh).toBe("50.000000");
  });
});
