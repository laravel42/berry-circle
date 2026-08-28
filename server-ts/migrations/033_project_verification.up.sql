-- What a project's work has to pass before a person is asked to look at it.
--
-- The commands live on the project rather than in the repository because Berry
-- runs them and Berry has to be able to show them: an operator changing what
-- counts as verified should not need a commit, and a run should not be able to
-- weaken its own evidence by editing a file in the branch it is proposing.
--
-- Ordered, because the useful order is the cheap-and-decisive one — a lint that
-- fails in two seconds should not wait behind a ten-minute test suite.
--
-- Empty means a run delivers with no evidence attached, which is the state
-- every project is in until someone fills this in. That is a weaker pull
-- request, not a broken one.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS verify_commands text[] NOT NULL DEFAULT ARRAY[]::text[];

-- A ceiling rather than a policy: a project with fifty verification commands
-- has a problem this column cannot solve, and a run that tried would hold a
-- container open for an hour.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_verify_commands_ck;
ALTER TABLE projects
    ADD CONSTRAINT projects_verify_commands_ck
    CHECK (array_length(verify_commands, 1) IS NULL OR array_length(verify_commands, 1) <= 10)
    NOT VALID;

COMMENT ON COLUMN projects.verify_commands IS
    'Shell commands run in the run''s checkout after the agent finishes. Their results become the evidence attached to the pull request.';
