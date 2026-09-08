-- Repository names lost their `.git` suffix when Berry moved to Gitea.
--
-- The bare-repository server this replaces was handed directories, and a bare
-- repository is named `<name>.git` by convention. Gitea names a repository
-- without the suffix and appends it to the clone URL itself, so a repository
-- literally called `foo.git` would be cloned from `foo.git.git`.
--
-- Existing rows are left as they are rather than rewritten: the repository they
-- name is on the server that is going away, so rewriting the string would
-- produce a name that points at nothing on either server. They are allowed by
-- the relaxed constraint and will be replaced when their project is.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_git_repo_ck;
ALTER TABLE projects
    ADD CONSTRAINT projects_git_repo_ck
    CHECK (git_repo IS NULL OR git_repo ~ '^[a-z0-9][a-z0-9._-]{0,98}$');

COMMENT ON COLUMN projects.git_repo IS
    'Repository name on Berry''s Gitea, under the configured owner. No .git suffix.';
