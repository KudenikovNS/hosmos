CREATE TABLE "account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"industry" text,
	"nace_code" text,
	"country" text,
	"country_code" char(2),
	"headcount" integer DEFAULT 0,
	"plan" text DEFAULT 'trial',
	"plan_start" date,
	"reporting_year" text DEFAULT '2024',
	"currency" char(3) DEFAULT 'EUR',
	"logo_url" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"status" text DEFAULT 'active',
	"employee_count" integer,
	"founded_date" date,
	"registered_at" timestamp with time zone DEFAULT now(),
	"last_activity_at" timestamp with time zone,
	"data_completion" integer DEFAULT 0,
	"stripe_customer_id" text,
	"subscription_started_at" timestamp with time zone,
	"next_payment_at" timestamp with time zone,
	"monthly_price" numeric DEFAULT '0',
	"governance_data" jsonb DEFAULT '{}'::jsonb,
	CONSTRAINT "companies_plan_check" CHECK ("companies"."plan" IN ('trial','starter','pro','enterprise')),
	CONSTRAINT "companies_status_check" CHECK ("companies"."status" IN ('active','trial','frozen','churned'))
);
--> statement-breakpoint
CREATE TABLE "emission_factor_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"authority" text NOT NULL,
	"publication" text,
	"version_year" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "emission_factor_sources_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "emission_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"factor_key" text NOT NULL,
	"country_code" char(2),
	"year" integer,
	"value" numeric NOT NULL,
	"unit" text NOT NULL,
	"source_id" uuid,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emission_factors" ADD CONSTRAINT "emission_factors_source_id_emission_factor_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."emission_factor_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written index: drizzle-kit truncates the string at the `--` inside '--'. Keep this literal (DENORM-IMPL-SPEC §5.2, Р-4).
