-- Documentation only: Berry migrations are forward-only and this file is not
-- embedded or executed. It records what a manual revert of 023 would involve.

ALTER TABLE automation_trigger_receipts DROP CONSTRAINT IF EXISTS automation_trigger_receipts_reason_ck;
ALTER TABLE automation_trigger_receipts DROP COLUMN IF EXISTS reason;
