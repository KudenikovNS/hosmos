// =============================================================================
// ASSETS — the flat registry of things (DM-6, F5, К-7).
//
// F5 IS THE WHOLE DESIGN OF THIS FILE, so it is worth stating what it denies:
//
//   • AN ASSET IS NOT A LEVEL OF THE ORG TREE. The tree is
//     `company → legal_entity → facility`; an asset REFINES an attribution
//     (`legal_entity_id` NOT NULL, `facility_id` optional) but nothing hangs
//     off it. There is no recursion, no parent link, no cycle rule.
//   • AN ASSET IS NOT COUNTED BY A PLAN LIMIT. There is deliberately no
//     `countAssets` here and deliberately no `requireWithinLimit` in the route:
//     the plan matrix has `maxLegalEntities` and `maxFacilities` and nothing
//     else on this axis (PG-2, `@/shared/plans`). A tenant on `starter` may
//     register the 40th vehicle, and the integration suite asserts exactly that
//     — a comment saying "not limited" would age into a lie the first time
//     someone copied the facility route wholesale.
//   • AN ASSET CARRIES NO DATA OF ITS OWN. Which is why, alone among the three
//     registries, it can be DELETED (§12.2 lists DELETE for this route and not
//     for the other two): there is no history to make irreproducible.
//
// THE ONE THING THAT CAN REFUSE A DELETE IS A REFERENCE (К-7). Five columns in
// four tables point at `asset(id)` and none of them was declared `ON DELETE
// RESTRICT` in 0004 — the DDL leaves referential policy to the app layer, as
// DM-4 does for legal entities. So `deleteAsset` counts them, in ONE round trip,
// and refuses with the counts. `meter_asset_id` is the reference that made К-7
// possible in the first place: it is how a `purchased_energy_activity` names the
// METER it was read from, and deleting that meter under a submitted reading is
// the exact loss this guard exists to prevent.
//
// RULES. No `reference_org` rule has `asset` in its `appliesTo` today, so a run
// against a new asset writes nothing — silence means "not applicable", never
// "passed" (see `validation/types.ts`). The writes go through `writeValidated`
// anyway: it is the SAME mechanism, so the day an asset rule is written it is
// already enforced, and until then it costs a handful of index lookups that
// match no row.
// =============================================================================
import { and, eq, sql } from "drizzle-orm";

import {
  oneOfOrNull,
  textOrNull,
  uuidOrNull,
  type ParseResult,
} from "@/server/api/parse";
import type { DbClient } from "@/server/db/client";
import { asset, validationResult } from "@/server/db/schema";
import {
  refuseValidation,
  writeValidated,
  type DeleteResult,
  type WriteResult,
} from "@/server/validation/write";
import { isAssetType } from "@/shared/enums";

import { getFacility } from "./facilities";
import { getLegalEntity } from "./legal-entities";

/** An `asset` row as Drizzle returns it. */
export type AssetRow = typeof asset.$inferSelect;

/** The column values a create/update writes (never `company_id`, never `id`). */
export type AssetValues = Partial<
  Omit<typeof asset.$inferInsert, "id" | "companyId">
>;

/** A create's values: the three NOT NULL columns are guaranteed present. */
export type NewAssetValues = AssetValues & {
  name: string;
  assetType: string;
  legalEntityId: string;
};

// ─── Wire contract (§4.4 — DD names, 1:1) ────────────────────────────────────

/** One asset as the API speaks it. No К-* renames: the DD names are the columns. */
export interface AssetDto {
  id: string;
  legal_entity_id: string;
  facility_id: string | null;
  name: string;
  asset_type: string;
  identifier: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** THE serialiser. Every response about an asset goes through it. */
export function serialiseAsset(row: AssetRow): AssetDto {
  return {
    id: row.id,
    legal_entity_id: row.legalEntityId,
    facility_id: row.facilityId,
    name: row.name,
    asset_type: row.assetType,
    identifier: row.identifier,
    notes: row.notes,
    created_at: row.createdAt?.toISOString() ?? null,
    updated_at: row.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Wire → columns, with per-field SHAPE validation only.
 *
 * `asset_type` is guarded against `ASSET_TYPES` here rather than by a CHECK
 * (§0.8/F6) and rather than by a rule (there is none): the list includes
 * `meter`, and К-7 depends on that value existing, so an unknown type is
 * refused as a bad FIELD with no rule code to show for it.
 */
function parseInput(
  body: unknown,
  opts: { partial: boolean },
): ParseResult<AssetValues> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, field: "body" };
  }
  const input = body as Record<string, unknown>;
  const values: AssetValues = {};
  const reject = (field: string): ParseResult<AssetValues> => ({
    ok: false,
    field,
  });

