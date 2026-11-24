-- 0021_plans_simplified_esrs.sql — THE SIMPLIFIED-ESRS MODULE FLAG (партия 9).
--
-- WHY. 0019 put the 50 datapoints of the simplified ESRS (C(2026)5010, adopted
-- 03.07.2026, not yet in force) into `metric_catalog` as `standard='esrs'`.
-- Nothing gated them: any plan could record a value against one. This flag is
-- the gate — `simplifiedEsrs` on `plans.features`, read the same way
-- `vsmeComprehensive` is (PG-6 style: a MODULE, refused 422, never a quota
-- 402). Pro and Enterprise have it; Trial and Starter do not. The value is the
-- one `PLAN_FEATURES` in `src/shared/plans.ts` states; `plan-catalog.test.ts`
-- and `plans-migration.integration.test.ts` hold the two in step.
--
-- ADDITIVE. `features || '{…}'` writes one key and keeps every other key of the
-- row (0004's own convention). No DDL, nothing PG-14-only. A row that does not
-- exist yet (a database that never ran 0004) gets nothing here and falls back
-- to the code default when read (`planRowsToFeatures` spreads `PLAN_FEATURES`
-- under the stored row), so the flag is never `undefined` at runtime.
-- Re-running is a no-op.
UPDATE plans SET features = features || '{"simplifiedEsrs": false}'::jsonb
WHERE id IN ('trial', 'starter');
UPDATE plans SET features = features || '{"simplifiedEsrs": true}'::jsonb
WHERE id IN ('pro', 'enterprise');
