-- Berry migration 087: what completes an agent's profile.
--
-- env is sealed like every other credential and only its names are readable.
-- Access scopes say which members may assign or mention the agent; owners and
-- admins always may, so a workspace can never lock itself out of an agent.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS labels text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE agents ADD COLUMN IF NOT EXISTS env_sealed bytea;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS env_names text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE agents ADD COLUMN IF NOT EXISTS assign_scope text NOT NULL DEFAULT 'everyone';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS mention_scope text NOT NULL DEFAULT 'everyone';

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_profile_ck;
ALTER TABLE agents ADD CONSTRAINT agents_profile_ck CHECK (
    coalesce(array_length(labels, 1), 0) <= 20
    AND coalesce(array_length(env_names, 1), 0) <= 50
    AND assign_scope IN ('everyone', 'admins', 'listed')
    AND mention_scope IN ('everyone', 'admins', 'listed')
) NOT VALID;

-- The avatar may be an upload served by Berry, not only an external URL.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_avatar_url_check;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_avatar_url_ck;
ALTER TABLE agents ADD CONSTRAINT agents_avatar_url_ck CHECK (
    avatar_url IS NULL
    OR avatar_url ~ '^https?://'
    OR avatar_url ~ '^/api/v1/agents/[0-9a-f-]{36}/avatar\?v=[0-9]+$'
) NOT VALID;

CREATE TABLE IF NOT EXISTS agent_access_members (
    agent_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL,
    PRIMARY KEY (agent_id, user_id),
    CONSTRAINT agent_access_members_agent_fk FOREIGN KEY (workspace_id, agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_avatars (
    agent_id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    content_type text NOT NULL,
    bytes bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_avatars_agent_fk FOREIGN KEY (workspace_id, agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT agent_avatars_type_ck CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
    CONSTRAINT agent_avatars_size_ck CHECK (octet_length(bytes) <= 524288)
);
