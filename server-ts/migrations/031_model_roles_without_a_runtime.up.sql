-- A model role no longer needs an agent upstream to exist.
--
-- A role is a provider, a model and a system prompt. The runtime held all three
-- inside an agent Berry spawned, so the row recorded which agent that was;
-- under the ADK runtime there is nothing to spawn, and Berry calls the
-- provider directly with what it already has.
--
-- The column stays for as long as the runtime path does, but it becomes
-- optional and its uniqueness becomes conditional: NULL is the truthful value
-- for "no agent upstream", and four roles that all have none must not collide
-- with each other on it.

ALTER TABLE model_role_agents
    ALTER COLUMN runtime_agent_id DROP NOT NULL;

-- Replaced rather than kept: a UNIQUE constraint treats NULLs as distinct, so
-- it would in fact permit four null rows — but it also cannot be dropped and
-- re-added conditionally later without this step, and stating the condition
-- makes the rule legible to anybody reading the schema.
ALTER TABLE model_role_agents
    DROP CONSTRAINT IF EXISTS model_role_agents_runtime_agent_id_key;
DROP INDEX IF EXISTS model_role_agents_runtime_agent_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS model_role_agents_runtime_agent_id_key
    ON model_role_agents (runtime_agent_id)
    WHERE runtime_agent_id IS NOT NULL;

-- A role recorded without an agent carries no manifest either. The columns
-- that describe one are already nullable; this only records why they will be
-- empty for such a row.
COMMENT ON COLUMN model_role_agents.runtime_agent_id IS
    'The runtime agent serving this role, or NULL when the role calls its provider directly.';
