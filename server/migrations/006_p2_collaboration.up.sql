-- Berry P2 collaboration and attachment primitives.
-- This migration intentionally depends only on objects present through 004.

ALTER TABLE comments
    ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
    ADD COLUMN IF NOT EXISTS resolved_by uuid;

UPDATE comments SET revision = 1 WHERE revision IS NULL OR revision < 1;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'comments'::regclass
          AND conname = 'comments_revision_positive_ck'
    ) THEN
        ALTER TABLE comments
            ADD CONSTRAINT comments_revision_positive_ck
            CHECK (revision > 0) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'comments'::regclass
          AND conname = 'comments_resolution_pair_ck'
    ) THEN
        ALTER TABLE comments
            ADD CONSTRAINT comments_resolution_pair_ck
            CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'comments'::regclass
          AND conname = 'comments_resolved_by_users_id_fk'
    ) THEN
        ALTER TABLE comments
            ADD CONSTRAINT comments_resolved_by_users_id_fk
            FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE RESTRICT
            NOT VALID;
    END IF;
END
$$;

ALTER TABLE comments VALIDATE CONSTRAINT comments_revision_positive_ck;
ALTER TABLE comments VALIDATE CONSTRAINT comments_resolution_pair_ck;
ALTER TABLE comments VALIDATE CONSTRAINT comments_resolved_by_users_id_fk;

