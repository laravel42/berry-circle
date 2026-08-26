-- Berry migration 023: trigger receipts carry the reason an event was skipped
-- or failed.
--
-- The dispatcher writes exactly one receipt per claimed outbox event and never
-- offers the event again (a provider action is an unsafe POST, so nothing is
-- retried by loops). An operator reading a 'skipped' or 'failed' receipt needs
-- the why beside the outcome rather than in a log line that has rotated away.
ALTER TABLE automation_trigger_receipts ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE automation_trigger_receipts DROP CONSTRAINT IF EXISTS automation_trigger_receipts_reason_ck;
ALTER TABLE automation_trigger_receipts ADD CONSTRAINT automation_trigger_receipts_reason_ck
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500);
