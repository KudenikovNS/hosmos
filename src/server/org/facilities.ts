// =============================================================================
// FACILITIES — the site registry of the Phase-1 model (DM-5).
//
// Same shape as `./legal-entities`, which is the point: the service owns the
// wire contract (one serialiser, one parser per operation), the route owns only
// guards and status codes, and the write path is the shared
// `writeValidated` — transaction, write, run `reference_org`, roll back on a
// blocking failure (VR-3). What is specific to facilities is here and nowhere
// else:
//
//   1. NO К-* RENAMES. Unlike `legal_entity` (К-1/К-2), all 16 Phase-1 fields of
//      a facility are named 1:1 with the Data Dictionary (spec §4.3). The
//      serialiser is therefore a plain snake_case projection — and it still
//      exists, because "the DTO happens to match the columns" is a property that
//      must be stated in ONE place if it is ever to be broken safely.
//
//   2. ONE FK REFERENCE, RESOLVED BEFORE THE WRITE. `legal_entity_id` is NOT
//      NULL and points at `legal_entity`; a foreign or unknown id would be an FK
//      violation (a 500) before any rule could speak, so it is resolved
//      tenant-pinned first and a miss is refused as `VALIDATION` — API-1: another
//      company's entity "does not exist" for this company.
//
//   3. THE COORDINATE RANGE IS NOT PARSED, IT IS RULED. `latitude: 91` passes
//      the parser (it is a perfectly storable NUMERIC) and is refused by VAL-006
//      inside the transaction, so the client gets the rule CODE to render
//      against the field and the row is not written. Narrowing the parser to
//      −90…90 would have been the natural-looking mistake: it would answer
//      `{field: "latitude"}` instead, and VAL-006 would then be a rule that no
//      API path can ever trigger — implemented and dead.
//
//   4. NO DELETE. §12.2 gives this route GET/POST/PATCH only, and unlike an
//      asset a facility is pointed at by input rows (`facility_id` on all four
//      row tables) and is the unit PG-3/F1 counts at lock. Retiring a site is
//      `closing_date` + `included_in_boundary = false`, which keeps the years it
//      reported reproducible. The one deletion path that exists is
//      `deleteLegalEntity`, and it REFUSES while a facility is attached (DM-4).
// =============================================================================
import { and, eq, sql } from "drizzle-orm";

import {
  alphaCodeOrNull,
  booleanValue,
  decimalOrNull,
  isoDateOrNull,
  num,
  oneOfOrNull,
  textOrNull,
  uuidOrNull,
  type ParseResult,
} from "@/server/api/parse";
import type { DbClient } from "@/server/db/client";
import { facility } from "@/server/db/schema";
import {
  refuseValidation,
  writeValidated,
  type WriteResult,
} from "@/server/validation/write";
import {
  isBoundaryTreatment,
  isControlStatus,
  isFacilityType,
  isTenureType,
} from "@/shared/enums";

import { getLegalEntity } from "./legal-entities";

/** A `facility` row as Drizzle returns it. */
export type FacilityRow = typeof facility.$inferSelect;

/** The column values a create/update writes (never `company_id`, never `id`). */
export type FacilityValues = Partial<
  Omit<typeof facility.$inferInsert, "id" | "companyId">
>;

/** A create's values: the two NOT NULL columns are guaranteed present. */
export type NewFacilityValues = FacilityValues & {
  facilityName: string;
  legalEntityId: string;
};

// ─── Wire contract (§4.3 — DD names, 1:1) ────────────────────────────────────

/**
 * One facility as the API speaks it: snake_case DD field names, NUMERIC columns
 * as numbers, dates as ISO strings.
 *
 * `company_id` is absent on purpose (the tenant is the session, never a field a
 * client could read back and start sending); `legal_entity_id` is present
 * because it is a genuine choice the user makes among THEIR OWN entities.
 */
