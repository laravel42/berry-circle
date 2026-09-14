-- Berry migration 092: which runs a comment started.
--
-- The primary key is the idempotency guard: a retried request, or a hook that
-- runs twice, finds the row and does not enqueue a second run for the same
-- comment and agent.

CREATE TABLE IF NOT EXISTS comment_run_triggers (
    comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    agent_id uuid NOT NULL,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id uuid,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, agent_id),
    CONSTRAINT comment_run_triggers_reason_ck CHECK (reason IN ('mention', 'squad_leader', 'reply_to_assignee'))
);
