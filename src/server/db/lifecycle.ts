/**
 * The 20 shared columns of an input row (§4.8) — placement, dating, unit,
 * row state, approvals, the version chain and the tombstone — as one mixin
 * spread into the four input tables, so the columns cannot drift apart. The
 * self-referencing FKs are why the mixin takes an accessor for the own `id`.
 *
 * See docs/decisions/lifecycle-mixin.md for the full account.
 */
import { boolean, text, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

import { appUuidPk, timestamptz } from "./columns";
import {
  asset,
  companies,
  facility,
  legalEntity,
  metricCatalog,
  profiles,
  reportRevision,
} from "./schema";

/**
 * The 20 shared columns of an input row (spec §4.8). Spread into the `pgTable`
 * of `emission_activity`, `purchased_energy_activity`, `contractual_instrument`
 * and `disclosure_record`.
 *
 * @param self accessor for the OWN `id` column of the table being defined —
 *   `(): AnyPgColumn => emissionActivity.id`. The two version links
 *   (`previous_version_id`, `superseded_by_id`) are self-FKs, so the mixin
 *   cannot resolve them; the explicit `AnyPgColumn` return annotation is what
 *   lets TypeScript accept a table referencing itself (Drizzle's documented
 *   self-relation form).
 *
 * NOT included here, deliberately:
 *   - the `state` / `year_month` CHECK constraints and the three DM-12 indexes:
 *     they are table-level and their names must be table-specific, so each
 *     `pgTable` declares its own in `schema.ts` (where the partial
 *     `WHERE superseded_by_id IS NULL` index stays greppable next to its `.sql`
 *     twin, R-1);
 *   - `metric_key`'s NOT NULL on `disclosure_record` (DM-18): that one table
 *     overrides the column in its own object literal.
 */
export function lifecycleColumns(self: () => AnyPgColumn) {
  return {
    // Identity — a row version is write-once; the id IS the version id.
    id: appUuidPk(),
    // Denormalised tenant key (§4.0): every input/derived table carries it for
    // guards and indexes even though D23's column list does not name it.
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Which revision this row belongs to — the only stateful thing above it.
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => reportRevision.id),
    // Mandatory attribution (D9); facility/asset only refine it (К-18, F5).
    legalEntityId: uuid("legal_entity_id")
      .notNull()
      .references(() => legalEntity.id),
    facilityId: uuid("facility_id").references(() => facility.id),
    assetId: uuid("asset_id").references(() => asset.id),
    // Link to the disclosure catalogue; NOT NULL only on `disclosure_record`.
    metricKey: text("metric_key").references(() => metricCatalog.metricKey),
    // Dating (D3). NULL = the row covers the whole period (e.g. a certificate).
    yearMonth: text("year_month"),
    // The unit the value was collected in (D7) — conversion is a calc step.
    unit: text("unit"),
    // Row-level lifecycle, two values only (§0.5). CHECK per table.
    state: text("state").notNull().default("draft"),
    approvedBy: uuid("approved_by").references(() => profiles.id),
    approvedAt: timestamptz("approved_at"),
    notes: text("notes"),
    // Version chain (D5). `superseded_by_id` is the ONLY mutable field on an
    // input row: current state = `superseded_by_id IS NULL` (§0.4).
    previousVersionId: uuid("previous_version_id").references(self),
    supersededById: uuid("superseded_by_id").references(self),
    changeReason: text("change_reason"),
    // Tombstone (К-21) — deletion is a new version, never a DELETE.
    isDeleted: boolean("is_deleted").notNull().default(false),
    // Who wrote THIS version, and their role at that moment (a snapshot, like
    // `audit_log.actor_role` — not an FK, roles change and the trail must not).
    actorId: uuid("actor_id")
      .notNull()
      .references(() => profiles.id),
    actorRole: text("actor_role"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  };
}
