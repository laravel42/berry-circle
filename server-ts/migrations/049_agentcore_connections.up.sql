-- Connection metadata for the AgentCore era.
--
-- The credential itself moves to AgentCore Identity, which is the point of the
-- migration: Berry stops holding a GitHub token at all. What Berry still needs
-- is the non-secret part — which provider, which account, and whether the
-- connection is usable — so a settings page can say "connected as acme"
-- without a secret being anywhere near it.
--
-- Nothing is dropped. `access_token_encrypted` and `refresh_token_encrypted`
-- keep whatever they hold so a deployment can roll back to GITHUB_PROVIDER=legacy
-- without having destroyed the credential that path needs. They stop being
-- *written* in code; emptying them is a later migration, once the gateway is
-- confirmed in an environment that can actually reach one.
ALTER TABLE integration_connections
    ADD COLUMN IF NOT EXISTS connection_type text NOT NULL DEFAULT 'oauth';
ALTER TABLE integration_connections
    ADD COLUMN IF NOT EXISTS agentcore_identity_id text;
ALTER TABLE integration_connections
    ADD COLUMN IF NOT EXISTS external_account_id text;

ALTER TABLE integration_connections DROP CONSTRAINT IF EXISTS integration_connections_type_ck;
ALTER TABLE integration_connections
    ADD CONSTRAINT integration_connections_type_ck
    CHECK (connection_type IN ('oauth', 'github_app', 'agentcore'));

COMMENT ON COLUMN integration_connections.connection_type IS
    'How the credential is held: agentcore means AgentCore Identity owns it and Berry stores none.';
COMMENT ON COLUMN integration_connections.agentcore_identity_id IS
    'The AgentCore credential provider this connection resolves through.';
COMMENT ON COLUMN integration_connections.access_token_encrypted IS
    'Legacy. Not written when connection_type is agentcore; retained for rollback to GITHUB_PROVIDER=legacy.';

-- Existing rows describe how they were actually made, rather than being
-- relabelled as something they are not.
UPDATE integration_connections
   SET connection_type = 'oauth'
 WHERE connection_type IS NULL;