export interface FacilityDto {
  id: string;
  legal_entity_id: string;
  facility_name: string;
  facility_type: string | null;
  address: string | null;
  country: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  tenure: string | null;
  control_status: string | null;
  floor_area: number | null;
  opening_date: string | null;
  closing_date: string | null;
  included_in_boundary: boolean;
  boundary_classification: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** THE serialiser. Every response about a facility goes through it. */
export function serialiseFacility(row: FacilityRow): FacilityDto {
  return {
    id: row.id,
    legal_entity_id: row.legalEntityId,
    facility_name: row.facilityName,
    facility_type: row.facilityType,
    address: row.address,
    country: row.country,
    postal_code: row.postalCode,
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    tenure: row.tenure,
    control_status: row.controlStatus,
    floor_area: num(row.floorArea),
    opening_date: row.openingDate,
    closing_date: row.closingDate,
    included_in_boundary: row.includedInBoundary,
    boundary_classification: row.boundaryClassification,
    created_at: row.createdAt?.toISOString() ?? null,
    updated_at: row.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Wire → columns, with per-field SHAPE validation only.
 *
 * See `@/server/api/parse` for where the line runs. Two fields are worth
 * naming because their treatment here looks lax and is not:
 *   • `latitude`/`longitude` take ANY finite number — the range belongs to
 *     VAL-006 (point 3 of the header);
 *   • `country` is length-checked (`char(2)`) but not membership-checked — a
 *     facility's country selects the grid factor (VAL-021, T3.2), and that is
 *     the rule that owns the list.
 *
 * `partial` is PATCH semantics: an absent key means "leave it alone", and an
 * empty result means "you asked me to change nothing", which is a rejection.
 */
function parseInput(
  body: unknown,
  opts: { partial: boolean },
): ParseResult<FacilityValues> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, field: "body" };
  }
  const input = body as Record<string, unknown>;
  const values: FacilityValues = {};
  const reject = (field: string): ParseResult<FacilityValues> => ({
    ok: false,
    field,
  });

  // The two NOT NULL columns. On a create both are required; on a PATCH they
  // may be omitted but never blanked — `facility_name: ""` and
  // `legal_entity_id: null` are rejections, not "clear the column".
  if (input.facility_name !== undefined || !opts.partial) {
    const name = textOrNull(input.facility_name);
    if (name === undefined || name === null) return reject("facility_name");
    values.facilityName = name;
  }
  if (input.legal_entity_id !== undefined || !opts.partial) {
    const id = uuidOrNull(input.legal_entity_id);
    if (id === undefined || id === null) return reject("legal_entity_id");
    values.legalEntityId = id;
  }

  const TEXT_FIELDS = [
    ["address", "address"],
    ["postal_code", "postalCode"],
  ] as const;
  for (const [api, column] of TEXT_FIELDS) {
    if (input[api] === undefined) continue;
    const parsed = textOrNull(input[api]);
    if (parsed === undefined) return reject(api);
    values[column] = parsed;
  }

  if (input.country !== undefined) {
    const country = alphaCodeOrNull(input.country, 2);
    if (country === undefined) return reject("country");
    values.country = country;
  }

  // Coordinates: default (safe-integer) bounds — the DOMAIN range is VAL-006's.
  const COORDINATES = [
    ["latitude", "latitude"],
    ["longitude", "longitude"],
  ] as const;
  for (const [api, column] of COORDINATES) {
    if (input[api] === undefined) continue;
    const parsed = decimalOrNull(input[api]);
    if (parsed === undefined) return reject(api);
    values[column] = parsed;
  }

  // Floor area, on the other hand, has no rule of its own, and a negative m² is
  // not a value any rule would later catch — so the bound is enforced here.
  if (input.floor_area !== undefined) {
    const parsed = decimalOrNull(input.floor_area, 0);
    if (parsed === undefined) return reject("floor_area");
    values.floorArea = parsed;
  }

  const ENUM_FIELDS = [
    ["facility_type", "facilityType", isFacilityType],
    ["tenure", "tenure", isTenureType],
    ["control_status", "controlStatus", isControlStatus],
    ["boundary_classification", "boundaryClassification", isBoundaryTreatment],
  ] as const;
  for (const [api, column, guard] of ENUM_FIELDS) {
    if (input[api] === undefined) continue;
    const parsed = oneOfOrNull(input[api], guard);
    if (parsed === undefined) return reject(api);
    values[column] = parsed;
  }

  const DATE_FIELDS = [
    ["opening_date", "openingDate"],
    ["closing_date", "closingDate"],
  ] as const;
  for (const [api, column] of DATE_FIELDS) {
    if (input[api] === undefined) continue;
    const parsed = isoDateOrNull(input[api]);
    if (parsed === undefined) return reject(api);
    values[column] = parsed;
  }

  if (input.included_in_boundary !== undefined) {
    const parsed = booleanValue(input.included_in_boundary);
    if (parsed === undefined) return reject("included_in_boundary");
    values.includedInBoundary = parsed;
  }

