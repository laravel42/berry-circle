-- Documentation only: Berry migrations are forward-only and this file is not
-- embedded or executed. It records what a manual revert of 021 would involve.
--
-- The deferred foreign keys 021 added to the 020 tables go first, then the
-- ledgers in dependency order. Approval rows that point at an automation lose
-- their target and are removed rather than left dangling.

ALTER TABLE automation_issue_origins
    DROP CONSTRAINT IF EXISTS automation_issue_origins_step_run_fk,
    DROP CONSTRAINT IF EXISTS automation_issue_origins_run_fk,
    DROP CONSTRAINT IF EXISTS automation_issue_origins_automation_fk;
DROP INDEX IF EXISTS automation_issue_origins_run_idx;
DELETE FROM automation_issue_origins;

DELETE FROM approvals WHERE automation_id IS NOT NULL OR automation_run_id IS NOT NULL OR automation_step_run_id IS NOT NULL;
ALTER TABLE approvals
    DROP CONSTRAINT IF EXISTS approvals_automation_step_run_fk,
    DROP CONSTRAINT IF EXISTS approvals_automation_run_fk,
    DROP CONSTRAINT IF EXISTS approvals_automation_fk;

DROP TABLE IF EXISTS integration_webhook_deliveries;
DROP TABLE IF EXISTS automation_trigger_receipts;
DROP FUNCTION IF EXISTS berry_allocate_automation_run_event_sequence(uuid);
DROP TABLE IF EXISTS automation_run_events;
DROP TABLE IF EXISTS automation_step_runs;
DROP TABLE IF EXISTS automation_runs;
DROP TABLE IF EXISTS automation_versions;
DROP TABLE IF EXISTS automations;
