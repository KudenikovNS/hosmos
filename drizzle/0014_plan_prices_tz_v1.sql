-- 0014_plan_prices_tz_v1.sql — THE PRICE LIST CATCHES UP WITH THE PUBLIC PAGE.
--
-- WHAT WAS WRONG. The public page (`/vsme`, ТЗ первой лендинговой страницы
-- v1.0 от 15.08.2026, §7) quotes Starter €300, Pro €1 000, Enterprise €2 000
-- a year excl. VAT. `PLAN_FEATURES` in `src/shared/plans.ts` carried monthly
-- 20 / 100 / 1 000, i.e. annual (×10, §5.2) 200 / 1 000 / 10 000. Only Pro
-- agreed. Nothing tied the two sources together, so a customer could read one
-- price and be invoiced another. Decision of 06.09.2026: the ТЗ is the truth.
-- `PLAN_FEATURES` now says 30 / 100 / 200 a month and the landing's
-- `content.test.ts` asserts `annualPriceEur === price × 10` for every plan.
--
-- WHY A MIGRATION. `plan_prices` reaches production ONLY through migrations —
-- `deploy.yml` never ships `seed.ts` (О-13), and the 0001 fallback INSERT is
-- commented out. The table on the server is therefore either EMPTY or holds
-- the old cents. Both must end at the same eight rows, which is why this is an
-- UPSERT on the natural key `(plan_id, period, currency)` (unique index
-- `plan_prices_plan_period_currency_key`, 0001) and not an UPDATE: an UPDATE
-- against an empty table is a silent no-op.
--
-- `plans` rows are NOT touched — 0004 upserts them and 0006 trims them; this
-- file owns prices only. `id` is generated per row (`gen_random_uuid()` is core
-- since PostgreSQL 13 — the production major, see `.env.example`); on conflict
-- the existing id is kept and only `amount_minor` moves.
--
-- Values are PLAN_FEATURES[id].price × 100 (cents) for monthly and × 10 of that
-- for annual — `plan-prices-migration.test.ts` parses this file and compares it
-- with `PLAN_SEED.prices` so the two renderings cannot drift.
INSERT INTO plan_prices (id, plan_id, period, currency, amount_minor, active)
VALUES
  (gen_random_uuid(), 'trial',      'monthly', 'EUR',      0, true),
  (gen_random_uuid(), 'trial',      'annual',  'EUR',      0, true),
  (gen_random_uuid(), 'starter',    'monthly', 'EUR',   3000, true),
  (gen_random_uuid(), 'starter',    'annual',  'EUR',  30000, true),
  (gen_random_uuid(), 'pro',        'monthly', 'EUR',  10000, true),
  (gen_random_uuid(), 'pro',        'annual',  'EUR', 100000, true),
  (gen_random_uuid(), 'enterprise', 'monthly', 'EUR',  20000, true),
  (gen_random_uuid(), 'enterprise', 'annual',  'EUR', 200000, true)
ON CONFLICT (plan_id, period, currency)
DO UPDATE SET amount_minor = excluded.amount_minor, active = true;
