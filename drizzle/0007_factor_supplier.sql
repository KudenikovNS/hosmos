-- 0007_factor_supplier.sql — `emission_factor` LEARNS WHOSE FACTOR IT IS
-- (CALC-2's `supplier_specific` rung; DM-22, VAL-031, О-18).
--
-- ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
-- CALC-2's top rung is `supplier_specific`: a factor published by the energy
-- supplier itself beats the national grid average, because it describes the
-- product actually bought. Until this migration the table had NO WAY TO SAY
-- WHICH SUPPLIER, so the resolver matched the rung on two facts that say nothing
-- about identity — the activity row names SOME supplier, and the candidate
-- carries `source_name = 'supplier'`. Two consequences, both demonstrated by
-- driving the engine rather than by reading it:
--
--   1. a row naming "Totally Different Utility d.o.o." was priced by a factor
--      published by an unrelated supplier in the same country;
--   2. two RIVAL suppliers' factors both sat on the rung, tied through the whole
--      ladder, and the `publication_date` tie-break silently picked the newer —
--      exactly the "a surviving tie raises, it never picks" rule of CALC-2,
--      broken by a tie-break that has no meaning between two different sellers.
--
-- It was latent only because `legacy-v1` ships zero rows with
-- `source_name = 'supplier'` (`SELECT source_name … GROUP BY 1` on the seeded set
-- returns six statistics agencies and nothing else). `factors.custom` lets an
-- administrator write one, and the moment they did it would price rows for every
-- tenant in that country.
--
-- ── WHY A COLUMN AND NOT A FOREIGN KEY ──────────────────────────────────────
-- There is nothing to point at. `supply_chain_data` (§Q5) is COMPANY-SCOPED
-- disclosure data and is forbidden from touching the carbon formula (D7), while
-- `emission_factor` is reference data shared by every tenant — a shared row
-- cannot carry an FK into one company's table without either leaking that
-- company's suppliers into everybody's factor library or making the library
-- tenant-scoped, and both are larger, worse changes than a text column. So the
-- supplier is identified the way the activity row identifies it: BY NAME
-- (`purchased_energy_activity.supplier` is `text` too). The match is exact after
-- case-folding and whitespace collapsing (`calc/factors.ts`, `normaliseSupplier`)
-- — deliberately NOT fuzzy. A near-miss ("Elektro Ljubljana" vs "Elektro
-- Ljubljana d.o.o.") falls through to the country grid factor, which is a
-- conservative, published, auditable number; a fuzzy match would silently apply
-- one seller's contract to another's electricity, which is the defect above with
-- extra steps.
--
-- ── THE CHECK ───────────────────────────────────────────────────────────────
-- `source_name = 'supplier'` is the value an administrator writes to claim
-- supplier provenance. A row that makes that claim and does not say WHOSE is
-- unusable by construction — the resolver can put it on no rung at all (it is
-- excluded from `site_country`/`global` precisely so an unmatched supplier row
-- cannot serve as a country average). Rather than let such a row be stored and
-- then be invisible, the constraint refuses it at the door. The converse is NOT
-- constrained: a factor may name its supplier while `source_name` carries the
-- publishing authority's own prose, which is how the seed writes provenance.
--
-- ── THE RESOLUTION KEY MUST LEARN IT TOO (VAL-031, О-18) ────────────────────
-- `emission_factor_resolution_key` is CALC-2's resolve key spelled as a unique
-- index: if two rows can answer one question, the calculation is
-- non-deterministic. Two DIFFERENT suppliers now answer two different questions
-- for the same (set, activity, geography, unit, year), so `supplier_name` joins
-- the key — otherwise two competing suppliers who both publish under
-- `source_name='supplier'` with the same `source_version` collide on an index
-- that has no business separating them, and the admin is told VAL-031 about a
-- pair of rows that are not duplicates at all. `COALESCE(supplier_name, '--')`
-- mirrors the sentinel style `unit_conversion` already uses for its nullable
-- key column: Postgres counts NULLs as DISTINCT inside a unique index, so
-- without the COALESCE the 440 supplier-less rows would stop being covered by
-- the key entirely.
--
-- Hand-authored like every migration here (`drizzle-kit generate` is never run,
-- §0.4 / ./README.md) with a hand-written `idx: 7` in `meta/_journal.json`. Each
-- statement is idempotent, and NO ROW OF THE SHIPPED SET MOVES: the column is
-- nullable and `legacy-v1` has no supplier-sourced factor to fill it with.

ALTER TABLE emission_factor
  ADD COLUMN IF NOT EXISTS supplier_name text;

ALTER TABLE emission_factor
  DROP CONSTRAINT IF EXISTS emission_factor_supplier_name_check;
ALTER TABLE emission_factor
  ADD CONSTRAINT emission_factor_supplier_name_check
  CHECK (source_name <> 'supplier' OR supplier_name IS NOT NULL);

DROP INDEX IF EXISTS emission_factor_resolution_key;
CREATE UNIQUE INDEX IF NOT EXISTS emission_factor_resolution_key
  ON emission_factor (
    factor_set_id, source_name, source_version, activity_type, geography,
    input_unit, COALESCE(applicable_year, -1), COALESCE(supplier_name, '--')
  );
