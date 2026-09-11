-- Berry 175: what a quick action is actually used for, and how recently.
--
-- Quick actions were listed alphabetically, which is the one order that says
-- nothing: the list a workspace accumulates is long, and the two or three
-- actions anyone runs are scattered through it. A count and a last-used time
-- make "most used first" and "nobody has run this in three months" answerable
-- without reading the run ledger, which is partitioned by time and is the
-- wrong thing to aggregate on every settings page load.
--
-- Both are derived facts about the definition, so they live on it. A run that
-- is later deleted does not decrement the count — this measures how often the
-- action was reached for, not how many runs survive.
ALTER TABLE quick_action_definitions
    ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0;
ALTER TABLE quick_action_definitions
    ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'quick_action_definitions_use_count_ck'
    ) THEN
        ALTER TABLE quick_action_definitions ADD CONSTRAINT quick_action_definitions_use_count_ck
            CHECK (use_count >= 0);
    END IF;
END $$;

-- The settings page's order: most used first within a workspace, and the
-- archived rows it hides are excluded so the index stays the size of what is
-- actually listed.
CREATE INDEX IF NOT EXISTS quick_action_definitions_usage_idx
    ON quick_action_definitions (workspace_id, use_count DESC)
    WHERE archived_at IS NULL;
