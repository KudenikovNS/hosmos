/**
 * Factor set `legacy-v1`: the 440 legacy factors normalised onto the Phase-1
 * resolve key, reached by BOTH the migration generator and `seed.ts` from this
 * one module so the two can never drift. Ids are derived (UUIDv5), the legacy
 * mapping is not re-derived here, and MIG-4's judgement calls are recorded.
 *
 * See docs/decisions/factor-set-v1-seed.md for the full account.
 */
import { derivedId } from "./derived-id";
import {
  FLIGHTS,
  GRID,
  HEAT,
  REFRIGERANTS,
  SCOPE3,
  SOURCES,
  STATIONARY,
  VEHICLE_ENERGY,
  VEHICLES,
} from "./legacy-factors";
import {
  normaliseLegacyFactors,
  type NormalisedFactorRow,
} from "./legacy-normalisation";

// ─── The set ─────────────────────────────────────────────────────────────────

/** One `factor_set` row (DM-21), column names verbatim. */
export type FactorSetSeed = {
  id: string;
  code: string;
  name: string;
  description: string;
  status: "active";
  published_at: string;
};

/**
 * The Phase-1 set. `status='active'` because a period may only pin an active
 * set (DM-21) and after S2 production must be able to create one on day zero.
 *
 * `published_at` is a CONSTANT, not `now()`: the seed and the migration must
 * write the same instant or the two derivations differ on a column.
 */
export const LEGACY_FACTOR_SET: FactorSetSeed = {
  id: derivedId("factor_set", "legacy-v1"),
  code: "legacy-v1",
  name: "Legacy factor set v1",
  description:
    "The factor library the platform shipped with, normalised onto the Phase-1 " +
    "resolve key (DEFRA/DESNZ, AIB residual mixes, IEA, EXIOBASE, EcoAct and " +
    "national statistics agencies). Superseded only by a NEW set, never edited.",
  status: "active",
  published_at: "2026-01-01T00:00:00Z",
};

/** One `emission_factor` row (DM-22), column names verbatim. */
export type EmissionFactorSeed = {
  id: string;
  factor_code: string;
  factor_name: string;
  source_name: string;
  source_version: string;
  applicable_year: number | null;
  geography: string;
  activity_type: string;
  input_unit: string;
  factor_value: string;
  output_unit: string;
  gwp_basis: string;
  wtt_included: boolean;
  biogenic_treatment: string | null;
  rf_included: boolean | null;
  source_url: string;
  licence: string;
  status: string;
};

/**
 * `factor_code` → the human label the legacy tuple carries. Built from the
 * arrays here rather than threaded through `legacy-normalisation.ts`, which
 * states outright that `factor_name` is T1.5's to decide. All 168 legacy keys
 * are globally unique (asserted by the T1.5 suite), so one flat map is safe.
 */
const FACTOR_NAMES = new Map<string, string>([
  ...STATIONARY.map(([key, name]) => [key, name] as const),
  ...VEHICLES.map(
    ([key, category, size, fuel]) =>
      [key, `${category} ${size} (${fuel})`] as const,
  ),
  ...VEHICLE_ENERGY.map(
    ([key, category, size]) =>
      [key, `${category} ${size} (BEV energy intensity)`] as const,
  ),
  ...FLIGHTS.map(
    ([key, flightType, cabinClass]) =>
      [key, `Flight ${flightType} (${cabinClass})`] as const,
  ),
  ...REFRIGERANTS.map(([key, name]) => [key, name] as const),
  ...HEAT.map(([key, , name]) => [key, name] as const),
  ...SCOPE3.map(([key, , , name]) => [key, name] as const),
]);

/** Grid rows share one `factor_code`; the country name is the distinguishing bit. */
const GRID_COUNTRY_NAMES = new Map(
  GRID.map(([countryCode, countryName]) => [countryCode, countryName] as const),
);

