-- The rules engine, removed.
--
-- Berry's automations were a trigger, a graph of steps, and a versioned
-- definition to configure it all. The concept did not earn its complexity: a
-- person who wants a condition respected writes it in the task's description,
-- where the agent reading the task will see it — rather than in a rule that
-- lives somewhere else and has to be kept in agreement with the work.
--
-- Seven tables go, and the three columns on other tables that pointed at
-- them. Nothing is preserved: an automation's definition means nothing
-- without the engine that ran it, and a run of one is a record of a thing
-- that can no longer happen.

-- Pointers first, so the drops below are not blocked by a foreign key from a
-- table that is staying.
ALTER TABLE approvals DROP COLUMN IF EXISTS automation_id;
ALTER TABLE approvals DROP COLUMN IF EXISTS automation_run_id;
ALTER TABLE approvals DROP COLUMN IF EXISTS automation_step_run_id;
ALTER TABLE inbox_items DROP COLUMN IF EXISTS automation_run_id;
ALTER TABLE integration_audit_events DROP COLUMN IF EXISTS automation_step_run_id;

-- An approval addressed to a step of an automation has nothing left to gate.
-- Resolved rather than deleted: it happened, and a person may have decided
-- it. `expired` is the status that already means "this one is no longer
-- anybody's to answer".
UPDATE approvals
   SET status = 'expired',
       decision_note = COALESCE(decision_note, '') ||
          CASE WHEN COALESCE(decision_note, '') = '' THEN '' ELSE E'\n\n' END ||
          'Automations were retired; this approval no longer gates anything.',
       resolved_at = COALESCE(resolved_at, now()),
       updated_at = now()
 WHERE kind IN ('automation_activation', 'automation_step')
   AND status = 'pending';

-- Dependency order is handled by CASCADE, which here only ever reaches other
-- tables in this list — every pointer from a surviving table was dropped
-- above.
DROP TABLE IF EXISTS automation_issue_origins CASCADE;
DROP TABLE IF EXISTS automation_run_events CASCADE;
DROP TABLE IF EXISTS automation_trigger_receipts CASCADE;
DROP TABLE IF EXISTS automation_step_runs CASCADE;
DROP TABLE IF EXISTS automation_runs CASCADE;
DROP TABLE IF EXISTS automation_versions CASCADE;
DROP TABLE IF EXISTS automations CASCADE;
