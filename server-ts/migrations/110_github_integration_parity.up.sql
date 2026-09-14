-- GitHub integration parity (workstream K, block 110-119).
--
-- Four facts per workspace, each owned by its workspace so a delete of the
-- workspace takes them with it and no read can cross the tenant line:
--
--   - what the workspace has switched on for GitHub,
--   - which repositories it works in,
--   - which pull requests GitHub has told Berry about, and which issues they
--     name, and
--   - the checks reported against those pull requests' head commits.
--
-- Pull requests and checks are keyed by GitHub's own numeric ids. A webhook is
-- routed to a workspace by its installation id before any of these rows are
-- touched, so a repository name never decides whose row is written.

-- The switches. No row means the defaults, which are all on: a workspace that
-- installed the App before this table existed keeps the behaviour it expects.
CREATE TABLE IF NOT EXISTS github_workspace_settings (
    workspace_id      uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
    -- The master switch. Off means no GitHub feature acts in this workspace,
    -- whatever the individual toggles say.
    enabled           boolean NOT NULL DEFAULT true,
    show_linked_prs   boolean NOT NULL DEFAULT true,
    co_author_trailer boolean NOT NULL DEFAULT true,
    auto_link_prs     boolean NOT NULL DEFAULT true,
    updated_by        uuid REFERENCES users (id) ON DELETE SET NULL,
    updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE github_workspace_settings IS
    'Per-workspace GitHub feature switches. Absent row = defaults (all on).';

-- The repositories a workspace works in, as a person would paste them.
-- `github_repo_id` is set only when the row came from the import picker, where
-- GitHub itself said which repository it is.
CREATE TABLE IF NOT EXISTS workspace_repositories (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    url            text NOT NULL,
    description    text NOT NULL DEFAULT '',
    github_repo_id bigint,
    position       integer NOT NULL DEFAULT 0,
    created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workspace_repositories_url_ck
        CHECK (char_length(url) BETWEEN 1 AND 500
               AND (url LIKE 'https://%' OR url LIKE 'ssh://%' OR url LIKE 'git@%')),
    CONSTRAINT workspace_repositories_description_ck CHECK (char_length(description) <= 500),
    CONSTRAINT workspace_repositories_url_key UNIQUE (workspace_id, url)
);

CREATE INDEX IF NOT EXISTS workspace_repositories_workspace_idx
    ON workspace_repositories (workspace_id, position, created_at);

-- A pull request as GitHub last described it.
CREATE TABLE IF NOT EXISTS github_pull_requests (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    github_id         bigint NOT NULL,
    repo_id           bigint NOT NULL,
    repo_full_name    text NOT NULL,
    number            integer NOT NULL,
    title             text NOT NULL,
    url               text NOT NULL,
    state             text NOT NULL,
    draft             boolean NOT NULL DEFAULT false,
    head_ref          text NOT NULL,
    head_sha          text,
    author_login      text,
    merged_at         timestamptz,
    closed_at         timestamptz,
    -- GitHub's own stamp. An event carrying an older one is a retry that
    -- arrived late, and must not roll a merged pull request back to open.
    github_updated_at timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT github_pull_requests_state_ck CHECK (state IN ('open', 'draft', 'merged', 'closed')),
    CONSTRAINT github_pull_requests_title_ck CHECK (char_length(title) <= 1000),
    CONSTRAINT github_pull_requests_key UNIQUE (workspace_id, github_id)
);

CREATE INDEX IF NOT EXISTS github_pull_requests_head_idx
    ON github_pull_requests (workspace_id, repo_id, head_sha);

-- Which issues a pull request names, and whether it said it closes them.
CREATE TABLE IF NOT EXISTS github_pull_request_links (
    workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    pull_request_id uuid NOT NULL REFERENCES github_pull_requests (id) ON DELETE CASCADE,
    issue_id        uuid NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
    close_intent    boolean NOT NULL DEFAULT false,
    source          text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pull_request_id, issue_id),
    CONSTRAINT github_pull_request_links_source_ck
        CHECK (source IN ('branch', 'title', 'body', 'run'))
);

CREATE INDEX IF NOT EXISTS github_pull_request_links_issue_idx
    ON github_pull_request_links (workspace_id, issue_id);

-- Check runs and check suites, against the commit they ran on. A pull request
-- finds its checks through its head commit, so a check that arrives before the
-- pull request event is not lost.
CREATE TABLE IF NOT EXISTS github_checks (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    kind         text NOT NULL,
    github_id    bigint NOT NULL,
    repo_id      bigint NOT NULL,
    head_sha     text NOT NULL,
    name         text NOT NULL,
    status       text NOT NULL,
    conclusion   text,
    url          text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT github_checks_kind_ck CHECK (kind IN ('run', 'suite')),
    CONSTRAINT github_checks_key UNIQUE (workspace_id, kind, github_id)
);

CREATE INDEX IF NOT EXISTS github_checks_head_idx
    ON github_checks (workspace_id, repo_id, head_sha);
