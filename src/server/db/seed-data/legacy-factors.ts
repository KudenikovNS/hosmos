/**
 * Legacy emission-factor seed data — the 9 reference arrays, verbatim.
 *
 * MOVED HERE UNCHANGED from `src/server/db/seed.ts` (T1.3, plan О-3). Not a
 * rewrite: every tuple, every value string, every comment below is byte-for-byte
 * what `seed.ts` held.
 *
 * WHY THEY LIVE IN A MODULE OF THEIR OWN. The Phase-1 `factor_set` v1 seed
 * (T1.5) builds `emission_factor` FROM THIS DATA and never read the legacy
 * `emission_factors` TABLE — which is what let T3.9 `DROP TABLE` it (migration
 * `0005_drop_legacy.sql`) without taking the factor values with it. The data is
 * code; the table was a consumer, and it is gone.
 *
 * THIS FILE IS NOW THE SOURCE OF TRUTH FOR THE VALUES. They arrived as a 1:1
 * TypeScript port of the pre-drizzle Supabase factor seed (`002_seed_emission_factors`
 * + `003_factors_country_year` §5 for `s3_c7_rail`); that whole migration tree was
 * deleted in T3.9 along with the tables it created, so there is no upstream file
 * to diff against any more — a correction is made here, and reaches the database
 * as a NEW factor set (DM-21), never as an edit to `legacy-v1`.
 *
 * The legacy `factor_key`/`unit` strings here are NOT the Phase-1 domain
 * vocabulary. `./legacy-normalisation.ts` is the single place that decomposes
 * them into `(activity_type, input_unit)` per the contract in
 * `src/shared/enums/activities.ts`; T1.5 must use that helper rather than
 * re-deriving the mapping.
 */
export type SourceCode =
  | "DEFRA"
  | "AIB"
  | "IPCC_AR5"
  | "IEA"
  | "EXIOBASE"
  | "ECOACT"
  | "NATIONAL_STATS";

// ─── 1. Emission factor sources ──────────────────────────────────────────────
export const SOURCES: Array<{
  code: SourceCode;
  name: string;
  authority: string;
  publication: string;
  versionYear: number;
  notes: string;
}> = [
  {
    code: "DEFRA",
    name: "UK Government GHG Conversion Factors",
    authority: "UK Department for Energy Security and Net Zero (DESNZ)",
    publication: "GHG Conversion Factors for Company Reporting",
    versionYear: 2024,
    notes: "DEFRA/DESNZ 2024-2025 factors for Scope 1, 2, 3",
  },
  {
    code: "AIB",
    name: "European Residual Mix",
    authority: "Association of Issuing Bodies (AIB)",
    publication: "European Residual Mixes",
    versionYear: 2024,
    notes: "AIB Residual Mix 2023-2024 for market-based Scope 2",
  },
  {
    code: "IPCC_AR5",
    name: "IPCC Fifth Assessment Report",
    authority: "Intergovernmental Panel on Climate Change",
    publication: "AR5 Working Group I",
    versionYear: 2014,
    notes: "GWP-100 values for refrigerants and greenhouse gases",
  },
  {
    code: "IEA",
    name: "IEA Emission Factors",
    authority: "International Energy Agency",
    publication: "IEA CO2 Emissions from Fuel Combustion",
    versionYear: 2024,
    notes: "Steam and cooling factors from IEA data",
  },
  {
    code: "EXIOBASE",
    name: "Exiobase MRIO Database",
    authority: "Exiobase Consortium",
    publication: "Exiobase v3",
    versionYear: 2024,
    notes: "Multi-regional input-output model for spend-based Scope 3 factors",
  },
  {
    code: "ECOACT",
    name: "EcoAct Research",
    authority: "EcoAct",
    publication: "Homeworking Emissions Whitepaper",
    versionYear: 2024,
    notes: "Work from home emission factors",
  },
  {
    code: "NATIONAL_STATS",
    name: "National Statistics Agencies",
    authority: "Various national energy/statistics agencies",
    publication: "National energy statistics and reports",
    versionYear: 2024,
    notes:
      "E-Control AT, AGFW/UBA DE, Danish Energy Agency, Energiateollisuus FI, SCB/Energimyndigheten SE, SSB NO, URE/GUS PL, ERU CZ, ARSO SI, EIHP HR, SNCU/ADEME FR, RVO NL, AIRU/GSE IT, Elering/StatEE, LSTA LT, CSP LV, NSI BG, ANRE RO, RZS RS, Euroheat",
  },
];

// ─── 2. Stationary fuel — [factorId, name, unit, [[year, kgCo2e], ...]] (DEFRA) ─
export const STATIONARY: Array<
  [string, string, string, Array<[string, string]>]
