-- Berry migration 014: workspace-scoped integration connections, permissions,
-- and an audit trail for every action an agent takes through one.
--
-- The runtime already ships MCP servers for these providers, so Berry does not
-- reimplement their APIs. What the runtime has no concept of is the part that
-- matters to a product: which workspace a connection belongs to, who connected
-- it, which agents may use which tools, and what was done with it. That is what
-- these tables own.

-- One connected provider account, scoped to a workspace.
--
-- A workspace may hold at most one live connection per provider: two would make
-- "which account is this agent acting as" unanswerable. Disconnected rows are
-- kept rather than deleted so an audit entry can still name the connection it
-- ran through, which is why the uniqueness is partial.
CREATE TABLE IF NOT EXISTS integration_connections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    provider text NOT NULL,
    -- The person who authorised it. Kept for provenance after they leave, which
    -- is why this nulls rather than cascading.
    connected_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    external_account_id text,
    external_account_name text,
    -- Credentials are sealed by internal/secrets before they arrive here. The
    -- column is bytea, not text, so a plaintext token cannot be written by
    -- accident: it would have to be encoded first, and nothing in the write path
    -- does that except the sealer.
    access_token_encrypted bytea,
    refresh_token_encrypted bytea,
    expires_at timestamptz,
    scopes text[] NOT NULL DEFAULT '{}',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'connected',
    -- Why a connection needs attention, shown in settings. Never a token.
    status_detail text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT integration_connections_provider_ck
        CHECK (provider IN ('github', 'slack', 'linear', 'notion', 'gmail')),
    CONSTRAINT integration_connections_status_ck
        CHECK (status IN ('connected', 'expired', 'revoked', 'error', 'disconnected')),
    CONSTRAINT integration_connections_metadata_object_ck
        CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_live_idx
    ON integration_connections (workspace_id, provider)
    WHERE status <> 'disconnected';

CREATE INDEX IF NOT EXISTS integration_connections_workspace_idx
    ON integration_connections (workspace_id, provider, created_at DESC);

-- An in-flight OAuth authorisation.
--
-- The state value is the CSRF defence, so it is stored hashed: a leaked table
-- read must not let an attacker complete someone else's flow. Rows expire, and
-- a used row is consumed rather than left replayable.
CREATE TABLE IF NOT EXISTS integration_oauth_states (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    state_hash bytea NOT NULL UNIQUE,
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider text NOT NULL,
    redirect_uri text NOT NULL,
    -- PKCE verifier where the provider supports it, sealed like any credential.
    code_verifier_encrypted bytea,
    scopes text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,

    CONSTRAINT integration_oauth_states_hash_ck
        CHECK (octet_length(state_hash) = 32),
    CONSTRAINT integration_oauth_states_provider_ck
        CHECK (provider IN ('github', 'slack', 'linear', 'notion', 'gmail')),
    CONSTRAINT integration_oauth_states_expiry_ck
        CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS integration_oauth_states_expiry_idx
    ON integration_oauth_states (expires_at)
    WHERE consumed_at IS NULL;

-- Which agent may call which tool on which provider.
--
-- Absence denies. A tool an agent has no row for cannot be called, so adding a
-- provider never silently widens what existing agents can reach. `tool = '*'`
-- grants every tool the provider offers at that access level.
CREATE TABLE IF NOT EXISTS integration_permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    -- Null agent means the grant applies to every agent in the workspace.
    agent_id uuid REFERENCES agents (id) ON DELETE CASCADE,
    provider text NOT NULL,
    tool text NOT NULL,
    -- The strongest effect this grant allows. A tool classified above its grant
    -- is refused, so a read grant can never execute a write.
    max_effect text NOT NULL DEFAULT 'read',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT integration_permissions_provider_ck
        CHECK (provider IN ('github', 'slack', 'linear', 'notion', 'gmail')),
    CONSTRAINT integration_permissions_effect_ck
        CHECK (max_effect IN ('read', 'write', 'external_side_effect', 'destructive'))
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_permissions_grant_idx
    ON integration_permissions (workspace_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), provider, tool);

-- Every integration action an agent takes.
--
-- Written before the call and completed after, so an action that never returns
-- still leaves a record. Inputs and results are summaries: a full payload would
-- put provider content, and eventually a credential, into a log.
CREATE TABLE IF NOT EXISTS integration_audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    connection_id uuid REFERENCES integration_connections (id) ON DELETE SET NULL,
    agent_id uuid REFERENCES agents (id) ON DELETE SET NULL,
    -- Set when the agent acted for a specific person rather than autonomously.
    user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    run_id uuid REFERENCES runs (id) ON DELETE SET NULL,
    provider text NOT NULL,
    tool text NOT NULL,
    effect text NOT NULL,
    input_summary text,
    result_summary text,
    status text NOT NULL DEFAULT 'started',
    approval_status text NOT NULL DEFAULT 'not_required',
    external_ids text[] NOT NULL DEFAULT '{}',
    external_url text,
    error_code text,
    error_message text,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    duration_ms bigint,

    CONSTRAINT integration_audit_provider_ck
        CHECK (provider IN ('github', 'slack', 'linear', 'notion', 'gmail')),
    CONSTRAINT integration_audit_effect_ck
        CHECK (effect IN ('read', 'write', 'external_side_effect', 'destructive')),
    CONSTRAINT integration_audit_status_ck
        CHECK (status IN ('started', 'succeeded', 'failed', 'denied', 'awaiting_approval')),
    CONSTRAINT integration_audit_approval_ck
        CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
    CONSTRAINT integration_audit_completion_ck
        CHECK ((completed_at IS NULL) = (duration_ms IS NULL))
);

CREATE INDEX IF NOT EXISTS integration_audit_workspace_idx
    ON integration_audit_events (workspace_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS integration_audit_agent_idx
    ON integration_audit_events (agent_id, started_at DESC)
    WHERE agent_id IS NOT NULL;
