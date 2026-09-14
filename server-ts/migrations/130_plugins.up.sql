-- Workspace plugins: a package (manifest plus files) installed into one
-- workspace, calling back into Berry with short-lived plugin tokens.
--
-- Every table carries workspace_id, even where the installation already
-- implies it, so a scoped query can filter on the column directly.

CREATE TABLE IF NOT EXISTS plugin_installations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    plugin_key text NOT NULL,
    name text NOT NULL,
    version text NOT NULL,
    manifest jsonb NOT NULL,
    source text NOT NULL,
    source_url text,
    base_url text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    granted_scopes text[] NOT NULL DEFAULT '{}',
    signing_secret_encrypted bytea NOT NULL,
    installed_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plugin_installations_key_ck CHECK (plugin_key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    CONSTRAINT plugin_installations_source_ck CHECK (source IN ('url', 'upload')),
    CONSTRAINT plugin_installations_source_url_ck CHECK ((source = 'url') = (source_url IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_installations_workspace_key
    ON plugin_installations (workspace_id, plugin_key);

CREATE TABLE IF NOT EXISTS plugin_files (
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path text NOT NULL,
    content text NOT NULL,
    PRIMARY KEY (installation_id, path),
    CONSTRAINT plugin_files_size_ck CHECK (octet_length(content) <= 262144)
);

CREATE TABLE IF NOT EXISTS plugin_secrets (
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    value_encrypted bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (installation_id, name),
    CONSTRAINT plugin_secrets_name_ck CHECK (name ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE TABLE IF NOT EXISTS plugin_storage (
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (installation_id, key),
    CONSTRAINT plugin_storage_key_ck CHECK (char_length(key) BETWEEN 1 AND 200)
);

CREATE TABLE IF NOT EXISTS plugin_invocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    kind text NOT NULL,
    trigger text NOT NULL,
    status text NOT NULL,
    http_status integer,
    duration_ms integer NOT NULL DEFAULT 0,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plugin_invocations_kind_ck CHECK (kind IN ('event', 'schedule', 'surface', 'mcp')),
    CONSTRAINT plugin_invocations_status_ck CHECK (status IN ('ok', 'error'))
);
CREATE INDEX IF NOT EXISTS plugin_invocations_recent
    ON plugin_invocations (installation_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS plugin_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    public_id text NOT NULL,
    secret_hash bytea NOT NULL,
    scopes text[] NOT NULL DEFAULT '{}',
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plugin_tokens_public_id_ck CHECK (public_id ~ '^[A-Za-z0-9_-]{16}$'),
    CONSTRAINT plugin_tokens_hash_ck CHECK (octet_length(secret_hash) = 32)
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_tokens_public_id_key ON plugin_tokens (public_id);
CREATE INDEX IF NOT EXISTS plugin_tokens_expiry ON plugin_tokens (expires_at);

CREATE TABLE IF NOT EXISTS plugin_hook_state (
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    hook_key text NOT NULL,
    interval_minutes integer NOT NULL,
    next_fire_at timestamptz NOT NULL,
    last_fired_at timestamptz,
    PRIMARY KEY (installation_id, hook_key),
    CONSTRAINT plugin_hook_state_interval_ck CHECK (interval_minutes BETWEEN 5 AND 10080)
);
CREATE INDEX IF NOT EXISTS plugin_hook_state_due ON plugin_hook_state (next_fire_at);

-- One row: how far the event hook runner has read outbox_events. Locked
-- FOR UPDATE SKIP LOCKED so exactly one server delivers each event.
CREATE TABLE IF NOT EXISTS plugin_event_cursor (
    id smallint PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    event_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    CONSTRAINT plugin_event_cursor_single_ck CHECK (id = 1)
);
INSERT INTO plugin_event_cursor (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS plugin_tool_approvals (
    installation_id uuid NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tool_name text NOT NULL,
    approved_by uuid NOT NULL REFERENCES users(id),
    approved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (installation_id, tool_name)
);

-- The hook runner reads outbox_events in (occurred_at, id) order every few
-- seconds; the existing index covers only unpublished rows.
CREATE INDEX IF NOT EXISTS outbox_events_occurred_order_idx
    ON outbox_events (occurred_at, id);
