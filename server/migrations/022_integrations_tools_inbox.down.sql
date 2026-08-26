-- Documentation only: Berry migrations are forward-only and this file is not
-- embedded or executed. It records what a manual revert of 022 would involve.
--
-- Rows written under the widened vocabulary must go before the narrower
-- checks return: inbox items in the new categories, integration rows for
-- providers 014 never allowed, and the role agents table as a whole.

DROP TABLE IF EXISTS model_role_agents;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_manifest_limits_ck;
ALTER TABLE agents DROP COLUMN IF EXISTS manifest_limits;
ALTER TABLE agents DROP COLUMN IF EXISTS skills;

ALTER TABLE notification_preferences ALTER COLUMN preferences SET DEFAULT
    '{"inApp":{"assignments":true,"statusChanges":true,"comments":true,"mentions":true,"updates":true,"agentActivity":true}}'::jsonb;
DELETE FROM inbox_items WHERE category IN ('approvals', 'goals', 'workflows');
DROP INDEX IF EXISTS inbox_items_approval_idx;
ALTER TABLE inbox_items
    DROP COLUMN IF EXISTS plan_id,
    DROP COLUMN IF EXISTS automation_run_id,
    DROP COLUMN IF EXISTS goal_id,
    DROP COLUMN IF EXISTS approval_id;
ALTER TABLE inbox_items DROP CONSTRAINT IF EXISTS inbox_items_category_ck;
ALTER TABLE inbox_items ADD CONSTRAINT inbox_items_category_ck CHECK (category IN (
    'assignments','statusChanges','comments','mentions','updates','agentActivity'));

DROP INDEX IF EXISTS integration_audit_events_step_run_idx;
ALTER TABLE integration_audit_events DROP COLUMN IF EXISTS automation_step_run_id;
DELETE FROM integration_audit_events WHERE provider NOT IN ('github', 'slack', 'linear');
DELETE FROM integration_permissions WHERE provider NOT IN ('github', 'slack', 'linear');
DELETE FROM integration_oauth_states WHERE provider NOT IN ('github', 'slack', 'linear');
DELETE FROM integration_connections WHERE provider NOT IN ('github', 'slack', 'linear');
ALTER TABLE integration_audit_events DROP CONSTRAINT IF EXISTS integration_audit_provider_ck;
ALTER TABLE integration_audit_events ADD CONSTRAINT integration_audit_provider_ck CHECK (provider IN ('github', 'slack', 'linear'));
ALTER TABLE integration_permissions DROP CONSTRAINT IF EXISTS integration_permissions_provider_ck;
ALTER TABLE integration_permissions ADD CONSTRAINT integration_permissions_provider_ck CHECK (provider IN ('github', 'slack', 'linear'));
ALTER TABLE integration_oauth_states DROP CONSTRAINT IF EXISTS integration_oauth_states_provider_ck;
ALTER TABLE integration_oauth_states ADD CONSTRAINT integration_oauth_states_provider_ck CHECK (provider IN ('github', 'slack', 'linear'));
ALTER TABLE integration_connections DROP CONSTRAINT IF EXISTS integration_connections_provider_ck;
ALTER TABLE integration_connections ADD CONSTRAINT integration_connections_provider_ck CHECK (provider IN ('github', 'slack', 'linear'));
