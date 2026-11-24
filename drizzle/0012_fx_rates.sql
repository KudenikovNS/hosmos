-- 0012_fx_rates.sql — THE EXCHANGE RATES REACH PRODUCTION AT LAST.
--
-- RENUMBERED FROM 0008, AND THE REASON IS THE WHOLE POINT OF THIS FILE'S
-- EXISTENCE REPEATING ITSELF. It was authored as `0008` on a branch that was
-- never merged, while 0009-0011 landed on main and reserved an empty slot for
-- it. The migrator applies a migration only when its journal timestamp is
-- GREATER than the last one applied (`drizzle-orm/pg-core/dialect.js`: `if
-- (!lastDbMigration || Number(lastDbMigration.created_at) < migration.
-- folderMillis)`). Merging it behind 0011 would therefore have SKIPPED it
-- silently, forever — the exchange rates would have stayed absent and emissions
-- intensity blank for every company, which is the exact defect this file was
-- written to repair.
--
-- So a reserved gap in the journal is not cosmetic: it is a migration that can
-- never run. Nothing had applied 0008 anywhere (production stopped at 0007), so
-- renumbering is safe and is the honest fix rather than editing timestamps to
-- fake an order.
--
-- THE DEFECT. `0002_data_integrity.sql` CREATEs `fx_rates` and populates
-- `currencies` beside it, but nothing has ever INSERTed a rate: the thirty rows
-- live in `src/server/db/seed.ts`, and production never runs that script —
-- `deploy.yml` ships neither `seed.ts` nor `tsx`, and the server executes only
-- `scripts/migrate.mjs`. (The `db:seed` line in the workflow belongs to the
-- CI **test** database.) So every production database has an empty `fx_rates`.
--
-- WHAT IT COSTS, and why it is not a demo-only inconvenience. `resolveFxRateMap`
-- omits a currency it has no rate for, `convertToEur` then answers null, and
-- `aggregate.ts` withholds `turnoverEur` and BOTH intensity figures rather than
-- inventing a rate of 1.0 — deliberately, since a silent 1.0 would state a
-- company's turnover in the wrong unit with nothing looking wrong. The refusal
-- is correct; the missing data is not. The visible effect is that VSME B3
-- intensity is blank for EVERY company on prod, and the report prints
-- "not published" with `fx_rate_missing` beside it. This migration is what makes
-- that sentence stop being true.
--
-- THIS IS THE SAME LESSON AS О-13/MIG-6, MISSED ONCE. Phase-1 reference data
-- (141 metrics, the factor set, 440 factors, 38 conversions, 4 plans) travels
-- inside `0004` for exactly this reason. `fx_rates` predates that rule by two
-- migrations and was never brought under it. The rule, restated: reference data
-- that production needs ships in a MIGRATION, never in the seed.
--
-- SOURCE OF TRUTH. The values are `seed.ts`'s `FX` table verbatim — ECB/NBS
-- annual averages for 2023/2024/2025, `rate_to_eur` = EUR per 1 unit, EUR = 1.
-- `db:seed` keeps its own copy and stays the catch-up path for a warm local
-- database; both write the same numbers and both are `ON CONFLICT DO NOTHING`,
-- so whichever runs second is a no-op. A rate that needs CORRECTING is a new
-- migration, not an edit here — by S5 this file is applied and drizzle never
-- re-executes a migration whose journal row exists.
--
-- IDEMPOTENT. `ON CONFLICT (currency_code, year) DO NOTHING` against
-- `fx_rates_currency_year_key`, so a second run, a database that already ran
-- `db:seed`, and a partially populated table all land in the same place.
-- `gen_random_uuid()` is only ever evaluated for a row that is actually
-- inserted, so re-running mints no orphans. Every `currency_code` here is one of
-- the ten `0002` inserts, so the FK is satisfied on any migrated database.
--
-- Hand-authored like every migration here: `drizzle-kit generate` is never run
-- (§0.4, ./README.md) and `meta/_journal.json` carries a hand-written `idx: 8`.

INSERT INTO fx_rates (id, currency_code, year, rate_to_eur) VALUES
  (gen_random_uuid(), 'EUR', '2023', 1),
  (gen_random_uuid(), 'EUR', '2024', 1),
  (gen_random_uuid(), 'EUR', '2025', 1),
  (gen_random_uuid(), 'USD', '2023', 0.92480),
  (gen_random_uuid(), 'USD', '2024', 0.92390),
  (gen_random_uuid(), 'USD', '2025', 0.92500),
  (gen_random_uuid(), 'GBP', '2023', 1.14970),
  (gen_random_uuid(), 'GBP', '2024', 1.18120),
  (gen_random_uuid(), 'GBP', '2025', 1.19000),
  (gen_random_uuid(), 'RSD', '2023', 0.008528),
  (gen_random_uuid(), 'RSD', '2024', 0.008541),
  (gen_random_uuid(), 'RSD', '2025', 0.008540),
  (gen_random_uuid(), 'CHF', '2023', 1.02900),
  (gen_random_uuid(), 'CHF', '2024', 1.04980),
  (gen_random_uuid(), 'CHF', '2025', 1.06500),
  (gen_random_uuid(), 'PLN', '2023', 0.22070),
  (gen_random_uuid(), 'PLN', '2024', 0.23220),
  (gen_random_uuid(), 'PLN', '2025', 0.23600),
  (gen_random_uuid(), 'SEK', '2023', 0.086800),
  (gen_random_uuid(), 'SEK', '2024', 0.087490),
  (gen_random_uuid(), 'SEK', '2025', 0.091000),
  (gen_random_uuid(), 'NOK', '2023', 0.089200),
  (gen_random_uuid(), 'NOK', '2024', 0.085980),
  (gen_random_uuid(), 'NOK', '2025', 0.086000),
  (gen_random_uuid(), 'DKK', '2023', 0.134200),
  (gen_random_uuid(), 'DKK', '2024', 0.134050),
  (gen_random_uuid(), 'DKK', '2025', 0.134000),
  (gen_random_uuid(), 'CZK', '2023', 0.041700),
  (gen_random_uuid(), 'CZK', '2024', 0.039770),
  (gen_random_uuid(), 'CZK', '2025', 0.040000)
ON CONFLICT (currency_code, year) DO NOTHING;