> = [
  [
    "natural_gas_kwh_gross",
    "Natural Gas",
    "kWh (Gross CV)",
    [
      ["2023", "0.18316"],
      ["2024", "0.18290"],
      ["2025", "0.18296"],
    ],
  ],
  [
    "natural_gas_kwh_net",
    "Natural Gas",
    "kWh (Net CV)",
    [
      ["2023", "0.20297"],
      ["2024", "0.20260"],
      ["2025", "0.20270"],
    ],
  ],
  [
    "natural_gas_m3",
    "Natural Gas",
    "m³",
    [
      ["2023", "2.021"],
      ["2024", "2.018"],
      ["2025", "2.019"],
    ],
  ],
  [
    "gas_oil_litre",
    "Gas Oil (Diesel)",
    "litre",
    [
      ["2023", "2.75776"],
      ["2024", "2.75660"],
      ["2025", "2.75541"],
    ],
  ],
  [
    "diesel_biofuel_litre",
    "Diesel (avg biofuel blend)",
    "litre",
    [
      ["2023", "2.51210"],
      ["2024", "2.51279"],
      ["2025", "2.57082"],
    ],
  ],
  [
    "diesel_mineral_litre",
    "Diesel (100% mineral)",
    "litre",
    [
      ["2023", "2.66300"],
      ["2024", "2.66200"],
      ["2025", "2.66155"],
    ],
  ],
  [
    "petrol_biofuel_litre",
    "Petrol (avg biofuel blend)",
    "litre",
    [
      ["2023", "2.08480"],
      ["2024", "2.08390"],
      ["2025", "2.06916"],
    ],
  ],
  [
    "petrol_mineral_litre",
    "Petrol (100% mineral)",
    "litre",
    [
      ["2023", "2.34070"],
      ["2024", "2.34000"],
      ["2025", "2.33984"],
    ],
  ],
  [
    "lpg_litre",
    "LPG",
    "litre",
    [
      ["2023", "1.55780"],
      ["2024", "1.55750"],
      ["2025", "1.55713"],
    ],
  ],
  [
    "lpg_kwh",
    "LPG",
    "kWh (Gross CV)",
    [
      ["2023", "0.21460"],
      ["2024", "0.21455"],
      ["2025", "0.21450"],
    ],
  ],
  [
    "lpg_tonne",
    "LPG",
    "tonne",
    [
      ["2023", "2939.50"],
      ["2024", "2939.42"],
      ["2025", "2939.36"],
    ],
  ],
  [
    "coal_industrial_tonne",
    "Coal (industrial)",
    "tonne",
    [
      ["2023", "2396.10"],
      ["2024", "2395.70"],
      ["2025", "2395.29"],
    ],
  ],
  [
    "coal_domestic_tonne",
    "Coal (domestic)",
    "tonne",
    [
      ["2023", "2905.50"],
      ["2024", "2905.20"],
      ["2025", "2904.95"],
    ],
  ],
  [
    "fuel_oil_litre",
    "Fuel Oil",
    "litre",
    [
      ["2023", "3.17600"],
      ["2024", "3.17550"],
      ["2025", "3.17492"],
    ],
  ],
  [
    "fuel_oil_tonne",
    "Fuel Oil",
    "tonne",
    [
      ["2023", "3229.50"],
      ["2024", "3229.20"],
      ["2025", "3228.89"],
    ],
  ],
  [
    "burning_oil_litre",
    "Burning Oil / Kerosene",
    "litre",
    [
      ["2023", "2.54100"],
      ["2024", "2.54060"],
      ["2025", "2.54016"],
    ],
  ],
  [
    "butane_litre",
    "Butane",
    "litre",
    [
      ["2023", "1.74600"],
      ["2024", "1.74570"],
      ["2025", "1.74533"],
    ],
  ],
  [
    "propane_litre",
    "Propane",
    "litre",
    [
      ["2023", "1.54420"],
      ["2024", "1.54390"],
      ["2025", "1.54358"],
    ],
  ],
  [
    "wood_pellets_tonne",
    "Wood Pellets (biomass)",
    "tonne",
    [
      ["2023", "55.30"],
      ["2024", "55.25"],
      ["2025", "55.19"],
    ],
  ],
  [
    "wood_chips_tonne",
    "Wood Chips (biomass)",
    "tonne",
    [
      ["2023", "43.52"],
      ["2024", "43.48"],
      ["2025", "43.44"],
    ],
  ],
  [
    "wood_logs_tonne",
    "Wood Logs (biomass)",
    "tonne",
    [
      ["2023", "47.06"],
      ["2024", "47.03"],
      ["2025", "46.99"],
    ],
  ],
  // Биогенный CO₂ сжигания дров — отражается ВНЕ scope 1/2/3 (§5, D3). Значение =
  // прежний литерал отчёта 1.838 кг/кг → 1838 кг/тонну (сохранено дословно, §0.2).
  [
    "wood_logs_biogenic_co2",
    "Wood Logs (biomass) — biogenic CO₂",
    "tonne",
    [
      ["2023", "1838"],
      ["2024", "1838"],
      ["2025", "1838"],
    ],
  ],
];

// ─── 3. Vehicle — [factorId, category, type, fuel, [[year, kgCo2ePerKm], ...]] (DEFRA)
export const VEHICLES: Array<
  [string, string, string, string, Array<[string, string]>]
> = [
  // Cars — Petrol
  [
    "car_petrol_small",
    "Car",
    "Small",
    "Petrol",
    [
      ["2024", "0.14308"],
      ["2025", "0.14308"],
    ],
  ],
  [
    "car_petrol_medium",
    "Car",
    "Medium",
    "Petrol",
    [
      ["2024", "0.17474"],
      ["2025", "0.17474"],
    ],
  ],
  [
    "car_petrol_large",
    "Car",
    "Large",
    "Petrol",
    [
      ["2024", "0.26828"],
      ["2025", "0.26828"],
    ],
  ],
  [
    "car_petrol_avg",
    "Car",
    "Average",
    "Petrol",
    [
      ["2024", "0.16272"],
      ["2025", "0.16272"],
    ],
  ],
  // Cars — Diesel
  [
    "car_diesel_small",
    "Car",
    "Small",
    "Diesel",
    [
      ["2024", "0.14340"],
      ["2025", "0.14340"],
    ],
  ],
  [
    "car_diesel_medium",
    "Car",
    "Medium",
    "Diesel",
    [
      ["2024", "0.17174"],
      ["2025", "0.17174"],
    ],
  ],
  [
    "car_diesel_large",
    "Car",
    "Large",
    "Diesel",
    [
      ["2024", "0.21007"],
      ["2025", "0.21007"],
    ],
  ],
  [
    "car_diesel_avg",
    "Car",
    "Average",
    "Diesel",
    [
      ["2024", "0.17304"],
      ["2025", "0.17304"],
    ],
  ],
  // Cars — Hybrid
  [
    "car_hybrid_small",
    "Car",
    "Small",
    "Hybrid",
    [
      ["2024", "0.11413"],
      ["2025", "0.11413"],
    ],
  ],
  [
    "car_hybrid_medium",
    "Car",
    "Medium",
    "Hybrid",
    [
      ["2024", "0.11724"],
      ["2025", "0.11724"],
    ],
  ],
  [
    "car_hybrid_large",
    "Car",
    "Large",
    "Hybrid",
    [
      ["2024", "0.15650"],
      ["2025", "0.15650"],
    ],
  ],
  [
    "car_hybrid_avg",
    "Car",
    "Average",
    "Hybrid",
    [
      ["2024", "0.12825"],
      ["2025", "0.12825"],
    ],
  ],
  // Cars — BEV
  [
    "car_bev_small",
    "Car",
    "Small",
    "BEV",
    [
      ["2024", "0.04047"],
      ["2025", "0.03339"],
    ],
  ],
  [
    "car_bev_medium",
    "Car",
    "Medium",
    "BEV",
    [
      ["2024", "0.04250"],
      ["2025", "0.03513"],
    ],
  ],
  [
    "car_bev_large",
    "Car",
    "Large",
    "BEV",
    [
      ["2024", "0.04600"],
      ["2025", "0.03807"],
    ],
  ],
  [
    "car_bev_avg",
    "Car",
    "Average",
    "BEV",
    [
      ["2024", "0.04047"],
      ["2025", "0.03663"],
    ],
  ],
  // Cars — CNG & LPG
  [
    "car_cng_avg",
    "Car",
    "Average",
    "CNG",
    [
      ["2024", "0.17414"],
      ["2025", "0.17414"],
    ],
  ],
  [
    "car_lpg_avg",
    "Car",
    "Average",
    "LPG",
    [
      ["2024", "0.19599"],
      ["2025", "0.19599"],
    ],
  ],
  // Motorbikes
  [
    "motorbike_small",
    "Motorbike",
    "Small",
    "Petrol",
    [
      ["2024", "0.08319"],
      ["2025", "0.08319"],
    ],
  ],
  [
    "motorbike_medium",
    "Motorbike",
    "Medium",
    "Petrol",
    [
      ["2024", "0.10107"],
      ["2025", "0.10107"],
    ],
  ],
  [
    "motorbike_large",
    "Motorbike",
    "Large",
    "Petrol",
    [
      ["2024", "0.13252"],
      ["2025", "0.13252"],
    ],
  ],
  [
    "motorbike_avg",
    "Motorbike",
    "Average",
    "Petrol",
    [
      ["2024", "0.11367"],
      ["2025", "0.11367"],
    ],
  ],
  // Vans
  [
    "van_diesel_class1",
    "Van",
    "Class I (<=1.3t)",
    "Diesel",
    [
      ["2024", "0.15738"],
      ["2025", "0.15738"],
    ],
  ],
  [
    "van_diesel_class2",
    "Van",
    "Class II (1.3-1.7t)",
    "Diesel",
    [
      ["2024", "0.19260"],
      ["2025", "0.19260"],
    ],
  ],
  [
    "van_diesel_class3",
    "Van",
    "Class III (1.7-3.5t)",
    "Diesel",
    [
      ["2024", "0.27878"],
      ["2025", "0.27878"],
    ],
  ],
  [
    "van_diesel_avg",
    "Van",
    "Average",
    "Diesel",
    [
      ["2024", "0.25561"],
      ["2025", "0.25561"],
    ],
  ],
  [
    "van_petrol_avg",
    "Van",
    "Average",
    "Petrol",
    [
      ["2024", "0.21335"],
      ["2025", "0.21335"],
    ],
  ],
  // HGVs
  [
    "hgv_rigid_small",
    "HGV",
    "Rigid (3.5-7.5t)",
    "Diesel",
    [
      ["2024", "0.46138"],
      ["2025", "0.46138"],
    ],
  ],
  [
    "hgv_rigid_medium",
    "HGV",
    "Rigid (7.5-17t)",
    "Diesel",
    [
      ["2024", "0.55061"],
      ["2025", "0.55061"],
    ],
  ],
  [
    "hgv_rigid_large",
    "HGV",
    "Rigid (>17t)",
    "Diesel",
    [
      ["2024", "0.77400"],
      ["2025", "0.77400"],
    ],
  ],
  [
    "hgv_rigid_avg",
    "HGV",
    "All Rigids",
    "Diesel",
    [
      ["2024", "0.67912"],
      ["2025", "0.67912"],
    ],
  ],
  [
    "hgv_artic_small",
    "HGV",
    "Artic (3.5-33t)",
    "Diesel",
    [
      ["2024", "0.62775"],
      ["2025", "0.62775"],
    ],
  ],
  [
    "hgv_artic_large",
    "HGV",
    "Artic (>33t)",
    "Diesel",
    [
      ["2024", "0.64734"],
      ["2025", "0.64734"],
    ],
  ],
  [
    "hgv_artic_avg",
    "HGV",
    "All Artics",
    "Diesel",
    [
      ["2024", "0.64659"],
      ["2025", "0.64659"],
    ],
  ],
  [
    "hgv_avg",
    "HGV",
    "All HGVs",
    "Diesel",
    [
      ["2024", "0.65975"],
      ["2025", "0.65975"],
    ],
  ],
];

