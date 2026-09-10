-- Berry migration 086: MCP servers an agent's loop connects to.
--
-- Workspace-wide when agent_id is NULL, otherwise one agent's. Headers are a
-- credential more often than not, so they are sealed with the integration key
-- and only their names are readable.

CREATE TABLE IF NOT EXISTS mcp_servers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id uuid,
    name text NOT NULL,
    url text NOT NULL,
    transport text NOT NULL DEFAULT 'streamable_http',
    headers_sealed bytea,
    header_names text[] NOT NULL DEFAULT ARRAY[]::text[],
    via_gateway boolean NOT NULL DEFAULT false,
    enabled boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mcp_servers_agent_fk FOREIGN KEY (workspace_id, agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT mcp_servers_name_ck CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
    CONSTRAINT mcp_servers_url_ck CHECK (url ~ '^https?://' AND char_length(url) <= 2000),
    CONSTRAINT mcp_servers_transport_ck CHECK (transport IN ('streamable_http', 'sse')),
    CONSTRAINT mcp_servers_headers_ck CHECK ((headers_sealed IS NULL) = (coalesce(array_length(header_names, 1), 0) = 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_servers_name_key
    ON mcp_servers (workspace_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
