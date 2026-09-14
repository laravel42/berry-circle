-- Berry migration 080 (workstream C, block 080-084): model usage per event and its hourly rollup.
--
-- task_usage is the record: one row per usage report from a run, priced when
-- written. task_usage_hourly is a projection maintained on the same write, so
-- a 90-day chart reads a few thousand rows rather than every model call.
-- runtime_id carries no foreign key on purpose: agent_runtimes belongs to
-- another migration block, and usage must be recordable before it exists.

CREATE TABLE IF NOT EXISTS task_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
    agent_id uuid NOT NULL,
    runtime_id uuid,
    model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 300),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
    cost_micros bigint CHECK (cost_micros IS NULL OR cost_micros >= 0),
    currency text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (cost_micros IS NULL AND currency IS NULL)
        OR (cost_micros IS NOT NULL AND currency ~ '^[A-Z]{3}$')
    )
);

CREATE INDEX IF NOT EXISTS task_usage_workspace_time_idx
    ON task_usage (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS task_usage_run_idx
    ON task_usage (run_id);
CREATE INDEX IF NOT EXISTS task_usage_issue_idx
    ON task_usage (issue_id) WHERE issue_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_usage_hourly (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    bucket timestamptz NOT NULL,
    agent_id uuid NOT NULL,
    runtime_id uuid,
    model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 300),
    events integer NOT NULL DEFAULT 0 CHECK (events >= 0),
    unpriced_events integer NOT NULL DEFAULT 0
        CHECK (unpriced_events >= 0 AND unpriced_events <= events),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
    cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- NULLS NOT DISTINCT (PostgreSQL 15+; Compose runs 16): the workspace-default
    -- runtime is NULL, and its rows must fold into one bucket, not one per event.
    CONSTRAINT task_usage_hourly_key
        UNIQUE NULLS NOT DISTINCT (workspace_id, bucket, agent_id, runtime_id, model)
);

CREATE INDEX IF NOT EXISTS task_usage_hourly_workspace_bucket_idx
    ON task_usage_hourly (workspace_id, bucket);
CREATE INDEX IF NOT EXISTS task_usage_hourly_agent_idx
    ON task_usage_hourly (workspace_id, agent_id, bucket);
