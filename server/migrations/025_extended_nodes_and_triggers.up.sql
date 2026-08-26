-- Berry migration 025: extended workflow nodes and triggers (P4.5).
--
-- foreach fans one row per body step per item out onto the run ledger, named
-- "<stepId>[<index>]"; subworkflow runs record their parent run and step and
-- how deep they nest; the trigger dispatcher scans workflow run outcomes so a
-- parent can resume on its child; integration triggers are matched on
-- (provider, operation); and every answer an agent gives through
-- POST /agents/{id}/ask is a ledger row with its usage and cost, because a
-- paid call Berry cannot account for is not allowed to exist.

-- 1. Foreach body rows carry an item index.
ALTER TABLE automation_step_runs DROP CONSTRAINT IF EXISTS automation_step_runs_step_id_ck;
ALTER TABLE automation_step_runs ADD CONSTRAINT automation_step_runs_step_id_ck
    CHECK (step_id ~ '^[a-z][a-z0-9_]{0,63}(\[[0-9]{1,3}\])?$');

-- 2. Subworkflow runs know their parent and their depth below the run a
--    trigger started (0). The depth bound mirrors automation.MaxSubworkflowDepth.
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS parent_run_id uuid REFERENCES automation_runs(id) ON DELETE SET NULL;
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS parent_step_run_id uuid REFERENCES automation_step_runs(id) ON DELETE SET NULL;
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0;
ALTER TABLE automation_runs DROP CONSTRAINT IF EXISTS automation_runs_depth_ck;
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_depth_ck CHECK (depth BETWEEN 0 AND 3);
ALTER TABLE automation_runs DROP CONSTRAINT IF EXISTS automation_runs_parent_ck;
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_parent_ck CHECK ((parent_run_id IS NULL) = (depth = 0));
CREATE INDEX IF NOT EXISTS automation_runs_parent_idx ON automation_runs (parent_run_id, created_at, id) WHERE parent_run_id IS NOT NULL;

-- 3. The dispatcher also scans workflow run outcomes (subworkflow waits).
--    The three topics stay out of the subscribable Berry event vocabulary:
--    a workflow triggered by its own run outcome would loop forever.
DROP INDEX IF EXISTS outbox_events_trigger_dispatch_order_idx;
CREATE INDEX IF NOT EXISTS outbox_events_trigger_dispatch_order_idx
    ON outbox_events (available_at, occurred_at, id)
    WHERE topic IN (
        'issue.created', 'issue.updated', 'issue.assigned', 'issue.started', 'issue.completed', 'issue.deleted',
        'goal.created', 'goal.started', 'goal.completed', 'goal.cancelled',
        'run.completed', 'run.failed', 'run.cancelled',
        'agent.started', 'agent.completed', 'agent.failed',
        'approval.requested', 'approval.approved', 'approval.rejected', 'approval.expired',
        'artifact.created', 'integration.webhook.received', 'plan.updated',
        'workflow.run.succeeded', 'workflow.run.failed', 'workflow.run.cancelled'
    );

-- 4. Integration triggers are matched on (provider, operation) inside the
--    workspace the delivery belongs to, the way Berry event triggers are
--    matched on their topic.
CREATE INDEX IF NOT EXISTS automations_active_integration_idx
    ON automations (workspace_id, trigger_provider, trigger_operation)
    WHERE status = 'active' AND trigger_type = 'integration';

-- 5. Asks: one bounded chat completion to a workspace agent, answered as JSON
--    and checked against the schema the caller named. Never retried; the row
--    exists whether or not the answer was usable so the spend is visible.
CREATE TABLE IF NOT EXISTS agent_asks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
    request_id text,
    status text NOT NULL,
    prompt_bytes integer NOT NULL DEFAULT 0,
    answer jsonb,
    failure_code text, failure_message text,
    model_provider text, model_name text,
    input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
    cost_micros bigint, currency text,
    upstream_request_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT agent_asks_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT agent_asks_status_ck CHECK (status IN ('succeeded','failed')),
    CONSTRAINT agent_asks_failure_ck CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
    CONSTRAINT agent_asks_usage_ck CHECK (input_tokens >= 0 AND output_tokens >= 0 AND prompt_bytes >= 0 AND (cost_micros IS NULL OR cost_micros >= 0)),
    CONSTRAINT agent_asks_answer_ck CHECK (answer IS NULL OR octet_length(answer::text) <= 262144)
);
CREATE INDEX IF NOT EXISTS agent_asks_workspace_order_idx ON agent_asks (workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agent_asks_agent_idx ON agent_asks (agent_id, created_at DESC);
