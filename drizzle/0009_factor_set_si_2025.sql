-- 0009_factor_set_si_2025.sql — A SECOND FACTOR SET, AND THE END OF THE
-- BRITISH DEFAULT.
--
-- WHAT THIS SHIPS. One `factor_set` (`si-2025`) and the 23 `emission_factor`
-- rows it holds, built from the client workbook
-- `workbook/feedback3/Hosmos_ emission factors.xlsx`, sheet `Factors`. It does
-- not touch `legacy-v1`, its 440 rows, or any period that pins it.
--
-- WHY IT IS THE DEFAULT AND WHY THAT IS ONE COLUMN. `resolveFactorSet`
-- (`src/server/periods/periods.ts`) answers "which set does a period with no
-- explicit choice pin?" with `status='active' ORDER BY published_at DESC NULLS
-- LAST, code ASC LIMIT 1`. So "default" is not a flag anywhere — it is the
-- greatest `published_at` among the active sets. `legacy-v1` published at
-- 2026-01-01; this set publishes at 2026-06-01 and therefore becomes the
-- default from the moment this migration lands. Nothing else changes:
-- `legacy-v1` STAYS `active` and is NOT archived or deleted, because every
-- existing period pins it by id (К-24, AC-8) and it must remain explicitly
-- selectable on a new one. It simply stops being what a caller gets by omission.
--
-- ── WHAT WAS LOADED, AND WHAT WAS NOT ───────────────────────────────────────
-- The workbook has 99 data rows. The selection is deliberate and was taken with
-- its consequences on the table:
--
--   * 45 Scope-3 rows are NOT loaded. Phase 1 stores `scope3_category` as
--     always NULL and the engine computes Scope 1/2 only.
--   * 8 rows with no `factor_value` are NOT loaded. They are method
--     descriptions, not factors — their "units" are sentences ("same as Scope
--     1/2", "t CO2e + financial/ownership data").
--   * 23 rows whose `geography_name` is "United Kingdom (fallback)" are NOT
--     loaded. THIS IS THE POINT OF THE SET. Loading them would have carried
--     coverage from 6 activity types to a great many more, at the price of
--     printing a British number under a Slovenian company's name. A report that
--     refuses with `failed_missing_factor` is the intended outcome for a fuel
--     this set does not price; see the coverage note below.
--
-- That leaves 30 rows (15 Slovenia, 13 International, 2 with no geography).
-- SEVEN OF THE THIRTY ARE NOT HERE, because `emission_factor.activity_type` must
-- be a value the input forms actually produce — `FUEL_TYPES`, `VEHICLE_TYPES`,
-- `REFRIGERANT_TYPES`, `PROCESS_TYPES` in `src/shared/enums/activities.ts`, the
-- vocabularies `inventory/_lib/tabs.ts` builds its selects from. A factor filed
-- under anything else is unreachable and is decoration, which in a factor set is
-- worse than absence: it makes the set look complete. Inventing a literal is a
-- change to the enum, to this migration AND to the UI, and is not this
-- migration's business (§0.8's order is "seed the factor rows, then add the
-- literal" — the literal is what is missing, so neither half is done here).
-- The seven, named so the gap is in the tree and not only in a review comment:
--
--   row 15  Бурый уголь (импорт)      lignite, 1816.29 kg CO2/t — `FUEL_TYPES`
--           has `coal_industrial` and `coal_domestic`, and neither is lignite.
--           Filing 1816 under `coal_domestic` would price household anthracite
--           at brown coal's carbon.
--   row 16  Кокс                       coke, 3135.1 kg CO2/t — no coal-derived
--           solid fuel in `FUEL_TYPES` is coke.
--   row 53  Lignite — IPCC default     101 kg CO2/GJ, same gap as row 15.
--   row 54  Coke Oven Coke — IPCC      107 kg CO2/GJ, same gap as row 16.
--   row 43  HFC-125                    3170 kg CO2e/kg — `REFRIGERANT_TYPES`
--           carries 14 gases and R-125 is not one of them.
--   rows 27, 28  the two blank-geography rows. They are "any owned/controlled
--           diesel / petrol vehicle or machinery", priced PER LITRE. Every one
--           of the 36 `VEHICLE_TYPES` resolves on `km`; the model has no
--           litre-denominated mobile activity type, and `emission_activity` has
--           no column that could carry one. Their VALUES are byte-identical to
--           rows 8 and 9 (2.6673777 and 2.33733655, same ARSO document), so
--           loading them under `gas_oil`/`petrol_mineral` at SI would put two
--           indistinguishable candidates on one resolve key — a guaranteed
--           runtime `FACTORS_AMBIGUOUS` — and loading them at `GLOBAL` would
--           publish a Slovenian number as an international default. The
--           coverage they intend is already in the set, as rows 8 and 9.
--
-- ── THE MAPPING, AND WHERE IT WAS TAKEN FROM ────────────────────────────────
-- The workbook labels an activity in mixed Russian/English and puts the fuel in
-- a second column; CALC-2 resolves on EQUALITY over
-- `(activity_type, geography, input_unit, applicable_year)`. Each row was mapped
-- onto the enum literal the corresponding form emits:
--
--   Стационарное сжигание + fuel  → `FUEL_TYPES`      (tabs `stationary`/`onsite`)
--   Утечки хладагентов    + gas   → `REFRIGERANT_TYPES` (tab `fugitive`)
--   Location-based (electricity)  → `grid:grid_electricity`
--   Market-based   (electricity)  → `grid:residual_mix`
--
-- The two Scope-2 spellings are NOT invented here: they are
-- `LOCATION_ACTIVITY_TYPES` and `RESIDUAL_MIX_ACTIVITY_TYPES` in
-- `src/server/calc/scope2.ts`. `grid:residual_mix` is the row that module says
-- outright the shipped set does not carry yet — the AGEN-RS "preostala sestava
-- proizvodnih virov" IS a residual mix, so this set is the first to reach the
-- `residual_mix` rung of the market-based ladder instead of falling to
-- `grid_average`.
--
-- UNITS are `UNIT_CODES`, not the workbook's spellings: `Nm³`→`m3`, `t`→`t`,
-- `L`→`L`, `kg`→`kg`, `MWh`/`GJ`/`kWh` as themselves. The one judgement is the
-- natural-gas `kWh` row, which is filed as `kWh_net`: the ARSO source is
-- literally titled "Značilne NETO kalorične vrednosti", 55.5 kg CO2/GJ × 0.0036
-- = 0.1998 kg CO2/kWh is the same number restated, and `unit_conversion` defines
-- plain `kWh` as GROSS CV ("a billed kWh is Gross CV (DEFRA convention)").
-- Filing a net-calorific number under the gross code would understate every
-- Slovenian gas bill by about 10% with nothing looking wrong. See the known
-- sharp edge at the bottom of this header.
--
-- ── GEOGRAPHY ───────────────────────────────────────────────────────────────
-- `Slovenia` → `SI` (ISO-3166 alpha-2, what `facility.country_code` holds and
-- what CALC-2's `site_country` rung matches). `International` → `GLOBAL`, DM-22's
-- "no country in particular" and the value CALC-2's third rung is defined by.
-- Blank geography does not appear: the only two blank rows are 27/28 above.
--
-- ── DATES: WHY `publication_date` IS SET AND `valid_from`/`valid_to` ARE NOT ──
-- EVERY ROW CARRIES A `publication_date`, and that is load-bearing. All 440 rows
-- of `legacy-v1` have a NULL one, so within THAT set CALC-2's last tie-break is
-- vacuous. A set that mixed dated and undated rows on one resolution key would
-- have the dated row win every tie for a reason nobody chose. This set has 23
-- rows and all 23 are dated, from the source's own vintage — 2025-01-01 for the
-- Slovenian sources, 2026-01-01 for DESNZ, 2006-01-01 for the IPCC guidelines.
--
-- `valid_from`/`valid_to` stay NULL, exactly as they are on all 440 rows of
-- `legacy-v1`, and NOT because the workbook has no dates — it has them, and
-- copying them verbatim would have broken the set. CALC-2 judges that window
-- against the reporting period's END DATE. Verbatim, the eight IPCC rows would
-- have been valid only during calendar 2006 and the five refrigerant rows only
-- during 2026, so a 2025 period would have resolved neither. The year dimension
-- of a factor is `applicable_year` (О-18), which is where it is expressed:
--
--   * the 13 Slovenian rows are `applicable_year = 2025`. ARSO/AGEN/AIB publish
--     a table PER YEAR and an electricity mix is a measurement of one year, so
--     a 2024 period must not silently be priced with the 2025 number
--     (`yearRank` returns -1 and the candidate is not eligible at all).
--   * the 4 refrigerant rows and the 6 IPCC rows are `applicable_year = NULL`.
--     A GWP does not depend on a year (О-18 — `legacy-v1` treats the same 14
--     gases the same way) and an IPCC default carbon content is a constant of
--     the fuel, not a measurement of 2006. NULL means "competes for every year
--     and loses to an exact match", which is precisely the intent: a Slovenian
--     site reporting 2025 gets the ARSO number; the same site reporting a year
--     ARSO is not loaded for falls to the IPCC default at the `global` rung
--     rather than to nothing. That fallback is the geography ladder doing its
--     documented job with rows the client chose, not a widening of the set.
--
-- ── GASES ───────────────────────────────────────────────────────────────────
-- The workbook's `gas` column is CO2 on the 19 combustion/electricity rows and
-- CO2e on the 4 refrigerants. `output_unit` is `kgCO2e` on ALL 23 — it is the
-- unit `calculation.co2e_result` is summed in, and a second output unit inside
-- one set would silently add two different quantities. The distinction is
-- carried where DM-22 puts it: `co2_value` = `factor_value` on the 19 CO2-only
-- rows (all of this factor is CO2; the source states no CH4 or N2O), and NULL on
-- the 4 refrigerants, whose value is already a GWP-weighted aggregate.
-- `gwp_basis` is `AR5` set-wide as on `legacy-v1`; it is load-bearing only on
-- the four refrigerants, and it was CHECKED — 677 / 1300 / 3943 / 1924 are the
-- AR5 GWP-100 values for HFC-32, HFC-134a, R-404A and R-410A (AR6 would be 771,
-- 1526, …). `wtt_included` is false: none of these bundles well-to-tank.
-- `source_locator` carries the workbook's own `source_id`, so any row here can
-- be grepped back to the sheet it came from.
--
-- ── COVERAGE, STATED OUT LOUD ───────────────────────────────────────────────
-- `legacy-v1` prices 163 distinct `activity_type` values. THIS SET PRICES 14:
--   natural_gas, gas_oil, petrol_mineral, fuel_oil, lpg, propane, butane,
--   coal_industrial, r32, r134a, r404a, r410a,
--   grid:grid_electricity, grid:residual_mix.
-- A company pinned to `si-2025` that burns wood, coal (domestic), burning oil,
-- diesel/petrol blends, or runs any fleet priced per kilometre, or leaks any of
-- the other ten refrigerants, WILL get `calculation_status='failed_missing_factor'`,
-- the run will be `failed`, no total will be published and approve/render/lock
-- will be blocked (§0.7, AC-6). That is the intended behaviour and the reason
-- the UK rows were left out. `legacy-v1` remains active and can be selected on
-- the period for a company that needs the wider library.
--
-- ── ONE KNOWN SHARP EDGE ────────────────────────────────────────────────────
-- Natural gas entered in plain `kWh` or in `kWh_gross` at a Slovenian site
-- resolves to a TIE between the `m3` row and the `kWh_net` row — both are
-- reachable contextually through the seeded calorific conversions, both carry
-- the same publication date, and CALC-2 raises `FACTORS_AMBIGUOUS` (503) rather
-- than picking one. This is loud, not silent, and it is the SAME defect
-- `legacy-v1` already ships: natural gas entered in `kWh` ties `m3` against
-- `kWh_net` there too (verified against the real 440 rows). Closing it needs
-- either a Slovenian gross-CV gas row that this workbook does not contain, or a
-- change to the shared `unit_conversion` table, which would move numbers under
-- every period already pinned to `legacy-v1`. Neither belongs in this migration.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- `ON CONFLICT (code) DO NOTHING` on the set; `ON CONFLICT DO NOTHING` with no
-- arbiter named on the factors, so that BOTH the primary key and the VAL-031
-- unique index `emission_factor_resolution_key` are a no-op on a re-run (the
-- same reason 0004's block names none). Every `id` is a UUIDv5 of the row's
-- natural key under `seed-data/derived-id.ts`'s namespace, derived with exactly
-- the components `legacy-v1` uses — so the ids are a pure function of the data
-- and a second run inserts nothing rather than minting orphans.
--
-- REFERENCE DATA SHIPS IN A MIGRATION, NEVER IN THE SEED (О-13, MIG-6, and
-- 0008's restatement of the same lesson): `deploy.yml` ships `.next/standalone`,
-- `scripts/migrate.mjs` and `drizzle/`, and neither `src/server/db/seed.ts` nor
-- `tsx` ever reaches the server. A factor set that lived only in the seed is a
-- factor set production never has.
--
-- Hand-authored like every migration here: `drizzle-kit generate` is never run
-- (§0.4, ./README.md) and `meta/_journal.json` carries a hand-written `idx: 9`.
-- The gap at `idx: 8` is deliberate — `0008_fx_rates.sql` is on its own branch
-- and this file must not take its number.

INSERT INTO factor_set (
  id, code, name, description, status, published_at
) VALUES
  ('6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'si-2025', 'Slovenia 2025', 'National Slovenian factors (ARSO 2025 fuels, AIB 2025 production mix, AGEN-RS 2025 residual mix) with IPCC 2006 defaults and DESNZ 2026 refrigerant GWPs as the international fallback. Deliberately carries NO United Kingdom rows: a fuel it does not price fails loudly rather than being priced with a British number.', 'active', '2026-06-01T00:00:00Z')
ON CONFLICT (code) DO NOTHING;

INSERT INTO emission_factor (
  id, factor_set_id, factor_code, factor_name, source_name, source_version, publication_date, applicable_year, geography, activity_type, input_unit, factor_value, output_unit, co2_value, gwp_basis, wtt_included, source_url, source_locator, licence, status
) VALUES
  ('f48fe0fb-2760-5cdf-9c4f-a2f26c7623a2', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'arso_si_2025_natural_gas_nm3', 'Natural gas', 'Slovenian Environment Agency (ARSO)', 'Značilne neto kalorične vrednosti in emisijski faktorji 2025', '2025-01-01', 2025, 'SI', 'natural_gas', 'm3', '2.0633235', 'kgCO2e', '2.0633235', 'AR5', false, 'https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf', 'SRC_ARSO_SI_2025', 'unspecified', 'active'),
  ('1fb98f1d-7c9a-5381-bb26-eebad304882c', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'arso_si_2025_natural_gas_kwh_net', 'Natural gas', 'Slovenian Environment Agency (ARSO)', 'Značilne neto kalorične vrednosti in emisijski faktorji 2025', '2025-01-01', 2025, 'SI', 'natural_gas', 'kWh_net', '0.1998', 'kgCO2e', '0.1998', 'AR5', false, 'https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf', 'SRC_ARSO_SI_2025', 'unspecified', 'active'),
  ('772d7329-63b6-501c-b848-fcb38456ee70', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'arso_si_2025_natural_gas_mwh', 'Natural gas', 'Slovenian Environment Agency (ARSO)', 'Značilne neto kalorične vrednosti in emisijski faktorji 2025', '2025-01-01', 2025, 'SI', 'natural_gas', 'MWh', '199.8', 'kgCO2e', '199.8', 'AR5', false, 'https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf', 'SRC_ARSO_SI_2025', 'unspecified', 'active'),
  ('512edf9c-008a-5514-a6b2-1fd64e12c640', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'arso_si_2025_natural_gas_gj', 'Natural gas', 'Slovenian Environment Agency (ARSO)', 'Značilne neto kalorične vrednosti in emisijski faktorji 2025', '2025-01-01', 2025, 'SI', 'natural_gas', 'GJ', '55.5', 'kgCO2e', '55.5', 'AR5', false, 'https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf', 'SRC_ARSO_SI_2025', 'unspecified', 'active'),
  ('6ffa3551-388c-553f-b137-60d3d2290a1c', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'arso_si_2025_gas_oil_litre', 'Diesel / gas oil', 'Slovenian Environment Agency (ARSO)', 'Značilne neto kalorične vrednosti in emisijski faktorji 2025', '2025-01-01', 2025, 'SI', 'gas_oil', 'L', '2.6673777', 'kgCO2e', '2.6673777', 'AR5', false, 'https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf', 'SRC_ARSO_SI_2025', 'unspecified', 'active'),
  ('b61da9de-86aa-556d-9f31-9e53c9cadbdb', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'arso_si_2025_petrol_litre', 'Petrol (motor gasoline)', 'Slovenian Environment Agency (ARSO)', 'Značilne neto kalorične vrednosti in emisijski faktorji 2025', '2025-01-01', 2025, 'SI', 'petrol_mineral', 'L', '2.33733655', 'kgCO2e', '2.33733655', 'AR5', false, 'https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf', 'SRC_ARSO_SI_2025', 'unspecified', 'active'),
  ('30bb5321-81fd-5975-b39f-0511d8ee9c93', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'arso_si_2025_fuel_oil_tonne', 'Heating oil (residual fuel oil)', 'Slovenian Environment Agency (ARSO)', 'Značilne neto kalorične vrednosti in emisijski faktorji 2025', '2025-01-01', 2025, 'SI', 'fuel_oil', 't', '3205.908', 'kgCO2e', '3205.908', 'AR5', false, 'https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf', 'SRC_ARSO_SI_2025', 'unspecified', 'active'),
  ('02913857-1c95-527a-a285-753f2966826e', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'arso_si_2025_lpg_tonne', 'LPG mixture (~60% propane)', 'Slovenian Environment Agency (ARSO)', 'Značilne neto kalorične vrednosti in emisijski faktorji 2025', '2025-01-01', 2025, 'SI', 'lpg', 't', '2991.89', 'kgCO2e', '2991.89', 'AR5', false, 'https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf', 'SRC_ARSO_SI_2025', 'unspecified', 'active'),
  ('211e3925-667a-5c5a-90f4-e81c577128ef', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'arso_si_2025_propane_tonne', 'Propane', 'Slovenian Environment Agency (ARSO)', 'Značilne neto kalorične vrednosti in emisijski faktorji 2025', '2025-01-01', 2025, 'SI', 'propane', 't', '2983.52', 'kgCO2e', '2983.52', 'AR5', false, 'https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf', 'SRC_ARSO_SI_2025', 'unspecified', 'active'),
  ('5a5b9225-1218-5411-8e71-c6fc237ce779', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'arso_si_2025_butane_tonne', 'Butane', 'Slovenian Environment Agency (ARSO)', 'Značilne neto kalorične vrednosti in emisijski faktorji 2025', '2025-01-01', 2025, 'SI', 'butane', 't', '3007.06', 'kgCO2e', '3007.06', 'AR5', false, 'https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf', 'SRC_ARSO_SI_2025', 'unspecified', 'active'),
  ('79791f67-5427-570c-a4ec-7e5ffcd13027', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'arso_si_2025_coal_industrial_tonne', 'Hard coal', 'Slovenian Environment Agency (ARSO)', 'Značilne neto kalorične vrednosti in emisijski faktorji 2025', '2025-01-01', 2025, 'SI', 'coal_industrial', 't', '2440.68', 'kgCO2e', '2440.68', 'AR5', false, 'https://www.gov.si/assets/ministrstva/MOPE/Podnebje/Za-ARSO/Znacilne-neto-kaloricne-vrednosti-in-emisijski-faktorji-za-leto-2025.pdf', 'SRC_ARSO_SI_2025', 'unspecified', 'active'),
  ('c35144d8-87ba-5dda-b84a-27b23c328d87', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'aib_si_2025_grid_electricity', 'Grid electricity — Slovenia (production mix)', 'Association of Issuing Bodies (AIB)', 'European Residual Mixes 2025', '2025-01-01', 2025, 'SI', 'grid:grid_electricity', 'kWh', '0.15783', 'kgCO2e', '0.15783', 'AR5', false, 'https://www.aib-net.org/sites/default/files/assets/eecs/Residual%20Mix/AIB_2025_Residual_Mix_Final%20Results_%2026052026.pdf', 'SRC_AIB_2025', 'unspecified', 'active'),
  ('5cd94bd8-50d2-53cc-8527-2119f38ab78c', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'agen_si_2025_residual_mix', 'Grid electricity — Slovenia (residual mix)', 'Energy Agency of the Republic of Slovenia (AGEN-RS)', 'Preostala sestava proizvodnih virov 2025', '2025-01-01', 2025, 'SI', 'grid:residual_mix', 'kWh', '0.463', 'kgCO2e', '0.463', 'AR5', false, 'https://www.agen-rs.si/documents/10926/17445/Preostala-sestava-proizvodnih-virov-2025_1/8149799f-1e7a-4c72-81df-25e724f040de', 'SRC_AGEN_SI_2025', 'unspecified', 'active'),
  ('16239f61-03bc-5750-a20e-dc91d3a973b1', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'desnz_2026_r32', 'HFC-32', 'UK Department for Energy Security and Net Zero (DESNZ)', 'GHG Conversion Factors for Company Reporting 2026', '2026-01-01', NULL, 'GLOBAL', 'r32', 'kg', '677', 'kgCO2e', NULL, 'AR5', false, 'https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026', 'SRC_DESNZ_2026', 'unspecified', 'active'),
  ('274a9b93-2996-5614-bff5-02f12f0f42e2', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'desnz_2026_r134a', 'HFC-134a', 'UK Department for Energy Security and Net Zero (DESNZ)', 'GHG Conversion Factors for Company Reporting 2026', '2026-01-01', NULL, 'GLOBAL', 'r134a', 'kg', '1300', 'kgCO2e', NULL, 'AR5', false, 'https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026', 'SRC_DESNZ_2026', 'unspecified', 'active'),
  ('7ccfb1b9-9fc7-5f60-8492-0b49744bf4d4', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'desnz_2026_r404a', 'R-404A', 'UK Department for Energy Security and Net Zero (DESNZ)', 'GHG Conversion Factors for Company Reporting 2026', '2026-01-01', NULL, 'GLOBAL', 'r404a', 'kg', '3943', 'kgCO2e', NULL, 'AR5', false, 'https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026', 'SRC_DESNZ_2026', 'unspecified', 'active'),
  ('1fcf470b-0207-5c9f-8b75-389f15f2c654', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'desnz_2026_r410a', 'R-410A', 'UK Department for Energy Security and Net Zero (DESNZ)', 'GHG Conversion Factors for Company Reporting 2026', '2026-01-01', NULL, 'GLOBAL', 'r410a', 'kg', '1924', 'kgCO2e', NULL, 'AR5', false, 'https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026', 'SRC_DESNZ_2026', 'unspecified', 'active'),
  ('8b085214-6096-5035-9a7d-73acc7c3a99a', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'ipcc_2006_natural_gas', 'Natural gas — IPCC default', 'Intergovernmental Panel on Climate Change (IPCC)', '2006 IPCC Guidelines for National Greenhouse Gas Inventories, Volume 2, Chapter 2', '2006-01-01', NULL, 'GLOBAL', 'natural_gas', 'GJ', '56.1', 'kgCO2e', '56.1', 'AR5', false, 'https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_2_Ch2_Stationary_Combustion.pdf', 'SRC_IPCC_2006', 'unspecified', 'active'),
  ('72cd8c44-e5c7-562e-81b1-8e566a310ce6', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'ipcc_2006_gas_diesel_oil', 'Gas/diesel oil — IPCC default', 'Intergovernmental Panel on Climate Change (IPCC)', '2006 IPCC Guidelines for National Greenhouse Gas Inventories, Volume 2, Chapter 2', '2006-01-01', NULL, 'GLOBAL', 'gas_oil', 'GJ', '74.1', 'kgCO2e', '74.1', 'AR5', false, 'https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_2_Ch2_Stationary_Combustion.pdf', 'SRC_IPCC_2006', 'unspecified', 'active'),
  ('49a1c3bd-23ca-5e6a-be67-5223fd94b8a7', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'ipcc_2006_motor_gasoline', 'Motor gasoline — IPCC default', 'Intergovernmental Panel on Climate Change (IPCC)', '2006 IPCC Guidelines for National Greenhouse Gas Inventories, Volume 2, Chapter 2', '2006-01-01', NULL, 'GLOBAL', 'petrol_mineral', 'GJ', '69.3', 'kgCO2e', '69.3', 'AR5', false, 'https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_2_Ch2_Stationary_Combustion.pdf', 'SRC_IPCC_2006', 'unspecified', 'active'),
  ('b7130e58-3659-5765-beb9-88bdd3d88c18', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'ipcc_2006_residual_fuel_oil', 'Residual fuel oil — IPCC default', 'Intergovernmental Panel on Climate Change (IPCC)', '2006 IPCC Guidelines for National Greenhouse Gas Inventories, Volume 2, Chapter 2', '2006-01-01', NULL, 'GLOBAL', 'fuel_oil', 'GJ', '77.4', 'kgCO2e', '77.4', 'AR5', false, 'https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_2_Ch2_Stationary_Combustion.pdf', 'SRC_IPCC_2006', 'unspecified', 'active'),
  ('8ba787b5-84a0-5b96-97f1-385b071c7c6c', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'ipcc_2006_lpg', 'Liquefied petroleum gases — IPCC default', 'Intergovernmental Panel on Climate Change (IPCC)', '2006 IPCC Guidelines for National Greenhouse Gas Inventories, Volume 2, Chapter 2', '2006-01-01', NULL, 'GLOBAL', 'lpg', 'GJ', '63.1', 'kgCO2e', '63.1', 'AR5', false, 'https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_2_Ch2_Stationary_Combustion.pdf', 'SRC_IPCC_2006', 'unspecified', 'active'),
  ('e47265eb-ad86-5268-ba10-7f854b2790c8', '6ab4a62c-097e-5835-ae1b-c75c60ddf449', 'ipcc_2006_other_bituminous_coal', 'Other bituminous coal — IPCC default', 'Intergovernmental Panel on Climate Change (IPCC)', '2006 IPCC Guidelines for National Greenhouse Gas Inventories, Volume 2, Chapter 2', '2006-01-01', NULL, 'GLOBAL', 'coal_industrial', 'GJ', '94.6', 'kgCO2e', '94.6', 'AR5', false, 'https://www.ipcc-nggip.iges.or.jp/public/2006gl/pdf/2_Volume2/V2_2_Ch2_Stationary_Combustion.pdf', 'SRC_IPCC_2006', 'unspecified', 'active')
ON CONFLICT DO NOTHING;
