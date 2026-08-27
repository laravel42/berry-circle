-- An artifact path can hold more than one version.
--
-- ADK's ArtifactService versions what an agent saves: `saveArtifact` returns a
-- version number and a caller may load or list any of them. Berry's table was
-- keyed on (run_id, path) alone, so the only way to serve that interface was to
-- overwrite — silently discarding an agent's earlier output every time it
-- rewrote a file, which is the one thing a record of work should not do.
--
-- Version 0 is the first. Existing rows are version 0, so nothing that reads
-- one artifact per path sees a change until something writes a second version.

ALTER TABLE run_artifacts
    ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;

ALTER TABLE run_artifacts
    DROP CONSTRAINT IF EXISTS run_artifacts_version_ck;
ALTER TABLE run_artifacts
    ADD CONSTRAINT run_artifacts_version_ck CHECK (version >= 0);

-- The identity of an artifact is now the path *and* the version. Dropping the
-- old uniqueness is what allows a second version at all; adding the new one is
-- what still stops the same version being written twice.
--
-- Dropped as an index, not as a constraint. It was created as a unique index,
-- so ALTER TABLE ... DROP CONSTRAINT skips it with a notice and leaves it
-- enforcing the old rule — a migration that appears to succeed and changes
-- nothing. Both forms are attempted because either could exist.
ALTER TABLE run_artifacts
    DROP CONSTRAINT IF EXISTS run_artifacts_run_path_key;
DROP INDEX IF EXISTS run_artifacts_run_path_key;
ALTER TABLE run_artifacts
    ADD CONSTRAINT run_artifacts_run_path_version_key UNIQUE (run_id, path, version);

-- Reads want the newest version of each path, and allocating the next version
-- wants the highest for one path. Both are this index, descending.
CREATE INDEX IF NOT EXISTS run_artifacts_latest_idx
    ON run_artifacts (run_id, path, version DESC) WHERE state = 'ready';
