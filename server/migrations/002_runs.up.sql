-- Berry migration range 000-099: durable run ledger and ordered run events.

DO $$
BEGIN
    CREATE TYPE run_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

ALTER TYPE run_status ADD VALUE IF NOT EXISTS 'queued';
ALTER TYPE run_status ADD VALUE IF NOT EXISTS 'running';
ALTER TYPE run_status ADD VALUE IF NOT EXISTS 'succeeded';
ALTER TYPE run_status ADD VALUE IF NOT EXISTS 'failed';
ALTER TYPE run_status ADD VALUE IF NOT EXISTS 'cancelled';

CREATE TABLE IF NOT EXISTS runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    agent_id uuid NOT NULL,
    status run_status NOT NULL DEFAULT 'queued',
    sequence bigint NOT NULL DEFAULT 0,
    summary text,
    input_tokens bigint NOT NULL DEFAULT 0,
    output_tokens bigint NOT NULL DEFAULT 0,
    total_tokens bigint NOT NULL DEFAULT 0,
    cost_micros bigint,
    currency text,
    failure_code text,
    failure_message text,
    failure_retryable boolean,
    upstream_agent_id text,
    upstream_request_id text,
    origin jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (sequence >= 0),
    CHECK (input_tokens >= 0 AND output_tokens >= 0 AND total_tokens >= 0),
    CHECK (cost_micros IS NULL OR cost_micros >= 0),
    CHECK (
        (cost_micros IS NULL AND currency IS NULL)
        OR (cost_micros IS NOT NULL AND currency ~ '^[A-Z]{3}$')
    ),
    CHECK (
        (status = 'failed' AND failure_code IS NOT NULL AND failure_message IS NOT NULL)
        OR (status <> 'failed' AND failure_code IS NULL AND failure_message IS NULL)
    ),
    CHECK (
        (status IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NOT NULL)
        OR (status IN ('queued', 'running') AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_issue_key
    ON runs (issue_id)
    WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS runs_issue_created_idx
    ON runs (issue_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS runs_board_created_idx
    ON runs (board_id, created_at DESC, id DESC);

ALTER TABLE issues ADD COLUMN IF NOT EXISTS active_run_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'issues'::regclass AND conname = 'issues_active_run_id_runs_id_fk'
    ) THEN
        ALTER TABLE issues ADD CONSTRAINT issues_active_run_id_runs_id_fk
            FOREIGN KEY (active_run_id) REFERENCES runs(id) ON DELETE SET NULL;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS issues_active_run_id_key
    ON issues (active_run_id)
    WHERE active_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    sequence bigint NOT NULL CHECK (sequence >= 0),
    event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 100),
    payload jsonb NOT NULL,
    public boolean NOT NULL DEFAULT false,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS run_events_run_order_idx
    ON run_events (run_id, sequence);
CREATE INDEX IF NOT EXISTS run_events_board_order_idx
    ON run_events (board_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS run_events_issue_order_idx
    ON run_events (issue_id, occurred_at, id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'runs'::regclass
          AND NOT tgisinternal
          AND tgname = 'berry_runs_set_updated_at'
    ) THEN
        CREATE TRIGGER berry_runs_set_updated_at
            BEFORE UPDATE ON runs
            FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
    END IF;
END
$$;