CREATE INDEX IF NOT EXISTS comments_issue_resolution_idx
    ON comments (issue_id, resolved_at, id)
    WHERE resolved_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS comments_one_resolution_per_thread_key
    ON comments (issue_id, (COALESCE(parent_id, id)))
    WHERE resolved_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS attachments (
    id uuid PRIMARY KEY,
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    comment_id uuid,
    uploader_id uuid REFERENCES users(id) ON DELETE SET NULL,
    uploader_name text NOT NULL,
    file_name text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    checksum_sha256 bytea NOT NULL,
    storage_key text NOT NULL,
    state text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    ready_at timestamptz,
    CONSTRAINT attachments_comment_issue_fk
        FOREIGN KEY (issue_id, comment_id)
        REFERENCES comments(issue_id, id)
        ON DELETE CASCADE,
    CONSTRAINT attachments_uploader_name_length_ck
        CHECK (char_length(uploader_name) BETWEEN 1 AND 100),
    CONSTRAINT attachments_file_name_length_ck
        CHECK (char_length(file_name) BETWEEN 1 AND 255),
    CONSTRAINT attachments_file_name_safe_ck
        CHECK (file_name !~ '[[:cntrl:]/\\]'
            AND btrim(file_name) = file_name
            AND file_name NOT IN ('.', '..')),
    CONSTRAINT attachments_content_type_length_ck
        CHECK (char_length(content_type) BETWEEN 1 AND 255),
    CONSTRAINT attachments_content_type_safe_ck
        CHECK (content_type !~ '[[:cntrl:]]'),
    CONSTRAINT attachments_size_ck
        CHECK (size_bytes BETWEEN 1 AND 26214400),
    CONSTRAINT attachments_checksum_ck
        CHECK (octet_length(checksum_sha256) = 32),
    CONSTRAINT attachments_storage_key_length_ck
        CHECK (char_length(storage_key) BETWEEN 1 AND 1024),
    CONSTRAINT attachments_storage_key_shape_ck
        CHECK (storage_key ~
            '^attachments/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT attachments_state_ck
        CHECK (state IN ('pending', 'ready', 'deleting')),
    CONSTRAINT attachments_ready_state_ck
        CHECK ((state = 'pending' AND ready_at IS NULL)
            OR (state IN ('ready', 'deleting') AND ready_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS attachments_storage_key_key
    ON attachments (storage_key);
CREATE INDEX IF NOT EXISTS attachments_issue_order_idx
    ON attachments (issue_id, created_at, id)
    WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS attachments_comment_order_idx
    ON attachments (comment_id, created_at, id)
    WHERE comment_id IS NOT NULL AND state = 'ready';
CREATE INDEX IF NOT EXISTS attachments_incomplete_idx
    ON attachments (created_at, id)
    WHERE state <> 'ready';

CREATE TABLE IF NOT EXISTS issue_reactions (
    id uuid PRIMARY KEY,
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT issue_reactions_emoji_length_ck
        CHECK (char_length(emoji) BETWEEN 1 AND 16 AND octet_length(emoji) <= 64),
    CONSTRAINT issue_reactions_emoji_safe_ck
        CHECK (emoji !~ '[[:cntrl:][:space:]]'),
    CONSTRAINT issue_reactions_actor_emoji_key
        UNIQUE (issue_id, actor_id, emoji)
);

CREATE INDEX IF NOT EXISTS issue_reactions_issue_order_idx
    ON issue_reactions (issue_id, created_at, id);

CREATE TABLE IF NOT EXISTS comment_reactions (
    id uuid PRIMARY KEY,
    comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT comment_reactions_emoji_length_ck
        CHECK (char_length(emoji) BETWEEN 1 AND 16 AND octet_length(emoji) <= 64),
    CONSTRAINT comment_reactions_emoji_safe_ck
        CHECK (emoji !~ '[[:cntrl:][:space:]]'),
    CONSTRAINT comment_reactions_actor_emoji_key
        UNIQUE (comment_id, actor_id, emoji)
);

CREATE INDEX IF NOT EXISTS comment_reactions_comment_order_idx
    ON comment_reactions (comment_id, created_at, id);

CREATE TABLE IF NOT EXISTS issue_subscribers (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason text NOT NULL DEFAULT 'manual',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (issue_id, user_id),
    CONSTRAINT issue_subscribers_membership_fk
        FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_memberships(workspace_id, user_id)
        ON DELETE CASCADE,
    CONSTRAINT issue_subscribers_reason_ck
        CHECK (reason IN ('creator', 'assignee', 'commenter', 'manual'))
);

CREATE INDEX IF NOT EXISTS issue_subscribers_issue_order_idx
    ON issue_subscribers (issue_id, created_at, user_id);
CREATE INDEX IF NOT EXISTS issue_subscribers_user_idx
    ON issue_subscribers (workspace_id, user_id, created_at, issue_id);

CREATE OR REPLACE FUNCTION berry_p2_enforce_subscriber_issue_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM issues AS issue
        JOIN boards AS board ON board.id = issue.board_id
        WHERE issue.id = NEW.issue_id
          AND board.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23503',
            CONSTRAINT = 'issue_subscribers_issue_workspace_fk',
            MESSAGE = 'issue subscriber workspace does not own issue';
    END IF;
    RETURN NEW;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'issue_subscribers'::regclass
          AND tgname = 'issue_subscribers_issue_workspace_ck'
          AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER issue_subscribers_issue_workspace_ck
            BEFORE INSERT OR UPDATE OF workspace_id, issue_id
            ON issue_subscribers
            FOR EACH ROW
            EXECUTE FUNCTION berry_p2_enforce_subscriber_issue_workspace();
    END IF;
END
$$;

-- Backfill only users who still hold membership in the owning workspace.
INSERT INTO issue_subscribers (workspace_id, issue_id, user_id, reason, created_at)
SELECT board.workspace_id, issue.id, issue.created_by, 'creator', issue.created_at
FROM issues AS issue
JOIN boards AS board ON board.id = issue.board_id
JOIN workspace_memberships AS membership
  ON membership.workspace_id = board.workspace_id
 AND membership.user_id = issue.created_by
WHERE issue.created_by IS NOT NULL
ON CONFLICT (issue_id, user_id) DO NOTHING;

INSERT INTO issue_subscribers (workspace_id, issue_id, user_id, reason, created_at)
SELECT board.workspace_id, issue.id, issue.assignee_id, 'assignee', issue.updated_at
FROM issues AS issue
JOIN boards AS board ON board.id = issue.board_id
JOIN workspace_memberships AS membership
  ON membership.workspace_id = board.workspace_id
 AND membership.user_id = issue.assignee_id
WHERE issue.assignee_type = 'user' AND issue.assignee_id IS NOT NULL
ON CONFLICT (issue_id, user_id) DO NOTHING;

INSERT INTO issue_subscribers (workspace_id, issue_id, user_id, reason, created_at)
SELECT board.workspace_id, comment.issue_id, comment.author_id, 'commenter', min(comment.created_at)
FROM comments AS comment
JOIN issues AS issue ON issue.id = comment.issue_id
JOIN boards AS board ON board.id = issue.board_id
JOIN workspace_memberships AS membership
  ON membership.workspace_id = board.workspace_id
 AND membership.user_id = comment.author_id
WHERE comment.author_type = 'user'
GROUP BY board.workspace_id, comment.issue_id, comment.author_id
ON CONFLICT (issue_id, user_id) DO NOTHING;
