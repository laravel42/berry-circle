-- Agent output becomes a tree of its own, instead of borrowing the table
-- built for a person dragging a file onto an issue.
--
-- `attachments.file_name` is checked against `!~ '[[:cntrl:]/\\]'`: a
-- separator is forbidden, deliberately, because that name is rendered and used
-- in downloads. Agent output is not a name, it is a path — an agent asked to
-- build an application writes src/password/generator.ts and
-- .github/workflows/ci.yml — so storing it there meant either flattening the
-- path into the name or dropping everything below the top level. Berry did the
-- second, silently: a run that wrote eleven files under src/ promoted none of
-- them and read as having produced nothing.
--
-- Delivery already needed the real path, because a commit places a file rather
-- than naming one. This gives promotion the same fact, so the two stop
-- disagreeing about what a file is.
CREATE TABLE IF NOT EXISTS run_artifacts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    run_id          uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    issue_id        uuid NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
    -- The agent is denormalised for display: an artifact outlives the agent
    -- row being archived, and "written by coder" must survive that.
    agent_id        uuid REFERENCES agents (id) ON DELETE SET NULL,
    agent_name      text NOT NULL,
    -- path is relative to the run's output/ directory, slash-separated.
    path            text NOT NULL,
    content_type    text NOT NULL,
    size_bytes      bigint NOT NULL,
    checksum_sha256 bytea NOT NULL,
    storage_key     text NOT NULL UNIQUE,
    state           text NOT NULL DEFAULT 'pending',
    created_at      timestamptz NOT NULL DEFAULT now(),
    ready_at        timestamptz,

    -- A path is the one field here that reaches a filesystem, a git tree and a
    -- URL, so it is constrained at the column rather than trusted from the
    -- promoter. Anything that could climb out of the run's output directory,
    -- or address a directory rather than a file, is refused.
    CONSTRAINT run_artifacts_path_length_ck
        CHECK (char_length(path) BETWEEN 1 AND 1024),
    CONSTRAINT run_artifacts_path_safe_ck
        CHECK (
            path !~ '[[:cntrl:]\\]'
            AND btrim(path) = path
            AND path !~ '^/'
            AND path !~ '/$'
            AND path !~ '//'
            -- No segment that is '.' or '..', at any position.
            AND path !~ '(^|/)\.\.?(/|$)'
        ),
    CONSTRAINT run_artifacts_content_type_ck
        CHECK (char_length(content_type) BETWEEN 1 AND 255 AND content_type !~ '[[:cntrl:]]'),
    CONSTRAINT run_artifacts_size_ck
        CHECK (size_bytes BETWEEN 1 AND 26214400),
    CONSTRAINT run_artifacts_checksum_ck
        CHECK (octet_length(checksum_sha256) = 32),
    CONSTRAINT run_artifacts_state_ck
        CHECK (state IN ('pending', 'ready', 'deleting')),
    CONSTRAINT run_artifacts_ready_state_ck
        CHECK (
            (state = 'pending' AND ready_at IS NULL)
            OR (state IN ('ready', 'deleting') AND ready_at IS NOT NULL)
        ),
    CONSTRAINT run_artifacts_storage_key_shape_ck
        CHECK (storage_key ~ '^artifacts/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}$')
);

-- One row per path per run: a retried promotion re-reserves the same file
-- rather than adding a second copy of it.
CREATE UNIQUE INDEX IF NOT EXISTS run_artifacts_run_path_key
    ON run_artifacts (run_id, path);

-- The tree, in path order, which is the order it is rendered in.
CREATE INDEX IF NOT EXISTS run_artifacts_run_order_idx
    ON run_artifacts (run_id, path) WHERE state = 'ready';

-- Everything an issue has produced across every run on it.
CREATE INDEX IF NOT EXISTS run_artifacts_issue_order_idx
    ON run_artifacts (issue_id, created_at DESC, id DESC) WHERE state = 'ready';

-- Move what already exists. The stored objects are untouched: only the row
-- changes tables, and its storage_key still names the same bytes. Flat paths,
-- because a flat name is exactly what these artifacts were able to record.
INSERT INTO run_artifacts (
    id, workspace_id, run_id, issue_id, agent_id, agent_name, path,
    content_type, size_bytes, checksum_sha256, storage_key, state,
    created_at, ready_at
)
SELECT attachment.id, board.workspace_id, attachment.run_id, attachment.issue_id,
       attachment.uploader_agent_id, attachment.uploader_name, attachment.file_name,
       attachment.content_type, attachment.size_bytes, attachment.checksum_sha256,
       attachment.storage_key, attachment.state, attachment.created_at, attachment.ready_at
  FROM attachments AS attachment
  JOIN issues AS issue ON issue.id = attachment.issue_id
  JOIN boards AS board ON board.id = issue.board_id
 WHERE attachment.run_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- attachments is a person's upload again. The rows are not dropped blindly:
-- only those that moved above, matched on the id they kept.
DELETE FROM attachments
 WHERE run_id IS NOT NULL
   AND id IN (SELECT id FROM run_artifacts);