// ─── 3b. Vehicle energy-intensity — [factorId, category, type, [[year, kWhPerKm], ...]]
// Единица kWh/km (НЕ kgCO2e/km): переводит fleet-EV км → зарядку Scope 2 по местному
// гриду (§4/§5, D1). 0.195 = DEFRA 2024 car_bev_avg 0.04047 ÷ UK-грид 0.207, сверено с
// реальным потреблением BEV EEA ≈0.19. car_bev_avg остаётся отдельной справочной строкой.
export const VEHICLE_ENERGY: Array<
  [string, string, string, Array<[string, string]>]
> = [
  [
    "car_bev_kwh_per_km",
    "Car",
    "Average",
    [
      ["2024", "0.195"],
      ["2025", "0.195"],
    ],
  ],
];

// ─── 4. Flight — [factorId, flightType, cabinClass, [[year, withRf, withoutRf], ...]] (DEFRA)
export const FLIGHTS: Array<
  [string, string, string, Array<[string, string, string]>]
> = [
  [
    "flight_domestic_avg",
    "Domestic",
    "Average",
    [
      ["2024", "0.27257", "0.16098"],
      ["2025", "0.22928", "0.13552"],
    ],
  ],
  [
    "flight_shorthaul_avg",
    "Short-haul (<3700km)",
    "Average",
    [
      ["2024", "0.18592", "0.10974"],
      ["2025", "0.12786", "0.07559"],
    ],
  ],
  [
    "flight_shorthaul_economy",
    "Short-haul (<3700km)",
    "Economy",
    [
      ["2024", "0.18287", "0.10794"],
      ["2025", "0.12576", "0.07435"],
    ],
  ],
  [
    "flight_shorthaul_business",
    "Short-haul (<3700km)",
    "Business",
    [
      ["2024", "0.27430", "0.16191"],
      ["2025", "0.18863", "0.11152"],
    ],
  ],
  [
    "flight_longhaul_avg",
    "Long-haul (>3700km)",
    "Average",
    [
      ["2024", "0.26128", "0.15423"],
      ["2025", "0.15282", "0.09043"],
    ],
  ],
  [
    "flight_longhaul_economy",
    "Long-haul (>3700km)",
    "Economy",
    [
      ["2024", "0.20011", "0.11812"],
      ["2025", "0.11704", "0.06926"],
    ],
  ],
  [
    "flight_longhaul_premium",
    "Long-haul (>3700km)",
    "Premium Economy",
    [
      ["2024", "0.32015", "0.18897"],
      ["2025", "0.18726", "0.11081"],
    ],
  ],
  [
    "flight_longhaul_business",
    "Long-haul (>3700km)",
    "Business",
    [
      ["2024", "0.58028", "0.34252"],
      ["2025", "0.33940", "0.20083"],
    ],
  ],
  [
    "flight_longhaul_first",
    "Long-haul (>3700km)",
    "First",
    [
      ["2024", "0.80040", "0.47246"],
      ["2025", "0.46814", "0.27701"],
    ],
  ],
  [
    "flight_intl_avg",
    "International",
    "Average",
    [
      ["2024", "0.17580", "0.10377"],
      ["2025", "0.14253", "0.08420"],
    ],
  ],
  [
    "flight_intl_economy",
    "International",
    "Economy",
    [
      ["2024", "0.13465", "0.07948"],
      ["2025", "0.10916", "0.06449"],
    ],
  ],
  [
    "flight_intl_premium",
    "International",
    "Premium Economy",
    [
      ["2024", "0.21542", "0.12716"],
      ["2025", "0.17465", "0.10318"],
    ],
  ],
  [
    "flight_intl_business",
    "International",
    "Business",
    [
      ["2024", "0.39044", "0.23047"],
      ["2025", "0.31656", "0.18701"],
    ],
  ],
  [
    "flight_intl_first",
    "International",
    "First",
    [
      ["2024", "0.53854", "0.31789"],
      ["2025", "0.43663", "0.25794"],
    ],
  ],
];

