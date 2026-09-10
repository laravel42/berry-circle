-- Reverses 053 for a deployment rolling back ADR-0014. Tasks with no issue
-- cannot survive the NOT NULL restored below, so they are deleted first.
DROP TABLE IF EXISTS task_tokens;
DELETE FROM runs WHERE issue_id IS NULL;
DELETE FROM run_events WHERE issue_id IS NULL;
DROP TRIGGER IF EXISTS berry_runs_fill_workspace ON runs;
DROP FUNCTION IF EXISTS berry_runs_fill_workspace();
DROP INDEX IF EXISTS runs_claim_order_idx;
DROP INDEX IF EXISTS runs_runtime_active_idx;
DROP INDEX IF EXISTS runs_workspace_created_idx;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_ck;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_source_ck;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_task_target_ck;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_issue_board_pair_ck;
ALTER TABLE run_events ALTER COLUMN issue_id SET NOT NULL;
ALTER TABLE run_events ALTER COLUMN board_id SET NOT NULL;
ALTER TABLE runs ALTER COLUMN issue_id SET NOT NULL;
ALTER TABLE runs ALTER COLUMN board_id SET NOT NULL;
ALTER TABLE runs
    DROP COLUMN IF EXISTS result, DROP COLUMN IF EXISTS completion_spec,
    DROP COLUMN IF EXISTS runtime_session_id, DROP COLUMN IF EXISTS runtime_id,
    DROP COLUMN IF EXISTS priority, DROP COLUMN IF EXISTS autopilot_run_id,
    DROP COLUMN IF EXISTS chat_session_id, DROP COLUMN IF EXISTS prompt,
    DROP COLUMN IF EXISTS source, DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS workspace_id;
ALTER TABLE agents DROP COLUMN IF EXISTS runtime_profile_id, DROP COLUMN IF EXISTS runtime_id;
DROP TABLE IF EXISTS runtime_profiles;
DROP TABLE IF EXISTS agent_runtimes;
