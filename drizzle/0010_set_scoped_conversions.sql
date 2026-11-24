-- 0010_set_scoped_conversions.sql — A CALORIFIC VALUE BELONGS TO A METHODOLOGY,
-- NOT TO THE WORLD (CALC-3, DM-23, К-24).
--
-- ── THE DEFECT THIS CLOSES, WITH THE ARITHMETIC THAT PROVES IT ──────────────
-- `unit_conversion` held ONE global table with no geography and no factor-set
-- dimension, and its natural-gas calorific rows are DEFRA's UK figures: 11.0342
-- kWh gross per m³, 9.9594 kWh net per m³, gross→net 0.90259. `si-2025` (0009)
-- prices Slovenian gas from ARSO, and Slovenian gas is not British gas. So one
-- kWh on a Slovenian gas bill was priced two different ways depending on which
-- factor the resolver reached:
--
--   via m3      : 0.0906273223251 × 2.0633235 = 0.186993483895…  kgCO2/kWh
--   via kWh_net : 0.90259         × 0.1998    = 0.180337482      kgCO2/kWh
--   disagreement: 3.6909 %
--
-- Both routes are CONTEXTUAL, both are `converted`, both carry publication date
-- 2025-01-01 — so CALC-2's ladder ended in a tie and the run refused with
-- `FACTORS_AMBIGUOUS` (503). That refusal was CORRECT: neither number is the
-- one the source publishes. THE WORKBOOK IS INTERNALLY CONSISTENT AND WE WERE
-- NOT — `2.0633235 / 10.3269444444… = 0.1998`, exactly its own kWh row, where
-- 10.3269444444… kWh/m³ is ARSO's OWN calorific value and not DEFRA's 11.0342.
--
-- ── THE DECISION: BIND CONVERSIONS TO THE FACTOR SET ────────────────────────
-- `unit_conversion` gains a nullable `factor_set_id`. NULL means "shared by
-- every set" — physics (kWh→MWh) and the conventions the shared table already
-- carried. A non-null one belongs to THAT set, and `calc/units.ts` prefers it:
-- the pinned set's rows are consulted first (contextual before universal), then
-- the shared ones (contextual before universal).
--
-- REPRODUCIBILITY IS PRESERVED RATHER THAN COMPROMISED BY THIS. A calorific
-- value IS part of a methodology, methodology is already pinned per period
-- (`reporting_period.factor_set_id`, К-24) and snapshotted per calculation row
-- (DM-29, T5.4), so a locked revision recalculated after this migration still
-- reproduces byte-identically: it reads the conversions of the set it pinned,
-- which are exactly the ones it read before. What was NOT reproducible is the
-- old arrangement, where an edit to the one shared table would have moved
-- numbers under every period of every set at once.
--
-- ON DELETE CASCADE, matching `emission_factor.factor_set_id`: a set's
-- conversions are part of that set, and a conversion outliving the factors it
-- was derived from is a multiplier nothing can check.
--
-- ── THE UNIQUE INDEX IS ONE OF THE PAIRED EIGHT (R-1) ───────────────────────
-- `unit_conversion_from_to_context_key` gains the new column, and
-- `src/server/db/schema.ts` is edited in the same commit — nothing checks the
-- two against each other except `schema-0004.integration.test.ts`, which pins
-- both spellings. The sentinel is the all-zero UUID, exactly as
-- `validation_result_target_key` does for its nullable uuids: the column is
-- nullable and Postgres treats NULLs as DISTINCT, so without it two shared rows
-- for one (from, to, context) would be representable again. WITH it, a pair may
-- hold one shared row and one row per set — which is the point of the column —
-- and never two rows of the same scope, which is what lets `calc/units.ts` take
-- the first match inside a tier with no order to depend on.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE si-2025 CONVERSIONS, AND THE ARITHMETIC THAT PRODUCED EVERY ONE       ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- Source: `workbook/feedback3/Hosmos_ emission factors.xlsx`, sheet `Factors`,
-- the `conversion_to_gj` column — the column 0009 ignored. It is populated on
-- exactly twelve of the ninety-nine rows: the four Slovenian natural-gas rows
-- and the eight IPCC GJ rows (where it is the trivial 1). So the workbook
-- supplies ONE fuel-specific number, and it supplies it four times over:
--
--   unit   conversion_to_gj   factor_value   check: conv × 55.5 kg CO2/GJ
--   Nm³    0.037177           2.0633235      0.037177 × 55.5 = 2.0633235  ✔
--   kWh    0.0036             0.1998         0.0036   × 55.5 = 0.1998     ✔
--   MWh    3.6                199.8          3.6      × 55.5 = 199.8      ✔
--   GJ     1                  55.5           1        × 55.5 = 55.5       ✔
--
-- All four factors are one factor — ARSO's 55.5 kg CO2 per GJ — restated per
-- unit through that unit's ENERGY CONTENT. Two facts fall straight out of it:
--
--   1. ARSO's calorific value of Slovenian natural gas is
--          0.037177 GJ/Nm³ ÷ 0.0036 GJ/kWh = 10.3269444444444… kWh/m³,
--      against DEFRA's 11.0342 gross / 9.9594 net. That is the 3.69 % above.
--   2. THE WORKBOOK'S `kWh` IS A NET-CV kWh. Its energy content is the exact
--      physical 0.0036 GJ, and the factor it multiplies (55.5 kg CO2/GJ) is
--      stated by a source titled "Značilne NETO kalorične vrednosti…". So
--      within `si-2025`, `kWh` and `kWh_net` are ONE quantity under two names,
--      and the conversion between them is exactly ×1 (0.0036 ÷ 0.0036). This is
--      the same kind of statement the shared table already makes with
--      `kWh → kWh_gross ×1` ("a billed kWh is Gross CV (DEFRA convention)") —
--      restated for a set whose whole energy denomination is net.
--
-- ── THE ROW LIST IS A CORRECTION, NEVER A WIDENING ─────────────────────────
-- WHICH EDGES ARE RESTATED IS NOT A JUDGEMENT CALL: it is exactly the shared
-- table's own natural-gas contextual edges, minus the ones this set cannot
-- speak about. `seed-data/unit-conversions.ts` states fourteen; four of them end
-- at or start from `kWh_gross`, which this set has no basis for (see the open
-- edge below); the remaining TEN are restated here from ARSO's energy content
-- instead of DEFRA's.
--
-- The rule matters because of what it FORBIDS. A row this set could not price
-- before must not start being priced now: a conversion carries no year, so an
-- edge that opened a NEW route would let ARSO's 2025 calorific value price a
-- 2024 volume through the year-agnostic IPCC default — quietly undoing the year
-- discipline 0009 built into `applicable_year`. Restating an existing edge
-- cannot do that: within 2025 the calorific value and the factors are the same
-- vintage, and outside 2025 the restated edges lead exactly where the shared
-- ones led, which is nowhere. So `m3 → GJ ×0.037177` — the workbook's own
-- column, verbatim, and the most directly derived number available — is
-- DELIBERATELY NOT HERE: the shared table has no `m3 → GJ` edge, and adding one
-- would price a 2024 Slovenian gas bill in m³ that correctly fails today.
--
-- EVERY MULTIPLIER BELOW IS gj(from) ÷ gj(to) for gj = {m3: 0.037177,
-- kWh: 0.0036, kWh_net: 0.0036, MWh: 3.6, GJ: 1}. Written out beside the shared
-- row each one replaces:
--
--   edge               this set                       the shared row it beats
--   m3      → kWh_net  0.037177/0.0036   = 10.3269444444444…   9.9594
--   m3      → kWh      0.037177/0.0036   = 10.3269444444444…   11.0342
--   kWh     → m3       0.0036/0.037177   =  0.0968340640718724… 0.0906273223251
--   kWh_net → m3       0.0036/0.037177   =  0.0968340640718724… 0.100407655080
--   kWh     → kWh_net  0.0036/0.0036     =  1        (exact)    0.90259
--   kWh_net → kWh      0.0036/0.0036     =  1        (exact)    1.10792275563
--   MWh     → kWh_net  3.6/0.0036        = 1000      (exact)    902.59
--   kWh_net → MWh      0.0036/3.6        =  0.001    (exact)    0.00110792275563
--   GJ      → kWh_net  1/0.0036          = 277.777777777778…    250.719444444444
--   kWh_net → GJ       0.0036/1          =  0.0036   (exact)    0.00398852192025
--
-- The right-hand column is DEFRA's. The first four rows differ by 3.6–6.9% —
-- that is the calorific value alone, Slovenian gas against British. The last six
-- differ by ~10%, because they carry a gross→net step as well, and this set does
-- not take one: on a net-CV methodology a kilowatt-hour is a kilowatt-hour.
--
-- PRECISION: 15 significant digits on the non-terminating ones, three more than
-- the shared table's twelve. It is not decoration — `ROUNDING_DECIMALS` is 6 and
-- a round trip through a reciprocal must not move a figure in the sixth place.
-- Every reversed pair multiplies back to 1 within 4.3 × 10⁻¹⁵.
--
-- ── WHAT A SLOVENIAN GAS BILL IN kWh NOW COMPUTES TO ────────────────────────
-- `kWh → kWh_net` is ×1, so it sits on the `as_entered` rung (1.3.0) and beats
-- every converted route outright — no tie, no 503, and the entered number
-- reaches the factor unchanged:
--
--   1 kWh × 1 × 0.1998 = 0.199800 kgCO2e
--
-- AND THE OTHER ROUTE AGREES, which is the actual repair. Through this set's own
-- calorific value:
--
--   1 kWh × 0.0968340640718724 × 2.0633235 = 0.19980000000000001192… kgCO2e
--
-- i.e. 1.2 × 10⁻¹⁷ from the first, and identical at every one of the six decimal
-- places `ROUNDING_RULE` keeps. The MWh and GJ routes (shared physics, ×0.001
-- and ×0.0036) land on 0.1998 exactly. Four routes, one number — where before
-- two routes differed by 3.69 % and the resolver refused to choose.
--
-- ── SCOPE: NATURAL GAS ONLY, AND WHY ────────────────────────────────────────
-- `conversion_to_gj` is populated for no other fuel. `si-2025`'s other Slovenian
-- factors are per litre or per tonne with no published energy content, so there
-- is nothing to derive and nothing is invented: a Slovenian diesel row entered
-- in kWh has no path and fails `failed_unit`, which is the honest answer (§0.7).
--
-- ONE EDGE STAYS OPEN, NARROWED FROM TWO. 0009's header recorded that natural
-- gas entered in `kWh` OR in `kWh_gross` ties on this set. `kWh` is closed here.
-- `kWh_gross` is NOT, deliberately: ARSO publishes only NET calorific values, so
-- this set has no gross-CV opinion at all, and the two shared routes out of
-- `kWh_gross` (→ m3 at DEFRA's 11.0342, → kWh_net at DEFRA's 0.90259) still tie.
-- Closing it would mean adopting a British ratio into a Slovenian set — the very
-- import 0009 refused when it dropped the 23 United Kingdom rows — so it is
-- left refusing loudly and recorded here rather than papered over. Note that a
-- Slovenian gas invoice says `kWh`, not `kWh_gross`; the open edge is the unit
-- a user picks only by explicitly asserting a calorific basis this set does not
-- publish.
--
-- The 10 rows are named `activity_context = 'natural_gas'` (contextual — a
-- calorific value is a property of the fuel) and `factor_set_id = si-2025`. They
-- do not touch `legacy-v1`: its 440 rows resolve against the shared table
-- exactly as before, which the 440-row self-resolution sweep still asserts.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- `ON CONFLICT DO NOTHING` with no arbiter named, so BOTH the primary key and
-- the (rebuilt) expression unique index are a no-op on a re-run — the same
-- reason 0004's and 0009's blocks name none. Every `id` is a UUIDv5 of
-- `('unit_conversion', from, to, context, 'si-2025')` under
-- `seed-data/derived-id.ts`'s namespace: a pure function of the data, so a
-- second run inserts nothing rather than minting orphans.
--
-- The INSERT is a `SELECT … FROM factor_set WHERE code = 'si-2025'` rather than
-- a literal set id, so it writes nothing at all on a database where 0009 has not
-- run — and it cannot write a dangling FK.
--
-- REFERENCE DATA SHIPS IN A MIGRATION, NEVER IN THE SEED (О-13, MIG-6): the
-- deploy ships `.next/standalone`, `scripts/migrate.mjs` and `drizzle/`, and
-- never `src/server/db/seed.ts`. Hand-authored like every migration here
-- (`drizzle-kit generate` is never run, §0.4 / ./README.md) with a hand-written
-- `idx: 10` in `meta/_journal.json`. `idx: 8` stays reserved for
-- `0008_fx_rates` on its own branch — a migration's number is taken when it is
-- WRITTEN and renumbering one at merge time would change its `when`, which a
-- database that already ran it cannot survive.

