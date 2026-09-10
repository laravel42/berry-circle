-- Sign-in moves to Better Auth, with GitHub as the only method (workstream J).
--
-- Better Auth's user model is the existing users table, so every user keeps
-- the id their workspaces, issues and tokens already point at. Sessions,
-- linked provider accounts and OAuth state get tables of their own: Better
-- Auth stores its session token as it is (the cookie is signed), which is a
-- different contract from the hashed bearer tokens in `sessions`, and mixing
-- the two in one table would make every row ambiguous.

-- Better Auth reads and writes this. Existing users start unverified; linking
-- relies on GitHub's verified email, not on this flag (see src/auth/better-auth.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

-- Better Auth looks users up by the lowercased address. The unique index on
-- lower(email) already rules out two users that differ only in case, so this
-- cannot collide; it only makes the stored spelling match the lookup.
UPDATE users SET email = lower(email) WHERE email <> lower(email);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token text NOT NULL,
    expires_at timestamptz NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_token_key ON auth_sessions (token);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth_accounts (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamptz,
    refresh_token_expires_at timestamptz,
    scope text,
    -- Present only because Better Auth's account model has the column and
    -- selects it. Berry has no password sign-in, so it can never hold one.
    password text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_accounts_no_password_ck CHECK (password IS NULL),
    CONSTRAINT auth_accounts_github_only_ck CHECK (provider_id = 'github')
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_accounts_provider_account_key
    ON auth_accounts (provider_id, account_id);
CREATE INDEX IF NOT EXISTS auth_accounts_user_idx ON auth_accounts (user_id);

CREATE TABLE IF NOT EXISTS auth_verifications (
    id uuid PRIMARY KEY,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_verifications_identifier_idx ON auth_verifications (identifier);

-- Cutover: every session issued by the old login is ended. Nothing reads this
-- table after this release, and revoking rather than deleting keeps the record
-- that the access existed. Personal API tokens are a different table and keep
-- working.
UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;