// ─── 5. Refrigerant — [factorId, name, gwp100, kgCo2ePerKg, commonUse] (DEFRA, gwp_source default AR5)
export const REFRIGERANTS: Array<[string, string, string, string, string]> = [
  [
    "r134a",
    "R-134a (HFC-134a)",
    "1430",
    "1430",
    "Car AC, chillers, refrigerators",
  ],
  ["r410a", "R-410A", "2088", "2088", "Heat pumps, air conditioning"],
  ["r407c", "R-407C", "1774", "1774", "Commercial AC, retrofit for R-22"],
  ["r32", "R-32 (HFC-32)", "675", "675", "Modern split AC, heat pumps"],
  ["r404a", "R-404A", "3922", "3922", "Commercial refrigeration, cold storage"],
  ["r507a", "R-507A", "3985", "3985", "Industrial refrigeration"],
  [
    "r449a",
    "R-449A (Opteon XP40)",
    "1397",
    "1397",
    "R-404A replacement, supermarkets",
  ],
  [
    "r448a",
    "R-448A (Solstice N40)",
    "1387",
    "1387",
    "R-404A replacement, commercial",
  ],
  ["r290", "R-290 (Propane)", "3", "3", "Natural refrigerant, small systems"],
  ["r600a", "R-600a (Isobutane)", "3", "3", "Domestic refrigerators"],
  ["r744", "R-744 (CO2)", "1", "1", "CO2 transcritical, supermarkets"],
  ["r717", "R-717 (Ammonia)", "0", "0", "Industrial refrigeration"],
  ["r22", "R-22 (HCFC-22)", "1810", "1810", "Legacy AC (being phased out)"],
  [
    "sf6",
    "SF6 (Sulphur hexafluoride)",
    "22800",
    "22800",
    "Electrical switchgear, insulation",
  ],
];

// ─── 6. Grid electricity — [countryCode, countryName, [[year, loc, mkt], ...]] (AIB)
export const GRID: Array<[string, string, Array<[string, string, string]>]> = [
  [
    "AT",
    "Austria",
    [
      ["2023", "0.0956", "0.227"],
      ["2024", "0.0865", "0.210"],
    ],
  ],
  [
    "BE",
    "Belgium",
    [
      ["2023", "0.112", "0.167"],
      ["2024", "0.104", "0.131"],
    ],
  ],
  [
    "CH",
    "Switzerland",
    [
      ["2023", "0.00151", "0.128"],
      ["2024", "0.00578", "0.120"],
    ],
  ],
  [
    "DE",
    "Germany",
    [
      ["2023", "0.335", "0.719"],
      ["2024", "0.311", "0.724"],
    ],
  ],
  [
    "FR",
    "France",
    [
      ["2023", "0.0308", "0.0407"],
      ["2024", "0.0180", "0.0235"],
    ],
  ],
  [
    "LU",
    "Luxembourg",
    [
      ["2023", "0.0584", "0.357"],
      ["2024", "0.0461", "0.213"],
    ],
  ],
  [
    "MC",
    "Monaco",
    [
      ["2023", "0.0308", "0.0407"],
      ["2024", "0.0180", "0.0235"],
    ],
  ],
  [
    "NL",
    "Netherlands",
    [
      ["2023", "0.241", "0.379"],
      ["2024", "0.228", "0.382"],
    ],
  ],
  [
    "LI",
    "Liechtenstein",
    [
      ["2023", "0.00151", "0.128"],
      ["2024", "0.00578", "0.120"],
    ],
  ],
  [
    "DK",
    "Denmark",
    [
      ["2023", "0.0738", "0.582"],
      ["2024", "0.0511", "0.421"],
    ],
  ],
  [
    "FI",
    "Finland",
    [
      ["2023", "0.0451", "0.565"],
      ["2024", "0.0332", "0.405"],
    ],
  ],
  [
    "IS",
    "Iceland",
    [
      ["2023", "0.00020", "0.595"],
      ["2024", "0.00017", "0.505"],
    ],
  ],
  [
    "NO",
    "Norway",
    [
      ["2023", "0.0070", "0.598"],
      ["2024", "0.00674", "0.534"],
    ],
  ],
  [
    "SE",
    "Sweden",
    [
      ["2023", "0.00652", "0.0682"],
      ["2024", "0.00505", "0.0855"],
    ],
  ],
  [
    "EE",
    "Estonia",
    [
      ["2023", "0.464", "0.711"],
      ["2024", "0.364", "0.611"],
    ],
  ],
  [
    "LT",
    "Lithuania",
    [
      ["2023", "0.151", "0.583"],
      ["2024", "0.118", "0.567"],
    ],
  ],
  [
    "LV",
    "Latvia",
    [
      ["2023", "0.120", "0.535"],
      ["2024", "0.145", "0.504"],
    ],
  ],
  [
    "IE",
    "Ireland",
    [
      ["2023", "0.267", "0.445"],
      ["2024", "0.245", "0.365"],
    ],
  ],
  [
    "ES",
    "Spain",
    [
      ["2023", "0.121", "0.282"],
      ["2024", "0.100", "0.292"],
    ],
  ],
  [
    "PT",
    "Portugal",
    [
      ["2023", "0.100", "0.539"],
      ["2024", "0.0433", "0.501"],
    ],
  ],
  [
    "IT",
    "Italy",
    [
      ["2023", "0.273", "0.500"],
      ["2024", "0.235", "0.441"],
    ],
  ],
  [
    "GR",
    "Greece",
    [
      ["2023", "0.259", "0.491"],
      ["2024", "0.231", "0.367"],
    ],
  ],
  [
    "MT",
    "Malta",
    [
      ["2023", "0.365", "0.408"],
      ["2024", "0.345", "0.398"],
    ],
  ],
  [
    "CY",
    "Cyprus",
    [
      ["2023", "0.572", "0.595"],
      ["2024", "0.586", "0.613"],
    ],
  ],
  [
    "AD",
    "Andorra",
    [
      ["2023", "0.121", "0.282"],
      ["2024", "0.100", "0.292"],
    ],
  ],
  [
    "SM",
    "San Marino",
    [
      ["2023", "0.273", "0.500"],
      ["2024", "0.235", "0.441"],
    ],
  ],
  [
    "VA",
    "Vatican City",
    [
      ["2023", "0.273", "0.500"],
      ["2024", "0.235", "0.441"],
    ],
  ],
  [
    "PL",
    "Poland",
    [
      ["2023", "0.668", "0.788"],
      ["2024", "0.634", "0.808"],
    ],
  ],
  [
    "CZ",
    "Czech Republic",
    [
      ["2023", "0.577", "0.658"],
      ["2024", "0.529", "0.584"],
    ],
  ],
  [
    "SK",
    "Slovakia",
    [
      ["2023", "0.123", "0.357"],
      ["2024", "0.0991", "0.334"],
    ],
  ],
  [
    "HU",
    "Hungary",
    [
      ["2023", "0.195", "0.322"],
      ["2024", "0.177", "0.318"],
    ],
  ],
  [
    "SI",
    "Slovenia",
    [
      ["2023", "0.207", "0.486"],
      ["2024", "0.212", "0.429"],
    ],
  ],
  [
    "HR",
    "Croatia",
    [
      ["2023", "0.176", "0.550"],
      ["2024", "0.224", "0.573"],
    ],
  ],
  [
    "RO",
    "Romania",
    [
      ["2023", "0.212", "0.212"],
      ["2024", "0.216", "0.233"],
    ],
  ],
  [
    "BG",
    "Bulgaria",
    [
      ["2023", "0.332", "0.418"],
      ["2024", "0.310", "0.379"],
    ],
  ],
  [
    "RS",
    "Serbia",
    [
      ["2023", "0.766", "0.966"],
      ["2024", "0.801", "0.895"],
    ],
  ],
  [
    "BA",
    "Bosnia & Herzegovina",
    [
      ["2023", "0.700", "0.719"],
      ["2024", "0.776", "0.777"],
    ],
  ],
  [
    "ME",
    "Montenegro",
    [
      ["2023", "0.467", "0.747"],
      ["2024", "0.482", "0.622"],
    ],
  ],
  [
    "MK",
    "North Macedonia",
    [
      ["2023", "0.550", "0.680"],
      ["2024", "0.520", "0.650"],
    ],
  ],
  [
    "AL",
    "Albania",
    [
      ["2023", "0.0150", "0.350"],
      ["2024", "0.0180", "0.340"],
    ],
  ],
  [
    "XK",
    "Kosovo",
    [
      ["2023", "0.820", "0.850"],
      ["2024", "0.790", "0.820"],
    ],
  ],
  [
    "GB",
    "United Kingdom",
    [
      ["2023", "0.193", "0.388"],
      ["2024", "0.148", "0.420"],
    ],
  ],
  [
    "UA",
    "Ukraine",
    [
      ["2023", "0.310", "0.310"],
      ["2024", "0.330", "0.330"],
    ],
  ],
  [
    "MD",
    "Moldova",
    [
      ["2023", "0.420", "0.420"],
      ["2024", "0.400", "0.400"],
    ],
  ],
  [
    "BY",
    "Belarus",
    [
      ["2023", "0.370", "0.370"],
      ["2024", "0.360", "0.360"],
    ],
  ],
  [
    "TR",
    "Turkey",
    [
      ["2023", "0.420", "0.420"],
      ["2024", "0.395", "0.395"],
    ],
  ],
  [
    "GE",
    "Georgia",
    [
      ["2023", "0.095", "0.095"],
      ["2024", "0.100", "0.100"],
    ],
  ],
  [
    "AM",
    "Armenia",
    [
      ["2023", "0.180", "0.180"],
      ["2024", "0.175", "0.175"],
    ],
  ],
  [
    "AZ",
    "Azerbaijan",
    [
      ["2023", "0.480", "0.480"],
      ["2024", "0.470", "0.470"],
    ],
  ],
];

