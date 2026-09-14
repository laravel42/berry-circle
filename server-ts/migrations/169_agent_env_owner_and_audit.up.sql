-- Berry migration 169: who made an agent, and who looked at its secrets.
--
-- Two things the agent screens need and the schema could not answer.
--
-- `created_by` is the agent's owner. Until now an agent had no author at all,
-- so every screen that wanted to say who is responsible for one either
-- invented an answer (the signed-in user) or printed nothing. It is nullable
-- and ON DELETE SET NULL: agents seeded by a trigger have no author, and a
-- departing member must not take their agents with them.
--
-- `agent_env_audit` is the standing record of every touch of an agent's
-- environment. An agent's env is where its credentials live, so "someone
-- revealed these values at this time" is exactly the fact an audit needs, and
-- it is the one fact a sealed column cannot reconstruct afterwards. Names
-- only: the row records which variables were involved, never their values,
-- because an audit trail that copies the secret is a second place to steal it
-- from.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS agent_env_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    -- The member who did it. Kept as SET NULL rather than cascading: deleting
    -- a member must not erase the record that they opened a credential.
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    -- Denormalised so the entry still reads after the account is gone.
    actor_name text,
    action text NOT NULL,
    -- Variable names touched, never values.
    env_names text[] NOT NULL DEFAULT ARRAY[]::text[],
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_env_audit_agent_fk FOREIGN KEY (workspace_id, agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT agent_env_audit_action_ck CHECK (action IN ('reveal', 'update')),
    CONSTRAINT agent_env_audit_names_ck CHECK (coalesce(array_length(env_names, 1), 0) <= 50)
);

CREATE INDEX IF NOT EXISTS agent_env_audit_agent_time_idx
    ON agent_env_audit (workspace_id, agent_id, occurred_at DESC);

COMMENT ON TABLE agent_env_audit IS
    'Every reveal of, and every write to, an agent environment. Names only, never values.';
