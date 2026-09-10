-- Berry 061: sub-issues. A child points at its parent; `stage` orders siblings
-- into barriers (stage N+1 waits for every stage <= N sibling to finish).
-- A stage without a parent is ignored rather than refused, because deleting a
-- parent sets parent_id to NULL and must not fail on the child's stage.

ALTER TABLE issues
    ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES issues(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS stage integer;

ALTER TABLE issues
    ADD CONSTRAINT issues_parent_not_self_ck CHECK (parent_id IS NULL OR parent_id <> id),
    ADD CONSTRAINT issues_stage_range_ck CHECK (stage IS NULL OR stage BETWEEN 0 AND 1000);

CREATE INDEX IF NOT EXISTS issues_parent_stage_idx
    ON issues (parent_id, stage, id)
    WHERE parent_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION berry_issue_parent_same_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM issues AS parent
          JOIN boards AS parent_board ON parent_board.id = parent.board_id
          JOIN boards AS child_board ON child_board.id = NEW.board_id
         WHERE parent.id = NEW.parent_id
           AND parent_board.workspace_id = child_board.workspace_id
    ) THEN
        RAISE EXCEPTION 'parent issue belongs to another workspace'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER issues_parent_same_workspace
    BEFORE INSERT OR UPDATE OF parent_id, board_id ON issues
    FOR EACH ROW EXECUTE FUNCTION berry_issue_parent_same_workspace();
