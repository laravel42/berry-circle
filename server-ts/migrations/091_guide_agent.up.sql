-- Berry migration 091: a guide agent in every workspace.
--
-- The onboarding chat talks to it. Unlike the orchestrator it is an ordinary
-- agent: it can be edited, archived and restored; the index only stops a
-- workspace from getting two.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS system_role text;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_system_role_ck;
ALTER TABLE agents ADD CONSTRAINT agents_system_role_ck
    CHECK (system_role IS NULL OR system_role IN ('guide')) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS agents_one_guide_per_workspace_key
    ON agents (workspace_id) WHERE system_role = 'guide';

CREATE OR REPLACE FUNCTION berry_ensure_workspace_guide(target_workspace uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF target_workspace IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO agents (id, workspace_id, name, description, instructions, status, system_role)
    VALUES (
        gen_random_uuid(),
        target_workspace,
        'Guide',
        'Helps new members find their way around Berry.',
        'You are Guide, the Berry workspace helper. Explain how tasks, boards, agents, '
        || 'skills, squads and reviews work, suggest a first task, and point to the page '
        || 'where each thing is done. Be brief and concrete.',
        'available',
        'guide'
    )
    ON CONFLICT DO NOTHING;
END
$$;

CREATE OR REPLACE FUNCTION berry_workspace_guide_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM berry_ensure_workspace_guide(NEW.id);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS berry_workspaces_ensure_guide ON workspaces;
CREATE TRIGGER berry_workspaces_ensure_guide
    AFTER INSERT ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION berry_workspace_guide_trigger();

DO $$
DECLARE
    workspace_row record;
BEGIN
    FOR workspace_row IN SELECT id FROM workspaces WHERE deleted_at IS NULL LOOP
        PERFORM berry_ensure_workspace_guide(workspace_row.id);
    END LOOP;
END
$$;
