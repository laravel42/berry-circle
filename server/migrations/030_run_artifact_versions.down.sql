DROP INDEX IF EXISTS run_artifacts_latest_idx;
ALTER TABLE run_artifacts DROP CONSTRAINT IF EXISTS run_artifacts_run_path_version_key;
-- Only restorable while every path holds a single version.
ALTER TABLE run_artifacts ADD CONSTRAINT run_artifacts_run_path_key UNIQUE (run_id, path);
ALTER TABLE run_artifacts DROP CONSTRAINT IF EXISTS run_artifacts_version_ck;
ALTER TABLE run_artifacts DROP COLUMN IF EXISTS version;
