-- Berry migration 100: autopilots.
--
-- An autopilot is a standing instruction: this agent (or squad), this
-- prompt, whenever a schedule comes round or a signed webhook arrives. Each
-- firing becomes one agent task through the shared task queue. There is no
-- step graph and no condition language; a person who wants a condition
-- writes it in the prompt, where the agent will read it.
--
-- Every table is scoped to a workspace directly, so a workspace delete takes
-- all of it and no query needs a join to know whose a row is.

CREATE TABLE IF NOT EXISTS autopilots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    assignee_type text NOT NULL,
    assignee_id uuid NOT NULL,                  -- agents.id or squads.id; checked on write, resolved on fire
    prompt_template text NOT NULL,
    execution_mode text NOT NULL,
    board_id uuid REFERENCES boards(id) ON DELETE SET NULL,   -- create_issue: where tasks are opened
    issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,   -- fixed_issue: the task every run works on
    status text NOT NULL DEFAULT 'active',
    version integer NOT NULL DEFAULT 1,         -- bumps when the definition changes (autopilot_versions row)
    quota_period text NOT NULL DEFAULT 'none',
    quota_max integer,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    CONSTRAINT autopilots_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT autopilots_name_ck CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT autopilots_description_ck CHECK (description IS NULL OR char_length(description) <= 5000),
    CONSTRAINT autopilots_assignee_type_ck CHECK (assignee_type IN ('agent', 'squad')),
    CONSTRAINT autopilots_prompt_ck CHECK (char_length(prompt_template) BETWEEN 1 AND 20000),
    CONSTRAINT autopilots_mode_ck CHECK (execution_mode IN ('create_issue', 'fixed_issue')),
    CONSTRAINT autopilots_status_ck CHECK (status IN ('active', 'paused', 'archived')),
    CONSTRAINT autopilots_archived_ck CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
    CONSTRAINT autopilots_version_ck CHECK (version >= 1),
    CONSTRAINT autopilots_quota_ck CHECK (
        quota_period IN ('none', 'hour', 'day', 'week')
        AND ((quota_period = 'none') = (quota_max IS NULL))
        AND (quota_max IS NULL OR quota_max BETWEEN 1 AND 10000)
    )
);
CREATE INDEX IF NOT EXISTS autopilots_workspace_order_idx
    ON autopilots (workspace_id, updated_at DESC, id DESC) WHERE archived_at IS NULL;
DROP TRIGGER IF EXISTS berry_autopilots_set_updated_at ON autopilots;
CREATE TRIGGER berry_autopilots_set_updated_at BEFORE UPDATE ON autopilots
    FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();

CREATE TABLE IF NOT EXISTS autopilot_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    autopilot_id uuid NOT NULL,
    version integer NOT NULL,
    snapshot jsonb NOT NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT autopilot_versions_autopilot_fk FOREIGN KEY (workspace_id, autopilot_id)
        REFERENCES autopilots(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT autopilot_versions_version_key UNIQUE (autopilot_id, version),
    CONSTRAINT autopilot_versions_snapshot_ck CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 65536)
);