// ─── 7. Heat, steam & cooling ────────────────────────────────────────────────
// [factorId, category, name, unit, countryCode|null, notes, sourceCode, [[year, kg], ...]]
export const HEAT: Array<
  [
    string,
    string,
    string,
    string,
    string | null,
    string,
    SourceCode,
    Array<[string, string]>,
  ]
> = [
  // District heating — generic / DEFRA defaults
  [
    "heat_defra_default",
    "district_heating",
    "District heat (DEFRA default)",
    "kWh",
    null,
    "UK default for purchased heat",
    "DEFRA",
    [
      ["2023", "0.16630"],
      ["2024", "0.16590"],
    ],
  ],
  [
    "heat_gas_boiler",
    "district_heating",
    "Heat from gas boiler (centralised)",
    "kWh",
    null,
    "Natural gas net CV -- centralised boiler",
    "DEFRA",
    [
      ["2023", "0.20297"],
      ["2024", "0.20260"],
    ],
  ],
  [
    "heat_oil_boiler",
    "district_heating",
    "Heat from oil boiler",
    "kWh",
    null,
    "Fuel oil / kerosene boiler",
    "DEFRA",
    [
      ["2023", "0.26810"],
      ["2024", "0.26780"],
    ],
  ],
  [
    "heat_biomass_boiler",
    "district_heating",
    "Heat from biomass boiler",
    "kWh",
    null,
    "Wood pellets -- non-biogenic only",
    "DEFRA",
    [
      ["2023", "0.01313"],
      ["2024", "0.01310"],
    ],
  ],
  [
    "heat_heat_pump",
    "district_heating",
    "Heat pump (electricity-driven)",
    "kWh",
    null,
    "COP ~3.0 x grid factor (EU avg)",
    "DEFRA",
    [
      ["2023", "0.07700"],
      ["2024", "0.07100"],
    ],
  ],
  // District heating — by country
  [
    "dh_AT",
    "district_heating",
    "District heating -- Austria",
    "kWh",
    "AT",
    "High CHP, gas + biomass",
    "NATIONAL_STATS",
    [
      ["2023", "0.105"],
      ["2024", "0.098"],
    ],
  ],
  [
    "dh_DE",
    "district_heating",
    "District heating -- Germany",
    "kWh",
    "DE",
    "Mixed CHP + gas boilers",
    "NATIONAL_STATS",
    [
      ["2023", "0.183"],
      ["2024", "0.175"],
    ],
  ],
  [
    "dh_DK",
    "district_heating",
    "District heating -- Denmark",
    "kWh",
    "DK",
    "Biomass + waste CHP + heat pumps",
    "NATIONAL_STATS",
    [
      ["2023", "0.060"],
      ["2024", "0.047"],
    ],
  ],
  [
    "dh_FI",
    "district_heating",
    "District heating -- Finland",
    "kWh",
    "FI",
    "CHP peat/biomass/gas",
    "NATIONAL_STATS",
    [
      ["2023", "0.107"],
      ["2024", "0.092"],
    ],
  ],
  [
    "dh_SE",
    "district_heating",
    "District heating -- Sweden",
    "kWh",
    "SE",
    "Biomass + waste + heat pumps",
    "NATIONAL_STATS",
    [
      ["2023", "0.044"],
      ["2024", "0.040"],
    ],
  ],
  [
    "dh_NO",
    "district_heating",
    "District heating -- Norway",
    "kWh",
    "NO",
    "Waste CHP + electric boilers",
    "NATIONAL_STATS",
    [
      ["2023", "0.038"],
      ["2024", "0.035"],
    ],
  ],
  [
    "dh_PL",
    "district_heating",
    "District heating -- Poland",
    "kWh",
    "PL",
    "Coal CHP dominant",
    "NATIONAL_STATS",
    [
      ["2023", "0.310"],
      ["2024", "0.295"],
    ],
  ],
  [
    "dh_CZ",
    "district_heating",
    "District heating -- Czech Republic",
    "kWh",
    "CZ",
    "Coal + gas CHP",
    "NATIONAL_STATS",
    [
      ["2023", "0.220"],
      ["2024", "0.208"],
    ],
  ],
  [
    "dh_SI",
    "district_heating",
    "District heating -- Slovenia",
    "kWh",
    "SI",
    "Gas CHP + waste",
    "NATIONAL_STATS",
    [
      ["2023", "0.188"],
      ["2024", "0.180"],
    ],
  ],
  [
    "dh_HR",
    "district_heating",
    "District heating -- Croatia",
    "kWh",
    "HR",
    "Gas CHP",
    "NATIONAL_STATS",
    [
      ["2023", "0.195"],
      ["2024", "0.190"],
    ],
  ],
  [
    "dh_FR",
    "district_heating",
    "District heating -- France",
    "kWh",
    "FR",
    "Gas + waste + biomass",
    "NATIONAL_STATS",
    [
      ["2023", "0.115"],
      ["2024", "0.108"],
    ],
  ],
  [
    "dh_NL",
    "district_heating",
    "District heating -- Netherlands",
    "kWh",
    "NL",
    "Gas CHP",
    "NATIONAL_STATS",
    [
      ["2023", "0.165"],
      ["2024", "0.158"],
    ],
  ],
  [
    "dh_IT",
    "district_heating",
    "District heating -- Italy",
    "kWh",
    "IT",
    "Gas CHP",
    "NATIONAL_STATS",
    [
      ["2023", "0.150"],
      ["2024", "0.143"],
    ],
  ],
  [
    "dh_GB",
    "district_heating",
    "District heating -- United Kingdom",
    "kWh",
    "GB",
    "UK default",
    "DEFRA",
    [
      ["2023", "0.166"],
      ["2024", "0.166"],
    ],
  ],
  [
    "dh_EE",
    "district_heating",
    "District heating -- Estonia",
    "kWh",
    "EE",
    "Oil shale + biomass + gas",
    "NATIONAL_STATS",
    [
      ["2023", "0.178"],
      ["2024", "0.165"],
    ],
  ],
  [
    "dh_LT",
    "district_heating",
    "District heating -- Lithuania",
    "kWh",
    "LT",
    "Biomass transition, was gas",
    "NATIONAL_STATS",
    [
      ["2023", "0.130"],
      ["2024", "0.120"],
    ],
  ],
  [
    "dh_LV",
    "district_heating",
    "District heating -- Latvia",
    "kWh",
    "LV",
    "Gas + biomass",
    "NATIONAL_STATS",
    [
      ["2023", "0.145"],
      ["2024", "0.138"],
    ],
  ],
  [
    "dh_BG",
    "district_heating",
    "District heating -- Bulgaria",
    "kWh",
    "BG",
    "Gas + coal CHP",
    "NATIONAL_STATS",
    [
      ["2023", "0.240"],
      ["2024", "0.232"],
    ],
  ],
  [
    "dh_RO",
    "district_heating",
    "District heating -- Romania",
    "kWh",
    "RO",
    "Gas CHP",
    "NATIONAL_STATS",
    [
      ["2023", "0.225"],
      ["2024", "0.218"],
    ],
  ],
  [
    "dh_RS",
    "district_heating",
    "District heating -- Serbia",
    "kWh",
    "RS",
    "Gas + coal",
    "NATIONAL_STATS",
    [
      ["2023", "0.265"],
      ["2024", "0.258"],
    ],
  ],
  // Steam
  [
    "steam_defra",
    "steam",
    "Purchased steam (DEFRA default)",
    "kWh",
    null,
    "UK default -- steam from gas CHP",
    "DEFRA",
    [
      ["2023", "0.17864"],
      ["2024", "0.17820"],
    ],
  ],
  [
    "steam_gas_chp",
    "steam",
    "Steam from gas CHP",
    "kWh",
    null,
    "Allocation by energy content",
    "DEFRA",
    [
      ["2023", "0.19300"],
      ["2024", "0.19250"],
    ],
  ],
  [
    "steam_coal_chp",
    "steam",
    "Steam from coal CHP",
    "kWh",
    null,
    "Coal-fired CHP steam allocation",
    "IEA",
    [
      ["2023", "0.34000"],
      ["2024", "0.33800"],
    ],
  ],
  // Cooling
  [
    "cooling_defra",
    "cooling",
    "Purchased cooling (DEFRA default)",
    "kWh",
    null,
    "UK default -- chiller on grid electricity",
    "DEFRA",
    [
      ["2023", "0.07180"],
      ["2024", "0.06960"],
    ],
  ],
  [
    "cooling_electric",
    "cooling",
    "Electric chiller (COP 4.0)",
    "kWh cooling",
    null,
    "Grid electricity / COP 4.0",
    "DEFRA",
    [
      ["2023", "0.05800"],
      ["2024", "0.05300"],
    ],
  ],
  [
    "cooling_absorption",
    "cooling",
    "Absorption chiller (gas-fired)",
    "kWh cooling",
    null,
    "Gas-fired absorption COP ~0.7",
    "IEA",
    [
      ["2023", "0.29000"],
      ["2024", "0.28900"],
    ],
  ],
  [
    "cooling_district",
    "cooling",
    "District cooling (average EU)",
    "kWh cooling",
    null,
    "Centralised electric + absorption mix",
    "NATIONAL_STATS",
    [
      ["2023", "0.08500"],
      ["2024", "0.08000"],
    ],
  ],
];

