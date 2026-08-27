DROP INDEX IF EXISTS issue_auto_reviews_pending_idx;
DELETE FROM issue_auto_reviews WHERE approved IS NULL;
ALTER TABLE issue_auto_reviews
    DROP CONSTRAINT IF EXISTS issue_auto_reviews_decision_ck,
    DROP CONSTRAINT IF EXISTS issue_auto_reviews_attempt_ck;
ALTER TABLE issue_auto_reviews
    DROP COLUMN IF EXISTS started_at,
    DROP COLUMN IF EXISTS decided_at,
    DROP COLUMN IF EXISTS attempt;
ALTER TABLE issue_auto_reviews
    ALTER COLUMN approved SET NOT NULL,
    ALTER COLUMN reason SET NOT NULL;
