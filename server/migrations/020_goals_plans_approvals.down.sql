-- Documentation only: Berry migrations are forward-only and this file is not
-- embedded or executed. It records what a manual revert of 020 would involve.
--
-- Reverting narrows plans back to orchestrator briefs, so AI and manual plans
-- (which carry no project) must go before project_id becomes NOT NULL again.
-- Everything else is additive and drops cleanly once its dependants are gone.

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_goal_fk;
ALTER TABLE conversations DROP COLUMN IF EXISTS goal_id;

DROP TABLE IF EXISTS automation_issue_origins;
DROP TRIGGER IF EXISTS berry_issue_dependencies_validate ON issue_dependencies;
DROP FUNCTION IF EXISTS berry_validate_issue_dependency();
DROP TABLE IF EXISTS issue_dependencies;

DROP TRIGGER IF EXISTS berry_issues_block_unapproved_start ON issues;
DROP FUNCTION IF EXISTS berry_block_unapproved_issue_start();
DROP TABLE IF EXISTS approvals;

DROP TABLE IF EXISTS planner_events;
DROP TABLE IF EXISTS plan_versions;

DELETE FROM plans WHERE source <> 'orchestrator';
DROP INDEX IF EXISTS plans_goal_idx;
DROP INDEX IF EXISTS plans_one_open_per_goal_key;
ALTER TABLE plans
    DROP CONSTRAINT IF EXISTS plans_confidence_ck,
    DROP CONSTRAINT IF EXISTS plans_compile_status_ck,
    DROP CONSTRAINT IF EXISTS plans_validation_status_ck,
    DROP CONSTRAINT IF EXISTS plans_generation_status_ck,
    DROP CONSTRAINT IF EXISTS plans_ir_ck,
    DROP CONSTRAINT IF EXISTS plans_scope_ck,
    DROP CONSTRAINT IF EXISTS plans_source_ck,
    DROP CONSTRAINT IF EXISTS plans_goal_fk;
ALTER TABLE plans
    DROP COLUMN IF EXISTS created_by,
    DROP COLUMN IF EXISTS conversation_id,
    DROP COLUMN IF EXISTS compiled_at,
    DROP COLUMN IF EXISTS compile_error,
    DROP COLUMN IF EXISTS compile_status,
    DROP COLUMN IF EXISTS validation_status,
    DROP COLUMN IF EXISTS generation_error,
    DROP COLUMN IF EXISTS generation_status,
    DROP COLUMN IF EXISTS confidence,
    DROP COLUMN IF EXISTS planner_version,
    DROP COLUMN IF EXISTS current_version,
    DROP COLUMN IF EXISTS ir_version,
    DROP COLUMN IF EXISTS ir,
    DROP COLUMN IF EXISTS source_prompt,
    DROP COLUMN IF EXISTS source,
    DROP COLUMN IF EXISTS board_id,
    DROP COLUMN IF EXISTS goal_id;
ALTER TABLE plans ALTER COLUMN project_id SET NOT NULL;

DROP TABLE IF EXISTS goal_issues;
DROP TABLE IF EXISTS goals;
