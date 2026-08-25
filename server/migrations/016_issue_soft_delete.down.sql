-- Reverting discards the distinction between deleted and live issues. The rows
-- are removed rather than revived: they were deleted deliberately, and
-- restoring them into every board view on a rollback would be a surprise.
DELETE FROM issues WHERE deleted_at IS NOT NULL;

DROP INDEX IF EXISTS issues_intake_ready_idx;
DROP INDEX IF EXISTS issues_board_live_idx;

ALTER TABLE issues DROP COLUMN IF EXISTS deleted_at;
