-- The GitHub App this deployment owns, and where it is installed.
--
-- Berry creates its own App through GitHub's manifest flow rather than being
-- handed credentials in the environment: the deployment posts a manifest, a
-- person presses Create on GitHub, and the conversion hands back the app id,
-- both halves of the OAuth credential, the private key and the webhook secret
-- in one exchange. Everything secret in that answer is sealed with the same key
-- that seals a connection's token, so there is still exactly one place in the
-- server where a provider credential exists in the clear.
--
-- One row. A deployment is one Berry, and one Berry is one App — several rows
-- would only raise the question of which App a run should mint a token from.
CREATE TABLE IF NOT EXISTS github_apps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Always true, and unique: the constraint is what makes this a singleton
    -- rather than a convention nothing enforces.
    singleton boolean NOT NULL DEFAULT true,
    app_id bigint NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    client_id text NOT NULL,
    client_secret_encrypted bytea NOT NULL,
    private_key_encrypted bytea NOT NULL,
    webhook_secret_encrypted bytea,
    html_url text,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT github_apps_singleton_ck CHECK (singleton),
    CONSTRAINT github_apps_singleton_key UNIQUE (singleton),
    CONSTRAINT github_apps_app_id_ck CHECK (app_id > 0),
    CONSTRAINT github_apps_slug_ck CHECK (char_length(slug) BETWEEN 1 AND 200)
);

COMMENT ON TABLE github_apps IS
    'The GitHub App this deployment created for itself, secrets sealed.';

-- Where that App is installed, per workspace.
--
-- An installation is what a token is minted against, so this is the row that
-- decides which repositories a workspace's agents can reach. One per workspace:
-- a second would make "which installation" a question every run has to answer.
CREATE TABLE IF NOT EXISTS github_installations (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    installation_id bigint NOT NULL,
    account_login text,
    account_type text,
    installed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT github_installations_id_ck CHECK (installation_id > 0)
);

COMMENT ON TABLE github_installations IS
    'The App installation a workspace mints repository tokens against.';
