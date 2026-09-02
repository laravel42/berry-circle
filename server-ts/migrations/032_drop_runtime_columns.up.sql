-- Drop the columns that held an external agent substrate's identifiers.
--
-- Berry ran agents on a separate process that owned their identity, and three
-- tables carried its ids so Berry could find its way back to them. Agents now
-- execute in-process (ADR-0008) and the server that projected those identities
-- is gone (ADR-0009), so the ids name nothing.
--
-- agents.runtime_agent_id is the one that mattered: it was NOT NULL, so every
-- caller creating an agent had to invent an id for a process that would never
-- exist. Dropping the column removes the reason to make one up, rather than
-- leaving a required field satisfied by a lie.
--
-- Dropping a column drops the indexes over it, so agents_runtime_agent_id_key
-- and model_role_agents_runtime_agent_id_key go with them.

-- The orchestrator trigger function inserts into `agents`, so it has to lose
-- the column in the same migration. PL/pgSQL bodies are not parsed until they
-- run, so PostgreSQL will not report this as a dependency and will happily drop
-- the column out from under it — the failure then surfaces on the next
-- workspace creation, not here.
--
-- Its `status` stays 'unknown'. That value was chosen because only a successful
-- reconciliation against the runtime proved the agent could execute, and there
-- is no reconciliation now: nothing advances the row, so the built-in
-- orchestrator stays unavailable until something decides what its status should
-- mean. That is a product decision, not a schema one, and is deliberately left
-- out of this migration.
CREATE OR REPLACE FUNCTION berry_ensure_workspace_orchestrator(target_workspace uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF target_workspace IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO agents (
        id, workspace_id, board_id, name, description,
        status, capabilities, protected, created_at, updated_at
    )
    VALUES (
        gen_random_uuid(),
        target_workspace,
        NULL,
        'Orchestrator',
        'Built-in agent that picks up work when no other agent is available.',
        'unknown',
        ARRAY['orchestrate', 'triage']::text[],
        true,
        now(),
        now()
    )
    ON CONFLICT DO NOTHING;
END
$$;

ALTER TABLE issues DROP COLUMN IF EXISTS runtime_run_id;
ALTER TABLE agents DROP COLUMN IF EXISTS runtime_agent_id;
ALTER TABLE model_role_agents DROP COLUMN IF EXISTS runtime_agent_id;
