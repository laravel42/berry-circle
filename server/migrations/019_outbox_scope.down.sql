-- Documentation only: Berry migrations are forward-only and this file is not
-- embedded or executed. It records what a manual revert of 019 would involve.
--
-- Reverting restores the pre-019 overload of workspace_id: run-lane rows
-- (aggregate_type run/issue written by repository/runs) held the board id
-- there, while the collaboration and comment lanes held the workspace id. The
-- board_id column is what distinguishes the two after 019, so it has to be
-- folded back before it is dropped.

UPDATE outbox_events
   SET workspace_id = board_id
 WHERE board_id IS NOT NULL
   AND aggregate_type IN ('run', 'issue')
   AND (payload ? 'runId' OR payload ? 'sequence');

DROP INDEX IF EXISTS outbox_events_trigger_dispatch_order_idx;
DROP INDEX IF EXISTS outbox_events_board_replay_idx;

DROP INDEX IF EXISTS outbox_events_inbox_projection_order_idx;
CREATE INDEX IF NOT EXISTS outbox_events_inbox_projection_order_idx
    ON outbox_events (available_at, occurred_at, id)
    WHERE topic IN (
        'issue.updated', 'comment.created',
        'run.created', 'run.started', 'run.completed', 'run.failed', 'run.cancelled'
    );

ALTER TABLE outbox_events DROP COLUMN IF EXISTS board_id;
