-- Berry migration range 000-099: the existing Berry product core.
-- This is an additive squash of the Drizzle schema and is safe to apply after it.

DO $$
BEGIN
    CREATE TYPE issue_status AS ENUM (
        'backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    CREATE TYPE issue_priority AS ENUM ('none', 'urgent', 'high', 'medium', 'low');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    CREATE TYPE assignee_type AS ENUM ('user', 'agent');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    CREATE TYPE user_role AS ENUM ('admin', 'member');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

ALTER TYPE issue_status ADD VALUE IF NOT EXISTS 'backlog';
ALTER TYPE issue_status ADD VALUE IF NOT EXISTS 'todo';
ALTER TYPE issue_status ADD VALUE IF NOT EXISTS 'in_progress';
ALTER TYPE issue_status ADD VALUE IF NOT EXISTS 'in_review';
ALTER TYPE issue_status ADD VALUE IF NOT EXISTS 'done';
ALTER TYPE issue_status ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE issue_priority ADD VALUE IF NOT EXISTS 'none';
ALTER TYPE issue_priority ADD VALUE IF NOT EXISTS 'urgent';
ALTER TYPE issue_priority ADD VALUE IF NOT EXISTS 'high';
ALTER TYPE issue_priority ADD VALUE IF NOT EXISTS 'medium';
ALTER TYPE issue_priority ADD VALUE IF NOT EXISTS 'low';
ALTER TYPE assignee_type ADD VALUE IF NOT EXISTS 'user';
ALTER TYPE assignee_type ADD VALUE IF NOT EXISTS 'agent';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'admin';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'member';

CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    name text NOT NULL,
    avatar_url text,
    role user_role NOT NULL DEFAULT 'member',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role user_role DEFAULT 'member';
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
UPDATE users SET role = 'member' WHERE role IS NULL;
UPDATE users SET created_at = now() WHERE created_at IS NULL;
UPDATE users SET updated_at = now() WHERE updated_at IS NULL;
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'member';
ALTER TABLE users ALTER COLUMN role SET NOT NULL;
ALTER TABLE users ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE users ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE users ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE users ALTER COLUMN updated_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    user_agent text,
    ip text,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS boards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    columns jsonb NOT NULL DEFAULT '[]'::jsonb,
    issue_counter integer NOT NULL DEFAULT 0,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE boards ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS columns jsonb DEFAULT '[]'::jsonb;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS issue_counter integer DEFAULT 0;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE boards ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
UPDATE boards SET columns = '[]'::jsonb WHERE columns IS NULL;
UPDATE boards SET issue_counter = 0 WHERE issue_counter IS NULL;
UPDATE boards SET created_at = now() WHERE created_at IS NULL;
UPDATE boards SET updated_at = now() WHERE updated_at IS NULL;
ALTER TABLE boards ALTER COLUMN columns SET DEFAULT '[]'::jsonb;
ALTER TABLE boards ALTER COLUMN columns SET NOT NULL;
ALTER TABLE boards ALTER COLUMN issue_counter SET DEFAULT 0;
ALTER TABLE boards ALTER COLUMN issue_counter SET NOT NULL;
ALTER TABLE boards ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE boards ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE boards ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE boards ALTER COLUMN updated_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS issues (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    number integer NOT NULL,
    title text NOT NULL,
    description text,
    status issue_status NOT NULL DEFAULT 'backlog',
    priority issue_priority NOT NULL DEFAULT 'none',
    sort_order integer NOT NULL DEFAULT 0,
    due_date timestamptz,
    assignee_type assignee_type,
    assignee_id uuid,
    runtime_run_id text,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    assignee_type assignee_type NOT NULL,
    assignee_id uuid NOT NULL,
    assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author_type assignee_type NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    parent_id uuid REFERENCES comments(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'boards'::regclass AND conname = 'boards_created_by_users_id_fk'
    ) THEN
        ALTER TABLE boards ADD CONSTRAINT boards_created_by_users_id_fk
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'comments'::regclass AND conname = 'comments_parent_id_comments_id_fk'
    ) THEN
        ALTER TABLE comments ADD CONSTRAINT comments_parent_id_comments_id_fk
            FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE;
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'users'::regclass AND conname = 'users_email_length_ck'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_email_length_ck
            CHECK (char_length(email) BETWEEN 3 AND 320) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'boards'::regclass AND conname = 'boards_slug_format_ck'
    ) THEN
        ALTER TABLE boards ADD CONSTRAINT boards_slug_format_ck
            CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,10}[a-z0-9]$') NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'boards'::regclass AND conname = 'boards_columns_is_array'
    ) THEN
        ALTER TABLE boards ADD CONSTRAINT boards_columns_is_array
            CHECK (jsonb_typeof(columns) = 'array') NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'boards'::regclass AND conname = 'boards_issue_counter_ck'
    ) THEN
        ALTER TABLE boards ADD CONSTRAINT boards_issue_counter_ck
            CHECK (issue_counter >= 0) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'issues'::regclass AND conname = 'issues_number_positive_ck'
    ) THEN
        ALTER TABLE issues ADD CONSTRAINT issues_number_positive_ck
            CHECK (number > 0) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'issues'::regclass AND conname = 'issues_title_length_ck'
    ) THEN
        ALTER TABLE issues ADD CONSTRAINT issues_title_length_ck
            CHECK (char_length(title) BETWEEN 1 AND 500) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'issues'::regclass AND conname = 'issues_description_length_ck'
    ) THEN
        ALTER TABLE issues ADD CONSTRAINT issues_description_length_ck
            CHECK (description IS NULL OR char_length(description) <= 100000) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'issues'::regclass AND conname = 'issues_assignee_pair_ck'
    ) THEN
        ALTER TABLE issues ADD CONSTRAINT issues_assignee_pair_ck CHECK (
            (assignee_type IS NULL AND assignee_id IS NULL)
            OR (assignee_type IS NOT NULL AND assignee_id IS NOT NULL)
        ) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'comments'::regclass AND conname = 'comments_body_length_ck'
    ) THEN
        ALTER TABLE comments ADD CONSTRAINT comments_body_length_ck
            CHECK (char_length(body) BETWEEN 1 AND 100000) NOT VALID;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_ci_key ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS boards_slug_key ON boards (slug);
