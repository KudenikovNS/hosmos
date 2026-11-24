// =============================================================================
// Organisational-axis domain lists — `legal_entity`, `facility`, `period_scope`
// (spec §4.2, §4.3, §4.6).
//
// NOT DB tables and NOT CHECK constraints — see the rationale in `./index.ts`
// (F6, spec §0.8), with the ONE exception called out on ApplicabilityStatus
// below, which the spec does put in a CHECK.
// =============================================================================

import { enumGuard } from "./guard";

/** `legal_entity.group_structure_type` (spec §4.2, DD GroupStructureType). */
export const GROUP_STRUCTURE_TYPES = [
  "standalone",
  "parent",
  "subsidiary",
] as const;
export type GroupStructureType = (typeof GROUP_STRUCTURE_TYPES)[number];
export const isGroupStructureType = enumGuard(GROUP_STRUCTURE_TYPES);

/**
 * `legal_entity.consolidation_method` (spec §4.2) — the workbook's three
 * ConsolidationMethod values (ENUM-036…038) in sheet order, as wire literals.
 */
export const CONSOLIDATION_METHODS = [
  "operational_control",
  "financial_control",
  "equity_share",
] as const;
export type ConsolidationMethod = (typeof CONSOLIDATION_METHODS)[number];
export const isConsolidationMethod = enumGuard(CONSOLIDATION_METHODS);

/**
 * `reporting_period.reporting_basis` (К-13, spec §4.5) — does the period report
 * ONE legal entity or the consolidated group.
 *
 * EXCEPTION to §0.8, like `ApplicabilityStatus` above: the schema does carry
 * `reporting_period_reporting_basis_check` on this column, because the value
 * decides which rules apply (VAL-102 gates a consolidated boundary) and which
 * plan may use it at all (PG-2 — `consolidatedReports`). The CHECK is rendered
 * FROM this constant, so the two cannot drift.
 *
 * NOT THE SAME COLUMN AS `calculation.reporting_basis`, which is
 * `location_based`/`market_based` (К-20, the Scope-2 dual-reporting
 * discriminator) and deliberately has no constant in this module — it is a
 * structural discriminator written by the calculation engine (see `./index`).
 * The two share a name in the Data Dictionary and nothing else.
 */
export const REPORTING_BASES = ["individual", "consolidated"] as const;
export type ReportingBasis = (typeof REPORTING_BASES)[number];
export const isReportingBasis = enumGuard(REPORTING_BASES);

/**
 * `facility.facility_type` (spec §4.3). OPEN LIST — the spec spells it out as
 * "открытый список: office/plant/warehouse/store/farm/other".
 */
export const FACILITY_TYPES = [
  "office",
  "plant",
  "warehouse",
  "store",
  "farm",
  "other",
] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];
export const isFacilityType = enumGuard(FACILITY_TYPES);

/**
 * `asset.asset_type` (spec §4.4, DM-6). OPEN LIST, spelled out by the spec as
 * `vehicle/building/equipment/generator/meter/other` (the spec bolds `meter`).
 *
 * `meter` is the one value with a decision behind it. К-7 folded what the Data
 * Dictionary called a `Meter` OBJECT onto this registry: rather than a seventh
 * table with its own id space, a meter is an asset whose type says so, and
 * `purchased_energy_activity.meter_asset_id` points at it like any other asset
 * reference. Dropping the value from this list would silently un-implement К-7 —
 * a meter would have to be recorded as `equipment` or `other` and the FK would
 * stop meaning anything.
 *
 * PROVENANCE: the spec's own parenthetical (§4.4) and the DDL comment on
 * `asset.asset_type`; the workbook's Enums sheet has no AssetType rows, so the
 * ORDER here is the spec's, not a sheet's.
 */
