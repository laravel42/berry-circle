-- Reverses 180. Rows from a first-run setup name no workspace and no user, so
-- they cannot satisfy the old NOT NULL and are deleted rather than invented.
DELETE FROM integration_oauth_states WHERE workspace_id IS NULL OR user_id IS NULL;

ALTER TABLE integration_oauth_states DROP CONSTRAINT IF EXISTS integration_oauth_states_actor_ck;
ALTER TABLE integration_oauth_states ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE integration_oauth_states ALTER COLUMN user_id SET NOT NULL;