CREATE UNIQUE INDEX IF NOT EXISTS issues_board_number_key ON issues (board_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS comments_issue_id_id_key ON comments (issue_id, id);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS issues_board_status_idx ON issues (board_id, status);
CREATE INDEX IF NOT EXISTS issues_assignee_idx ON issues (assignee_type, assignee_id);
CREATE INDEX IF NOT EXISTS assignments_issue_id_idx ON assignments (issue_id);
CREATE INDEX IF NOT EXISTS comments_issue_id_idx ON comments (issue_id);
CREATE INDEX IF NOT EXISTS comments_parent_id_idx ON comments (parent_id);

UPDATE boards AS b
SET issue_counter = GREATEST(
    b.issue_counter,
    COALESCE((SELECT max(i.number) FROM issues AS i WHERE i.board_id = b.id), 0)
);

CREATE OR REPLACE FUNCTION berry_set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'users'::regclass
          AND NOT tgisinternal
          AND tgname IN ('users_set_updated_at', 'berry_users_set_updated_at')
    ) THEN
        CREATE TRIGGER berry_users_set_updated_at
            BEFORE UPDATE ON users
            FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'boards'::regclass
          AND NOT tgisinternal
          AND tgname IN ('boards_set_updated_at', 'berry_boards_set_updated_at')
    ) THEN
        CREATE TRIGGER berry_boards_set_updated_at
            BEFORE UPDATE ON boards
            FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'issues'::regclass
          AND NOT tgisinternal
          AND tgname IN ('issues_set_updated_at', 'berry_issues_set_updated_at')
    ) THEN
        CREATE TRIGGER berry_issues_set_updated_at
            BEFORE UPDATE ON issues
            FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'comments'::regclass
          AND NOT tgisinternal
          AND tgname IN ('comments_set_updated_at', 'berry_comments_set_updated_at')
    ) THEN
        CREATE TRIGGER berry_comments_set_updated_at
            BEFORE UPDATE ON comments
            FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION berry_next_issue_number(p_board_id uuid)
RETURNS integer
LANGUAGE sql
AS $$
    UPDATE boards
    SET issue_counter = issue_counter + 1
    WHERE id = p_board_id
    RETURNING issue_counter;
$$;
