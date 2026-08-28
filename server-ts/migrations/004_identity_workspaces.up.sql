-- Berry migration range 000-099: identity, multi-workspace membership, and settings.
-- This migration is additive. Existing users and boards are placed in one
-- deployment workspace so pre-workspace Berry data remains reachable.

DO $$
BEGIN
    CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'member', 'viewer');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

ALTER TYPE workspace_role ADD VALUE IF NOT EXISTS 'owner';
ALTER TYPE workspace_role ADD VALUE IF NOT EXISTS 'admin';
ALTER TYPE workspace_role ADD VALUE IF NOT EXISTS 'member';
ALTER TYPE workspace_role ADD VALUE IF NOT EXISTS 'viewer';

CREATE TABLE IF NOT EXISTS workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    settings jsonb NOT NULL DEFAULT
        '{"issuePrefix":"BERRY","defaultRole":"member","allowMemberInvites":false}'::jsonb,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    creation_key_hash bytea,
    creation_fingerprint bytea,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CHECK (char_length(name) BETWEEN 1 AND 100),
    CHECK (char_length(slug) BETWEEN 2 AND 50),
    CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$'),
    CHECK (description IS NULL OR char_length(description) <= 5000),
    CHECK (jsonb_typeof(settings) = 'object'),
    CHECK (creation_key_hash IS NULL OR octet_length(creation_key_hash) = 32),
    CHECK (creation_fingerprint IS NULL OR octet_length(creation_fingerprint) = 32),
    CHECK (
        (creation_key_hash IS NULL AND creation_fingerprint IS NULL)
        OR (creation_key_hash IS NOT NULL AND creation_fingerprint IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_active_key
    ON workspaces (slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_creation_key
    ON workspaces (created_by, creation_key_hash)
    WHERE created_by IS NOT NULL AND creation_key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspaces_created_order_idx
    ON workspaces (created_at DESC, id DESC) WHERE deleted_at IS NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT
    '{"theme":"system","timezone":"UTC","reducedMotion":false}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_state jsonb NOT NULL DEFAULT
    '{"version":1,"step":"welcome","answers":{},"skipped":false,"completed":false}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_workspace_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND conname = 'users_settings_object_ck'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_settings_object_ck
            CHECK (jsonb_typeof(settings) = 'object') NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND conname = 'users_onboarding_state_object_ck'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_onboarding_state_object_ck
            CHECK (jsonb_typeof(onboarding_state) = 'object') NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND conname = 'users_last_workspace_id_workspaces_id_fk'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_last_workspace_id_workspaces_id_fk
            FOREIGN KEY (last_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS workspace_memberships (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role workspace_role NOT NULL,
    joined_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_memberships_user_order_idx
    ON workspace_memberships (user_id, joined_at, workspace_id);
CREATE INDEX IF NOT EXISTS workspace_memberships_workspace_role_idx
    ON workspace_memberships (workspace_id, role, user_id);

CREATE TABLE IF NOT EXISTS workspace_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email text NOT NULL,
    role workspace_role NOT NULL,
    invited_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_hash bytea NOT NULL,
    idempotency_key_hash bytea NOT NULL,
    request_fingerprint bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (email = lower(email)),
    CHECK (char_length(email) BETWEEN 3 AND 320),
    CHECK (role <> 'owner'),
    CHECK (octet_length(token_hash) = 32),
    CHECK (octet_length(idempotency_key_hash) = 32),
    CHECK (octet_length(request_fingerprint) = 32),
    CHECK (expires_at > created_at),
    CHECK (accepted_at IS NULL OR revoked_at IS NULL),
    CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_active_email_key
    ON workspace_invitations (workspace_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_idempotency_key
    ON workspace_invitations (workspace_id, invited_by, idempotency_key_hash);
CREATE INDEX IF NOT EXISTS workspace_invitations_workspace_order_idx
    ON workspace_invitations (workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workspace_invitations_email_order_idx
    ON workspace_invitations (email, created_at DESC, id DESC)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS personal_api_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    public_id text NOT NULL,
    secret_hash bytea NOT NULL,
    idempotency_key_hash bytea NOT NULL,
    request_fingerprint bytea NOT NULL,
    expires_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (char_length(name) BETWEEN 1 AND 100),
    CHECK (public_id ~ '^[A-Za-z0-9_-]{16}$'),
    CHECK (octet_length(secret_hash) = 32),
    CHECK (octet_length(idempotency_key_hash) = 32),
    CHECK (octet_length(request_fingerprint) = 32),
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS personal_api_tokens_public_id_key
    ON personal_api_tokens (public_id);
CREATE UNIQUE INDEX IF NOT EXISTS personal_api_tokens_idempotency_key
    ON personal_api_tokens (user_id, idempotency_key_hash);
CREATE INDEX IF NOT EXISTS personal_api_tokens_user_order_idx
    ON personal_api_tokens (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS personal_api_tokens_expiry_idx
    ON personal_api_tokens (expires_at)
    WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
UPDATE sessions SET last_used_at = created_at WHERE last_used_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_live_hash_idx
    ON sessions (token_hash) WHERE revoked_at IS NULL;

ALTER TABLE boards ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS workspace_id uuid;

INSERT INTO workspaces (id, name, slug, description, settings, created_by, created_at, updated_at)
SELECT
    gen_random_uuid(),
    COALESCE(
        (SELECT b.name FROM boards AS b ORDER BY b.created_at, b.id LIMIT 1),
        'Berry'
    ),
    'berry',
    'Backfilled Berry workspace',
    '{"issuePrefix":"BERRY","defaultRole":"member","allowMemberInvites":false}'::jsonb,
    (
        SELECT u.id
        FROM users AS u
        ORDER BY (u.role::text = 'admin') DESC, u.created_at, u.id
        LIMIT 1
    ),
    COALESCE(
        (SELECT min(u.created_at) FROM users AS u),
        (SELECT min(b.created_at) FROM boards AS b),
        now()
    ),
    now()
WHERE NOT EXISTS (SELECT 1 FROM workspaces)
  AND (
      EXISTS (SELECT 1 FROM users)
      OR EXISTS (SELECT 1 FROM boards)
      OR EXISTS (SELECT 1 FROM agents)
  );

WITH target AS (
    SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT 1
),
ranked_users AS (
    SELECT
        u.id,
        u.role::text AS global_role,
        row_number() OVER (ORDER BY u.created_at, u.id) AS position,
        bool_or(u.role::text = 'admin') OVER () AS has_admin
    FROM users AS u
)
INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at)
SELECT
    target.id,
    ranked_users.id,
    CASE
        WHEN ranked_users.global_role = 'admin'
          OR (NOT ranked_users.has_admin AND ranked_users.position = 1)
        THEN 'owner'::workspace_role
        ELSE 'member'::workspace_role
    END,
    now(),
    now()
FROM target
CROSS JOIN ranked_users
ON CONFLICT (workspace_id, user_id) DO NOTHING;

UPDATE boards
SET workspace_id = (
    SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT 1
)
WHERE workspace_id IS NULL;

UPDATE agents AS a
SET workspace_id = COALESCE(
    (SELECT b.workspace_id FROM boards AS b WHERE b.id = a.board_id),
    (SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT 1)
)
WHERE a.workspace_id IS NULL;

UPDATE users AS u
SET last_workspace_id = (
    SELECT m.workspace_id
    FROM workspace_memberships AS m
    JOIN workspaces AS w ON w.id = m.workspace_id AND w.deleted_at IS NULL
    WHERE m.user_id = u.id
    ORDER BY m.joined_at, m.workspace_id
    LIMIT 1
)
WHERE u.last_workspace_id IS NULL;

UPDATE users
SET settings = COALESCE(
        settings,
        '{"theme":"system","timezone":"UTC","reducedMotion":false}'::jsonb
    ),
    onboarding_state =
        '{"version":1,"step":"complete","answers":{},"skipped":false,"completed":true}'::jsonb,
    onboarding_completed_at = COALESCE(onboarding_completed_at, created_at);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'boards'::regclass
          AND conname = 'boards_workspace_id_workspaces_id_fk'
    ) THEN
        ALTER TABLE boards ADD CONSTRAINT boards_workspace_id_workspaces_id_fk
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'agents'::regclass
          AND conname = 'agents_workspace_id_workspaces_id_fk'
    ) THEN
        ALTER TABLE agents ADD CONSTRAINT agents_workspace_id_workspaces_id_fk
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION berry_assign_board_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.workspace_id IS NULL THEN
        SELECT u.last_workspace_id
        INTO NEW.workspace_id
        FROM users AS u
        JOIN workspace_memberships AS membership
          ON membership.workspace_id = u.last_workspace_id
         AND membership.user_id = u.id
        JOIN workspaces AS workspace
          ON workspace.id = membership.workspace_id
         AND workspace.deleted_at IS NULL
        WHERE u.id = NEW.created_by;
    END IF;

    IF NEW.created_by IS NULL OR NEW.workspace_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM workspace_memberships AS membership
        JOIN workspaces AS workspace
          ON workspace.id = membership.workspace_id
         AND workspace.deleted_at IS NULL
        WHERE membership.workspace_id = NEW.workspace_id
          AND membership.user_id = NEW.created_by
    ) THEN
        RAISE EXCEPTION 'board creator has no active workspace membership'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'boards'::regclass
          AND NOT tgisinternal
          AND tgname = 'berry_boards_assign_workspace'
    ) THEN
        CREATE TRIGGER berry_boards_assign_workspace
            BEFORE INSERT ON boards
            FOR EACH ROW EXECUTE FUNCTION berry_assign_board_workspace();
    END IF;
END
$$;

ALTER TABLE boards ALTER COLUMN workspace_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS boards_workspace_created_idx
    ON boards (workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agents_workspace_name_idx
    ON agents (workspace_id, name, id) WHERE archived_at IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'workspaces'::regclass
          AND NOT tgisinternal
          AND tgname = 'berry_workspaces_set_updated_at'
    ) THEN
        CREATE TRIGGER berry_workspaces_set_updated_at
            BEFORE UPDATE ON workspaces
            FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'workspace_memberships'::regclass
          AND NOT tgisinternal
          AND tgname = 'berry_workspace_memberships_set_updated_at'
    ) THEN
        CREATE TRIGGER berry_workspace_memberships_set_updated_at
            BEFORE UPDATE ON workspace_memberships
            FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
    END IF;
END
$$;
