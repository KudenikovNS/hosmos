// LEGAL ENTITIES — the organisational axis of the Phase-1 model (DM-2…DM-4).
//
// See docs/decisions/server-org-legal-entities.md for the full account.
import { and, eq, sql } from "drizzle-orm";

import {
  alphaCodeOrNull,
  decimalOrNull,
  isoDateOrNull,
  num,
  oneOfOrNull,
  textOrNull,
  uuidOrNull,
  type ParseResult,
} from "@/server/api/parse";
import type { DbClient } from "@/server/db/client";
import { currencies, legalEntity, validationResult } from "@/server/db/schema";
import {
  refuseValidation,
  ruleRef,
  writeValidated,
  type DeleteResult,
  type WriteResult,
} from "@/server/validation/write";
import { isConsolidationMethod, isGroupStructureType } from "@/shared/enums";

export type { ParseResult };

/** A `legal_entity` row as Drizzle returns it. */
export type LegalEntityRow = typeof legalEntity.$inferSelect;

/** The column values a create/update writes (never `company_id`, never `id`). */
export type LegalEntityValues = Partial<
  Omit<typeof legalEntity.$inferInsert, "id" | "companyId">
>;

// ─── Wire contract (К-1, К-2) ────────────────────────────────────────────────

/**
 * One legal entity as the API speaks it: snake_case DD field names, NUMERIC
 * columns as numbers (the `normalize.ts` convention), dates as ISO strings.
 *
 * `organisation_name` and `parent_organisation_id` are the К-1/К-2 renames.
 * `company_id` is absent on purpose: the tenant is the session, never a field
 * the client could read back and start sending.
 */
