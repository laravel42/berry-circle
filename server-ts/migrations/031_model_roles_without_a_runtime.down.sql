-- Restoring NOT NULL requires every role to name an agent again. Rows recorded
-- without one are removed rather than given an invented id: a role that never
-- had an upstream agent cannot be described as having had one, and the next
-- boot re-records it either way.

DELETE FROM model_role_agents WHERE runtime_agent_id IS NULL;

DROP INDEX IF EXISTS model_role_agents_runtime_agent_id_key;

ALTER TABLE model_role_agents
    ALTER COLUMN runtime_agent_id SET NOT NULL;

ALTER TABLE model_role_agents
    ADD CONSTRAINT model_role_agents_runtime_agent_id_key UNIQUE (runtime_agent_id);
