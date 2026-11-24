-- F03: immutable input context, separate from result lines (including empty runs).
-- No backfill: current registry data is not evidence of historical inputs.
CREATE TABLE calculation_run_context (
  run_id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES report_revision(id),
  calculated_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  CONSTRAINT calculation_run_context_version_check
    CHECK (snapshot @> '{"version": 1}'::jsonb)
);
CREATE INDEX calculation_run_context_revision_idx
  ON calculation_run_context(company_id, revision_id, calculated_at);
