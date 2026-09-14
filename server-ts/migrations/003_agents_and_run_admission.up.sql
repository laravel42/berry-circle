-- Berry migration range 000-099: agent product identities and durable run admission.
-- The agent runtime remains an external execution substrate; this schema contains no
-- provider credentials, prompts, or execution-side configuration.

CREATE TABLE IF NOT EXISTS agents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The current foundation scopes product data by board. NULL represents a
    -- deployment-wide prototype agent until workspace membership lands.
    board_id uuid REFERENCES boards(id) ON DELETE CASCADE,
    runtime_agent_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    avatar_url text,
    status text NOT NULL DEFAULT 'unknown',
    capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
    model_provider text,
    model_name text,
    model_tier text,
    auth_status text,
    upstream_state text,
    upstream_last_active_at timestamptz,
    last_synced_at timestamptz,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (char_length(name) BETWEEN 1 AND 100),
    CHECK (description IS NULL OR char_length(description) <= 5000),
    CHECK (status IN ('available', 'busy', 'offline', 'unknown')),
    CHECK (
        avatar_url IS NULL
        OR avatar_url ~ '^https?://'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_runtime_agent_id_key
    ON agents (runtime_agent_id);
CREATE INDEX IF NOT EXISTS agents_name_id_idx
    ON agents (name ASC, id ASC)
    WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS agents_board_name_id_idx
    ON agents (board_id, name ASC, id ASC)
    WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS agents_status_name_id_idx
    ON agents (status, name ASC, id ASC)
    WHERE archived_at IS NULL;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS dispatch_state text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS dispatch_version bigint DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS dispatch_attempted_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS dispatch_accepted_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cancel_attempted_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cancel_completed_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS reconciliation_required_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS reconciliation_reason text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS instructions text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS output text DEFAULT '';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS requested_by uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cancel_requested_by uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS traceparent text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS provider_event_sequence bigint DEFAULT 0;

-- Applied databases can already contain run rows from the compatibility lane.
-- Never make those rows eligible for automatic dispatch during backfill.
UPDATE runs
SET dispatch_state = CASE
        WHEN status = 'succeeded' THEN 'succeeded'
        WHEN status = 'failed' THEN 'failed'
        WHEN status = 'cancelled' THEN 'cancelled'
        ELSE 'reconciliation_required'
    END,
    reconciliation_required_at = CASE
        WHEN status IN ('queued', 'running')
        THEN COALESCE(reconciliation_required_at, updated_at, now())
        ELSE reconciliation_required_at
    END,
    reconciliation_reason = CASE
        WHEN status IN ('queued', 'running')
        THEN COALESCE(reconciliation_reason, 'pre-admission-migration')
        ELSE reconciliation_reason
    END
WHERE dispatch_state IS NULL;

UPDATE runs SET dispatch_version = 0 WHERE dispatch_version IS NULL;
UPDATE runs SET output = '' WHERE output IS NULL;
UPDATE runs SET provider_event_sequence = 0 WHERE provider_event_sequence IS NULL;

ALTER TABLE runs ALTER COLUMN dispatch_state SET DEFAULT 'pending';
ALTER TABLE runs ALTER COLUMN dispatch_state SET NOT NULL;
ALTER TABLE runs ALTER COLUMN dispatch_version SET DEFAULT 0;
ALTER TABLE runs ALTER COLUMN dispatch_version SET NOT NULL;
ALTER TABLE runs ALTER COLUMN output SET DEFAULT '';
ALTER TABLE runs ALTER COLUMN output SET NOT NULL;
ALTER TABLE runs ALTER COLUMN provider_event_sequence SET DEFAULT 0;
ALTER TABLE runs ALTER COLUMN provider_event_sequence SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'runs'::regclass
          AND conname = 'runs_dispatch_state_ck'
    ) THEN
        ALTER TABLE runs ADD CONSTRAINT runs_dispatch_state_ck CHECK (
            dispatch_state IN (
                'pending',
                'dispatching',
                'streaming',
                'succeeded',
                'failed',
                'cancel_requested',
                'cancelled',
                'reconciliation_required'
            )
        ) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'runs'::regclass
          AND conname = 'runs_dispatch_version_ck'
    ) THEN
        ALTER TABLE runs ADD CONSTRAINT runs_dispatch_version_ck
            CHECK (dispatch_version >= 0) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'runs'::regclass
          AND conname = 'runs_provider_event_sequence_ck'
    ) THEN
        ALTER TABLE runs ADD CONSTRAINT runs_provider_event_sequence_ck
            CHECK (provider_event_sequence >= 0) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'runs'::regclass
          AND conname = 'runs_instructions_length_ck'
    ) THEN
        ALTER TABLE runs ADD CONSTRAINT runs_instructions_length_ck
            CHECK (instructions IS NULL OR char_length(instructions) <= 20000) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'runs'::regclass
          AND conname = 'runs_requested_by_users_id_fk'
    ) THEN
        ALTER TABLE runs ADD CONSTRAINT runs_requested_by_users_id_fk
            FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'runs'::regclass
          AND conname = 'runs_cancel_requested_by_users_id_fk'
    ) THEN
        ALTER TABLE runs ADD CONSTRAINT runs_cancel_requested_by_users_id_fk
            FOREIGN KEY (cancel_requested_by) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'runs'::regclass
          AND conname = 'runs_agent_id_agents_id_fk'
    ) THEN
        ALTER TABLE runs ADD CONSTRAINT runs_agent_id_agents_id_fk
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT NOT VALID;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS runs_dispatch_pending_idx
    ON runs (created_at, id)
    WHERE status = 'queued' AND dispatch_state = 'pending';
CREATE INDEX IF NOT EXISTS runs_reconciliation_idx
    ON runs (reconciliation_required_at, id)
    WHERE reconciliation_required_at IS NOT NULL;

-- Provider stream observations are bounded/redacted adapter evidence. Public
-- browser events continue to live in run_events and outbox_events.
CREATE TABLE IF NOT EXISTS run_provider_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sequence bigint NOT NULL CHECK (sequence >= 1),
    event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 100),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS run_provider_events_run_order_idx
    ON run_provider_events (run_id, sequence);
CREATE INDEX IF NOT EXISTS run_events_run_replay_idx
    ON run_events (run_id, sequence, id)
    WHERE public;
CREATE INDEX IF NOT EXISTS run_events_retention_idx
    ON run_events (occurred_at, id)
    WHERE public;
CREATE INDEX IF NOT EXISTS outbox_events_workspace_replay_idx
    ON outbox_events (workspace_id, occurred_at, id)
    WHERE workspace_id IS NOT NULL;

-- Call inside the same transaction that inserts the corresponding event. The
-- row update serializes concurrent appenders and rolls back with a failed insert.
CREATE OR REPLACE FUNCTION berry_allocate_run_event_sequence(p_run_id uuid)
RETURNS bigint
LANGUAGE sql
AS $$
    UPDATE runs
    SET sequence = sequence + 1
    WHERE id = p_run_id
    RETURNING sequence;
$$;

CREATE OR REPLACE FUNCTION berry_allocate_provider_event_sequence(p_run_id uuid)
RETURNS bigint
LANGUAGE sql
AS $$
    UPDATE runs
    SET provider_event_sequence = provider_event_sequence + 1
    WHERE id = p_run_id
    RETURNING provider_event_sequence;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'agents'::regclass
          AND NOT tgisinternal
          AND tgname = 'berry_agents_set_updated_at'
    ) THEN
        CREATE TRIGGER berry_agents_set_updated_at
            BEFORE UPDATE ON agents
            FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
    END IF;
END
$$;
