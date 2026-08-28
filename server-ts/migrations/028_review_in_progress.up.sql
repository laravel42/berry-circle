-- A review becomes visible when it starts, not when it finishes.
--
-- The row was written after the model answered, so for the length of the call
-- — and for as long as a failed call left no row at all — a task under review
-- looked exactly like a task nobody had reached. Reserving the row first makes
-- "who is reviewing this" answerable while it is still true.
ALTER TABLE issue_auto_reviews
    ALTER COLUMN approved DROP NOT NULL,
    ALTER COLUMN reason DROP NOT NULL;

ALTER TABLE issue_auto_reviews
    ADD COLUMN IF NOT EXISTS started_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS decided_at timestamptz,
    -- Which attempt at this task this review judged. A rejection sends the
    -- task back to be worked again, and without a count that loop has no end.
    ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;

-- Rows that predate this were all decided.
UPDATE issue_auto_reviews SET decided_at = created_at WHERE decided_at IS NULL AND approved IS NOT NULL;

-- Undecided means in progress; decided means both fields are present.
ALTER TABLE issue_auto_reviews
    ADD CONSTRAINT issue_auto_reviews_decision_ck CHECK (
        (approved IS NULL AND reason IS NULL AND decided_at IS NULL)
        OR (approved IS NOT NULL AND reason IS NOT NULL AND decided_at IS NOT NULL)
    );

ALTER TABLE issue_auto_reviews
    ADD CONSTRAINT issue_auto_reviews_attempt_ck CHECK (attempt BETWEEN 1 AND 100);

-- Reading "is anything reviewing this issue right now" without a scan.
CREATE INDEX IF NOT EXISTS issue_auto_reviews_pending_idx
    ON issue_auto_reviews (issue_id, started_at DESC) WHERE approved IS NULL;