export interface LegalEntityDto {
  id: string;
  organisation_name: string;
  registration_number: string | null;
  vat_number: string | null;
  registered_address: string | null;
  country: string | null;
  nace_code: string | null;
  reporting_currency: string | null;
  employee_count: number | null;
  average_fte: number | null;
  turnover: number | null;
  group_structure_type: string | null;
  parent_organisation_id: string | null;
  consolidation_method: string | null;
  ownership_percentage: number | null;
  effective_from: string | null;
  effective_to: string | null;
  exclusion_reason: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** THE serialiser (К-1/К-2). Every response about an entity goes through it. */
export function serialiseLegalEntity(row: LegalEntityRow): LegalEntityDto {
  return {
    id: row.id,
    organisation_name: row.name, // К-1
    registration_number: row.registrationNumber,
    vat_number: row.vatNumber,
    registered_address: row.registeredAddress,
    country: row.country,
    nace_code: row.naceCode,
    reporting_currency: row.reportingCurrency,
    employee_count: row.employeeCount,
    average_fte: num(row.averageFte),
    turnover: num(row.turnover),
    group_structure_type: row.groupStructureType,
    parent_organisation_id: row.parentLegalEntityId, // К-2
    consolidation_method: row.consolidationMethod,
    ownership_percentage: num(row.ownershipPercentage),
    effective_from: row.effectiveFrom,
    effective_to: row.effectiveTo,
    exclusion_reason: row.exclusionReason,
    created_at: row.createdAt?.toISOString() ?? null,
    updated_at: row.updatedAt?.toISOString() ?? null,
  };
}

/** A create's values: everything optional except the one NOT NULL column. */
export type NewLegalEntityValues = LegalEntityValues & { name: string };

/**
 * Wire → columns, with per-field SHAPE validation (К-1/К-2 applied here).
 *
 * The primitives are `@/server/api/parse`, whose header states the line this
 * function sits on: it refuses only what would reach Postgres as a malformed
 * literal, and leaves everything semantic — the reference lists (VAL-002), the
 * acyclic hierarchy (VAL-003), the ordered dating (VAL-004), the required
 * fields (VAL-001) — to the rules. A caller therefore gets a bare `VALIDATION`
 * for a malformed body and a `VALIDATION` carrying rule codes for a well-formed
 * but invalid entity.
 *
 * Unknown keys are ignored (house style); `partial` is PATCH semantics, where
 * an absent key means "leave it alone" and an empty result means "you asked me
 * to change nothing". Callers use the two named wrappers below rather than the
 * flag.
 */
function parseInput(
  body: unknown,
  opts: { partial: boolean },
): ParseResult<LegalEntityValues> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, field: "body" };
  }
  const input = body as Record<string, unknown>;
  const values: LegalEntityValues = {};
  const reject = (field: string): ParseResult<LegalEntityValues> => ({
    ok: false,
    field,
  });

  // `organisation_name` (К-1) — the only NOT NULL column of the profile.
  if (input.organisation_name !== undefined || !opts.partial) {
    const name = textOrNull(input.organisation_name);
    if (name === undefined || name === null) return reject("organisation_name");
    values.name = name;
  }

  // Free text, blank → NULL.
  const TEXT_FIELDS = [
    ["registration_number", "registrationNumber"],
    ["vat_number", "vatNumber"],
    ["registered_address", "registeredAddress"],
    ["nace_code", "naceCode"],
    ["exclusion_reason", "exclusionReason"],
  ] as const;
  for (const [api, column] of TEXT_FIELDS) {
    if (input[api] === undefined) continue;
    const parsed = textOrNull(input[api]);
    if (parsed === undefined) return reject(api);
    values[column] = parsed;
  }

  // `char(2)` / `char(3)` — a longer string is a driver error, not a rule miss.
  if (input.country !== undefined) {
    const country = alphaCodeOrNull(input.country, 2);
    if (country === undefined) return reject("country");
    values.country = country;
  }
  if (input.reporting_currency !== undefined) {
    const currency = alphaCodeOrNull(input.reporting_currency, 3);
    if (currency === undefined) return reject("reporting_currency");
    values.reportingCurrency = currency;
  }

  if (input.employee_count !== undefined) {
    const raw = input.employee_count;
    if (raw === null || raw === "") {
      values.employeeCount = null;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) return reject("employee_count");
      values.employeeCount = n;
    }
  }

  const DECIMAL_FIELDS = [
    ["average_fte", "averageFte", 0, Number.MAX_SAFE_INTEGER],
    ["turnover", "turnover", 0, Number.MAX_SAFE_INTEGER],
    // F4 — an ownership share is a percentage, so 0…100 (not a 0…1 ratio).
    ["ownership_percentage", "ownershipPercentage", 0, 100],
  ] as const;
  for (const [api, column, min, max] of DECIMAL_FIELDS) {
    if (input[api] === undefined) continue;
    const parsed = decimalOrNull(input[api], min, max);
    if (parsed === undefined) return reject(api);
    values[column] = parsed;
  }

  if (input.group_structure_type !== undefined) {
    const raw = oneOfOrNull(input.group_structure_type, isGroupStructureType);
    if (raw === undefined) return reject("group_structure_type");
    values.groupStructureType = raw;
  }
  if (input.consolidation_method !== undefined) {
    const raw = oneOfOrNull(input.consolidation_method, isConsolidationMethod);
    if (raw === undefined) return reject("consolidation_method");
    values.consolidationMethod = raw;
  }

  // К-2 — the parent is another entity of the SAME company; existence and
  // tenancy are resolved in the write path, the shape here.
  if (input.parent_organisation_id !== undefined) {
    const raw = uuidOrNull(input.parent_organisation_id);
    if (raw === undefined) return reject("parent_organisation_id");
    values.parentLegalEntityId = raw;
  }

  const DATE_FIELDS = [
    ["effective_from", "effectiveFrom"],
    ["effective_to", "effectiveTo"],
  ] as const;
  for (const [api, column] of DATE_FIELDS) {
    if (input[api] === undefined) continue;
    const parsed = isoDateOrNull(input[api]);
    if (parsed === undefined) return reject(api);
    values[column] = parsed;
  }

  if (opts.partial && Object.keys(values).length === 0) return reject("body"); // a PATCH that changes nothing
  return { ok: true, values };
}

/**
 * POST body → the values of a NEW entity. `organisation_name` is required, and
 * the re-check below is what lets the type say so: `createLegalEntity` then
 * needs no cast and no runtime guard of its own.
 */
export function parseNewLegalEntity(
  body: unknown,
): ParseResult<NewLegalEntityValues> {
  const parsed = parseInput(body, { partial: false });
  if (!parsed.ok) return parsed;
  const { name } = parsed.values;
  if (name === undefined) return { ok: false, field: "organisation_name" };
  return { ok: true, values: { ...parsed.values, name } };
}

