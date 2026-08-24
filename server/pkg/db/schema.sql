-- sqlc parser snapshot. Forward-only migrations remain the executable source
-- of truth; update this file with schema changes before running go generate.

CREATE TYPE issue_status AS ENUM (
    'backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'
);
CREATE TYPE issue_priority AS ENUM ('none', 'urgent', 'high', 'medium', 'low');
CREATE TYPE assignee_type AS ENUM ('user', 'agent');
CREATE TYPE user_role AS ENUM ('admin', 'member');
CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE run_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

CREATE TABLE berry_schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    checksum char(64) NOT NULL,
    applied_at timestamptz NOT NULL,
    duration_ms bigint NOT NULL
);

CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    name text NOT NULL,
    avatar_url text,
    role user_role NOT NULL,
    settings jsonb NOT NULL,
    onboarding_state jsonb NOT NULL,
    onboarding_completed_at timestamptz,
    last_workspace_id uuid,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    token_hash text NOT NULL,
    user_agent text,
    ip text,
    expires_at timestamptz NOT NULL,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL
);

CREATE TABLE workspaces (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    settings jsonb NOT NULL,
    created_by uuid REFERENCES users(id),
    creation_key_hash bytea,
    creation_fingerprint bytea,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz
);

CREATE TABLE workspace_memberships (
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    user_id uuid NOT NULL REFERENCES users(id),
    role workspace_role NOT NULL,
    joined_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE workspace_invitations (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    email text NOT NULL,
    role workspace_role NOT NULL,
    invited_by uuid NOT NULL REFERENCES users(id),
    token_hash bytea NOT NULL,
    idempotency_key_hash bytea NOT NULL,
    request_fingerprint bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    accepted_by uuid REFERENCES users(id),
    revoked_at timestamptz,
    created_at timestamptz NOT NULL
);

CREATE TABLE personal_api_tokens (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    name text NOT NULL,
    public_id text NOT NULL,
    secret_hash bytea NOT NULL,
    idempotency_key_hash bytea NOT NULL,
    request_fingerprint bytea NOT NULL,
    expires_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL
);

CREATE TABLE boards (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    columns jsonb NOT NULL,
    issue_counter integer NOT NULL,
    created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE issues (
    id uuid PRIMARY KEY,
    board_id uuid NOT NULL REFERENCES boards(id),
    number integer NOT NULL,
    title text NOT NULL,
    description text,
    status issue_status NOT NULL,
    priority issue_priority NOT NULL,
    sort_order integer NOT NULL,
    due_date timestamptz,
    assignee_type assignee_type,
    assignee_id uuid,
    openfang_run_id text,
    active_run_id uuid,
    created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE assignments (
    id uuid PRIMARY KEY,
    issue_id uuid NOT NULL REFERENCES issues(id),
    assignee_type assignee_type NOT NULL,
    assignee_id uuid NOT NULL,
    assigned_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL
);

CREATE TABLE comments (
    id uuid PRIMARY KEY,
    issue_id uuid NOT NULL REFERENCES issues(id),
    author_type assignee_type NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    parent_id uuid REFERENCES comments(id),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE runs (
    id uuid PRIMARY KEY,
    issue_id uuid NOT NULL REFERENCES issues(id),
    board_id uuid NOT NULL REFERENCES boards(id),
    agent_id uuid NOT NULL,
    status run_status NOT NULL,
    sequence bigint NOT NULL,
    summary text,
    input_tokens bigint NOT NULL,
    output_tokens bigint NOT NULL,
    total_tokens bigint NOT NULL,
    cost_micros bigint,
    currency text,
    failure_code text,
    failure_message text,
    failure_retryable boolean,
    upstream_agent_id text,
    upstream_request_id text,
    origin jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL
);

ALTER TABLE issues
    ADD CONSTRAINT issues_active_run_id_runs_id_fk
    FOREIGN KEY (active_run_id) REFERENCES runs(id);

CREATE TABLE run_events (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES runs(id),
    board_id uuid NOT NULL REFERENCES boards(id),
    issue_id uuid NOT NULL REFERENCES issues(id),
    sequence bigint NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    public boolean NOT NULL,
    occurred_at timestamptz NOT NULL
);

CREATE TABLE idempotency_records (
    id uuid PRIMARY KEY,
    actor_type text NOT NULL,
    actor_id uuid NOT NULL,
    method text NOT NULL,
    canonical_path text NOT NULL,
    canonical_path_hash bytea NOT NULL,
    idempotency_key text NOT NULL,
    fingerprint bytea NOT NULL,
    response_status integer,
    response_headers jsonb,
    response_body bytea,
    lease_expires_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    completed_at timestamptz
);

CREATE TABLE outbox_events (
    id uuid PRIMARY KEY,
    topic text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    workspace_id uuid,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL,
    available_at timestamptz NOT NULL,
    published_at timestamptz,
    attempts integer NOT NULL,
    last_error text
);
