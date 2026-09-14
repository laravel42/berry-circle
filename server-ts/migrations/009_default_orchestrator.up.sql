-- Berry migration 009: the built-in orchestrator agent and the system actor.
--
-- Every workspace carries one protected orchestrator agent from creation. It
-- is the fallback that takes intake work when a workspace has defined no other
-- agents, so a fresh deployment can execute an issue without any setup.
--
-- Protection is enforced here, in the database, rather than in a handler. A
-- handler check is advisory: any other writer, a migration, or a direct psql
-- session bypasses it. The invariant is "this row always exists", so it is
-- expressed as a constraint and two triggers.

-- ---------------------------------------------------------------- system user

-- runs.requested_by is a foreign key to users(id), so automated intake needs a
-- real identity to attribute runs to. This is that identity. It is not a login:
-- no session is ever issued for it, and it holds the lowest role.
INSERT INTO users (id, email, name, role, created_at, updated_at)
VALUES (
    '00000000-0000-4000-8000-000000000001',
    'system@berry.internal',
    'Berry',
    'member',
    now(),
    now()
)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------ agent protection

ALTER TABLE agents ADD COLUMN IF NOT EXISTS protected boolean NOT NULL DEFAULT false;

-- A protected agent cannot be soft-deleted either. Archiving is how the product
-- removes an agent, so leaving it open would make protection cosmetic.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'agents'::regclass
          AND conname = 'agents_protected_not_archived_ck'
    ) THEN
        ALTER TABLE agents ADD CONSTRAINT agents_protected_not_archived_ck
            CHECK (NOT protected OR archived_at IS NULL);
    END IF;
END
$$;

-- Exactly one orchestrator per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS agents_one_protected_per_workspace_key
    ON agents (workspace_id)
    WHERE protected;

CREATE OR REPLACE FUNCTION berry_block_protected_agent_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.protected THEN
        RAISE EXCEPTION
            'agent % is protected and cannot be deleted', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS berry_agents_block_protected_delete ON agents;
CREATE TRIGGER berry_agents_block_protected_delete
    BEFORE DELETE ON agents
    FOR EACH ROW
    EXECUTE FUNCTION berry_block_protected_agent_delete();

-- Clearing the flag would be deletion by two statements instead of one.
CREATE OR REPLACE FUNCTION berry_block_protected_agent_unprotect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.protected AND NOT NEW.protected THEN
        RAISE EXCEPTION
            'agent % is protected and cannot be unprotected', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.protected AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
        RAISE EXCEPTION
            'protected agent % cannot change workspace', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS berry_agents_block_protected_unprotect ON agents;
CREATE TRIGGER berry_agents_block_protected_unprotect
    BEFORE UPDATE ON agents
    FOR EACH ROW
    EXECUTE FUNCTION berry_block_protected_agent_unprotect();

-- ------------------------------------------------------- orchestrator creation

-- Status starts 'unknown', not 'available'. The row asserts that Berry intends
-- this agent to exist; only a successful reconciliation against the runtime proves
-- it can actually execute. Intake requires 'available', so an unprovisioned
-- orchestrator is skipped rather than dispatched into a failure.
CREATE OR REPLACE FUNCTION berry_ensure_workspace_orchestrator(target_workspace uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF target_workspace IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO agents (
        id, workspace_id, board_id, runtime_agent_id, name, description,
        status, capabilities, protected, created_at, updated_at
    )
    VALUES (
        gen_random_uuid(),
        target_workspace,
        NULL,
        gen_random_uuid(),
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

CREATE OR REPLACE FUNCTION berry_workspace_orchestrator_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM berry_ensure_workspace_orchestrator(NEW.id);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS berry_workspaces_ensure_orchestrator ON workspaces;
CREATE TRIGGER berry_workspaces_ensure_orchestrator
    AFTER INSERT ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION berry_workspace_orchestrator_trigger();

-- Backfill every workspace that predates this migration.
DO $$
DECLARE
    workspace_row record;
BEGIN
    FOR workspace_row IN
        SELECT id FROM workspaces WHERE deleted_at IS NULL
    LOOP
        PERFORM berry_ensure_workspace_orchestrator(workspace_row.id);
    END LOOP;
END
$$;
