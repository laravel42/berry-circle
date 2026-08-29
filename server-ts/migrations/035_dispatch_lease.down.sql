DROP INDEX IF EXISTS runs_dispatch_lease_idx;
ALTER TABLE runs DROP COLUMN IF EXISTS dispatch_lease_until;
