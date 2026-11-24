// Shared domain lists (F6, §0.8): TypeScript `as const` tuples with guards,
// not DB tables and not CHECK constraints — the code is the source of truth and
// `enums-vs-seed.test.ts` keeps the seed in step. Values are wire/DB literals,
// never display labels; labels live in `messages/*.json`.
//
// See docs/decisions/enums-rationale.md for the full account.

export * from "./activities";
export * from "./documents";
export * from "./factors";
export * from "./instruments";
export * from "./org";
export * from "./quality";
export * from "./workflow";

import {
  CALCULATION_METHODS,
  ENERGY_UNITS,
  FUEL_TYPES,
  PROCESS_TYPES,
  REFRIGERANT_TYPES,
  UNIT_CODES,
  VEHICLE_TYPES,
} from "./activities";
import { CONFIDENTIALITIES, FILE_TYPES, OBJECT_TYPES } from "./documents";
import {
  BIOGENIC_TREATMENTS,
  FACTOR_SOURCES,
  FACTOR_STATUSES,
  GWP_BASES,
  METHODOLOGY_VERSIONS,
} from "./factors";
import {
  GENERATION_TECHNOLOGIES,
  INSTRUMENT_TYPES,
  QUALITY_CRITERIA_STATUSES,
} from "./instruments";
import {
  APPLICABILITY_STATUSES,
  ASSET_TYPES,
  BOUNDARY_TREATMENTS,
  CONSOLIDATION_METHODS,
  CONTROL_STATUSES,
  FACILITY_TYPES,
  GROUP_STRUCTURE_TYPES,
  REPORTING_BASES,
  TENURE_TYPES,
} from "./org";
import { DATA_TYPES, QUALITY_TIERS } from "./quality";
import { PERIOD_STATUSES, WORKFLOW_STATUSES } from "./workflow";

/**
 * Every Phase-1 list, keyed by its workbook / spec enum name.
 *
 * This is a code-level INDEX, not the enum registry F6 rejected: it holds no
 * values of its own, only references to the tuples above, so it cannot drift
 * from them. It exists so that invariants which must hold for ALL lists (no
 * empties, no duplicates) can be asserted once in the unit test instead of 29
 * times, and so a future admin screen can enumerate the lists without a table.
 */
export const PHASE1_ENUMS = {
  ApplicabilityStatus: APPLICABILITY_STATUSES,
  AssetType: ASSET_TYPES,
  BiogenicTreatment: BIOGENIC_TREATMENTS,
  BoundaryTreatment: BOUNDARY_TREATMENTS,
  CalculationMethod: CALCULATION_METHODS,
  Confidentiality: CONFIDENTIALITIES,
  ConsolidationMethod: CONSOLIDATION_METHODS,
  ControlStatus: CONTROL_STATUSES,
  DataType: DATA_TYPES,
  EnergyUnit: ENERGY_UNITS,
  FacilityType: FACILITY_TYPES,
  FactorSource: FACTOR_SOURCES,
  FactorStatus: FACTOR_STATUSES,
  FileType: FILE_TYPES,
  FuelType: FUEL_TYPES,
  GenerationTechnology: GENERATION_TECHNOLOGIES,
  GroupStructureType: GROUP_STRUCTURE_TYPES,
  GWPBasis: GWP_BASES,
  InstrumentType: INSTRUMENT_TYPES,
  MethodologyVersion: METHODOLOGY_VERSIONS,
  ObjectType: OBJECT_TYPES,
  PeriodStatus: PERIOD_STATUSES,
  ProcessType: PROCESS_TYPES,
  QualityCriteriaStatus: QUALITY_CRITERIA_STATUSES,
  QualityTier: QUALITY_TIERS,
  RefrigerantType: REFRIGERANT_TYPES,
  ReportingBasis: REPORTING_BASES,
  TenureType: TENURE_TYPES,
  UnitCode: UNIT_CODES,
  VehicleType: VEHICLE_TYPES,
  WorkflowStatus: WORKFLOW_STATUSES,
} as const satisfies Record<string, readonly string[]>;

/** The enum names of {@link PHASE1_ENUMS} — e.g. `'FuelType'`. */
export type Phase1EnumName = keyof typeof PHASE1_ENUMS;