/**
 * `SOURCES[].code` → the two DM-22 provenance columns, per MIG-4:
 * `authority`→`source_name`, `publication`+`versionYear`→`source_version`.
 *
 * `source_name` is therefore the AUTHORITY prose ("UK Department for Energy
 * Security and Net Zero (DESNZ)"), which is what MIG-4 and the plan's T1.5 both
 * spell out, even though DM-22's gloss illustrates the column with the short
 * `FACTOR_SOURCES` tokens. The list is explicitly open, and nothing resolves on
 * `source_name`: CALC-2's key is (activity_type, geography, input_unit,
 * applicable_year). Keyed by plain `string` because `NormalisedFactorRow`
 * reports the code as one.
 */
const SOURCE_PROVENANCE = new Map<
  string,
  { source_name: string; source_version: string }
>(
  SOURCES.map(({ code, authority, publication, versionYear }) => [
    code,
    { source_name: authority, source_version: `${publication} ${versionYear}` },
  ]),
);

/**
 * The one `activity_type` whose factor is BIOGENIC CO₂ (D3/VAL-017): the legacy
 * `wood_logs_biogenic_co2` row prices the biogenic carbon released by burning
 * logs, which CALC-4 must route to `biogenic_co2_result`, outside the fossil
 * total. Every other row is silent on the question and stays NULL.
 */
const BIOGENIC_ACTIVITY_TYPES = new Set(["wood_logs_biogenic"]);

/**
 * The factors whose value is a LEGITIMATE zero (VAL-033's "unless explicitly
 * valid zero") — RE-EXPORTED, defined in `./explicit-zeros`.
 *
 * It moved out in T2.8, when VAL-033's evaluator became its second reader: a
 * request path importing THIS module would have pulled the whole legacy corpus
 * into a route bundle to read two strings. The header of `./explicit-zeros`
 * carries the reasoning that used to live here; the re-export keeps every
 * existing importer (the T1.5 suite among them) pointing where it always did.
 */
export { EXPLICIT_ZERO_ACTIVITY_TYPES } from "./explicit-zeros";

/** The label for a normalised row, from the legacy tuple it came from. */
function factorNameFor(row: NormalisedFactorRow): string {
  if (row.legacyCategory === "grid") {
    const country = GRID_COUNTRY_NAMES.get(row.geography) ?? row.geography;
    return `Grid electricity — ${country}`;
  }
  const name = FACTOR_NAMES.get(row.legacyKey);
  if (name === undefined) {
    throw new Error(
      `legacy factor_key ${JSON.stringify(row.legacyKey)} has no name in ` +
        "FACTOR_NAMES — emission_factor.factor_name is NOT NULL (DM-22)",
    );
  }
  return name;
}

/**
 * THE 440 `emission_factor` ROWS of `legacy-v1`, in the legacy seed's insert
 * order. Pure: same input arrays → byte-identical output, ids included.
 */
export function legacyFactorRows(): EmissionFactorSeed[] {
  return normaliseLegacyFactors().map((row) => {
    const provenance = SOURCE_PROVENANCE.get(row.sourceCode);
    if (provenance === undefined) {
      throw new Error(
        `legacy source code ${JSON.stringify(row.sourceCode)} is not in ` +
          "SOURCES — source_name/source_version are NOT NULL (DM-22)",
      );
    }
    return {
      // The natural key of the row inside the set, i.e. VAL-031's key.
      id: derivedId(
        LEGACY_FACTOR_SET.code,
        provenance.source_name,
        provenance.source_version,
        row.activityType,
        row.geography,
        row.inputUnit,
        row.applicableYear ?? "any",
      ),
      factor_code: row.legacyKey, // MIG-4: factor_key → factor_code, verbatim
      factor_name: factorNameFor(row),
      ...provenance,
      applicable_year: row.applicableYear,
      geography: row.geography,
      activity_type: row.activityType,
      input_unit: row.inputUnit,
      factor_value: row.value, // NUMERIC-as-string, verbatim
      output_unit: row.outputUnit,
      gwp_basis: "AR5", // MIG-4 — the legacy refrigerant practice, set-wide
      wtt_included: false, // MIG-4 — no legacy factor bundles well-to-tank
      biogenic_treatment: BIOGENIC_ACTIVITY_TYPES.has(row.activityType)
        ? "biogenic"
        : null,
      rf_included: row.legacyCategory === "flight" ? true : null,
      source_url: "unspecified", // MIG-4 — absent in the source, said out loud
      licence: "unspecified",
      status: "active",
    };
  });
}
