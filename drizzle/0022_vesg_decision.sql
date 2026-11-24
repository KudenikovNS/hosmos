-- 0022_vesg_decision.sql — THE MANUAL ITEMS OF THE VESG VOUCHER CHECKLIST.
--
-- WHY. The expert's checklist (06.09.2026, sheet «VESG - чеклист») lists 16
-- requirements of the Slovenian VESG voucher (SPS, «vavčer za pripravo
-- prostovoljnega poročila o trajnostnosti»). Twelve are judged from the data
-- HOSMOS already holds (`src/server/vesg/evaluate.ts`); four are outside the
-- platform — the co-financing budget, the external expert's contract, the
-- publication on AJPES and the application through the SPS ePortal — and can
-- only be CONFIRMED by a person, with a note (an AJPES URL, a contract date).
-- That confirmation is a row here: one per company per requirement, like
-- `disclosure_applicability` (0016) is one per revision per datapoint.
--
-- ADDITIVE. A new table, nothing existing altered; PostgreSQL 13 constructs
-- only (production, see `.env.example`). `ON DELETE CASCADE` from the company.
-- The requirement key is not a FK — the list lives in code (`VESG_REQUIREMENTS`)
-- and a key the code no longer knows is simply not shown.

CREATE TABLE IF NOT EXISTS vesg_decision (
  id               uuid PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  requirement_key  text NOT NULL,
  confirmed        boolean NOT NULL DEFAULT false,
  note             text,
  decided_by       uuid REFERENCES profiles(id),          -- DM-13
  decided_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vesg_decision_requirement_key_check
    CHECK (length(btrim(requirement_key)) > 0),
  CONSTRAINT vesg_decision_company_requirement_key
    UNIQUE (company_id, requirement_key)
);
