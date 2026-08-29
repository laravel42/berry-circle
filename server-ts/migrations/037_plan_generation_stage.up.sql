-- Where a plan is, while it is being made.
--
-- Generation runs several model stages — generate, then repair when the
-- checks failed, then critic — and takes long enough that a person watches it.
-- Without this the page can say "running" and nothing else, which is the same
-- thing a hung generation says.
--
-- Null when nothing is running: the column answers "what is happening right
-- now", not "what happened", which is what `planner_events` is for.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS generation_stage text;

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_generation_stage_ck;
ALTER TABLE plans
    ADD CONSTRAINT plans_generation_stage_ck
    CHECK (generation_stage IS NULL OR generation_stage = ANY (ARRAY[
        'intent', 'context', 'generate', 'validate', 'repair', 'critic', 'finalize'
    ]))
    NOT VALID;

COMMENT ON COLUMN plans.generation_stage IS
    'The pipeline stage in flight while generation_status is running; null otherwise.';
