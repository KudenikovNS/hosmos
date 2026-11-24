import { describe, expect, it } from "vitest";
import { computeScope1, type Scope1Factor, type Scope1Row } from "../scope1";
import {
  computeScope2,
  type Scope2Factor,
  type Scope2EnergyRow,
} from "../scope2";
import one from "./golden/scope1-basic.json";
import two from "./golden/scope2-dual.json";

const gas = { ...one.rows[0], unit: "kWh", activityValue: "1" } as Scope1Row;
const gasFactor = {
  ...one.factors[0],
  inputUnit: "kWh",
  factorValue: "1",
} as Scope1Factor;
const power = {
  ...two.rows[0],
  unit: "kWh",
  consumption: "1",
} as Scope2EnergyRow;
const grid = { ...two.factors[0], factorValue: "1" } as Scope2Factor;

describe("emission-factor output units", () => {
  it("normalises tonnes and kilograms to the same Scope 1 figures", () => {
    const tonnes = computeScope1(
      [gas],
      [{ ...gasFactor, outputUnit: "tCO2e" }],
      [],
      one.period,
    );
    const kilograms = computeScope1(
      [gas],
      [{ ...gasFactor, outputUnit: "kgCO2e", factorValue: "1000" }],
      [],
      one.period,
    );
    expect(tonnes.lines[0].co2eResult).toBe("1000.000000");
    expect(tonnes.totals).toEqual(kilograms.totals);
    expect(tonnes.lines[0].factor?.factorValue).toBe("1");
    expect(tonnes.lines[0].factor?.outputUnit).toBe("tCO2e");
    expect(tonnes.lines[0].conversionFactor).toBe("1");
  });

  it("normalises biogenic tonnes without adding them to the fossil total", () => {
    const result = computeScope1(
      [gas],
      [{ ...gasFactor, outputUnit: "tCO2e", biogenicTreatment: "biogenic" }],
      [],
      one.period,
    );
    expect(result.lines[0].co2eResult).toBe("0.000000");
    expect(result.lines[0].biogenicCo2Result).toBe("1000.000000");
  });

  it("converts the numerator before the single final rounding", () => {
    const result = computeScope1(
      [gas],
      [{ ...gasFactor, outputUnit: "tCO2e", factorValue: "0.0000000005" }],
      [],
      one.period,
    );
    expect(result.lines[0].co2eResult).toBe("0.000001");
  });

  for (const market of ["grid", "residual", "supplier"] as const) {
    it(`normalises Scope 2 location-based and ${market} market-based factors`, () => {
      const extra: Scope2Factor[] =
        market === "grid"
          ? []
          : [
              {
                ...grid,
                id: "extra",
                outputUnit: "tCO2e",
                activityType:
                  market === "residual"
                    ? "grid:residual_mix"
                    : grid.activityType,
                sourceName:
                  market === "supplier" ? "supplier" : grid.sourceName,
                supplierName: market === "supplier" ? "Energy supplier" : null,
              },
            ];
      const row = {
        ...power,
        supplier: market === "supplier" ? "Energy supplier" : null,
      };
      const result = computeScope2(
        [row],
        [],
        [{ ...grid, outputUnit: "tCO2e" }, ...extra],
        two.conversions,
        two.period,
      );
      expect(result.lines).toHaveLength(2);
      expect(result.lines.map((line) => line.co2eResult)).toEqual([
        "1000.000000",
        "1000.000000",
      ]);
      const kg = computeScope2(
        [row],
        [],
        [
          { ...grid, outputUnit: "kgCO2e", factorValue: "1000" },
          ...extra.map((f) => ({
            ...f,
            outputUnit: "kgCO2e",
            factorValue: "1000",
          })),
        ],
        two.conversions,
        two.period,
      );
      expect(result.totals).toEqual(kg.totals);
    });
  }

  for (const outputUnit of ["kWh", "gCO2e", "unknown"]) {
    it(`refuses ${outputUnit} as a finished emissions result`, () => {
      const oneResult = computeScope1(
        [gas],
        [{ ...gasFactor, outputUnit }],
        [],
        one.period,
      );
      expect(oneResult.lines[0].calculationStatus).toBe("failed_unit");
      expect(oneResult.lines[0].co2eResult).toBeNull();
      const twoResult = computeScope2(
        [power],
        [],
        [{ ...grid, outputUnit }],
        two.conversions,
        two.period,
      );
      expect(
        twoResult.lines.every((line) => line.calculationStatus !== "ok"),
      ).toBe(true);
      expect(twoResult.lines.every((line) => line.co2eResult === null)).toBe(
        true,
      );
    });
  }

  for (const source of ["supplier", "residual"] as const) {
    it(`does not hide an invalid ${source} numerator behind a grid fallback`, () => {
      const extra = {
        ...grid,
        id: "bad-output",
        outputUnit: "kWh",
        activityType:
          source === "supplier" ? grid.activityType : "grid:residual_mix",
        sourceName: source === "supplier" ? "supplier" : grid.sourceName,
        supplierName: source === "supplier" ? "Energy supplier" : null,
      };
      const result = computeScope2(
        [
          {
            ...power,
            supplier: source === "supplier" ? "Energy supplier" : null,
          },
        ],
        [],
        [grid, extra],
        two.conversions,
        two.period,
      );
      expect(
        result.lines.find((line) => line.reportingBasis === "market_based"),
      ).toMatchObject({ calculationStatus: "failed_unit", co2eResult: null });
    });
  }
});
