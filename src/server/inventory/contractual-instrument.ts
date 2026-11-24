// =============================================================================
// `contractual_instrument` — THE WIRE CONTRACT of market-based Scope 2
// (DM-17, §4.11, D19).
//
// ONE PROTOCOL, FOUR WIRE CONTRACTS (see `./rows` and `./wire`). This body is
// the simplest of the four and the only one with NO discriminator: §4.11 names
// all ten Phase-1 fields 1:1 with the Data Dictionary, so there is no К-6
// mapping to perform — `instrument_type` is a domain list (GoO/REGO/REC/PPA/…),
// not the shape of the row.
//
// WHY THE WHOLE BODY IS NULLABLE except the type. An instrument is entered from
// a certificate, and certificates arrive incomplete: the registry gives the
// vintage window before the cancellation statement does, and a PPA has no
// certificate id at all. §4.11 puts NOT NULL on nothing but the mixin and the
// type, and the completeness questions are rules — VAL-023 on the vintage window
// here, VAL-022/VAL-024 on the volumes in T5.3.
//
// WHAT THIS TABLE IS FOR, so that the columns read as more than a form. CALC-5
// matches instruments against an entity's purchased electricity for the period:
// each instrument's `covered_volume` is prorated by how much of its
// `generation_period_start..end` overlaps the reporting period, facility-bound
// instruments are consumed first, and the matched total is capped by the
// entity's consumption. `residual_mix_volume` is the unmatched remainder that
// gets priced at the residual mix. THAT ALGORITHM IS T5.3's, not this module's —
// what T3.2 owes it is that every column it reads is writable and readable here,
// with the types it will read them at.
//
// `year_month` is normally NULL: an instrument covers the whole period rather
// than a month of it (§4.11), which is why VAL-012 passes a NULL rather than
// skipping it.
// =============================================================================
import {
  alphaCodeOrNull,
  decimalOrNull,
  isoDateOrNull,
  num,
  oneOfOrNull,
  textOrNull,
  type ParseResult,
} from "@/server/api/parse";
import { contractualInstrument } from "@/server/db/schema";
import {
  isGenerationTechnology,
  isInstrumentType,
  isQualityCriteriaStatus,
} from "@/shared/enums";

import type { NewRowValues, RowValues } from "./rows";
import type { InputRow } from "./tables";
import {
  asNewRowValues,
  collectMixin,
  fieldCollector,
  MIXIN_REFERENCES,
  objectBody,
  serialiseMixin,
  type RowMixinDto,
  type RowWireContract,
} from "./wire";

/** A `contractual_instrument` row as Drizzle returns it. */
type ContractualInstrumentRow = typeof contractualInstrument.$inferSelect;

// ─── DTO ─────────────────────────────────────────────────────────────────────

/**
 * One version of an instrument as the API speaks it: the 19 mixin fields (§4.8)
 * plus the ten DM-17 fields, volumes in MWh, dates as ISO strings.
 */
export interface ContractualInstrumentDto extends RowMixinDto {
  instrument_type: string;
  certificate_id: string | null;
  covered_volume: number | null;
  production_country: string | null;
  technology: string | null;
  generation_period_start: string | null;
  generation_period_end: string | null;
  cancellation_date: string | null;
  quality_criteria_status: string | null;
  residual_mix_volume: number | null;
}

/** THE serialiser. Every response about an instrument goes through it. */
function serialiseContractualInstrument(
  row: InputRow,
): ContractualInstrumentDto {
  const r = row as ContractualInstrumentRow;
  return {
    ...serialiseMixin(row),
    instrument_type: r.instrumentType,
    certificate_id: r.certificateId,
    covered_volume: num(r.coveredVolume),
    production_country: r.productionCountry,
    technology: r.technology,
    generation_period_start: r.generationPeriodStart,
    generation_period_end: r.generationPeriodEnd,
    cancellation_date: r.cancellationDate,
    quality_criteria_status: r.qualityCriteriaStatus,
    residual_mix_volume: num(r.residualMixVolume),
  };
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** The three date columns of §4.11 — vintage window plus cancellation. */
const DATE_FIELDS = [
  ["generation_period_start", "generationPeriodStart"],
  ["generation_period_end", "generationPeriodEnd"],
  ["cancellation_date", "cancellationDate"],
] as const;

/** The two MWh volumes — CALC-5's numerator and its remainder. */
const VOLUME_FIELDS = [
  ["covered_volume", "coveredVolume"],
  ["residual_mix_volume", "residualMixVolume"],
] as const;

/**
 * Wire → columns, SHAPE only.
 *
 * The dates are checked for BEING dates and nothing else: whether the vintage
 * window has anything to do with the reporting period is VAL-023's, and whether
 * the volumes are claimable is VAL-022/VAL-024's in T5.3. `production_country`
 * is checked for the `char(2)` the column holds, not for ISO-3166 membership —
 * the same line `alphaCodeOrNull` draws everywhere else.
 */
function parseInput(
  body: unknown,
  opts: { partial: boolean },
): ParseResult<RowValues> {
  const input = objectBody(body);
  if (!input) return { ok: false, field: "body" };

  const fields = fieldCollector(input, opts);
  collectMixin(fields);
  fields.required("instrument_type", "instrumentType", (raw) =>
    oneOfOrNull(raw, isInstrumentType),
  );
  fields.optional("certificate_id", "certificateId", textOrNull);
  fields.optional("production_country", "productionCountry", (raw) =>
    alphaCodeOrNull(raw, 2),
  );
  fields.optional("technology", "technology", (raw) =>
    oneOfOrNull(raw, isGenerationTechnology),
  );
  fields.optional("quality_criteria_status", "qualityCriteriaStatus", (raw) =>
    oneOfOrNull(raw, isQualityCriteriaStatus),
  );
  for (const [api, column] of DATE_FIELDS) {
    fields.optional(api, column, isoDateOrNull);
  }
  for (const [api, column] of VOLUME_FIELDS) {
    // MWh: a negative certificate volume is not a figure any rule would later
    // catch (VAL-022 compares against consumption, VAL-024 balances a run), so
    // the bound belongs here — the `floor_area` case of `org/facilities.ts`.
    fields.optional(api, column, (raw) => decimalOrNull(raw, 0));
  }
  return fields.result();
}

/** POST body → the columns of a NEW instrument. */
function parseNewContractualInstrument(
  body: unknown,
): ParseResult<NewRowValues> {
  const parsed = parseInput(body, { partial: false });
  return parsed.ok ? asNewRowValues(parsed.values) : parsed;
}

/** PATCH body → the columns to change (absent key = leave alone, LC-5). */
function parseContractualInstrumentPatch(
  body: unknown,
): ParseResult<RowValues> {
  return parseInput(body, { partial: true });
}

/** The contract `./row-routes` serves `/api/activities/instruments` from. */
export const CONTRACTUAL_INSTRUMENT_CONTRACT: RowWireContract<ContractualInstrumentDto> =
  {
    table: "contractual_instrument",
    listKey: "instruments",
    serialise: serialiseContractualInstrument,
    parseNew: parseNewContractualInstrument,
    parsePatch: parseContractualInstrumentPatch,
    references: MIXIN_REFERENCES,
  };
