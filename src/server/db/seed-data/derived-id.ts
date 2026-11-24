/**
 * Derived primary keys for reference data (T1.5).
 *
 * WHY REFERENCE ROWS DO NOT GET `crypto.randomUUID()`. Every reference table in
 * Phase 1 is delivered TWICE — once by `scripts/gen-reference-sql.mjs` into
 * `drizzle/0004_data_model.sql` (the only path that reaches production, О-13)
 * and once by `src/server/db/seed.ts` (the catch-up path for a warm local
 * database). Two random draws would give the same factor two different `id`s
 * depending on which path ran, so a row could not be compared, referenced or
 * de-duplicated across the two. Worse, the generator would rewrite hundreds of
 * UUIDs into the committed migration on every run — an unreadable diff over a
 * file whose SHA-256 the migrator records.
 *
 * A UUIDv5 of the row's NATURAL KEY fixes both: the id is a pure function of the
 * data, so the two paths agree and a re-run is a no-op on the primary key as
 * well as on the natural-key constraint.
 */
import { createHash } from "node:crypto";

/**
 * The namespace every derived reference id is drawn from. A constant with no
 * meaning of its own — changing it renumbers every reference row, which is a
 * migration, not an edit.
 */
const NAMESPACE = "5d5d723c-def3-4e8e-a7ca-8792702adf53";

/**
 * RFC 4122 §4.3 name-based UUID (SHA-1) under {@link NAMESPACE}. Small enough to
 * own outright; the alternative is a dependency for twenty lines.
 *
 * `parts` are joined with `|`, so a component must never contain one — none of
 * the natural keys here (unit codes, activity types, ISO country codes, years)
 * can.
 */
export function derivedId(...parts: Array<string | number | null>): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const name = parts.map((p) => (p === null ? "" : String(p))).join("|");
  const bytes = Buffer.from(
    createHash("sha1").update(ns).update(name, "utf8").digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
