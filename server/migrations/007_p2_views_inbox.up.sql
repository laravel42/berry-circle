-- Berry P2 query, saved-view, pins, inbox, and notification foundations.
-- This migration intentionally depends only on migrations 000-004. Project
-- targets remain polymorphic UUIDs until the project lane owns its schema.

CREATE TABLE IF NOT EXISTS saved_issue_views (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    visibility text NOT NULL DEFAULT 'private',
    definition_version integer NOT NULL DEFAULT 1,
    query jsonb NOT NULL,
    display jsonb NOT NULL DEFAULT '{}'::jsonb,
    revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (char_length(name) BETWEEN 1 AND 80),
    CHECK (visibility IN ('private', 'workspace')),
    CHECK (definition_version BETWEEN 1 AND 1000),
    CHECK (jsonb_typeof(query) = 'object'),
    CHECK (octet_length(query::text) <= 65536),
    CHECK (jsonb_typeof(display) = 'object'),
    CHECK (octet_length(display::text) <= 32768),
    CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS saved_issue_views_visible_order_idx
    ON saved_issue_views (workspace_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS saved_issue_views_owner_order_idx
    ON saved_issue_views (workspace_id, owner_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS issue_view_preferences (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    active_view_id uuid REFERENCES saved_issue_views(id) ON DELETE SET NULL,
    preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id),
    CHECK (jsonb_typeof(preferences) = 'object'),
    CHECK (octet_length(preferences::text) <= 32768)
);

CREATE INDEX IF NOT EXISTS issue_view_preferences_active_view_idx
    ON issue_view_preferences (active_view_id)
    WHERE active_view_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_pins (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    position integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (target_type IN ('issue', 'view', 'project')),
    CHECK (position >= 0),
    UNIQUE (workspace_id, user_id, target_type, target_id),
    UNIQUE (workspace_id, user_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS user_pins_order_idx
    ON user_pins (workspace_id, user_id, position, id);
CREATE INDEX IF NOT EXISTS user_pins_target_idx
    ON user_pins (workspace_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS notification_preferences (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    preferences jsonb NOT NULL DEFAULT
        '{"inApp":{"assignments":true,"statusChanges":true,"comments":true,"mentions":true,"updates":true,"agentActivity":true}}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id),
    CHECK (jsonb_typeof(preferences) = 'object'),
    CHECK (octet_length(preferences::text) <= 32768)
);

CREATE TABLE IF NOT EXISTS inbox_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_event_id uuid REFERENCES outbox_events(id) ON DELETE SET NULL,
    event_type text NOT NULL,
    category text NOT NULL,
    severity text NOT NULL DEFAULT 'info',
    issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
    actor_type text,
    actor_id uuid,
    title text NOT NULL,
    body text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    read_at timestamptz,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (char_length(event_type) BETWEEN 1 AND 100),
    CHECK (category IN (
        'assignments', 'statusChanges', 'comments', 'mentions',
        'updates', 'agentActivity'
    )),
    CHECK (severity IN ('info', 'warning', 'critical')),
    CHECK (
        (actor_type IS NULL AND actor_id IS NULL)
        OR (actor_type IN ('user', 'agent') AND actor_id IS NOT NULL)
    ),
    CHECK (char_length(title) BETWEEN 1 AND 500),
    CHECK (body IS NULL OR char_length(body) <= 5000),
    CHECK (jsonb_typeof(details) = 'object'),
    CHECK (octet_length(details::text) <= 65536)
);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_items_recipient_source_key
    ON inbox_items (recipient_id, source_event_id)
    WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_items_recipient_active_order_idx
    ON inbox_items (workspace_id, recipient_id, created_at DESC, id DESC)
    WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS inbox_items_recipient_archived_order_idx
    ON inbox_items (workspace_id, recipient_id, created_at DESC, id DESC)
    WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_items_recipient_unread_idx
    ON inbox_items (workspace_id, recipient_id, created_at DESC, id DESC)
    WHERE read_at IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS inbox_items_issue_idx
    ON inbox_items (workspace_id, recipient_id, issue_id)
    WHERE issue_id IS NOT NULL;

-- One receipt is written in the same transaction as projected inbox rows.
-- It is independent from outbox_events.published_at so realtime publication
-- and inbox projection can retry and advance without coupling their liveness.
CREATE TABLE IF NOT EXISTS inbox_projection_events (
    event_id uuid PRIMARY KEY REFERENCES outbox_events(id) ON DELETE CASCADE,
    workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
    outcome text NOT NULL,
    inbox_count integer NOT NULL DEFAULT 0,
    projected_at timestamptz NOT NULL DEFAULT now(),
    CHECK (outcome IN ('projected', 'suppressed', 'skipped')),
    CHECK (inbox_count >= 0)
);

CREATE INDEX IF NOT EXISTS inbox_projection_events_workspace_order_idx
    ON inbox_projection_events (workspace_id, projected_at, event_id);
CREATE INDEX IF NOT EXISTS outbox_events_inbox_projection_order_idx
    ON outbox_events (available_at, occurred_at, id)
    WHERE topic IN (
        'issue.updated', 'comment.created', 'run.created', 'run.started',
        'run.completed', 'run.failed', 'run.cancelled'
    );

-- B-tree expression indexes cover exact/prefix matching. Contains matching is
-- still bounded by the workspace predicate and repository statement timeout.
CREATE INDEX IF NOT EXISTS boards_workspace_name_search_idx
    ON boards (workspace_id, lower(name) text_pattern_ops, id);
CREATE INDEX IF NOT EXISTS issues_title_search_idx
    ON issues (board_id, lower(title) text_pattern_ops, id);
CREATE INDEX IF NOT EXISTS issues_board_updated_order_idx
    ON issues (board_id, updated_at DESC, id DESC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'saved_issue_views'::regclass
          AND NOT tgisinternal
          AND tgname = 'berry_saved_issue_views_set_updated_at'
    ) THEN
        CREATE TRIGGER berry_saved_issue_views_set_updated_at
            BEFORE UPDATE ON saved_issue_views
            FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'issue_view_preferences'::regclass
          AND NOT tgisinternal
          AND tgname = 'berry_issue_view_preferences_set_updated_at'
    ) THEN
        CREATE TRIGGER berry_issue_view_preferences_set_updated_at
            BEFORE UPDATE ON issue_view_preferences
            FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'notification_preferences'::regclass
          AND NOT tgisinternal
          AND tgname = 'berry_notification_preferences_set_updated_at'
    ) THEN
        CREATE TRIGGER berry_notification_preferences_set_updated_at
            BEFORE UPDATE ON notification_preferences
            FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
    END IF;
END
$$;
