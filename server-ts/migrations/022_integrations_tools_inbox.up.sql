-- Berry migration 022: registry-driven provider ids, step-run audit link,
-- approvals/goals/workflows in the inbox, model role agents.

-- 014 hard-codes provider IN ('github','slack','linear'). Providers and pieces
-- are registry-driven from here on; the DB only enforces the id format.
ALTER TABLE integration_connections DROP CONSTRAINT IF EXISTS integration_connections_provider_ck;
ALTER TABLE integration_connections ADD CONSTRAINT integration_connections_provider_ck CHECK (provider ~ '^[a-z][a-z0-9_]{1,63}$') NOT VALID;
ALTER TABLE integration_oauth_states DROP CONSTRAINT IF EXISTS integration_oauth_states_provider_ck;
ALTER TABLE integration_oauth_states ADD CONSTRAINT integration_oauth_states_provider_ck CHECK (provider ~ '^[a-z][a-z0-9_]{1,63}$') NOT VALID;
ALTER TABLE integration_permissions DROP CONSTRAINT IF EXISTS integration_permissions_provider_ck;
ALTER TABLE integration_permissions ADD CONSTRAINT integration_permissions_provider_ck CHECK (provider ~ '^[a-z][a-z0-9_]{1,63}$') NOT VALID;
ALTER TABLE integration_audit_events DROP CONSTRAINT IF EXISTS integration_audit_provider_ck;
ALTER TABLE integration_audit_events ADD CONSTRAINT integration_audit_provider_ck CHECK (provider ~ '^[a-z][a-z0-9_]{1,63}$') NOT VALID;
ALTER TABLE integration_audit_events ADD COLUMN IF NOT EXISTS automation_step_run_id uuid REFERENCES automation_step_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS integration_audit_events_step_run_idx ON integration_audit_events (automation_step_run_id) WHERE automation_step_run_id IS NOT NULL;

-- 007 declared the inbox category CHECK without a name; find it by definition
-- inside the current schema (migration tests use an isolated search_path).
DO $$
DECLARE category_constraint text;
BEGIN
    SELECT con.conname INTO category_constraint
      FROM pg_constraint AS con
      JOIN pg_class AS rel ON rel.oid = con.conrelid
      JOIN pg_namespace AS nsp ON nsp.oid = rel.relnamespace
     WHERE rel.relname = 'inbox_items'
       AND nsp.nspname = current_schema()
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%category%agentActivity%'
     LIMIT 1;
    IF category_constraint IS NOT NULL THEN
        EXECUTE format('ALTER TABLE inbox_items DROP CONSTRAINT %I', category_constraint);
    END IF;
END
$$;
ALTER TABLE inbox_items DROP CONSTRAINT IF EXISTS inbox_items_category_ck;
ALTER TABLE inbox_items ADD CONSTRAINT inbox_items_category_ck CHECK (category IN (
    'assignments','statusChanges','comments','mentions','updates','agentActivity','approvals','goals','workflows')) NOT VALID;
ALTER TABLE inbox_items
    ADD COLUMN IF NOT EXISTS approval_id uuid REFERENCES approvals(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS goal_id uuid REFERENCES goals(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS automation_run_id uuid REFERENCES automation_runs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES plans(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS inbox_items_approval_idx ON inbox_items (recipient_id, approval_id) WHERE approval_id IS NOT NULL;
ALTER TABLE notification_preferences ALTER COLUMN preferences SET DEFAULT
    '{"inApp":{"assignments":true,"statusChanges":true,"comments":true,"mentions":true,"updates":true,"agentActivity":true,"approvals":true,"goals":true,"workflows":true}}'::jsonb;

-- Agents: Berry-authored skills (planner vocabulary) beside runtime-owned
-- capabilities (tool names overwritten on every sync), plus the manifest
-- limits snapshot the registry surfaces (max_tokens, max_llm_tokens_per_hour).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS skills text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE agents ADD COLUMN IF NOT EXISTS manifest_limits jsonb;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_manifest_limits_ck;
ALTER TABLE agents ADD CONSTRAINT agents_manifest_limits_ck CHECK (manifest_limits IS NULL OR (jsonb_typeof(manifest_limits) = 'object' AND octet_length(manifest_limits::text) <= 2048)) NOT VALID;

-- Lean planner role agents provisioned by Berry (orchestration/bootstrap.go
-- precedent). Global by design: one agent per role serves every workspace and
-- never appears in the workspace agents table.
CREATE TABLE IF NOT EXISTS model_role_agents (
    role text PRIMARY KEY,
    runtime_agent_id text NOT NULL UNIQUE,
    upstream_name text NOT NULL UNIQUE,
    model_provider text NOT NULL,
    model_name text NOT NULL,
    prompt_version text NOT NULL,
    max_tokens integer,
    max_llm_tokens_per_hour bigint,
    status text NOT NULL DEFAULT 'unknown',
    last_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT model_role_agents_role_ck CHECK (role IN ('planner','repair','critic','classifier')),
    CONSTRAINT model_role_agents_status_ck CHECK (status IN ('available','offline','unknown'))
);
DROP TRIGGER IF EXISTS berry_model_role_agents_set_updated_at ON model_role_agents;
CREATE TRIGGER berry_model_role_agents_set_updated_at BEFORE UPDATE ON model_role_agents FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
