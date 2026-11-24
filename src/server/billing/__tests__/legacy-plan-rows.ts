// =============================================================================
// THE PRE-T1.8 `plans` ROWS AND THE KEYS T5.8 RETIRES — both READ OUT OF THE
// MIGRATIONS, never transcribed (О-13, О-15).
//
// NOT A `.test.ts`: `vitest.config.ts` collects `src/**/__tests__/**/*.test.ts`,
// so this file is a fixture module the two billing suites import, not a suite of
// its own.
//
// ── WHY THE FIXTURE IS PARSED AND NOT PASTED ────────────────────────────────
// `plan-catalog.test.ts` and `plans-migration.integration.test.ts` both need the
// `plans` rows as production actually holds them: the 13-key shape from the
// commented-out psql fallback in `drizzle/0001_billing.sql`, which is the ONLY
// description of those rows that ever reached the server (`db:seed` does not run
// there — О-13). Each file used to carry its own character-for-character copy of
// that JSON, which made three spellings of one fact; a copy that nobody can
// diff against its original is a fixture that can quietly stop being "old".
// Reading the block is also what lets `src/` be free of the retired key NAMES,
// which is T5.8's own acceptance criterion — the names live in the SQL that
// deletes them and in the SQL that once wrote them, and nowhere else.
//
// The parse is deliberately strict and the callers assert on its result (four
// rows, thirteen keys each), so a reformatted migration fails loudly rather than
// yielding a silently empty fixture.
// =============================================================================

import { readFileSync } from "node:fs";
import path from "node:path";

const DRIZZLE_DIR = path.resolve(__dirname, "../../../..", "drizzle");

function migration(file: string): string {
  return readFileSync(path.join(DRIZZLE_DIR, file), "utf8");
}

/** One `plans` row of the 0001 fallback, as the suites want it. */
export interface LegacyPlanRow {
  id: string;
  name: string;
  sortOrder: number;
  /** The stored `features` JSONB, verbatim text. */
  json: string;
}

/**
 * The four pre-T1.8 rows, parsed from the commented `INSERT INTO "plans"`
 * fallback of `drizzle/0001_billing.sql`.
 *
 * Every line looks like
 *   `--   ('trial','Trial',0,'{"scope3":false,…}'::jsonb),`
 * and no value inside the JSON contains a single quote, so the row can be split
 * on quoting alone.
 */
export const LEGACY_PLAN_ROWS: LegacyPlanRow[] = [
  ...migration("0001_billing.sql").matchAll(
    /^--\s+\('([a-z]+)','([^']+)',(\d+),'(\{.*\})'::jsonb\)/gm,
  ),
].map((match) => ({
  id: match[1],
  name: match[2],
  sortOrder: Number(match[3]),
  json: match[4],
}));

/**
 * The keys `drizzle/0006_retire_report_gating.sql` deletes from every plan
 * (О-15), read off the statement itself.
 *
 * Comment lines are dropped BEFORE the match: the file's header discusses
 * `jsonb - 'key'` and `WHERE features ? 'reports'` in prose, and a regex over
 * the whole text would collect those too.
 */
export const RETIRED_REPORT_KEYS: string[] = (() => {
  const statement = migration("0006_retire_report_gating.sql")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return [...statement.matchAll(/-\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
})();
