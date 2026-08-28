-- Berry migration 017: a project can name the GitHub repository it delivers into.
--
-- Two columns rather than one, because the two facts have different lifetimes.
-- The numeric id is what GitHub guarantees stable: a repository keeps it across
-- renames and transfers between owners. The full name is what a person reads
-- and what every REST path is built from, and it changes underneath us without
-- notice.
--
-- Storing only the name would silently point at nothing after a rename — or,
-- worse, at whatever new repository took the name. Storing only the id would
-- mean a lookup before every call and a project that cannot be displayed while
-- GitHub is unreachable. Keeping both makes the id authoritative and the name a
-- cache that can be refreshed.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS github_repo_id bigint,
    ADD COLUMN IF NOT EXISTS github_repo_full_name text;

-- Both or neither. A project carrying half a reference is one that looks
-- linked and cannot be used, which is harder to notice than one that is plainly
-- unlinked.
ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_github_repo_pair_ck;
ALTER TABLE projects
    ADD CONSTRAINT projects_github_repo_pair_ck CHECK (
        (github_repo_id IS NULL AND github_repo_full_name IS NULL)
        OR (github_repo_id IS NOT NULL AND github_repo_full_name IS NOT NULL)
    ) NOT VALID;

-- owner/name, which is the only shape GitHub's REST paths accept. Constrained
-- because the value is interpolated into request paths: a name that could carry
-- a slash or a traversal segment would address a different resource entirely.
ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_github_repo_shape_ck;
ALTER TABLE projects
    ADD CONSTRAINT projects_github_repo_shape_ck CHECK (
        github_repo_full_name IS NULL
        OR github_repo_full_name ~ '^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$'
    ) NOT VALID;

-- "Which project delivers into this repository" is asked when a webhook or a
-- pull request arrives, so it gets an index rather than a scan.
CREATE INDEX IF NOT EXISTS projects_github_repo_idx
    ON projects (github_repo_id)
    WHERE github_repo_id IS NOT NULL AND deleted_at IS NULL;
