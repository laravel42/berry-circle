-- Undo 038. The schema it describes is not decided yet.
--
-- 038 was written alongside docs/adr/0010-goals-as-derived-task-groups.md and
-- was not meant to run until that record was accepted and the server code
-- followed. It ran anyway: the migration runner applies what it finds on boot,
-- so rebuilding the API image was enough to apply it, and the goals mount —
-- which still selects `source` — began failing with "column goal.source does
-- not exist".
--
-- Forward-only means the undo is its own migration rather than an edit to 038.
-- When ADR-0010 is accepted, 038's content comes back as a new number, next to
-- the code that needs it.

ALTER TABLE goal_issues DROP CONSTRAINT IF EXISTS goal_issues_issue_project_fk;
ALTER TABLE goal_issues DROP CONSTRAINT IF EXISTS goal_issues_goal_project_fk;
ALTER TABLE goal_issues DROP COLUMN IF EXISTS project_id;

ALTER TABLE issue_project_links DROP CONSTRAINT IF EXISTS issue_project_links_workspace_project_key;
ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_workspace_project_key;

DROP FUNCTION IF EXISTS berry_goal_derived_status(uuid);

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_live_project_ck;

-- `source` and `source_prompt` come back with the defaults 020 gave them, so a
-- goal written before 038 reads the way it did.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS source_prompt text;

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_source_ck;
ALTER TABLE goals
    ADD CONSTRAINT goals_source_ck CHECK (source IN ('manual', 'ai'));

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_source_prompt_length_ck;
ALTER TABLE goals
    ADD CONSTRAINT goals_source_prompt_length_ck
    CHECK (source_prompt IS NULL OR char_length(source_prompt) <= 20000);

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_status_ck;
ALTER TABLE goals
    ADD CONSTRAINT goals_status_ck
    CHECK (status IN ('draft', 'planned', 'active', 'blocked', 'completed', 'cancelled'));
