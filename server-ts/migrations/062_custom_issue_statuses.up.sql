-- Berry 062: an issue may name a custom status. `issues.status` stays the
-- category (the enum the board, the ledger and the review gate address), and
-- `status_id` refines it. A status change that does not name a status_id drops
-- a status_id of another category instead of failing.

ALTER TABLE issues
    ADD COLUMN IF NOT EXISTS status_id uuid
        REFERENCES issue_status_definitions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS issues_status_id_idx
    ON issues (status_id) WHERE status_id IS NOT NULL;

CREATE OR REPLACE FUNCTION berry_issue_status_definition_matches()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    definition_category text;
    definition_workspace uuid;
    issue_workspace uuid;
BEGIN
    IF NEW.status_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT category, workspace_id
      INTO definition_category, definition_workspace
      FROM issue_status_definitions WHERE id = NEW.status_id;
    SELECT workspace_id INTO issue_workspace FROM boards WHERE id = NEW.board_id;
    IF definition_workspace IS DISTINCT FROM issue_workspace THEN
        RAISE EXCEPTION 'status belongs to another workspace' USING ERRCODE = '23503';
    END IF;
    IF definition_category <> NEW.status::text THEN
        IF TG_OP = 'UPDATE' AND NEW.status_id IS NOT DISTINCT FROM OLD.status_id THEN
            NEW.status_id := NULL;
        ELSE
            RAISE EXCEPTION 'status definition category does not match the issue status'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER issues_status_definition_matches
    BEFORE INSERT OR UPDATE OF status, status_id, board_id ON issues
    FOR EACH ROW EXECUTE FUNCTION berry_issue_status_definition_matches();

ALTER TABLE issue_subscribers DROP CONSTRAINT IF EXISTS issue_subscribers_reason_ck;
ALTER TABLE issue_subscribers
    ADD CONSTRAINT issue_subscribers_reason_ck
    CHECK (reason IN ('creator', 'assignee', 'commenter', 'mentioned', 'manual'));
