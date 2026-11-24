import { enumGuard } from "./enums/guard";

/** Numerators supported by the final emissions calculation. */
export const EMISSION_OUTPUT_UNITS = ["kgCO2e", "tCO2e"] as const;
export type EmissionOutputUnit = (typeof EMISSION_OUTPUT_UNITS)[number];
export const isEmissionOutputUnit = enumGuard(EMISSION_OUTPUT_UNITS);

/** kWh is an intermediate EV energy intensity, never finished emissions. */
const FACTOR_OUTPUT_UNITS = [...EMISSION_OUTPUT_UNITS, "kWh"] as const;
export const isFactorOutputUnit = enumGuard(FACTOR_OUTPUT_UNITS);

export const OUTPUT_TO_KG: Readonly<Record<EmissionOutputUnit, string>> = {
  kgCO2e: "1",
  tCO2e: "1000",
};

export interface FactorOutputConversion {
  readonly from_unit: EmissionOutputUnit;
  readonly to_unit: "kgCO2e";
  readonly multiplier: string;
}

export function isCompatibleFactorOutput(
  output: string,
  activityType: string,
  inputUnit: string,
): boolean {
  return (
    isEmissionOutputUnit(output) ||
    (output === "kWh" &&
      activityType === "car_bev_kwh_per_km" &&
      inputUnit === "km")
  );
}
