-- F01: factors are shared, but their DQ assessments belong to companies.
-- Relax the old global key to one assessment per company and object/version.
-- Existing rows, ids, scores and authors are preserved. Previously overwritten
-- values cannot be reconstructed by this migration.
ALTER TABLE dq_assessment
  DROP CONSTRAINT dq_assessment_object_key,
  ADD CONSTRAINT dq_assessment_company_object_key
    UNIQUE (company_id, object_type, object_id);