  // The three NOT NULL columns: required on create, never blankable on PATCH.
  if (input.name !== undefined || !opts.partial) {
    const name = textOrNull(input.name);
    if (name === undefined || name === null) return reject("name");
    values.name = name;
  }
  if (input.asset_type !== undefined || !opts.partial) {
    const type = oneOfOrNull(input.asset_type, isAssetType);
    if (type === undefined || type === null) return reject("asset_type");
    values.assetType = type;
  }
  if (input.legal_entity_id !== undefined || !opts.partial) {
    const id = uuidOrNull(input.legal_entity_id);
    if (id === undefined || id === null) return reject("legal_entity_id");
    values.legalEntityId = id;
  }

  // `facility_id` IS clearable: an asset that stops belonging to a site keeps
  // its legal entity (F5 — the entity is the attribution, the site is a refinement).
  if (input.facility_id !== undefined) {
    const id = uuidOrNull(input.facility_id);
    if (id === undefined) return reject("facility_id");
    values.facilityId = id;
  }

  const TEXT_FIELDS = [
    ["identifier", "identifier"],
    ["notes", "notes"],
  ] as const;
  for (const [api, column] of TEXT_FIELDS) {
    if (input[api] === undefined) continue;
    const parsed = textOrNull(input[api]);
    if (parsed === undefined) return reject(api);
    values[column] = parsed;
  }

  if (opts.partial && Object.keys(values).length === 0) return reject("body");
  return { ok: true, values };
}

/** POST body → the values of a NEW asset (the three required fields re-checked). */
export function parseNewAsset(body: unknown): ParseResult<NewAssetValues> {
  const parsed = parseInput(body, { partial: false });
  if (!parsed.ok) return parsed;
  const { name, assetType, legalEntityId } = parsed.values;
  if (name === undefined) return { ok: false, field: "name" };
  if (assetType === undefined) return { ok: false, field: "asset_type" };
  if (legalEntityId === undefined)
    return { ok: false, field: "legal_entity_id" };
  return {
    ok: true,
    values: { ...parsed.values, name, assetType, legalEntityId },
  };
}

