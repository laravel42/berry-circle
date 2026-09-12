-- Berry migration 180: an OAuth state for a deployment nobody has signed into.
--
-- The GitHub App's credentials live in this database, and the App is created
-- from the browser through the manifest flow. That flow needs a state row, and
-- until now a state row named a workspace and a user — neither of which exists
-- on a deployment where the App *is* what sign-in is waiting for. The first
-- person to set a server up therefore could not: creating the App required a
-- session, and a session required the App.
--
-- So both columns become nullable, and a row with no workspace and no user is
-- exactly the first-run setup case. Both or neither: a half-named state would
-- let a callback attribute an installation to a workspace with no one behind
-- it, and every other flow still writes both.
ALTER TABLE integration_oauth_states ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE integration_oauth_states ALTER COLUMN user_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'integration_oauth_states_actor_ck'
    ) THEN
        ALTER TABLE integration_oauth_states
            ADD CONSTRAINT integration_oauth_states_actor_ck
            CHECK ((workspace_id IS NULL) = (user_id IS NULL));
    END IF;
END $$;

COMMENT ON COLUMN integration_oauth_states.workspace_id IS
    'The workspace the flow belongs to; NULL only for first-run App setup.';
COMMENT ON COLUMN integration_oauth_states.user_id IS
    'Who started the flow; NULL only for first-run App setup, before any user.';
