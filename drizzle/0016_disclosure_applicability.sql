-- 0016_disclosure_applicability.sql — A DATAPOINT CAN BE DECLARED NOT
-- APPLICABLE, OR OMITTED AS SENSITIVE, AND THE DECISION IS A ROW.
--
-- WHY. The stage-1 specification (13.08.2026, §5.2) defines readiness per
-- VSME datapoint with six statuses; two of them — «неприменимо с причиной» and
-- «исключено как чувствительное» — are DECISIONS a person takes, not facts the
-- data implies. `disclosure_record` cannot carry them: a record IS a value, and
-- a value-less record is the thing §4.12 forbids. So the decision gets its own
-- table, keyed like a record (revision × metric), with the reason mandatory —
-- the same shape as `period_scope.exclusion_reason` (D15, VAL-101) one level
-- down. VSME B1 §24(b) itself asks for the list of omitted sensitive
-- disclosures; this is where that list comes from.
--
-- ADDITIVE. Nothing existing is altered. `ON DELETE CASCADE` from the revision:
-- a decision belongs to the revision it was taken for, exactly like its records,
-- and the next revision starts undecided unless seeding copies it.
--
-- PostgreSQL 13 (production, see `.env.example`): no 14+ construct is used.

CREATE TABLE IF NOT EXISTS disclosure_applicability (
  id           uuid PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  revision_id  uuid NOT NULL REFERENCES report_revision(id) ON DELETE CASCADE,
  metric_key   text NOT NULL REFERENCES metric_catalog(metric_key),
  status       text NOT NULL,
  reason       text NOT NULL,
  decided_by   uuid REFERENCES profiles(id),            -- DM-13
  decided_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT disclosure_applicability_status_check
    CHECK (status IN ('not_applicable','sensitive_omitted')),
  CONSTRAINT disclosure_applicability_reason_check
    CHECK (length(btrim(reason)) > 0),
  CONSTRAINT disclosure_applicability_revision_metric_key
    UNIQUE (revision_id, metric_key)
);

CREATE INDEX IF NOT EXISTS disclosure_applicability_company_revision_idx
  ON disclosure_applicability (company_id, revision_id);
