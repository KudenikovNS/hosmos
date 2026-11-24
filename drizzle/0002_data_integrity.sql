-- 0002_data_integrity.sql — additive; baseline 0000 + billing 0001 untouched.

-- Q1: steam column + verbatim backfill (numbers must not shift, §0.5)
ALTER TABLE monthly_emissions_data
  ADD COLUMN IF NOT EXISTS steam_kwh numeric DEFAULT 0;
UPDATE monthly_emissions_data
  SET steam_kwh = steam_kg
  WHERE steam_kwh IS DISTINCT FROM steam_kg;

-- Q6: audit trail
CREATE TABLE IF NOT EXISTS audit_log (
  id           uuid PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  entity       text NOT NULL,
  entity_id    text,
  action       text NOT NULL,
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz DEFAULT now(),
  CONSTRAINT audit_log_action_check CHECK (action IN ('create','update','delete'))
);
CREATE INDEX IF NOT EXISTS audit_log_company_created_idx
  ON audit_log (company_id, created_at DESC);

-- D8: currency reference + annual FX rates
CREATE TABLE IF NOT EXISTS currencies (
  code     char(3) PRIMARY KEY,
  name     text NOT NULL,
  symbol   text NOT NULL,
  decimals smallint NOT NULL DEFAULT 2
);
-- Seed the supported currencies INLINE, BEFORE the companies FK below: the FK
-- validates existing companies.currency ('EUR') against this table AT MIGRATE TIME,
-- and prod applies 0002 BEFORE re-running seed.ts — so the rows must exist here, not
-- only in the seed. seed.ts keeps the same idempotent upsert (no-op after this).
INSERT INTO currencies (code, name, symbol, decimals) VALUES
  ('EUR','Euro','€',2), ('USD','US Dollar','$',2), ('GBP','Pound Sterling','£',2),
  ('RSD','Serbian Dinar','дин.',2), ('CHF','Swiss Franc','CHF',2),
  ('PLN','Polish Złoty','zł',2), ('SEK','Swedish Krona','kr',2),
  ('NOK','Norwegian Krone','kr',2), ('DKK','Danish Krone','kr',2),
  ('CZK','Czech Koruna','Kč',2)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS fx_rates (
  id            uuid PRIMARY KEY,
  currency_code char(3) NOT NULL REFERENCES currencies(code),
  year          text NOT NULL,
  rate_to_eur   numeric NOT NULL,          -- EUR per 1 unit; EUR → 1.0
  CONSTRAINT fx_rates_currency_year_key UNIQUE (currency_code, year)
);
-- D8: reuse companies.currency as company default; validate + backfill.
-- The backfill + FK run AFTER the INSERT above so every existing companies.currency
-- ('EUR' post-backfill) resolves to a currencies row.
UPDATE companies SET currency = 'EUR' WHERE currency IS NULL;
ALTER TABLE companies
  ADD CONSTRAINT companies_currency_fk FOREIGN KEY (currency) REFERENCES currencies(code);

-- Q3(b)/D8: per-commodity, currency-aware Scope-3 spend (cat 1 & 2)
CREATE TABLE IF NOT EXISTS scope3_spend (
  id            uuid PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  year          text NOT NULL,
  category      smallint NOT NULL,
  commodity_key text NOT NULL,
  spend_amount  numeric NOT NULL DEFAULT 0,
  currency      char(3) NOT NULL DEFAULT 'EUR' REFERENCES currencies(code),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  CONSTRAINT scope3_spend_category_check CHECK (category IN (1,2)),
  CONSTRAINT scope3_spend_company_year_commodity_key UNIQUE (company_id, year, commodity_key)
);

-- optional: speed report reads of the per-category breakdown
CREATE INDEX IF NOT EXISTS scope3_results_company_year_idx
  ON scope3_results (company_id, year);
