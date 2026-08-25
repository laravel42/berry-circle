DROP INDEX IF EXISTS projects_github_repo_idx;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_github_repo_shape_ck;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_github_repo_pair_ck;

ALTER TABLE projects
    DROP COLUMN IF EXISTS github_repo_full_name,
    DROP COLUMN IF EXISTS github_repo_id;
