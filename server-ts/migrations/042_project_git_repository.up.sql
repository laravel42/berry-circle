-- The repository on Berry's own git server that a project's work lives in.
--
-- `github_repo` names somewhere else, and is optional: a project may deliver
-- nowhere, or to a host Berry does not control. This one is Berry's, created
-- with the project, and is where an agent clones from when no external
-- repository is linked — so a run always has somewhere to work rather than
-- failing for want of a checkout.
--
-- The path is relative to the server's repositories directory, not a URL. The
-- URL depends on how a run reaches the server, which is deployment
-- configuration and not a property of the project.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS git_repo text;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_git_repo_ck;
ALTER TABLE projects
    ADD CONSTRAINT projects_git_repo_ck
    CHECK (git_repo IS NULL OR git_repo ~ '^[a-z0-9][a-z0-9._-]{0,98}\.git$');

COMMENT ON COLUMN projects.git_repo IS
    'Bare repository on Berry''s git server, relative to its repositories directory.';
