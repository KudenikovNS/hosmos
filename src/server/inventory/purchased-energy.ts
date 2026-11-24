// =============================================================================
// `purchased_energy_activity` — THE WIRE CONTRACT of Scope 2 (DM-16, §4.10,
// К-6, К-7).
//
// ONE PROTOCOL, FOUR WIRE CONTRACTS (see `./rows` and `./wire`): the append-only
// mechanics and the mixin are shared, the BODY below is this table's alone.
//
// К-6 IN PRACTICE. The Data Dictionary spells every field four times, once per
// carrier (`electricity_consumption`, `district_heating_consumption`,
// `steam_supplier`, `cooling_meter_id`, …). The model keeps ONE set of columns
// plus the `energy_type` discriminator, and the wire follows the model: a client
// sends `energy_type` + the unprefixed names, and the DD's name is recoverable
// as `<energy_type>_<suffix>`. Accepting the four prefixed spellings instead
// would put the discriminator back into the field NAMES — the thing К-6 removed.
//
// К-7 IN PRACTICE. There is no Meter entity: a meter is an `asset` with
// `asset_type = 'meter'`, and the column is `meter_asset_id`. The wire keeps
// that name rather than the DD's `*_meter_id`, because the value a client sends
// IS an asset id and calling it a meter id would invite it to send a serial
// number. The reference is tenant-pinned like every other (`./wire`): another
// company's meter is a `VALIDATION`, not a row that reaches across tenants.
//
// THE TWO CALCULATED FIELDS ARE READ-ONLY, AND THAT IS ENFORCED BY ABSENCE.
// §4.10 marks `location_factor_id` and `market_factor_id` Calculated: CALC-5
// (T5.3) resolves the location-based and market-based factors and writes them
// back onto the row. They are in the DTO — a client has to be able to see which
// factor its figure was priced with, that is half of what makes a calculation
// auditable — and they are NOT in the parser. Not on a deny-list: simply not
// among the columns `parseInput` collects, so no request body has a path into
// them. A client cannot hand this system a factor, and there is no list of
// forbidden field names to keep in step with the schema (see `fieldCollector`).
// =============================================================================
import {
  decimalOrNull,
  num,
  oneOfOrNull,
  textOrNull,
  uuidOrNull,
  type ParseResult,
} from "@/server/api/parse";
import { purchasedEnergyActivity } from "@/server/db/schema";

import type { NewRowValues, RowValues } from "./rows";
import type { InputRow } from "./tables";
import {
  asNewRowValues,
  collectMixin,
  fieldCollector,
  METER_REFERENCE,
  MIXIN_REFERENCES,
  objectBody,
  serialiseMixin,
  type RowMixinDto,
  type RowWireContract,
} from "./wire";

/** A `purchased_energy_activity` row as Drizzle returns it. */
type PurchasedEnergyRow = typeof purchasedEnergyActivity.$inferSelect;

/**
 * The four carriers of §4.10 — the structural discriminator (К-6, §0.8), pair of
 * the CHECK constraint `purchased_energy_activity_energy_type_check`.
 *
 * Here rather than in `@/shared/enums` for the reason that module states about
 * discriminators: this is the SHAPE of the schema, not a domain list data may
 * extend. A fifth carrier is a new table shape (and a new CALC-5 branch), never
 * a new row in a reference table.
 */
export const ENERGY_TYPES = [
  "electricity",
  "district_heating",
  "steam",
  "cooling",
] as const;
export type EnergyType = (typeof ENERGY_TYPES)[number];

/** Is `value` one of the four §4.10 carriers? */
function isEnergyType(value: string): value is EnergyType {
  return (ENERGY_TYPES as readonly string[]).includes(value);
}

// ─── DTO ─────────────────────────────────────────────────────────────────────

/**
 * One version of a Scope-2 energy row as the API speaks it: the 19 mixin fields
 * (§4.8) plus the DM-16 body. `unit` is the mixin's, holding the EnergyUnit of
 * §4.10 (kWh/MWh/GJ — VAL-014's subject, not the parser's).
 */
export interface PurchasedEnergyDto extends RowMixinDto {
  energy_type: string;
  supplier: string | null;
  meter_asset_id: string | null;
  consumption: number | null;
  renewable_share: number | null;
  /** Calculated (§4.10) — written by CALC-5, never accepted from the wire. */
  location_factor_id: string | null;
  /** Calculated (§4.10) — written by CALC-5, never accepted from the wire. */
  market_factor_id: string | null;
}

/** THE serialiser. Every response about a Scope-2 energy row goes through it. */
function serialisePurchasedEnergy(row: InputRow): PurchasedEnergyDto {
  const r = row as PurchasedEnergyRow;
  return {
    ...serialiseMixin(row),
    energy_type: r.energyType,
    supplier: r.supplier,
    meter_asset_id: r.meterAssetId,
    consumption: num(r.consumption),
    renewable_share: num(r.renewableShare),
    location_factor_id: r.locationFactorId,
    market_factor_id: r.marketFactorId,
  };
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Wire → columns, SHAPE only.
 *
 * `consumption` accepts a negative number: the sign is VAL-020's (and VAL-011's,
 * which says the same thing in the activity domain's words), and refusing it
 * here would answer `{field: "consumption"}` where the UI renders a rule code.
 * `renewable_share`, by contrast, IS bounded here — 0–100 is stated by §4.10 and
 * owned by no rule, exactly the case `floor_area` set in `org/facilities.ts`.
 */
function parseInput(
  body: unknown,
  opts: { partial: boolean },
): ParseResult<RowValues> {
  const input = objectBody(body);
  if (!input) return { ok: false, field: "body" };

  const fields = fieldCollector(input, opts);
  collectMixin(fields);
  fields.required("energy_type", "energyType", (raw) =>
    oneOfOrNull(raw, isEnergyType),
  );
  fields.required("consumption", "consumption", decimalOrNull);
  fields.optional("supplier", "supplier", textOrNull);
  fields.optional("meter_asset_id", "meterAssetId", uuidOrNull);
  fields.optional("renewable_share", "renewableShare", (raw) =>
    decimalOrNull(raw, 0, 100),
  );
  return fields.result();
}

/** POST body → the columns of a NEW Scope-2 energy row. */
function parseNewPurchasedEnergy(body: unknown): ParseResult<NewRowValues> {
  const parsed = parseInput(body, { partial: false });
  return parsed.ok ? asNewRowValues(parsed.values) : parsed;
}

/** PATCH body → the columns to change (absent key = leave alone, LC-5). */
function parsePurchasedEnergyPatch(body: unknown): ParseResult<RowValues> {
  return parseInput(body, { partial: true });
}

/** The contract `./row-routes` serves `/api/activities/energy` from. */
export const PURCHASED_ENERGY_CONTRACT: RowWireContract<PurchasedEnergyDto> = {
  table: "purchased_energy_activity",
  listKey: "activities",
  serialise: serialisePurchasedEnergy,
  parseNew: parseNewPurchasedEnergy,
  parsePatch: parsePurchasedEnergyPatch,
  references: [...MIXIN_REFERENCES, METER_REFERENCE],
};