// ─── 8. Scope 3 ──────────────────────────────────────────────────────────────
// [factorId, categoryId, categoryName, name, unit, tier, sourceCode, [[year, kg], ...]]
export const SCOPE3: Array<
  [
    string,
    number,
    string,
    string,
    string,
    string,
    SourceCode,
    Array<[string, string]>,
  ]
> = [
  // Category 1: Purchased Goods & Services
  [
    "s3_c1_paper",
    1,
    "Purchased Goods & Services",
    "Paper / cardboard",
    "tonne",
    "starter",
    "DEFRA",
    [
      ["2024", "919"],
      ["2025", "919"],
    ],
  ],
  [
    "s3_c1_plastics",
    1,
    "Purchased Goods & Services",
    "Plastics (average)",
    "tonne",
    "starter",
    "DEFRA",
    [
      ["2024", "3120"],
      ["2025", "3120"],
    ],
  ],
  [
    "s3_c1_metals_steel",
    1,
    "Purchased Goods & Services",
    "Steel",
    "tonne",
    "starter",
    "DEFRA",
    [
      ["2024", "1820"],
      ["2025", "1820"],
    ],
  ],
  [
    "s3_c1_metals_aluminium",
    1,
    "Purchased Goods & Services",
    "Aluminium",
    "tonne",
    "starter",
    "DEFRA",
    [
      ["2024", "9700"],
      ["2025", "9700"],
    ],
  ],
  [
    "s3_c1_glass",
    1,
    "Purchased Goods & Services",
    "Glass",
    "tonne",
    "starter",
    "DEFRA",
    [
      ["2024", "840"],
      ["2025", "840"],
    ],
  ],
  [
    "s3_c1_textiles",
    1,
    "Purchased Goods & Services",
    "Textiles (clothing)",
    "tonne",
    "starter",
    "DEFRA",
    [
      ["2024", "22000"],
      ["2025", "22000"],
    ],
  ],
  [
    "s3_c1_electronics",
    1,
    "Purchased Goods & Services",
    "Electronics (average)",
    "EUR 1000 spent",
    "starter",
    "EXIOBASE",
    [
      ["2024", "350"],
      ["2025", "350"],
    ],
  ],
  [
    "s3_c1_food",
    1,
    "Purchased Goods & Services",
    "Food products (average)",
    "EUR 1000 spent",
    "starter",
    "EXIOBASE",
    [
      ["2024", "680"],
      ["2025", "680"],
    ],
  ],
  [
    "s3_c1_chemicals",
    1,
    "Purchased Goods & Services",
    "Chemicals",
    "tonne",
    "starter",
    "DEFRA",
    [
      ["2024", "2500"],
      ["2025", "2500"],
    ],
  ],
  [
    "s3_c1_construction",
    1,
    "Purchased Goods & Services",
    "Construction materials",
    "EUR 1000 spent",
    "starter",
    "EXIOBASE",
    [
      ["2024", "520"],
      ["2025", "520"],
    ],
  ],
  [
    "s3_c1_it_services",
    1,
    "Purchased Goods & Services",
    "IT services / cloud",
    "EUR 1000 spent",
    "starter",
    "EXIOBASE",
    [
      ["2024", "120"],
      ["2025", "120"],
    ],
  ],
  [
    "s3_c1_consulting",
    1,
    "Purchased Goods & Services",
    "Professional services",
    "EUR 1000 spent",
    "starter",
    "EXIOBASE",
    [
      ["2024", "85"],
      ["2025", "85"],
    ],
  ],
  [
    "s3_c1_furniture",
    1,
    "Purchased Goods & Services",
    "Furniture",
    "EUR 1000 spent",
    "starter",
    "EXIOBASE",
    [
      ["2024", "310"],
      ["2025", "310"],
    ],
  ],
  [
    "s3_c1_water",
    1,
    "Purchased Goods & Services",
    "Water supply",
    "m3",
    "starter",
    "DEFRA",
    [
      ["2024", "0.344"],
      ["2025", "0.344"],
    ],
  ],
  // Category 2: Capital Goods
  [
    "s3_c2_vehicles",
    2,
    "Capital Goods",
    "Vehicles (average car)",
    "unit",
    "pro",
    "DEFRA",
    [
      ["2024", "6000"],
      ["2025", "6000"],
    ],
  ],
  [
    "s3_c2_machinery",
    2,
    "Capital Goods",
    "Machinery / equipment",
    "EUR 1000 spent",
    "pro",
    "EXIOBASE",
    [
      ["2024", "450"],
      ["2025", "450"],
    ],
  ],
  [
    "s3_c2_buildings",
    2,
    "Capital Goods",
    "Buildings / renovations",
    "EUR 1000 spent",
    "pro",
    "EXIOBASE",
    [
      ["2024", "600"],
      ["2025", "600"],
    ],
  ],
  [
    "s3_c2_it_equipment",
    2,
    "Capital Goods",
    "IT equipment (computers)",
    "unit",
    "pro",
    "DEFRA",
    [
      ["2024", "350"],
      ["2025", "350"],
    ],
  ],
  // Category 3: Fuel- & Energy-Related (not in Scope 1/2)
  [
    "s3_c3_elec_td",
    3,
    "Fuel- & Energy-Related (not in Scope 1/2)",
    "Electricity T&D losses",
    "kWh",
    "pro",
    "DEFRA",
    [
      ["2024", "0.01769"],
      ["2025", "0.01769"],
    ],
  ],
  [
    "s3_c3_wtt_gas",
    3,
    "Fuel- & Energy-Related (not in Scope 1/2)",
    "WTT natural gas",
    "kWh",
    "pro",
    "DEFRA",
    [
      ["2024", "0.02368"],
      ["2025", "0.02368"],
    ],
  ],
  [
    "s3_c3_wtt_diesel",
    3,
    "Fuel- & Energy-Related (not in Scope 1/2)",
    "WTT diesel",
    "litre",
    "pro",
    "DEFRA",
    [
      ["2024", "0.60986"],
      ["2025", "0.60986"],
    ],
  ],
  [
    "s3_c3_wtt_petrol",
    3,
    "Fuel- & Energy-Related (not in Scope 1/2)",
    "WTT petrol",
    "litre",
    "pro",
    "DEFRA",
    [
      ["2024", "0.53063"],
      ["2025", "0.53063"],
    ],
  ],
  // Category 4: Upstream Transportation & Distribution
  [
    "s3_c4_road_hgv",
    4,
    "Upstream Transportation & Distribution",
    "Road freight (HGV avg)",
    "tonne-km",
    "pro",
    "DEFRA",
    [
      ["2024", "0.10415"],
      ["2025", "0.10415"],
    ],
  ],
  [
    "s3_c4_rail_freight",
    4,
    "Upstream Transportation & Distribution",
    "Rail freight",
    "tonne-km",
    "pro",
    "DEFRA",
    [
      ["2024", "0.02728"],
      ["2025", "0.02728"],
    ],
  ],
  [
    "s3_c4_sea_container",
    4,
    "Upstream Transportation & Distribution",
    "Sea freight (container)",
    "tonne-km",
    "pro",
    "DEFRA",
    [
      ["2024", "0.01613"],
      ["2025", "0.01613"],
    ],
  ],
  [
    "s3_c4_air_freight",
    4,
    "Upstream Transportation & Distribution",
    "Air freight (long-haul)",
    "tonne-km",
    "pro",
    "DEFRA",
    [
      ["2024", "0.60181"],
      ["2025", "0.60181"],
    ],
  ],
  // Category 5: Waste Generated in Operations
  [
    "s3_c5_landfill_mixed",
    5,
    "Waste Generated in Operations",
    "Mixed waste (landfill)",
    "tonne",
    "pro",
    "DEFRA",
    [
      ["2024", "467"],
      ["2025", "467"],
    ],
  ],
  [
    "s3_c5_recycle_mixed",
    5,
    "Waste Generated in Operations",
    "Mixed recycling",
    "tonne",
    "pro",
    "DEFRA",
    [
      ["2024", "21.3"],
      ["2025", "21.3"],
    ],
  ],
  [
    "s3_c5_incineration",
    5,
    "Waste Generated in Operations",
    "Incineration",
    "tonne",
    "pro",
    "DEFRA",
    [
      ["2024", "21.4"],
      ["2025", "21.4"],
    ],
  ],
  [
    "s3_c5_compost",
    5,
    "Waste Generated in Operations",
    "Composting",
    "tonne",
    "pro",
    "DEFRA",
    [
      ["2024", "10.2"],
      ["2025", "10.2"],
    ],
  ],
  // Category 6: Business Travel
  [
    "s3_c6_taxi",
    6,
    "Business Travel",
    "Taxi (average)",
    "km",
    "starter",
    "DEFRA",
    [
      ["2024", "0.20869"],
      ["2025", "0.20869"],
    ],
  ],
  [
    "s3_c6_bus",
    6,
    "Business Travel",
    "Bus (local, average)",
    "km",
    "starter",
    "DEFRA",
    [
      ["2024", "0.10312"],
      ["2025", "0.10312"],
    ],
  ],
  [
    "s3_c6_rail_national",
    6,
    "Business Travel",
    "National rail",
    "km",
    "starter",
    "DEFRA",
    [
      ["2024", "0.03549"],
      ["2025", "0.03549"],
    ],
  ],
  [
    "s3_c6_rail_intl",
    6,
    "Business Travel",
    "International rail (Eurostar)",
    "km",
    "starter",
    "DEFRA",
    [
      ["2024", "0.00446"],
      ["2025", "0.00446"],
    ],
  ],
  [
    "s3_c6_hotel_night",
    6,
    "Business Travel",
    "Hotel stay (average)",
    "room-night",
    "starter",
    "DEFRA",
    [
      ["2024", "16.5"],
      ["2025", "16.5"],
    ],
  ],
  // Category 7: Employee Commuting
  [
    "s3_c7_car_avg",
    7,
    "Employee Commuting",
    "Car (average, single occupant)",
    "km",
    "starter",
    "DEFRA",
    [
      ["2024", "0.16725"],
      ["2025", "0.16725"],
    ],
  ],
  [
    "s3_c7_bus",
    7,
    "Employee Commuting",
    "Bus",
    "km",
    "starter",
    "DEFRA",
    [
      ["2024", "0.10312"],
      ["2025", "0.10312"],
    ],
  ],
  [
    "s3_c7_rail",
    7,
    "Employee Commuting",
    "National rail",
    "km",
    "starter",
    "DEFRA",
    [
      ["2024", "0.03549"],
      ["2025", "0.03549"],
    ],
  ],
  [
    "s3_c7_metro",
    7,
    "Employee Commuting",
    "Metro / tram",
    "km",
    "starter",
    "DEFRA",
    [
      ["2024", "0.02781"],
      ["2025", "0.02781"],
    ],
  ],
  [
    "s3_c7_bicycle",
    7,
    "Employee Commuting",
    "Bicycle / walking",
    "km",
    "starter",
    "DEFRA",
    [
      ["2024", "0"],
      ["2025", "0"],
    ],
  ],
  [
    "s3_c7_ebike",
    7,
    "Employee Commuting",
    "E-bike / e-scooter",
    "km",
    "starter",
    "DEFRA",
    [
      ["2024", "0.00583"],
      ["2025", "0.00583"],
    ],
  ],
  [
    "s3_c7_wfh",
    7,
    "Employee Commuting",
    "Work from home",
    "day",
    "starter",
    "ECOACT",
    [
      ["2024", "1.26"],
      ["2025", "1.26"],
    ],
  ],
  // Category 8: Upstream Leased Assets
  [
    "s3_c8_office_sqm",
    8,
    "Upstream Leased Assets",
    "Leased office space",
    "m2/year",
    "pro",
    "DEFRA",
    [
      ["2024", "50"],
      ["2025", "50"],
    ],
  ],
  // Category 9: Downstream Transportation & Distribution
  [
    "s3_c9_road",
    9,
    "Downstream Transportation & Distribution",
    "Road delivery (avg)",
    "tonne-km",
    "pro",
    "DEFRA",
    [
      ["2024", "0.10415"],
      ["2025", "0.10415"],
    ],
  ],
  [
    "s3_c9_last_mile",
    9,
    "Downstream Transportation & Distribution",
    "Last-mile delivery (van)",
    "parcel",
    "pro",
    "DEFRA",
    [
      ["2024", "0.55"],
      ["2025", "0.55"],
    ],
  ],
  // Category 11: Use of Sold Products
  [
    "s3_c11_elec_product",
    11,
    "Use of Sold Products",
    "Electricity-consuming product",
    "kWh (lifetime)",
    "starter",
    "AIB",
    [
      ["2024", "0.233"],
      ["2025", "0.233"],
    ],
  ],
  [
    "s3_c11_fuel_product",
    11,
    "Use of Sold Products",
    "Fuel-consuming product",
    "litre (lifetime)",
    "starter",
    "DEFRA",
    [
      ["2024", "2.54"],
      ["2025", "2.54"],
    ],
  ],
  // Category 12: End-of-Life Treatment of Sold Products
  [
    "s3_c12_landfill",
    12,
    "End-of-Life Treatment of Sold Products",
    "Landfill disposal",
    "tonne",
    "pro",
    "DEFRA",
    [
      ["2024", "467"],
      ["2025", "467"],
    ],
  ],
  [
    "s3_c12_recycle",
    12,
    "End-of-Life Treatment of Sold Products",
    "Recycling",
    "tonne",
    "pro",
    "DEFRA",
    [
      ["2024", "21.3"],
      ["2025", "21.3"],
    ],
  ],
  // Categories 10, 13, 14, 15 have no factors in the TypeScript source (empty).
];
