-- Berry migration 016: issues can be deleted without being destroyed.
--
-- Soft, matching projects and workspaces, for two reasons beyond recoverability.
--
-- An issue's number is part of its identity: PLATFORM-4 appears in run history,
-- audit rows, comments and links. The next number comes from max(number) on the
-- board, so removing the newest issue would hand its number to the next one
-- created, and PLATFORM-4 would name two different things over time. Keeping
-- the row keeps the number retired.
--
-- And an issue owns work that outlives the reason for deleting it. Twelve
-- foreign keys cascade from here, including runs, run_events and attachments —
-- the record of what an agent did and the artifacts it produced, whose bytes
-- live in object storage and would be orphaned by a cascade that never calls
-- the two-phase attachment delete.
ALTER TABLE issues
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Every read filters on this, so the index carries the predicate rather than
-- leaving each query to scan and discard.
CREATE INDEX IF NOT EXISTS issues_board_live_idx
    ON issues (board_id, status, sort_order)
    WHERE deleted_at IS NULL;

-- Intake claims work by status, and a deleted issue must never be claimed: an
-- agent starting a run on something a person deleted is the failure this index
-- and the filter beside it exist to prevent.
CREATE INDEX IF NOT EXISTS issues_intake_ready_idx
    ON issues (created_at, id)
    WHERE deleted_at IS NULL AND status = 'todo' AND active_run_id IS NULL;