CREATE TABLE IF NOT EXISTS autopilot_members (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    autopilot_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT autopilot_members_pkey PRIMARY KEY (autopilot_id, user_id),
    CONSTRAINT autopilot_members_autopilot_fk FOREIGN KEY (workspace_id, autopilot_id)
        REFERENCES autopilots(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT autopilot_members_role_ck CHECK (role IN ('collaborator', 'subscriber'))
);

CREATE TABLE IF NOT EXISTS autopilot_triggers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    autopilot_id uuid NOT NULL,
    kind text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    cron_expression text,
    timezone text,
    next_fire_at timestamptz,                    -- the next slot the scheduler will claim
    last_fired_at timestamptz,
    webhook_token_hash bytea,                    -- sha256 of the token; the token itself is never stored
    webhook_token_hint text,                     -- last four characters, so a person can tell tokens apart
    signing_secret_sealed bytea,                 -- sealed with integrations/sealing.ts
    event_filters text[] NOT NULL DEFAULT ARRAY[]::text[],
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT autopilot_triggers_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT autopilot_triggers_autopilot_fk FOREIGN KEY (workspace_id, autopilot_id)
        REFERENCES autopilots(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT autopilot_triggers_kind_ck CHECK (kind IN ('cron', 'webhook')),
    CONSTRAINT autopilot_triggers_cron_ck CHECK (
        (kind = 'cron') = (cron_expression IS NOT NULL AND timezone IS NOT NULL)
    ),
    CONSTRAINT autopilot_triggers_webhook_ck CHECK (
        (kind = 'webhook') = (webhook_token_hash IS NOT NULL AND signing_secret_sealed IS NOT NULL)
    ),
    CONSTRAINT autopilot_triggers_token_hash_ck CHECK (webhook_token_hash IS NULL OR octet_length(webhook_token_hash) = 32),
    CONSTRAINT autopilot_triggers_cron_length_ck CHECK (cron_expression IS NULL OR char_length(cron_expression) <= 200),
    CONSTRAINT autopilot_triggers_filters_ck CHECK (cardinality(event_filters) <= 50)
);
CREATE UNIQUE INDEX IF NOT EXISTS autopilot_triggers_token_key
    ON autopilot_triggers (webhook_token_hash) WHERE webhook_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS autopilot_triggers_due_idx
    ON autopilot_triggers (next_fire_at) WHERE kind = 'cron' AND enabled AND next_fire_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS autopilot_triggers_autopilot_idx ON autopilot_triggers (autopilot_id, created_at, id);
DROP TRIGGER IF EXISTS berry_autopilot_triggers_set_updated_at ON autopilot_triggers;
CREATE TRIGGER berry_autopilot_triggers_set_updated_at BEFORE UPDATE ON autopilot_triggers
    FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();

CREATE TABLE IF NOT EXISTS autopilot_runs (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    autopilot_id uuid NOT NULL,
    autopilot_version integer NOT NULL,
    trigger_id uuid REFERENCES autopilot_triggers(id) ON DELETE SET NULL,
    source text NOT NULL,
    status text NOT NULL,
    reason_code text,
    reason_message text,
    issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
    run_id uuid,                                 -- the queued task (runs.id); no FK, runs belongs to the task queue
    slot timestamptz,                            -- cron firings: the slot this run answers
    requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT autopilot_runs_autopilot_fk FOREIGN KEY (workspace_id, autopilot_id)
        REFERENCES autopilots(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT autopilot_runs_source_ck CHECK (source IN ('cron', 'webhook', 'manual', 'replay')),
    CONSTRAINT autopilot_runs_status_ck CHECK (status IN ('pending', 'enqueued', 'skipped', 'failed')),
    CONSTRAINT autopilot_runs_reason_ck CHECK ((status IN ('pending', 'enqueued')) = (reason_code IS NULL)),
    CONSTRAINT autopilot_runs_reason_length_ck CHECK (reason_message IS NULL OR char_length(reason_message) <= 2000)
);
CREATE INDEX IF NOT EXISTS autopilot_runs_order_idx ON autopilot_runs (autopilot_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS autopilot_runs_quota_idx
    ON autopilot_runs (autopilot_id, created_at) WHERE status IN ('pending', 'enqueued');

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    autopilot_id uuid NOT NULL,
    trigger_id uuid REFERENCES autopilot_triggers(id) ON DELETE SET NULL,
    event text,
    status text NOT NULL,
    payload jsonb,                               -- null when the delivery was refused before it was read
    failure_reason text,
    autopilot_run_id uuid REFERENCES autopilot_runs(id) ON DELETE SET NULL,
    replay_of uuid REFERENCES webhook_deliveries(id) ON DELETE SET NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT webhook_deliveries_autopilot_fk FOREIGN KEY (workspace_id, autopilot_id)
        REFERENCES autopilots(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT webhook_deliveries_status_ck CHECK (status IN ('accepted', 'filtered', 'rejected', 'failed')),
    CONSTRAINT webhook_deliveries_event_ck CHECK (event IS NULL OR char_length(event) <= 100),
    CONSTRAINT webhook_deliveries_payload_ck CHECK (payload IS NULL OR octet_length(payload::text) <= 262144),
    CONSTRAINT webhook_deliveries_failure_ck CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 200)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_order_idx ON webhook_deliveries (autopilot_id, received_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sys_cron_executions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    trigger_id uuid NOT NULL REFERENCES autopilot_triggers(id) ON DELETE CASCADE,
    slot timestamptz NOT NULL,
    autopilot_run_id uuid REFERENCES autopilot_runs(id) ON DELETE SET NULL,
    claimed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sys_cron_executions_slot_key UNIQUE (trigger_id, slot)
);
CREATE INDEX IF NOT EXISTS sys_cron_executions_retention_idx ON sys_cron_executions (claimed_at, id);