CREATE UNIQUE INDEX "emission_factors_category_key_country_year" ON "emission_factors" ("category","factor_key",COALESCE("country_code", '--'),COALESCE("year", 0));--> statement-breakpoint
CREATE TABLE "emission_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"year" text NOT NULL,
	"scope1_stationary" numeric DEFAULT '0',
	"scope1_fleet" numeric DEFAULT '0',
	"scope1_total" numeric DEFAULT '0',
	"scope2_location" numeric DEFAULT '0',
	"scope2_market" numeric DEFAULT '0',
	"scope2_total" numeric DEFAULT '0',
	"scope3_total" numeric DEFAULT '0',
	"total_tco2e" numeric DEFAULT '0',
	"per_employee" numeric DEFAULT '0',
	"esg_score" integer DEFAULT 0,
	"calculated_at" timestamp with time zone DEFAULT now(),
	"factor_snapshot" jsonb,
	"calculation_version" text,
	"calculated_by" text DEFAULT 'client-legacy' NOT NULL,
	CONSTRAINT "emission_results_company_id_year_key" UNIQUE("company_id","year"),
	CONSTRAINT "emission_results_calculated_by_check" CHECK ("emission_results"."calculated_by" IN ('server','client-legacy'))
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text,
	"target_year" text,
	"target_value" numeric,
	"current_value" numeric DEFAULT '0',
	"unit" text,
	"baseline_year" text,
	"baseline_value" numeric,
	"status" text DEFAULT 'not_started',
	"sbti_aligned" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "goals_category_check" CHECK ("goals"."category" IN ('emissions','energy','waste','social','governance','supply_chain','water','biodiversity')),
	CONSTRAINT "goals_status_check" CHECK ("goals"."status" IN ('on_track','at_risk','behind','completed','not_started'))
);
--> statement-breakpoint
CREATE TABLE "monthly_emissions_data" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"year" text NOT NULL,
	"month" integer NOT NULL,
	"natural_gas_m3" numeric DEFAULT '0',
	"diesel_litres" numeric DEFAULT '0',
	"petrol_litres" numeric DEFAULT '0',
	"lpg_litres" numeric DEFAULT '0',
	"fuel_oil_litres" numeric DEFAULT '0',
	"fleet_diesel_km" numeric DEFAULT '0',
	"fleet_petrol_km" numeric DEFAULT '0',
	"fleet_ev_km" numeric DEFAULT '0',
	"electricity_kwh" numeric DEFAULT '0',
	"district_heating_kwh" numeric DEFAULT '0',
	"steam_kg" numeric DEFAULT '0',
	"cooling_kwh" numeric DEFAULT '0',
	"short_flights_pkm" numeric DEFAULT '0',
	"long_flights_pkm" numeric DEFAULT '0',
	"commute_car_km" numeric DEFAULT '0',
	"commute_bus_km" numeric DEFAULT '0',
	"commute_train_km" numeric DEFAULT '0',
	"status" text DEFAULT 'draft',
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"waste_landfill_tonnes" numeric DEFAULT '0',
	"waste_recycled_tonnes" numeric DEFAULT '0',
	"freight_road_tkm" numeric DEFAULT '0',
	"freight_rail_tkm" numeric DEFAULT '0',
	"freight_sea_tkm" numeric DEFAULT '0',
	"purchased_goods_eur" numeric DEFAULT '0',
	"capital_goods_eur" numeric DEFAULT '0',
	"scope1" numeric DEFAULT '0',
	"scope2" numeric DEFAULT '0',
	"scope3" numeric DEFAULT '0',
	"total" numeric DEFAULT '0',
	"biomass_wood_kg" numeric DEFAULT '0',
	CONSTRAINT "monthly_emissions_data_company_id_year_month_key" UNIQUE("company_id","year","month"),
	CONSTRAINT "monthly_emissions_data_month_check" CHECK ("monthly_emissions_data"."month" BETWEEN 1 AND 12),
	CONSTRAINT "monthly_emissions_data_status_check" CHECK ("monthly_emissions_data"."status" IN ('draft','submitted','verified'))
);
--> statement-breakpoint
CREATE TABLE "people_data" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"year" text NOT NULL,
	"headcount" integer,
	"fte" numeric,
	"female_ratio" numeric,
	"mgmt_female_ratio" numeric,
	"board_female_ratio" numeric,
	"training_hours" numeric,
	"turnover_rate" numeric,
	"accident_rate" numeric,
	"fatalities" integer DEFAULT 0,
	"sick_days" numeric,
	"gender_pay_gap" numeric,
	"enps" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "people_data_company_id_year_key" UNIQUE("company_id","year")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"role" text DEFAULT 'owner',
	"company_id" uuid,
	"locale" text DEFAULT 'en',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "profiles_role_check" CHECK ("profiles"."role" IN ('owner','admin','editor','viewer'))
);
--> statement-breakpoint
CREATE TABLE "scope3_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"year" text NOT NULL,
	"category_id" integer NOT NULL,
	"category_name" text NOT NULL,
	"tco2e" numeric DEFAULT '0',
	"methodology" text,
	"data_quality" text DEFAULT 'estimated',
	"notes" text,
	"calculated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "scope3_results_company_id_year_category_id_key" UNIQUE("company_id","year","category_id"),
	CONSTRAINT "scope3_results_data_quality_check" CHECK ("scope3_results"."data_quality" IN ('primary','secondary','estimated'))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "supply_chain_data" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"year" text NOT NULL,
	"supplier_name" text NOT NULL,
	"supplier_country" text,
	"category" text,
	"spend_eur" numeric DEFAULT '0',
	"emissions_tco2e" numeric DEFAULT '0',
	"risk_level" text DEFAULT 'medium',
	"tier" integer DEFAULT 1,
	"esg_score" integer,
	"certified" boolean DEFAULT false,
	"certification" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "supply_chain_data_risk_level_check" CHECK ("supply_chain_data"."risk_level" IN ('low','medium','high','critical'))
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emission_results" ADD CONSTRAINT "emission_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_emissions_data" ADD CONSTRAINT "monthly_emissions_data_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_emissions_data" ADD CONSTRAINT "monthly_emissions_data_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_data" ADD CONSTRAINT "people_data_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_user_id_fk" FOREIGN KEY ("id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope3_results" ADD CONSTRAINT "scope3_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_chain_data" ADD CONSTRAINT "supply_chain_data_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_user_id_index" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "account_user_id_index" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_index" ON "verification" ("identifier");