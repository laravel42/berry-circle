-- Berry 174: a workspace's mark, and what it tells its agents.
--
-- `agent_context` is the workspace-wide half of the context an agent is given;
-- `users.description` (173) is the personal half. Kept as its own column
-- rather than folded into `settings`, because `settings` is a bounded struct
-- whose JSON key order is part of the wire contract, and because free text of
-- this size does not belong in a column read on every workspace lookup's
-- jsonb path.
--
-- `logo_url` is an address, not a file: Berry hosts no uploads, and the API
-- bound (2048) is the one `validAvatar` already enforces for a user's avatar.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_context text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_logo_url_length_ck'
    ) THEN
        ALTER TABLE workspaces ADD CONSTRAINT workspaces_logo_url_length_ck
            CHECK (logo_url IS NULL OR char_length(logo_url) <= 2048);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_agent_context_length_ck'
    ) THEN
        ALTER TABLE workspaces ADD CONSTRAINT workspaces_agent_context_length_ck
            CHECK (agent_context IS NULL OR char_length(agent_context) <= 10000);
    END IF;
END $$;
