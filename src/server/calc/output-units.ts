import {
  isEmissionOutputUnit,
  OUTPUT_TO_KG,
  type FactorOutputConversion,
} from "@/shared/factor-output-units";
import { formatDecimal, multiply, parseDecimal } from "./decimal";

/** Exact numerator conversion; the engine rounds only the final line result. */
export function normaliseFactorOutput(
  value: string,
  outputUnit: string,
): { value: string; conversion: FactorOutputConversion } | null {
  if (!isEmissionOutputUnit(outputUnit)) return null;
  const multiplier = OUTPUT_TO_KG[outputUnit];
  const exact = multiply(parseDecimal(value), parseDecimal(multiplier));
  return {
    value: multiplier === "1" ? value : formatDecimal(exact, exact.scale),
    conversion: { from_unit: outputUnit, to_unit: "kgCO2e", multiplier },
  };
}
