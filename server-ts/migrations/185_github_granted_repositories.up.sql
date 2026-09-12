-- Berry migration 185: the repositories GitHub says a workspace was granted.
--
-- Berry holds no App private key on this deployment, so it cannot mint an
-- installation token and cannot ask `/installation/repositories` anything. What
-- it does hold is the user-to-server token from sign-in, which answers
-- `/user/installations/{id}/repositories` — the repositories that person granted
-- when they installed the App. Those answers are recorded here so that every
-- surface which lists repositories (the settings page, the project picker) reads
-- a table rather than a live call that needs a credential Berry may not have at
-- that moment, and so the list survives the person who granted it going offline.
--
-- Keyed by (workspace_id, repository_id): a repository row belongs to exactly
-- one workspace, which is the sentence the isolation rests on — another
-- workspace granted the same repository records its own row and sees only that
-- one. Never keyed by repository alone, which would make two workspaces fight
-- over the same row and let one read the other's grant.
--
-- `installation_id` is the account the grant came through, kept so a later mint
-- (on a deployment that does have a private key) knows which installation
-- actually owns the repository, and so a disconnected account's repositories go
-- with it. It references nothing: an installation row can be removed by a
-- webhook while the grant is still worth remembering as stale, and the refresh
-- below is what reconciles them.
--
-- `refreshed_at` is when GitHub last said this, because the whole table is a
-- cache of somebody else's truth and a page that shows it should be able to say
-- how old it is.
CREATE TABLE IF NOT EXISTS github_granted_repositories (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    repository_id bigint NOT NULL,
    installation_id bigint NOT NULL,
    full_name text NOT NULL,
    private boolean NOT NULL DEFAULT false,
    default_branch text,
    account_login text,
    account_type text,
    html_url text,
    refreshed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, repository_id),
    CONSTRAINT github_granted_repositories_id_ck CHECK (repository_id > 0),
    CONSTRAINT github_granted_repositories_installation_ck CHECK (installation_id > 0),
    CONSTRAINT github_granted_repositories_full_name_ck
        CHECK (char_length(full_name) BETWEEN 1 AND 400)
);

-- The read every surface makes: this workspace's repositories, grouped by the
-- account they came from and named in order inside it.
CREATE INDEX IF NOT EXISTS github_granted_repositories_workspace_idx
    ON github_granted_repositories (workspace_id, account_login, full_name);

-- And the write a refresh makes: everything this installation granted, replaced.
CREATE INDEX IF NOT EXISTS github_granted_repositories_installation_idx
    ON github_granted_repositories (workspace_id, installation_id);

COMMENT ON TABLE github_granted_repositories IS
    'What GitHub reported a workspace was granted, read with a member''s own user-to-server token.';
COMMENT ON COLUMN github_granted_repositories.installation_id IS
    'The App installation the grant came through; not a foreign key, so a removed installation leaves the grant readable as stale.';
COMMENT ON COLUMN github_granted_repositories.refreshed_at IS
    'When GitHub last confirmed this row. The table is a cache of GitHub''s answer, not a source of truth.';
