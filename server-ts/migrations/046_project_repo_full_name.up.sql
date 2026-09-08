-- A project's repository is addressed by owner and name, not name alone.
--
-- Migration 044 relaxed this column for Gitea's suffix-free names, but kept it
-- to a single path segment — which was true only while every repository lived
-- under one account. Workspaces now have organizations of their own, so `name`
-- no longer identifies a repository: two workspaces may each have `atlas-1a2b`.
--
-- Existing single-segment values stay valid and mean what they always did: a
-- repository under the deployment's default account.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_git_repo_ck;
ALTER TABLE projects
    ADD CONSTRAINT projects_git_repo_ck
    CHECK (
        git_repo IS NULL
        OR git_repo ~ '^[a-z0-9][a-z0-9._-]{0,98}(/[a-z0-9][a-z0-9._-]{0,98})?$'
    );

COMMENT ON COLUMN projects.git_repo IS
    'Repository on Berry''s git host as owner/name. A bare name means the default account.';