ALTER TABLE unit_conversion
  ADD COLUMN IF NOT EXISTS factor_set_id uuid
  REFERENCES factor_set(id) ON DELETE CASCADE;

-- PAIR (R-1): schema.ts `unitConversion`. Rebuilt, not created alongside — the
-- old three-column expression must not survive, or two shared rows for one
-- (from, to, context) become representable the moment a set-scoped row exists.
DROP INDEX IF EXISTS unit_conversion_from_to_context_key;
CREATE UNIQUE INDEX IF NOT EXISTS unit_conversion_from_to_context_key
  ON unit_conversion (
    from_unit,
    to_unit,
    COALESCE(activity_context, '--'),
    COALESCE(factor_set_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

INSERT INTO unit_conversion (
  id, from_unit, to_unit, multiplier, activity_context, factor_set_id, source, notes
)
SELECT v.id::uuid, v.from_unit, v.to_unit, v.multiplier::numeric,
       v.activity_context, s.id, v.source, v.notes
FROM factor_set s
CROSS JOIN (VALUES
  ('9ebac25b-cf4e-5ce0-bf3a-ff9c99846bbe', 'm3', 'kWh_net', '10.3269444444444', 'natural_gas', 'derived from factor set si-2025 (workbook conversion_to_gj)', 'ARSO net CV 10.32694 kWh/m3 = 0.037177 / 0.0036'),
  ('ae928359-b143-57dc-9652-a80d9df6337b', 'm3', 'kWh', '10.3269444444444', 'natural_gas', 'derived from factor set si-2025 (workbook conversion_to_gj)', 'ARSO net CV; in this set a billed kWh IS a net kWh'),
  ('77d1f107-2cda-5ef2-a162-b90e50cb2d52', 'kWh', 'm3', '0.0968340640718724', 'natural_gas', 'derived from factor set si-2025 (workbook conversion_to_gj)', '0.0036 / 0.037177'),
  ('612dbf9e-ed94-5ab6-9164-b36cd2fb6cf4', 'kWh_net', 'm3', '0.0968340640718724', 'natural_gas', 'derived from factor set si-2025 (workbook conversion_to_gj)', '0.0036 / 0.037177'),
  ('9cf9ef99-1e9c-5112-b05a-45ee521caf83', 'kWh', 'kWh_net', '1', 'natural_gas', 'derived from factor set si-2025 (workbook conversion_to_gj)', '0.0036 / 0.0036 — the billed kWh is this set net kWh'),
  ('9da93692-841f-5bd0-9107-801ece1e836a', 'kWh_net', 'kWh', '1', 'natural_gas', 'derived from factor set si-2025 (workbook conversion_to_gj)', '0.0036 / 0.0036 — the billed kWh is this set net kWh'),
  ('367ccf43-38b2-5549-b5f7-b8562432d4ee', 'MWh', 'kWh_net', '1000', 'natural_gas', 'derived from factor set si-2025 (workbook conversion_to_gj)', '3.6 / 0.0036'),
  ('35baac21-8d1a-5c87-9e16-76549f2cba67', 'kWh_net', 'MWh', '0.001', 'natural_gas', 'derived from factor set si-2025 (workbook conversion_to_gj)', '0.0036 / 3.6'),
  ('3074d254-1c12-5174-8ccf-5efa28cf1fb7', 'GJ', 'kWh_net', '277.777777777778', 'natural_gas', 'derived from factor set si-2025 (workbook conversion_to_gj)', '1 / 0.0036'),
  ('874fa86e-88e9-59d8-9110-313665ee7fec', 'kWh_net', 'GJ', '0.0036', 'natural_gas', 'derived from factor set si-2025 (workbook conversion_to_gj)', '0.0036 / 1')
) AS v(id, from_unit, to_unit, multiplier, activity_context, source, notes)
WHERE s.code = 'si-2025'
ON CONFLICT DO NOTHING;
