-- Restores the columns, not their contents: the ids are dropped with them and
-- nothing can regenerate an identifier that named a process in another system.
--
-- agents.runtime_agent_id comes back nullable rather than NOT NULL. Existing
-- rows have no value to supply, so a NOT NULL column could only be restored by
-- inventing one per row — which is what the forward migration exists to stop.

ALTER TABLE issues ADD COLUMN IF NOT EXISTS runtime_run_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_agent_id uuid;
ALTER TABLE model_role_agents ADD COLUMN IF NOT EXISTS runtime_agent_id text;
