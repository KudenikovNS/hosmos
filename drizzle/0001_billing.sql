-- 0001_billing.sql — BILLING layer A: plans / plan_prices / company_subscription
-- / payments / payment_events (BILLING-IMPL-SPEC §4.3). Hand-authored (NOT
-- drizzle-kit generate): partial/expression indexes are written by hand because
-- drizzle-kit serializes their WHERE clause broken (§3.3/§3.4, Р-5). Additive
-- only — no existing table is touched; baseline 0000 is authoritative for those.
-- Seed of plans/plan_prices lives in seed.ts (T-A2); a fallback INSERT ...
-- ON CONFLICT DO NOTHING is kept commented at the bottom for prod apply without
-- db:seed (§4.3 note, §4.5).
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer NOT NULL,
	"features" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "plan_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"period" text NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"amount_minor" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "plan_prices_period_check" CHECK ("period" IN ('monthly','annual'))
);
--> statement-breakpoint
CREATE TABLE "company_subscription" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"plan_id" text NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'trialing' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"pending_plan_id" text,
	"pending_period" text,
	"trial_ends_at" timestamp with time zone,
	"revolut_customer_id" text,
	"saved_payment_method_id" text,
	"dunning_attempts" integer DEFAULT 0 NOT NULL,
	"dunning_next_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "company_subscription_period_check" CHECK ("period" IN ('monthly','annual')),
	CONSTRAINT "company_subscription_status_check" CHECK ("status" IN ('trialing','active','past_due','cancelled','expired'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"revolut_order_id" text,
	"revolut_state" text,
	"saved_payment_method_id" text,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "payments_kind_check" CHECK ("kind" IN ('subscription','one_off')),
	CONSTRAINT "payments_status_check" CHECK ("status" IN ('pending','authorised','completed','failed','cancelled','refunded'))
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"order_id" text NOT NULL,
	"merchant_order_ext_ref" text,
	"payment_id" uuid,
	"raw" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_subscription" ADD CONSTRAINT "company_subscription_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_subscription" ADD CONSTRAINT "company_subscription_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_subscription" ADD CONSTRAINT "company_subscription_pending_plan_id_fk" FOREIGN KEY ("pending_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_prices_plan_period_currency_key" ON "plan_prices" ("plan_id","period","currency");--> statement-breakpoint
-- Partial unique index — HAND-AUTHORED (drizzle-kit serializes WHERE broken, §3.3).
CREATE UNIQUE INDEX "company_subscription_company_active_key" ON "company_subscription" ("company_id") WHERE "status" IN ('trialing','active','past_due');--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments" ("idempotency_key");--> statement-breakpoint
-- Partial unique index — HAND-AUTHORED (drizzle-kit serializes WHERE broken, §3.4).
CREATE UNIQUE INDEX "payments_revolut_order_id_key" ON "payments" ("revolut_order_id") WHERE "revolut_order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_event_order_key" ON "payment_events" ("event","order_id");
--> statement-breakpoint
-- ── Seed fallback (§4.3 note) ────────────────────────────────────────────────
-- The catalogue seed is normally applied via `npm run db:seed` (seed.ts, T-A2).
-- For a prod apply WITHOUT Node (phpPgAdmin/psql only, §4.5), uncomment the two
-- idempotent INSERTs below. `features` JSON = PLAN_FEATURES[id] minus {id,name,
-- price} (PlanFeaturesConfig, §3.6; includes `integrations` — Ф-1). `plan_prices`
-- amount_minor = EUR cents (monthly = price×100, annual = monthly×10, §5.2).
--
-- INSERT INTO "plans" ("id","name","sort_order","features") VALUES
--   ('trial','Trial',0,'{"scope3":false,"scope3Full":false,"reports":["gri"],"maxReportsPerMonth":3,"socialParams":false,"governanceParams":false,"supplyChain":false,"goals":false,"integrations":["starter"],"maxCompanies":1,"maxTeamMembers":1,"dataExport":false,"apiAccess":false}'::jsonb),
--   ('starter','Starter',1,'{"scope3":true,"scope3Full":false,"reports":["gri","esrs"],"maxReportsPerMonth":10,"socialParams":true,"governanceParams":true,"supplyChain":false,"goals":false,"integrations":["starter"],"maxCompanies":1,"maxTeamMembers":5,"dataExport":true,"apiAccess":false}'::jsonb),
--   ('pro','Pro',2,'{"scope3":true,"scope3Full":true,"reports":["gri","esrs","cdp","ungc"],"maxReportsPerMonth":50,"socialParams":true,"governanceParams":true,"supplyChain":true,"goals":true,"integrations":["starter","pro"],"maxCompanies":3,"maxTeamMembers":15,"dataExport":true,"apiAccess":false}'::jsonb),
--   ('enterprise','Enterprise',3,'{"scope3":true,"scope3Full":true,"reports":["gri","esrs","cdp","ungc","taxonomy","tcfd"],"maxReportsPerMonth":-1,"socialParams":true,"governanceParams":true,"supplyChain":true,"goals":true,"integrations":["starter","pro","enterprise"],"maxCompanies":-1,"maxTeamMembers":-1,"dataExport":true,"apiAccess":true}'::jsonb)
-- ON CONFLICT ("id") DO NOTHING;
-- INSERT INTO "plan_prices" ("id","plan_id","period","currency","amount_minor") VALUES
--   (gen_random_uuid(),'trial','monthly','EUR',0),
--   (gen_random_uuid(),'trial','annual','EUR',0),
--   (gen_random_uuid(),'starter','monthly','EUR',2000),
--   (gen_random_uuid(),'starter','annual','EUR',20000),
--   (gen_random_uuid(),'pro','monthly','EUR',10000),
--   (gen_random_uuid(),'pro','annual','EUR',100000),
--   (gen_random_uuid(),'enterprise','monthly','EUR',100000),
--   (gen_random_uuid(),'enterprise','annual','EUR',1000000)
-- ON CONFLICT ("plan_id","period","currency") DO NOTHING;
