-- Berry 064: shareable workspace join links. Only a SHA-256 of the token is
-- stored; the token is shown once, at creation.
CREATE TABLE IF NOT EXISTS workspace_join_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    role workspace_role NOT NULL,
    token_hash bytea NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz,
    max_uses integer,
    use_count integer NOT NULL DEFAULT 0,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workspace_join_links_role_ck CHECK (role <> 'owner'),
    CONSTRAINT workspace_join_links_token_ck CHECK (octet_length(token_hash) = 32),
    CONSTRAINT workspace_join_links_max_uses_ck CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 10000),
    CONSTRAINT workspace_join_links_use_count_ck
        CHECK (use_count >= 0 AND (max_uses IS NULL OR use_count <= max_uses)),
    CONSTRAINT workspace_join_links_expiry_ck CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_join_links_token_key
    ON workspace_join_links (token_hash);
CREATE INDEX IF NOT EXISTS workspace_join_links_workspace_order_idx
    ON workspace_join_links (workspace_id, created_at DESC, id DESC);
