-- 0005_drop_legacy.sql — THE FIRST DESTRUCTIVE MIGRATION OF THIS PROJECT
-- (plan T3.9; spec MIG-9 / MIG-11; plan overrides О-1, О-2, О-3).
--
-- 0000–0004 are strictly additive. This one is not: it removes the five tables
-- of the pre-Phase-1 model, whose last consumers were deleted in T3.6 (the
-- spend-based Scope 3 decoupling), T3.7 (the rebuilt dashboard) and T3.8 (the
-- legacy pages, routes, modules and their tests). Nothing in `src/` reads or
-- writes them any more; `src/server/db/schema.ts` loses its declarations in the
-- same commit, so a stray query would not even compile.
--
-- WHY IT IS SAFE TO DROP RATHER THAN ARCHIVE (О-2, risk R-8). There is no data
-- worth keeping: the product is pre-launch and these tables carry only
-- development rows. Reversibility is therefore not a data problem but a code
-- one, and it is stated honestly: BEFORE this migration reaches `main`, a
-- rollback is a redeploy of the previous build (0004 is additive and old code
-- cannot see it); AFTER it, rollback is forward-only — a fix commit — because
-- the tables no longer exist for an older build to fall back on.
--
--   monthly_emissions_data — the wide 12-rows-per-year activity grid; replaced by
--                            `emission_activity` / `purchased_energy_activity`
--                            (0004, append-only rows per period revision).
--   people_data            — the one-row-per-year social form; replaced by
--                            `disclosure_record` against the metric catalogue.
--   emission_results       — the annual result upsert of the legacy engine;
--                            replaced by `calculation` (S5).
--   emission_factors       — the denormalised legacy factor table; replaced by
--   emission_factor_sources  `factor_set` + `emission_factor` (0004, T1.5). The
--                            VALUES survive as code in
--                            `src/server/db/seed-data/legacy-factors.ts`, which
--                            is what factor set `legacy-v1` is built from — that
--                            is precisely why the table can go (О-3).
--
-- NOT DROPPED, and the plan says why (§5, О-8/О-10): `scope3_spend` /
-- `scope3_results` (a live, billable, parked feature — Phase 3), `goals` and
-- `supply_chain_data` (Phase 5 / Phase 3), and `companies.reporting_year`, which
-- still has consumers in `api/scope3-spend` and `api/supply-chain` and dies with
-- the Phase-3 Scope 3 model.
--
-- IDEMPOTENT AND ORDER-FREE. `IF EXISTS` makes a second run a no-op (a warm
-- developer database whose journal already records 0005, or a hand re-run of the
-- file), and `CASCADE` removes the dependent objects the drops would otherwise
-- trip over: the `emission_factors.source_id → emission_factor_sources.id` FK,
-- the hand-written COALESCE unique index on `emission_factors`, and the
-- `companies`/`profiles` FKs of the three wide tables. Nothing OUTSIDE these five
-- tables references them, so CASCADE cannot reach a surviving table — verified
-- against `pg_constraint` before writing this file.
--
-- Hand-authored like every migration here: `drizzle-kit generate` is never run
-- (§0.4, ../drizzle/README.md) and `meta/_journal.json` carries a hand-written
-- `idx: 5` entry.

DROP TABLE IF EXISTS monthly_emissions_data CASCADE;
DROP TABLE IF EXISTS people_data CASCADE;
DROP TABLE IF EXISTS emission_results CASCADE;
DROP TABLE IF EXISTS emission_factors CASCADE;
DROP TABLE IF EXISTS emission_factor_sources CASCADE;