/** PATCH body → the values to change (absent key = leave alone). */
export function parseAssetPatch(body: unknown): ParseResult<AssetValues> {
  return parseInput(body, { partial: true });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Every asset of the company, oldest first. */
export async function listAssets(
  db: DbClient,
  companyId: string,
): Promise<AssetRow[]> {
  return db
    .select()
    .from(asset)
    .where(eq(asset.companyId, companyId))
    .orderBy(asset.createdAt, asset.id);
}

/** One asset of THIS company, or `undefined` (foreign ids read as absent). */
export async function getAsset(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<AssetRow | undefined> {
  const [row] = await db
    .select()
    .from(asset)
    .where(and(eq(asset.id, id), eq(asset.companyId, companyId)))
    .limit(1);
  return row;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Outcome of a create/update: the row, or why it was refused. */
export type AssetWriteResult = WriteResult<AssetRow>;

/** The scope the write path validates against — see the header on why it runs at all. */
const SCOPE = { scope: "reference_org" } as const;

/**
 * Resolve both FK-backed references tenant-pinned, before the insert. Either
 * miss is the same answer (API-1): the object does not exist for this company.
 */
async function assertReferences(
  tx: DbClient,
  companyId: string,
  values: AssetValues,
): Promise<void> {
  const entityId = values.legalEntityId;
  if (entityId && !(await getLegalEntity(tx, companyId, entityId))) {
    refuseValidation();
  }
  const facilityId = values.facilityId;
  if (facilityId && !(await getFacility(tx, companyId, facilityId))) {
    refuseValidation();
  }
}

/** Create one asset (DM-6). NOT gated by any plan limit — see the header (F5). */
export async function createAsset(
  db: DbClient,
  companyId: string,
  values: NewAssetValues,
): Promise<AssetWriteResult> {
  return writeValidated(db, { companyId, ...SCOPE }, async (tx) => {
    await assertReferences(tx, companyId, values);
    const [row] = await tx
      .insert(asset)
      .values({ ...values, companyId })
      .returning();
    return row;
  });
}

/** Update one asset. A foreign `id` is `NOT_FOUND` (the route answers `VALIDATION`). */
export async function updateAsset(
  db: DbClient,
  companyId: string,
  id: string,
  values: AssetValues,
): Promise<AssetWriteResult> {
  return writeValidated(db, { companyId, ...SCOPE }, async (tx) => {
    await assertReferences(tx, companyId, values);
    const [row] = await tx
      .update(asset)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(asset.id, id), eq(asset.companyId, companyId)))
      .returning();
    return row;
  });
}

// ─── Deletion (К-7 — RESTRICT at the app layer) ──────────────────────────────

/**
 * Everything that can point at an asset, in the order a user would clear them.
 *
 * `meters` is `purchased_energy_activity.meter_asset_id` (К-7) and is listed
 * separately from `energy_activities` (the same table's `asset_id`) on purpose:
 * they are two DIFFERENT claims about the same row — "this reading came from
 * that meter" and "this consumption belongs to that asset" — and a user
 * clearing the way for a delete needs to know which one is in the way.
 */
interface AssetDeleteBlockers extends Record<string, number> {
  meters: number;
  emission_activities: number;
  energy_activities: number;
  contractual_instruments: number;
  disclosures: number;
}

/** Outcome of a delete: done, absent, or refused with the counts that refused it. */
export type AssetDeleteResult = DeleteResult<AssetDeleteBlockers>;

/**
 * Count every reference to this asset in ONE round trip.
 *
 * Scalar subqueries rather than five selects, for the reason `countDependents`
 * in `./legal-entities` gives: five statements could each be true at a
 * different instant, and "how many things block this delete" would be a number
 * that never existed. THE COST OF THE GUARD IS THEREFORE ONE EXTRA QUERY PER
 * DELETE — five index lookups on `(company_id, <fk>)`-shaped predicates, inside
 * the same transaction as the delete itself, so nothing can slip in between.
 */
async function countReferences(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<AssetDeleteBlockers> {
  const [row] = await db.execute<AssetDeleteBlockers>(sql`
    SELECT
      (SELECT count(*)::int FROM purchased_energy_activity
        WHERE meter_asset_id = ${id} AND company_id = ${companyId}) AS meters,
      (SELECT count(*)::int FROM emission_activity
        WHERE asset_id = ${id} AND company_id = ${companyId}) AS emission_activities,
      (SELECT count(*)::int FROM purchased_energy_activity
        WHERE asset_id = ${id} AND company_id = ${companyId}) AS energy_activities,
      (SELECT count(*)::int FROM contractual_instrument
        WHERE asset_id = ${id} AND company_id = ${companyId}) AS contractual_instruments,
      (SELECT count(*)::int FROM disclosure_record
        WHERE asset_id = ${id} AND company_id = ${companyId}) AS disclosures
  `);
  return row;
}

/**
 * Delete an asset nothing points at (§12.2, F5).
 *
 * The refusal is not about the asset's own data — it has none — but about the
 * ROWS THAT NAME IT. A tombstoned or superseded input row counts just as much
 * as a current one: the version chain (D5) is the audit trail, and a locked
 * revision that says "meter #7" must still be able to say what meter #7 was.
 * `is_deleted` is therefore NOT filtered out of the counts.
 *
 * The asset's own `validation_result` rows go with it, in the same transaction:
 * `validation_result.object_id` has no foreign key (it is polymorphic, К-8), so
 * nothing else would ever clean them up. Today no rule targets an asset and the
 * DELETE matches nothing — it is here so that adding the first asset rule does
 * not silently start leaving orphans behind.
 */
export async function deleteAsset(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<AssetDeleteResult> {
  const existing = await getAsset(db, companyId, id);
  if (!existing) return { ok: false, error: "NOT_FOUND" };

  return db.transaction(async (tx) => {
    const blockers = await countReferences(tx, companyId, id);
    if (Object.values(blockers).some((count) => count > 0)) {
      return { ok: false, error: "HAS_DATA", blockers };
    }
    await tx
      .delete(validationResult)
      .where(
        and(
          eq(validationResult.companyId, companyId),
          eq(validationResult.objectType, "asset"),
          eq(validationResult.objectId, id),
        ),
      );
    await tx
      .delete(asset)
      .where(and(eq(asset.id, id), eq(asset.companyId, companyId)));
    return { ok: true };
  });
}
