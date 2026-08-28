-- AutoGate: a plan may let its issues reach done without a person.
--
-- Off by default and per plan rather than per workspace. The gate it removes
-- is the one place a human sees an agent's work before it counts as finished,
-- so it is turned off unless somebody turned it on for a specific piece of
-- work, and turning it on for one plan says nothing about the next.
ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS auto_gate boolean NOT NULL DEFAULT false;

-- Carried onto the issue at compile time. By the time an issue reaches review
-- the plan is one join away, but the issue is the thing being gated and a plan
-- that is later edited must not retroactively change how work already in
-- flight is allowed to finish.
ALTER TABLE issues
    ADD COLUMN IF NOT EXISTS auto_gate boolean NOT NULL DEFAULT false;

-- The reviewer's verdict, so a person can see why an issue closed itself and
-- a second pass cannot silently overwrite the first.
CREATE TABLE IF NOT EXISTS issue_auto_reviews (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    issue_id       uuid NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
    run_id         uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    reviewer_id    uuid NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
    author_id      uuid NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
    approved       boolean NOT NULL,
    reason         text NOT NULL,
    ask_id         uuid,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT issue_auto_reviews_reason_length_ck CHECK (char_length(reason) <= 4000),
    -- One verdict per run. A retried activity records the same review once.
    CONSTRAINT issue_auto_reviews_run_key UNIQUE (run_id)
);

CREATE INDEX IF NOT EXISTS issue_auto_reviews_issue_idx
    ON issue_auto_reviews (issue_id, created_at DESC);

-- A reviewer must never be the author. Enforced here as well as in the picker
-- because "peer review" stops meaning anything the moment it can be the same
-- agent, and a bug in the picker should fail loudly rather than quietly
-- approve an agent's own work.
ALTER TABLE issue_auto_reviews
    ADD CONSTRAINT issue_auto_reviews_peer_ck CHECK (reviewer_id <> author_id);