export const ASSET_TYPES = [
  "vehicle",
  "building",
  "equipment",
  "generator",
  "meter",
  "other",
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export const isAssetType = enumGuard(ASSET_TYPES);

/**
 * `facility.tenure` (spec §4.3) — workbook TenureType (ENUM-039…042) in sheet
 * order. The workbook's fourth label is "Shared / co-working"; the wire literal
 * is the spec's `shared`.
 */
export const TENURE_TYPES = ["owned", "leased", "managed", "shared"] as const;
export type TenureType = (typeof TENURE_TYPES)[number];
export const isTenureType = enumGuard(TENURE_TYPES);

/** `facility.control_status` (spec §4.3) — does the organisation control it. */
export const CONTROL_STATUSES = ["controlled", "not_controlled"] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];
export const isControlStatus = enumGuard(CONTROL_STATUSES);

/**
 * `facility.boundary_classification` (spec §4.3).
 *
 * OPEN LIST, and the least documented list in this task.
 *
 * PROVENANCE: NONE. These three values are DERIVED, not cited. The spec names
 * only the type (`BoundaryTreatment`) and the DD gloss is "Scope treatment of
 * the facility"; the workbook's Enums sheet has no BoundaryTreatment rows at
 * all. Do not read them as the workbook's `Scope` list — that list (ENUM-032…
 * 035) is `Scope 1` / `Scope 2` / `Scope 3` / `Outside scopes` and keeps 1 and
 * 2 APART, so taking it as normative here would give four values, not three.
 *
 * What the three do encode is the GHGP-correct reading of the column: where a
 * site's emissions LAND. A controlled site contributes Scope 1 and Scope 2
 * together (`scope_1_2` — they are never split by facility, only by activity);
 * a leased or otherwise uncontrolled site contributes Scope 3 cat 8/13
 * (`scope_3`); a site outside the inventory contributes neither
 * (`outside_scopes`). Note this is NOT the in/out flag: that is
 * `facility.included_in_boundary` (boolean), and the period-level decision is
 * `period_scope.status` ({@link APPLICABILITY_STATUSES}).
 *
 * A LATER RENAME IS CHEAP, which is why deriving is acceptable: the column has
 * no CHECK (§0.8), no VAL-* rule references it, and no Phase-1 calculation
 * consumes it. Expect it revisited when the boundary UI lands (D10/D15).
 */
export const BOUNDARY_TREATMENTS = [
  "scope_1_2",
  "scope_3",
  "outside_scopes",
] as const;
export type BoundaryTreatment = (typeof BOUNDARY_TREATMENTS)[number];
export const isBoundaryTreatment = enumGuard(BOUNDARY_TREATMENTS);

/**
 * `period_scope.status` — the boundary decision per (period, legal entity)
 * (spec §4.6 / DM-8, D15). Exactly four values.
 *
 * EXCEPTION to §0.8: this one IS backed by a CHECK in the schema, because it is
 * a lifecycle/status column the freeze and render logic branch on. The workbook
 * sheet lists five ApplicabilityStatus rows (ENUM-049…053) — it adds
 * `Applicable`, which D15 folds into `included`. The spec wins: four values, in
 * the spec's CHECK order.
 *
 * FORWARD NAME COLLISION — flagged now so it is not discovered as a bug. The
 * workbook binds the name `ApplicabilityStatus` to a DIFFERENT column:
 * `Scope3CategoryRecord.cat1..15_applicability` (Phase 3), "is this Scope 3
 * category applicable to us". That column plausibly needs the fifth value
 * `Applicable` this list drops, so Phase 3 must NOT reuse this constant — it
 * needs its own list, and one of the two should be renamed at that point
 * (`PeriodScopeStatus` here would be the honest name).
 */
export const APPLICABILITY_STATUSES = [
  "included",
  "excluded",
  "not_applicable",
  "not_assessed",
] as const;
export type ApplicabilityStatus = (typeof APPLICABILITY_STATUSES)[number];
export const isApplicabilityStatus = enumGuard(APPLICABILITY_STATUSES);
