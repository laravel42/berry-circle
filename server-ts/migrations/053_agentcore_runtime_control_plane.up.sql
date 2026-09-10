-- Berry migration 053: the AgentCore Runtime control plane (ADR-0014).
--
-- Runtimes a workspace may dispatch to, the profiles that configure them,
-- task-scoped tokens the runtime calls Berry back with, and runs that are
-- tasks: a task may target an issue, a chat session, or nothing at all (a
-- completion), and carries its own prompt, priority and runtime.

CREATE TABLE IF NOT EXISTS agent_runtimes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    -- `platform` is the deployment's own runtime, one per workspace, synced
    -- from config at boot; `custom` is an ARN an owner registered.
    kind text NOT NULL,
    -- `agentcore` is invoked by ARN; `http` is the same image on a URL (local).
    driver text NOT NULL,
    arn text,
    endpoint_url text,
    qualifier text NOT NULL DEFAULT 'DEFAULT',
    region text,
    status text NOT NULL DEFAULT 'active',
    last_health_at timestamptz,
    last_health_error text,
    concurrency_limit integer,
    visibility text NOT NULL DEFAULT 'workspace',
    owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
    idle_timeout_s integer NOT NULL DEFAULT 3600,
    max_lifetime_s integer NOT NULL DEFAULT 28800,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_runtimes_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT agent_runtimes_name_ck CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT agent_runtimes_kind_ck CHECK (kind IN ('platform', 'custom')),
    CONSTRAINT agent_runtimes_driver_ck CHECK (driver IN ('agentcore', 'http')),
    CONSTRAINT agent_runtimes_target_ck CHECK (
        (driver = 'agentcore' AND (arn IS NOT NULL OR kind = 'platform'))
        OR (driver = 'http' AND (endpoint_url IS NOT NULL OR kind = 'platform'))
    ),
    CONSTRAINT agent_runtimes_status_ck CHECK (status IN ('active', 'unreachable', 'disabled')),
    CONSTRAINT agent_runtimes_visibility_ck CHECK (visibility IN ('private', 'workspace')),
    CONSTRAINT agent_runtimes_concurrency_ck CHECK (concurrency_limit IS NULL OR concurrency_limit > 0),
    CONSTRAINT agent_runtimes_idle_timeout_ck CHECK (idle_timeout_s BETWEEN 60 AND 28800),
    CONSTRAINT agent_runtimes_max_lifetime_ck CHECK (max_lifetime_s BETWEEN 60 AND 28800)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runtimes_one_default_key
    ON agent_runtimes (workspace_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS agent_runtimes_one_platform_key
    ON agent_runtimes (workspace_id) WHERE kind = 'platform';

CREATE TABLE IF NOT EXISTS runtime_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    runtime_id uuid NOT NULL,
    name text NOT NULL,
    -- Sealed with integrations/sealing.ts; a JSON object of env vars.
    env_sealed bytea,
    env_keys text[] NOT NULL DEFAULT '{}',
    model_default text,
    timeout_s integer,
    max_concurrency integer,
    idle_timeout_s integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT runtime_profiles_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT runtime_profiles_name_key UNIQUE (workspace_id, name),
    CONSTRAINT runtime_profiles_runtime_fk FOREIGN KEY (workspace_id, runtime_id)
        REFERENCES agent_runtimes (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT runtime_profiles_name_ck CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT runtime_profiles_timeout_ck CHECK (timeout_s IS NULL OR timeout_s BETWEEN 30 AND 28800),
    CONSTRAINT runtime_profiles_concurrency_ck CHECK (max_concurrency IS NULL OR max_concurrency > 0),
    CONSTRAINT runtime_profiles_idle_timeout_ck
        CHECK (idle_timeout_s IS NULL OR idle_timeout_s BETWEEN 60 AND 28800)
);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_id uuid
    REFERENCES agent_runtimes(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_profile_id uuid
    REFERENCES runtime_profiles(id) ON DELETE SET NULL;

-- Runs become tasks.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
UPDATE runs SET workspace_id = b.workspace_id FROM boards b WHERE b.id = runs.board_id AND runs.workspace_id IS NULL;
ALTER TABLE runs ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'agent';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'assignment';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS prompt text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS chat_session_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS autopilot_run_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_id uuid REFERENCES agent_runtimes(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_session_id text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS completion_spec jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE runs ALTER COLUMN issue_id DROP NOT NULL;
ALTER TABLE runs ALTER COLUMN board_id DROP NOT NULL;
ALTER TABLE run_events ALTER COLUMN issue_id DROP NOT NULL;
ALTER TABLE run_events ALTER COLUMN board_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_kind_ck') THEN
        ALTER TABLE runs ADD CONSTRAINT runs_kind_ck CHECK (kind IN ('agent', 'completion'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_source_ck') THEN
        ALTER TABLE runs ADD CONSTRAINT runs_source_ck CHECK (source IN (
            'assignment', 'mention', 'chat', 'autopilot', 'squad', 'quick_action', 'builder', 'completion'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_task_target_ck') THEN
        ALTER TABLE runs ADD CONSTRAINT runs_task_target_ck CHECK (
            kind = 'completion' OR issue_id IS NOT NULL OR chat_session_id IS NOT NULL);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_issue_board_pair_ck') THEN
        ALTER TABLE runs ADD CONSTRAINT runs_issue_board_pair_ck CHECK ((issue_id IS NULL) = (board_id IS NULL));
    END IF;
END
$$;

-- Writers that predate this migration (RunRepository.admit) name a board but
-- not a workspace; the board decides it.
CREATE OR REPLACE FUNCTION berry_runs_fill_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.workspace_id IS NULL AND NEW.board_id IS NOT NULL THEN
        SELECT workspace_id INTO NEW.workspace_id FROM boards WHERE id = NEW.board_id;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS berry_runs_fill_workspace ON runs;
CREATE TRIGGER berry_runs_fill_workspace
    BEFORE INSERT ON runs
    FOR EACH ROW EXECUTE FUNCTION berry_runs_fill_workspace();

CREATE INDEX IF NOT EXISTS runs_claim_order_idx
    ON runs (priority DESC, created_at ASC)
    WHERE status = 'queued' AND dispatch_state = 'pending';
CREATE INDEX IF NOT EXISTS runs_runtime_active_idx
    ON runs (runtime_id)
    WHERE status IN ('queued', 'running') AND runtime_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_workspace_created_idx
    ON runs (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    agent_id uuid NOT NULL,
    token_hash text NOT NULL,
    scopes text[] NOT NULL DEFAULT '{}',
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT task_tokens_hash_key UNIQUE (token_hash),
    CONSTRAINT task_tokens_hash_ck CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS task_tokens_run_idx ON task_tokens (run_id);