  if (opts.partial && Object.keys(values).length === 0) return reject("body");
  return { ok: true, values };
}

/**
 * POST body → the values of a NEW facility. The re-check of the two required
 * fields is what lets the TYPE say they are present, so `createFacility` needs
 * neither a cast nor a runtime guard of its own.
 */
export function parseNewFacility(
  body: unknown,
): ParseResult<NewFacilityValues> {
  const parsed = parseInput(body, { partial: false });
  if (!parsed.ok) return parsed;
  const { facilityName, legalEntityId } = parsed.values;
  if (facilityName === undefined) return { ok: false, field: "facility_name" };
  if (legalEntityId === undefined)
    return { ok: false, field: "legal_entity_id" };
  return {
    ok: true,
    values: { ...parsed.values, facilityName, legalEntityId },
  };
}

/** PATCH body → the values to change (absent key = leave alone). */
export function parseFacilityPatch(body: unknown): ParseResult<FacilityValues> {
  return parseInput(body, { partial: true });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Every facility of the company, oldest first. */
export async function listFacilities(
  db: DbClient,
  companyId: string,
): Promise<FacilityRow[]> {
  return db
    .select()
    .from(facility)
    .where(eq(facility.companyId, companyId))
    .orderBy(facility.createdAt, facility.id);
}

/**
 * How many facilities the company has — the `used` half of API-3 and the number
 * PG-2's `maxFacilities` gate compares.
 *
 * EVERY ROW COUNTS, including a site that is closed or excluded from the
 * boundary. The pricing PDF caps the size of the REGISTRY, not the size of one
 * period's boundary; and the alternative — a limit that a user could dodge by
 * un-ticking `included_in_boundary` — would be a limit in name only. (PG-3/F1
 * at lock is the separate question of how many facilities a REPORT includes,
 * and T2.6 counts that one over the period's own boundary.)
 */
export async function countFacilities(
  db: DbClient,
  companyId: string,
): Promise<number> {
  const [row] = await db
    .select({ used: sql<number>`count(*)::int` })
    .from(facility)
    .where(eq(facility.companyId, companyId));
  return row?.used ?? 0;
}

/** One facility of THIS company, or `undefined` (foreign ids read as absent). */
export async function getFacility(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<FacilityRow | undefined> {
  const [row] = await db
    .select()
    .from(facility)
    .where(and(eq(facility.id, id), eq(facility.companyId, companyId)))
    .limit(1);
  return row;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Outcome of a create/update: the row, or why it was refused. */
export type FacilityWriteResult = WriteResult<FacilityRow>;

/** The `reference_org` scope, named once — both writes validate against it. */
const SCOPE = { scope: "reference_org" } as const;

/**
 * Resolve `legal_entity_id` tenant-pinned before the insert. A miss is refused
 * with NO rule code: VAL-005 is about an entity that exists but is out of
 * force, whereas this is an entity that does not exist for this company at all
 * (API-1), and answering VAL-005 for it would tell the caller that the id is
 * real somewhere.
 */
async function assertReferences(
  tx: DbClient,
  companyId: string,
  values: FacilityValues,
): Promise<void> {
  const entityId = values.legalEntityId;
  if (entityId && !(await getLegalEntity(tx, companyId, entityId))) {
    refuseValidation();
  }
}

/** Create one facility (DM-5). Refused writes leave NO row behind. */
export async function createFacility(
  db: DbClient,
  companyId: string,
  values: NewFacilityValues,
): Promise<FacilityWriteResult> {
  return writeValidated(db, { companyId, ...SCOPE }, async (tx) => {
    await assertReferences(tx, companyId, values);
    const [row] = await tx
      .insert(facility)
      .values({ ...values, companyId })
      .returning();
    return row;
  });
}

/**
 * Update one facility. A foreign `id` is `NOT_FOUND` (the route answers
 * `VALIDATION` — API-1), and the update is a plain UPDATE: append-only (D5)
 * governs INPUT ROWS, not the registry, whose history is
 * `opening_date`/`closing_date`.
 */
export async function updateFacility(
  db: DbClient,
  companyId: string,
  id: string,
  values: FacilityValues,
): Promise<FacilityWriteResult> {
  return writeValidated(db, { companyId, ...SCOPE }, async (tx) => {
    await assertReferences(tx, companyId, values);
    const [row] = await tx
      .update(facility)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(facility.id, id), eq(facility.companyId, companyId)))
      .returning();
    return row;
  });
}
