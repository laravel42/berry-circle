-- The lease that makes an abandoned run detectable.
--
-- A run is claimed by a process and then executed for minutes. If that process
-- dies mid-run, nothing else can tell the difference between "someone is
-- working on this" and "nobody is, and never will be again" — and the run
-- stays `running` forever, holding its task's `active_run_id` and blocking
-- every later run on that task.
--
-- Elapsed time alone cannot answer it: a long model turn is silent, and a
-- threshold low enough to catch a dead worker is low enough to kill a live
-- one. A lease can, because renewing it is unconditional — a live owner
-- renews while the model thinks, and a dead one cannot renew at all.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS dispatch_lease_until timestamptz;

-- The dispatcher's two queries, both of which run every poll: find the next
-- claimable run, and find the abandoned ones. Partial, because a terminal run
-- is neither and there are far more of those than of the rest.
CREATE INDEX IF NOT EXISTS runs_dispatch_lease_idx
    ON runs (dispatch_lease_until)
    WHERE status IN ('queued', 'running');

COMMENT ON COLUMN runs.dispatch_lease_until IS
    'While a process is executing this run it holds a lease and renews it. A lease in the past means the holder is gone; null means nobody has claimed the run yet.';
