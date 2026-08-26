-- Berry migration 019: outbox_events gains an explicit board scope.
--
-- Until now the run lane (repository/runs) stored the BOARD id in
-- outbox_events.workspace_id while the collaboration lane stored the real
-- workspace id. Board replay filtered on workspace_id = board id, which silently
-- excluded comment.created and every collaboration event. From here on
-- workspace_id is always a workspace id and board_id is set whenever the
-- aggregate belongs to a board. Trigger dispatch (021) and the workspace stream
-- both rely on that.

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS board_id uuid;

-- 1. Run-lane rows: workspace_id currently holds a board id. Guarded by the
--    boards join so rows that already hold a workspace id are untouched.
UPDATE outbox_events AS event
   SET board_id = event.workspace_id,
       workspace_id = board.workspace_id
  FROM boards AS board
 WHERE board.id = event.workspace_id
   AND event.board_id IS NULL
   AND event.aggregate_type IN ('run', 'issue');

-- 2. Collaboration-lane issue rows (true workspace id, no board): derive board.
UPDATE outbox_events AS event
   SET board_id = issue.board_id
  FROM issues AS issue
 WHERE event.aggregate_type = 'issue'
   AND event.aggregate_id = issue.id
   AND event.board_id IS NULL;

-- 3. Comment rows: comments -> issues -> boards.
UPDATE outbox_events AS event
   SET board_id = issue.board_id
  FROM comments AS comment
  JOIN issues AS issue ON issue.id = comment.issue_id
 WHERE event.aggregate_type = 'comment'
   AND event.aggregate_id = comment.id
   AND event.board_id IS NULL;

-- 4. Attachment/reaction/resolution rows written by repository/collaboration
--    carry the issue id in payload->'payload'->>'issueId'; derive when present.
UPDATE outbox_events AS event
   SET board_id = issue.board_id
  FROM issues AS issue
 WHERE event.board_id IS NULL
   AND event.aggregate_type IN ('attachment', 'reaction', 'resolution', 'subscription')
   AND (event.payload->'payload'->>'issueId') ~ '^[0-9a-f-]{36}$'
   AND issue.id = (event.payload->'payload'->>'issueId')::uuid;

CREATE INDEX IF NOT EXISTS outbox_events_board_replay_idx
    ON outbox_events (board_id, occurred_at, id)
    WHERE board_id IS NOT NULL;

-- Inbox projector: add the topics the projector will learn in 021/022.
DROP INDEX IF EXISTS outbox_events_inbox_projection_order_idx;
CREATE INDEX IF NOT EXISTS outbox_events_inbox_projection_order_idx
    ON outbox_events (available_at, occurred_at, id)
    WHERE topic IN (
        'issue.created', 'issue.updated', 'issue.completed', 'comment.created',
        'run.created', 'run.started', 'run.completed', 'run.failed', 'run.cancelled',
        'approval.requested', 'approval.approved', 'approval.rejected', 'approval.expired',
        'goal.completed', 'workflow.run.failed', 'plan.generated', 'plan.compile_failed'
    );

-- Trigger dispatcher (service/triggerdispatch) scan order.
CREATE INDEX IF NOT EXISTS outbox_events_trigger_dispatch_order_idx
    ON outbox_events (available_at, occurred_at, id)
    WHERE topic IN (
        'issue.created', 'issue.updated', 'issue.assigned', 'issue.started', 'issue.completed', 'issue.deleted',
        'goal.created', 'goal.started', 'goal.completed', 'goal.cancelled',
        'run.completed', 'run.failed', 'run.cancelled',
        'agent.started', 'agent.completed', 'agent.failed',
        'approval.requested', 'approval.approved', 'approval.rejected', 'approval.expired',
        'artifact.created', 'integration.webhook.received', 'plan.updated'
    );
