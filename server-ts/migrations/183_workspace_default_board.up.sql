-- Berry migration 183: a board in every workspace.
--
-- `issues.board_id` is NOT NULL, so a workspace with no board cannot hold a
-- task at all — not one a person files and not one an agent files. A workspace
-- created through onboarding was given its Orchestrator, its Guide and its
-- issue statuses by trigger, but never a board, so it could track no work.
-- This closes the gap the way migration 009 closes it for the Orchestrator:
-- one trigger for new workspaces, one backfill for the ones already here.
--
-- The board is called 'Tasks' because that is what the product calls an issue
-- everywhere a person reads one ("My tasks", "New task").
--
-- `boards.slug` is unique across the whole deployment (boards_slug_key), not
-- per workspace, so only the first workspace can hold 'tasks'; the rest take
-- 'tasks-' and six hex characters, which is exactly the twelve characters
-- boards_slug_format_ck allows.
--
-- `created_by` is left NULL. A trigger has no actor, and attributing somebody's
-- board to the system user would be a claim the UI would then show.
--
-- That needs berry_assign_board_workspace (migration 004) relaxed: it refused a
-- NULL creator outright. What it is actually for is stopping a board from being
-- attributed to someone who is not in its workspace, and a board attributed to
-- nobody makes no such claim. So the membership check now applies to a named
-- creator only, and the message and SQLSTATE are unchanged for the callers that
-- assert on them.

CREATE OR REPLACE FUNCTION berry_assign_board_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.workspace_id IS NULL THEN
        SELECT u.last_workspace_id
        INTO NEW.workspace_id
        FROM users AS u
        JOIN workspace_memberships AS membership
          ON membership.workspace_id = u.last_workspace_id
         AND membership.user_id = u.id
        JOIN workspaces AS workspace
          ON workspace.id = membership.workspace_id
         AND workspace.deleted_at IS NULL
        WHERE u.id = NEW.created_by;
    END IF;

    IF NEW.workspace_id IS NULL OR (NEW.created_by IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM workspace_memberships AS membership
        JOIN workspaces AS workspace
          ON workspace.id = membership.workspace_id
         AND workspace.deleted_at IS NULL
        WHERE membership.workspace_id = NEW.workspace_id
          AND membership.user_id = NEW.created_by
    )) THEN
        RAISE EXCEPTION 'board creator has no active workspace membership'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION berry_ensure_workspace_board(target_workspace uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    candidate text := 'tasks';
BEGIN
    IF target_workspace IS NULL THEN
        RETURN;
    END IF;
    -- A workspace that already has a board keeps exactly the boards it has:
    -- this migration guarantees at least one, not a board of its own naming.
    IF EXISTS (SELECT 1 FROM boards WHERE workspace_id = target_workspace) THEN
        RETURN;
    END IF;
    WHILE EXISTS (SELECT 1 FROM boards WHERE slug = candidate) LOOP
        candidate := 'tasks-' || substr(md5(gen_random_uuid()::text), 1, 6);
    END LOOP;
    INSERT INTO boards (
        id, workspace_id, name, slug, description, columns,
        created_by, created_at, updated_at
    )
    VALUES (
        gen_random_uuid(),
        target_workspace,
        'Tasks',
        candidate,
        'Default board for this workspace.',
        '[]'::jsonb,
        NULL,
        now(),
        now()
    )
    ON CONFLICT DO NOTHING;
END
$$;

CREATE OR REPLACE FUNCTION berry_workspace_board_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM berry_ensure_workspace_board(NEW.id);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS berry_workspaces_ensure_board ON workspaces;
CREATE TRIGGER berry_workspaces_ensure_board
    AFTER INSERT ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION berry_workspace_board_trigger();

-- Backfill every workspace that predates this migration.
DO $$
DECLARE
    workspace_row record;
BEGIN
    FOR workspace_row IN SELECT id FROM workspaces WHERE deleted_at IS NULL LOOP
        PERFORM berry_ensure_workspace_board(workspace_row.id);
    END LOOP;
END
$$;
