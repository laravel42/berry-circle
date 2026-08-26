-- Berry migration 021: automations (product noun: Workflow), versions, runs,
-- step runs, run events, trigger receipts, webhook delivery dedupe.
--
-- An automation is a repeatable process: a trigger, typed steps, and the
-- ledger of every run those steps produced. Runs mirror the issue run ledger
-- (002/003) — a per-run sequence, an events table replayed by sequence — so
-- repository/ledger serves both without a second copy of the replay code.
CREATE TABLE IF NOT EXISTS automations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id uuid,
    goal_id uuid,
    name text NOT NULL,
    description text,
    status text NOT NULL DEFAULT 'draft',
    version integer NOT NULL DEFAULT 1,           -- bumps on every definition change (automation_versions row)
    revision integer NOT NULL DEFAULT 1,          -- optimistic concurrency on any write (saved_issue_views precedent)
    definition jsonb NOT NULL,
    definition_version text NOT NULL DEFAULT '1',
    layout jsonb NOT NULL DEFAULT '{}'::jsonb,    -- React Flow positions keyed by node id; never business state
    -- indexed metadata derived from definition on every write
    trigger_type text NOT NULL,
    trigger_provider text, trigger_operation text, trigger_event text,
    schedule_cron text, schedule_timezone text, schedule_next_at timestamptz,   -- next fire time cached for the in-process scheduler
    webhook_secret_hash bytea,
    risk text NOT NULL DEFAULT 'low',
    engine text NOT NULL DEFAULT 'native',
    engine_flow_id text,
    engine_sync_status text NOT NULL DEFAULT 'not_required',
    engine_sync_error text,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    CONSTRAINT automations_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT automations_project_fk FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE SET NULL,
    CONSTRAINT automations_goal_fk FOREIGN KEY (workspace_id, goal_id) REFERENCES goals(workspace_id, id) ON DELETE SET NULL,
    CONSTRAINT automations_name_length_ck CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT automations_description_length_ck CHECK (description IS NULL OR char_length(description) <= 20000),
    CONSTRAINT automations_status_ck CHECK (status IN ('draft','active','paused','archived')),
    CONSTRAINT automations_version_ck CHECK (version >= 1 AND revision >= 1),
    CONSTRAINT automations_definition_ck CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 262144),
    CONSTRAINT automations_layout_ck CHECK (jsonb_typeof(layout) = 'object' AND octet_length(layout::text) <= 65536),
    CONSTRAINT automations_trigger_type_ck CHECK (trigger_type IN ('integration','schedule','manual','berry_event','webhook')),
    CONSTRAINT automations_risk_ck CHECK (risk IN ('low','medium','high')),
    CONSTRAINT automations_engine_ck CHECK (engine IN ('native','activepieces')),
    CONSTRAINT automations_engine_sync_ck CHECK (engine_sync_status IN ('not_required','pending','synced','failed')),
    CONSTRAINT automations_webhook_secret_ck CHECK (webhook_secret_hash IS NULL OR octet_length(webhook_secret_hash) = 32),
    CONSTRAINT automations_archived_ck CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS automations_workspace_order_idx ON automations (workspace_id, updated_at DESC, id DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS automations_active_event_idx ON automations (workspace_id, trigger_event) WHERE status = 'active' AND trigger_type = 'berry_event';
CREATE INDEX IF NOT EXISTS automations_active_schedule_idx ON automations (schedule_next_at) WHERE status = 'active' AND trigger_type = 'schedule' AND schedule_next_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS automations_goal_idx ON automations (workspace_id, goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS automations_project_idx ON automations (workspace_id, project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS automations_engine_flow_key ON automations (engine, engine_flow_id) WHERE engine_flow_id IS NOT NULL;
DROP TRIGGER IF EXISTS berry_automations_set_updated_at ON automations;
CREATE TRIGGER berry_automations_set_updated_at BEFORE UPDATE ON automations FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();

CREATE TABLE IF NOT EXISTS automation_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    automation_id uuid NOT NULL,
    version integer NOT NULL,
    definition jsonb NOT NULL,
    definition_version text NOT NULL DEFAULT '1',
    engine_flow_version_id text,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automation_versions_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT automation_versions_automation_fk FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT automation_versions_version_key UNIQUE (automation_id, version),
    CONSTRAINT automation_versions_definition_ck CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 262144)
);

CREATE TABLE IF NOT EXISTS automation_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    automation_id uuid NOT NULL,
    automation_version integer NOT NULL,
    goal_id uuid,
    status text NOT NULL DEFAULT 'pending',
    trigger_type text NOT NULL,
    trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_event_key text,                        -- outbox event public id (text) or schedule tick key; NOT an FK so outbox pruning never erases dedupe
    current_step_id text,
    waiting_on text,                              -- approval:<id> | run:<id> | issue:<id> | timer:<rfc3339> | event:<topic>
    resume_at timestamptz,                        -- for timer waits (in-process scheduler scans this)
    sequence bigint NOT NULL DEFAULT 0,
    engine text NOT NULL DEFAULT 'native',
    engine_run_id text,
    failure_code text, failure_message text,
    input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0, cost_micros bigint,  -- sums of inline model usage (runs ledger keeps issue-mode cost)
    requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
    request_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz, completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automation_runs_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT automation_runs_usage_ck CHECK (input_tokens >= 0 AND output_tokens >= 0 AND (cost_micros IS NULL OR cost_micros >= 0)),
    CONSTRAINT automation_runs_automation_fk FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT automation_runs_goal_fk FOREIGN KEY (workspace_id, goal_id) REFERENCES goals(workspace_id, id) ON DELETE SET NULL,
    CONSTRAINT automation_runs_status_ck CHECK (status IN ('pending','running','waiting','succeeded','failed','cancelled')),
    CONSTRAINT automation_runs_trigger_type_ck CHECK (trigger_type IN ('integration','schedule','manual','berry_event','webhook')),
    CONSTRAINT automation_runs_payload_ck CHECK (jsonb_typeof(trigger_payload) = 'object' AND octet_length(trigger_payload::text) <= 262144),
    CONSTRAINT automation_runs_engine_ck CHECK (engine IN ('native','activepieces')),
    CONSTRAINT automation_runs_terminal_ck CHECK ((status IN ('succeeded','failed','cancelled')) = (completed_at IS NOT NULL)),
    CONSTRAINT automation_runs_failure_ck CHECK ((status = 'failed') = (failure_code IS NOT NULL AND failure_message IS NOT NULL)),
    CONSTRAINT automation_runs_waiting_ck CHECK ((status = 'waiting') = (waiting_on IS NOT NULL)),
    CONSTRAINT automation_runs_sequence_ck CHECK (sequence >= 0),
    CONSTRAINT automation_runs_source_event_key_ck CHECK (source_event_key IS NULL OR char_length(source_event_key) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS automation_runs_automation_order_idx ON automation_runs (automation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS automation_runs_workspace_order_idx ON automation_runs (workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS automation_runs_pending_idx ON automation_runs (created_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS automation_runs_waiting_idx ON automation_runs (waiting_on) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS automation_runs_resume_idx ON automation_runs (resume_at) WHERE status = 'waiting' AND resume_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_engine_run_key ON automation_runs (engine, engine_run_id) WHERE engine_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_source_event_key ON automation_runs (automation_id, source_event_key) WHERE source_event_key IS NOT NULL;
DROP TRIGGER IF EXISTS berry_automation_runs_set_updated_at ON automation_runs;
CREATE TRIGGER berry_automation_runs_set_updated_at BEFORE UPDATE ON automation_runs FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();

CREATE TABLE IF NOT EXISTS automation_step_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    automation_run_id uuid NOT NULL,
    step_id text NOT NULL,
    step_type text NOT NULL,
    attempt integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'pending',
    input jsonb, output jsonb,
    failure_code text, failure_message text,
    run_id uuid REFERENCES runs(id) ON DELETE SET NULL,          -- agent step (inline or issue mode) -> Berry run ledger
    issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,      -- create_issue / issue-mode agent step
    approval_id uuid,
    audit_event_id uuid REFERENCES integration_audit_events(id) ON DELETE SET NULL,
    engine_step_id text,
    usage jsonb,                                                 -- inline agent/ask steps: {inputTokens,outputTokens,costMicros,currency,upstreamRequestId}
    started_at timestamptz, completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automation_step_runs_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT automation_step_runs_run_fk FOREIGN KEY (workspace_id, automation_run_id) REFERENCES automation_runs(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT automation_step_runs_approval_fk FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals(workspace_id, id) ON DELETE SET NULL,
    CONSTRAINT automation_step_runs_step_attempt_key UNIQUE (automation_run_id, step_id, attempt),
    CONSTRAINT automation_step_runs_step_id_ck CHECK (step_id ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT automation_step_runs_step_type_ck CHECK (step_type IN ('trigger','action','condition','switch','agent','create_issue','update_issue','approval','wait','foreach','transform','subworkflow')),
    CONSTRAINT automation_step_runs_status_ck CHECK (status IN ('pending','running','waiting','succeeded','failed','skipped')),
    CONSTRAINT automation_step_runs_attempt_ck CHECK (attempt >= 1),
    CONSTRAINT automation_step_runs_input_ck CHECK (input IS NULL OR octet_length(input::text) <= 262144),
    CONSTRAINT automation_step_runs_output_ck CHECK (output IS NULL OR octet_length(output::text) <= 262144),
    CONSTRAINT automation_step_runs_usage_ck CHECK (usage IS NULL OR (jsonb_typeof(usage) = 'object' AND octet_length(usage::text) <= 4096)),
    CONSTRAINT automation_step_runs_failure_ck CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS automation_step_runs_run_order_idx ON automation_step_runs (automation_run_id, created_at, id);
CREATE INDEX IF NOT EXISTS automation_step_runs_berry_run_idx ON automation_step_runs (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS automation_step_runs_issue_idx ON automation_step_runs (issue_id) WHERE issue_id IS NOT NULL;
DROP TRIGGER IF EXISTS berry_automation_step_runs_set_updated_at ON automation_step_runs;
CREATE TRIGGER berry_automation_step_runs_set_updated_at BEFORE UPDATE ON automation_step_runs FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();

-- Same shape as run_events (002/003) so repository/ledger serves both.
CREATE TABLE IF NOT EXISTS automation_run_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    automation_run_id uuid NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
    sequence bigint NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    public boolean NOT NULL DEFAULT true,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automation_run_events_sequence_ck CHECK (sequence >= 0),
    CONSTRAINT automation_run_events_type_ck CHECK (char_length(event_type) BETWEEN 1 AND 100),
    CONSTRAINT automation_run_events_payload_ck CHECK (octet_length(payload::text) <= 262144),
    CONSTRAINT automation_run_events_run_sequence_key UNIQUE (automation_run_id, sequence)
);
CREATE INDEX IF NOT EXISTS automation_run_events_replay_idx ON automation_run_events (automation_run_id, sequence, id) WHERE public;
CREATE INDEX IF NOT EXISTS automation_run_events_retention_idx ON automation_run_events (occurred_at, id) WHERE public;
-- Call inside the same transaction that inserts the corresponding event. The
-- row update serializes concurrent appenders and rolls back with a failed
-- insert. Unlike the issue run ledger, which hand-writes sequence zero at
-- admission, every automation run event is allocated here, so the first call
-- returns 0 and automation_runs.sequence counts the events written.
CREATE OR REPLACE FUNCTION berry_allocate_automation_run_event_sequence(p_run_id uuid) RETURNS bigint
LANGUAGE sql AS $$
    UPDATE automation_runs SET sequence = sequence + 1 WHERE id = p_run_id RETURNING sequence - 1;
$$;

-- Receipt per consumed outbox event (inbox_projection_events precedent).
CREATE TABLE IF NOT EXISTS automation_trigger_receipts (
    event_id uuid PRIMARY KEY REFERENCES outbox_events(id) ON DELETE CASCADE,
    workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
    outcome text NOT NULL,
    matched_count integer NOT NULL DEFAULT 0,
    processed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automation_trigger_receipts_outcome_ck CHECK (outcome IN ('matched','unmatched','skipped','failed')),
    CONSTRAINT automation_trigger_receipts_count_ck CHECK (matched_count >= 0)
);
CREATE INDEX IF NOT EXISTS automation_trigger_receipts_order_idx ON automation_trigger_receipts (processed_at, event_id);

-- Inbound webhook dedupe for provider ingestors (github/slack/linear/activepieces).
CREATE TABLE IF NOT EXISTS integration_webhook_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    delivery_id text NOT NULL,
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT integration_webhook_deliveries_key UNIQUE (provider, delivery_id),
    CONSTRAINT integration_webhook_deliveries_provider_ck CHECK (provider ~ '^[a-z][a-z0-9_]{1,63}$'),
    CONSTRAINT integration_webhook_deliveries_delivery_ck CHECK (char_length(delivery_id) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS integration_webhook_deliveries_retention_idx ON integration_webhook_deliveries (received_at, id);

-- Deferred FKs from 020.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_automation_fk;
ALTER TABLE approvals ADD CONSTRAINT approvals_automation_fk FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_automation_run_fk;
ALTER TABLE approvals ADD CONSTRAINT approvals_automation_run_fk FOREIGN KEY (workspace_id, automation_run_id) REFERENCES automation_runs(workspace_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_automation_step_run_fk;
ALTER TABLE approvals ADD CONSTRAINT approvals_automation_step_run_fk FOREIGN KEY (workspace_id, automation_step_run_id) REFERENCES automation_step_runs(workspace_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE automation_issue_origins DROP CONSTRAINT IF EXISTS automation_issue_origins_automation_fk;
ALTER TABLE automation_issue_origins ADD CONSTRAINT automation_issue_origins_automation_fk FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE automation_issue_origins DROP CONSTRAINT IF EXISTS automation_issue_origins_run_fk;
ALTER TABLE automation_issue_origins ADD CONSTRAINT automation_issue_origins_run_fk FOREIGN KEY (workspace_id, automation_run_id) REFERENCES automation_runs(workspace_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE automation_issue_origins DROP CONSTRAINT IF EXISTS automation_issue_origins_step_run_fk;
ALTER TABLE automation_issue_origins ADD CONSTRAINT automation_issue_origins_step_run_fk FOREIGN KEY (workspace_id, automation_step_run_id) REFERENCES automation_step_runs(workspace_id, id) ON DELETE SET NULL NOT VALID;
CREATE INDEX IF NOT EXISTS automation_issue_origins_run_idx ON automation_issue_origins (workspace_id, automation_run_id, issue_id);
