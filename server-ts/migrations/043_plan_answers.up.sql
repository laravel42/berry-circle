-- What a person answered when the planner asked.
--
-- A blocked plan is not a broken one: the planner raised a question it could
-- not answer for itself and proposed no tasks. Answering used to be
-- impossible, so the only way forward was to reject the plan and retype the
-- prompt with the answer buried in it.
--
-- These rows live outside `plans.ir` for a load-bearing reason: answering
-- regenerates the plan, and regeneration replaces the IR. An answer stored in
-- the document it produces would be destroyed by the act it caused.
--
-- Append-only. Answering again adds rows rather than overwriting, so a plan
-- that took three rounds of questions can still say what was asked each time.
CREATE TABLE IF NOT EXISTS plan_answers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    plan_id       uuid NOT NULL,
    -- The assumption's id within the IR that asked it (`a1`). Not a foreign
    -- key: the IR is a document, and the version holding that id is replaced
    -- by the regeneration this answer triggers.
    assumption_id text NOT NULL,
    -- Snapshotted rather than joined, for the same reason. Once the new
    -- version lands, the question is gone from the current document, and an
    -- answer whose question cannot be recovered is not an audit record.
    question      text NOT NULL,
    answer        text NOT NULL,
    -- The option id when one was picked, null when the answer was typed.
    chosen_option text,
    -- Answering starts agents, so this is an authorisation record, not
    -- decoration: it says who committed the workspace to the work.
    answered_by   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    -- The version that asked, not the one produced: the produced version does
    -- not exist yet when this row is written.
    for_version   integer NOT NULL,
    answered_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT plan_answers_plan_fk FOREIGN KEY (workspace_id, plan_id)
        REFERENCES plans (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT plan_answers_answer_ck CHECK (char_length(answer) BETWEEN 1 AND 4000),
    CONSTRAINT plan_answers_question_ck CHECK (char_length(question) BETWEEN 1 AND 4000),
    CONSTRAINT plan_answers_version_ck CHECK (for_version >= 0)
);

-- One answer per question per round. A second submission for the same round is
-- the same answer arriving twice — a double-clicked wizard, a retried request —
-- and must not become two rows the planner then sees as contradicting itself.
CREATE UNIQUE INDEX IF NOT EXISTS plan_answers_round_key
    ON plan_answers (plan_id, for_version, assumption_id);

-- The read the regeneration makes: every answer for a plan, oldest first.
CREATE INDEX IF NOT EXISTS plan_answers_plan_idx
    ON plan_answers (plan_id, answered_at);

COMMENT ON TABLE plan_answers IS
    'Answers to a planner question, kept outside the IR that regeneration replaces.';
