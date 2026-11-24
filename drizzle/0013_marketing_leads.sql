-- 0013_marketing_leads.sql — WHERE A LANDING-PAGE ENQUIRY LANDS.
--
-- The first public page (ТЗ v1.0, 15.08.2026) has exactly two conversion
-- targets: the Demo form and the VESG Pro form (§11). Its acceptance criteria
-- (§16) contain one sentence that decides the shape of this table:
--
--     "success отправляется только после сохранения лида"
--
-- i.e. the browser may show "sent" ONLY once the lead is durably stored. That
-- rules out the obvious shortcut — POST the form, fire a webhook or an SMTP
-- send, answer 200 — because both of those succeed-then-vanish: a mail relay
-- that accepts and later bounces, or a CRM that is briefly down, produce a
-- visitor who believes they contacted us and a company that never heard from
-- them. §17 also leaves the CRM recipient as an OPEN decision, so there is no
-- system to hand the lead to yet. The database is the one place that can hold a
-- lead correctly today and still hand it onward tomorrow.
--
-- ONE TABLE, TWO FORMS. The Demo and VESG forms share five fields and differ in
-- four each (§11). Two tables would duplicate the shared columns, the retention
-- rule and every future export; a jsonb blob would make "how many Slovenian
-- micro companies asked about VESG" an untypable question. So: shared columns
-- are real columns, form-specific ones are nullable columns, and a CHECK makes
-- each form fill in its own set. The CHECK is the part that matters — without it
-- "nullable" quietly becomes "optional", and a Demo lead saved with no company
-- size is indistinguishable from a VESG lead that lost one.
--
-- WHAT IS DELIBERATELY *NOT* STORED. No raw IP address: rate limiting needs to
-- recognise a repeat sender, not to identify a person, and a salted hash does
-- the first without the second. `consent_privacy_at` is a TIMESTAMP rather than
-- a boolean for the same reason it is a separate un-preticked checkbox in the
-- UI (§11): consent is an event with a time, and "true" cannot be evidenced.
-- Marketing opt-in is a SECOND, independent timestamp — bundling the two is the
-- precise thing the spec forbids.

CREATE TABLE IF NOT EXISTS marketing_lead (
  id                    uuid PRIMARY KEY,

  -- Which form produced this row. Drives the CHECK below and every downstream
  -- routing decision; never inferred from which columns happen to be filled.
  form_type             text        NOT NULL,

  -- Shared identity fields (§11: both forms require name, work email, company).
  full_name             text        NOT NULL,
  email                 text        NOT NULL,
  company               text        NOT NULL,

  -- Demo-form fields.
  country               text,
  entity_count          text,       -- '1' | '2-3' | '4-10' | '10+'
  site_count            text,
  interest              text,       -- starter | pro | enterprise | white_label

  -- VESG-form fields.
  in_slovenia           text,       -- yes | no
  company_size          text,       -- micro | small | medium | other
  has_employee          text,       -- yes | no | unknown
  reporting_period      text,

  -- Free text. Never forwarded to analytics (§12) — it is the field most likely
  -- to contain something personal that no schema anticipated.
  comment               text,

  -- Attribution (§11 "Передавать: lead_source, landing_version, selected_plan/
  -- path, UTM, referrer, consent timestamps").
  selected_plan         text,
  lead_source           text        NOT NULL DEFAULT 'landing',
  landing_version       text        NOT NULL,
  locale                text        NOT NULL,
  referrer_origin       text,       -- ORIGIN only; a full referrer can identify a person
  utm                   jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Consent, as events rather than flags.
  consent_privacy_at    timestamptz NOT NULL,
  consent_marketing_at  timestamptz,

  -- Abuse control. Salted (LEAD_IP_SALT) SHA-256 of the client IP: enough to
  -- recognise a flood, useless for identifying whose flood it was.
  ip_hash               char(64),

  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketing_lead_form_type_check
    CHECK (form_type IN ('demo', 'vesg')),

  -- Each form fills in its own block, and only its own. Stated as an
  -- implication per form so that adding a third form later fails loudly here
  -- rather than silently accepting a row with nothing in it.
  CONSTRAINT marketing_lead_demo_fields_check
    CHECK (form_type <> 'demo' OR (entity_count IS NOT NULL AND interest IS NOT NULL)),
  CONSTRAINT marketing_lead_vesg_fields_check
    CHECK (form_type <> 'vesg' OR (in_slovenia IS NOT NULL AND company_size IS NOT NULL)),

  -- Enumerations, spelled out here rather than only in TypeScript: the API can
  -- be bypassed (a future admin import, a psql session), the CHECK cannot.
  CONSTRAINT marketing_lead_interest_check
    CHECK (interest IS NULL OR interest IN ('starter', 'pro', 'enterprise', 'white_label')),
  CONSTRAINT marketing_lead_entity_count_check
    CHECK (entity_count IS NULL OR entity_count IN ('1', '2-3', '4-10', '10+')),
  CONSTRAINT marketing_lead_in_slovenia_check
    CHECK (in_slovenia IS NULL OR in_slovenia IN ('yes', 'no')),
  CONSTRAINT marketing_lead_company_size_check
    CHECK (company_size IS NULL OR company_size IN ('micro', 'small', 'medium', 'other')),
  CONSTRAINT marketing_lead_has_employee_check
    CHECK (has_employee IS NULL OR has_employee IN ('yes', 'no', 'unknown'))
);

-- "The new leads, newest first" is how this table will always be read, whether
-- by a CRM sync job or by a person catching up on a Monday.
CREATE INDEX IF NOT EXISTS marketing_lead_created_idx
  ON marketing_lead (created_at DESC);

-- The rate limiter's read path: "how many rows from this sender in the last N
-- minutes". Without the composite index that becomes a full scan on every
-- single form submission, i.e. the cheapest possible denial of service.
CREATE INDEX IF NOT EXISTS marketing_lead_ip_hash_created_idx
  ON marketing_lead (ip_hash, created_at DESC);