/** PATCH body → the values to change (absent key = leave alone). */
export function parseLegalEntityPatch(
  body: unknown,
): ParseResult<LegalEntityValues> {
  return parseInput(body, { partial: true });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Every legal entity of the company, oldest first (the group tree's own order). */
export async function listLegalEntities(
  db: DbClient,
  companyId: string,
): Promise<LegalEntityRow[]> {
  return db
    .select()
    .from(legalEntity)
    .where(eq(legalEntity.companyId, companyId))
    .orderBy(legalEntity.createdAt, legalEntity.id);
}

/**
 * How many entities the company has — the `used` half of API-3 and the number
 * the plan gate compares.
 *
 * EVERY ROW COUNTS, including the parent/root one (PG-2 is explicit: the limit
 * is the total number of legal entities, not "subsidiaries besides the
 * parent"), and including an entity whose `effective_to` has passed — leaving
 * the group is not leaving the tenant, and the row is still there to be
 * reported on for the years it covered.
 */
export async function countLegalEntities(
  db: DbClient,
  companyId: string,
): Promise<number> {
  const [row] = await db
    .select({ used: sql<number>`count(*)::int` })
    .from(legalEntity)
    .where(eq(legalEntity.companyId, companyId));
  return row?.used ?? 0;
}

/** One entity of THIS company, or `undefined` (foreign ids read as absent). */
export async function getLegalEntity(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<LegalEntityRow | undefined> {
  const [row] = await db
    .select()
    .from(legalEntity)
    .where(and(eq(legalEntity.id, id), eq(legalEntity.companyId, companyId)))
    .limit(1);
  return row;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Outcome of a create/update: the row, or why it was refused. */
export type LegalEntityWriteResult = WriteResult<LegalEntityRow>;

/** The `reference_org` scope, named once — both writes validate against it. */
const SCOPE = { scope: "reference_org" } as const;

/**
 * Resolve the two FK-backed references, tenant-pinned, before anything is
 * written. Refuses via `refuseValidation` — the caller is already inside the
 * transaction, so the throw both answers and unwinds.
 */
async function assertReferences(
  tx: DbClient,
  companyId: string,
  values: LegalEntityValues,
): Promise<void> {
  const parentId = values.parentLegalEntityId;
  if (parentId) {
    const parent = await getLegalEntity(tx, companyId, parentId);
    // Another company's entity, or none at all — the same answer either way
    // (API-1). Answering "no such entity" for a real id of another tenant would
    // itself be a disclosure, so the two cases are indistinguishable here.
    if (!parent) refuseValidation();
  }

  const currency = values.reportingCurrency;
  if (currency) {
    const [known] = await tx
      .select({ code: currencies.code })
      .from(currencies)
      .where(eq(currencies.code, currency))
      .limit(1);
    if (!known) {
      // Named as VAL-002 rather than a bare refusal: it IS that rule's subject,
      // and the client should see the same code whether the currency was caught
      // here (before the FK could fire) or by the run afterwards. The code,
      // message and scope come from the inventory (`ruleRef`, T2.4) so the two
      // paths cannot answer differently.
      refuseValidation([ruleRef("VAL-002")]);
    }
  }
}

/** Create one legal entity (DM-2). Refused writes leave NO row behind. */
export async function createLegalEntity(
  db: DbClient,
  companyId: string,
  values: NewLegalEntityValues,
): Promise<LegalEntityWriteResult> {
  return writeValidated(db, { companyId, ...SCOPE }, async (tx) => {
    await assertReferences(tx, companyId, values);
    const [row] = await tx
      .insert(legalEntity)
      .values({ ...values, companyId })
      .returning();
    return row;
  });
}

/**
 * Update one legal entity. A foreign `id` is `NOT_FOUND` (the route answers
 * `VALIDATION` — API-1), and the update is a plain UPDATE rather than a new
 * version: the append-only rule (D5) governs INPUT ROWS, not the organisational
 * registry, whose history is `effective_from`/`effective_to` (F4).
 */
export async function updateLegalEntity(
  db: DbClient,
  companyId: string,
  id: string,
  values: LegalEntityValues,
): Promise<LegalEntityWriteResult> {
  return writeValidated(db, { companyId, ...SCOPE }, async (tx) => {
    await assertReferences(tx, companyId, values);
    const [row] = await tx
      .update(legalEntity)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(legalEntity.id, id), eq(legalEntity.companyId, companyId)))
      .returning();
    return row;
  });
}

// ─── Deletion (DM-4) ─────────────────────────────────────────────────────────

/**
 * What can make an entity undeletable, in the order a user would fix them.
 * `child_entities` is here for the same reason as the rest: deleting a parent
 * would leave its subsidiaries pointing at nothing.
 */
interface DeleteBlockers extends Record<string, number> {
  child_entities: number;
  facilities: number;
  assets: number;
  period_scopes: number;
  emission_activities: number;
  energy_activities: number;
  contractual_instruments: number;
  disclosures: number;
}

/** Outcome of a delete: done, absent, or refused with the counts that refused it. */
export type LegalEntityDeleteResult = DeleteResult<DeleteBlockers>;

/**
 * Everything that points at this entity, counted in ONE round trip.
 *
 * Written as scalar subqueries rather than eight selects because the answer has
 * to be consistent: eight statements could each be true at a different instant,
 * and "how many things block this delete" would then be a number that never
 * existed. Every count is tenant-pinned as well as entity-pinned — belt and
 * braces, since an entity is already tenant-pinned, but it keeps the invariant
 * local to the query.
 */
async function countDependents(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<DeleteBlockers> {
  const [row] = await db.execute<DeleteBlockers>(sql`
    SELECT
      (SELECT count(*)::int FROM legal_entity
        WHERE parent_legal_entity_id = ${id} AND company_id = ${companyId}) AS child_entities,
      (SELECT count(*)::int FROM facility
        WHERE legal_entity_id = ${id} AND company_id = ${companyId}) AS facilities,
      (SELECT count(*)::int FROM asset
        WHERE legal_entity_id = ${id} AND company_id = ${companyId}) AS assets,
      (SELECT count(*)::int FROM period_scope
        WHERE legal_entity_id = ${id} AND company_id = ${companyId}) AS period_scopes,
      (SELECT count(*)::int FROM emission_activity
        WHERE legal_entity_id = ${id} AND company_id = ${companyId}) AS emission_activities,
      (SELECT count(*)::int FROM purchased_energy_activity
        WHERE legal_entity_id = ${id} AND company_id = ${companyId}) AS energy_activities,
      (SELECT count(*)::int FROM contractual_instrument
        WHERE legal_entity_id = ${id} AND company_id = ${companyId}) AS contractual_instruments,
      (SELECT count(*)::int FROM disclosure_record
        WHERE legal_entity_id = ${id} AND company_id = ${companyId}) AS disclosures
  `);
  return row;
}

/**
 * Delete an entity that owns nothing (DM-4).
 *
 * The refusal is the point: an entity with facilities, rows or subsidiaries is
 * part of a reported history, and the way to take it out of the group is
 * `effective_to` (F4) — which keeps the numbers it contributed reproducible.
 * Only the mistake — an entity created and never used — is actually deletable.
 *
 * The entity's own `validation_result` rows go with it, in the same
 * transaction: `validation_result.object_id` has no foreign key (it is
 * polymorphic, К-8), so nothing else would ever clean them up and the boundary
 * screens would show findings about an object that no longer exists.
 */
export async function deleteLegalEntity(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<LegalEntityDeleteResult> {
  const existing = await getLegalEntity(db, companyId, id);
  if (!existing) return { ok: false, error: "NOT_FOUND" };

  return db.transaction(async (tx) => {
    const blockers = await countDependents(tx, companyId, id);
    if (Object.values(blockers).some((count) => count > 0)) {
      return { ok: false, error: "HAS_DATA", blockers };
    }
    await tx
      .delete(validationResult)
      .where(
        and(
          eq(validationResult.companyId, companyId),
          eq(validationResult.objectType, "legal_entity"),
          eq(validationResult.objectId, id),
        ),
      );
    await tx
      .delete(legalEntity)
      .where(and(eq(legalEntity.id, id), eq(legalEntity.companyId, companyId)));
    return { ok: true };
  });
}
