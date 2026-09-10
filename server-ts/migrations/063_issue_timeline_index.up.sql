-- Berry 063: the issue timeline reads outbox_events by the envelope's issueId,
-- which issue, comment and work-tracking events all carry at the top level.
CREATE INDEX IF NOT EXISTS outbox_events_issue_timeline_idx
    ON outbox_events (workspace_id, (payload ->> 'issueId'), occurred_at, id)
    WHERE payload ? 'issueId';
