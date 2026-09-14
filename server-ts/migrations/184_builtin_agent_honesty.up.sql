-- Berry migration 184: the built-in agents stop claiming what they cannot do.
--
-- A person asked the Orchestrator in chat to create a project. It answered as
-- though it had, and nothing was created: it had no tool for it. It now has one
-- (create_project, create_task), but the next missing tool will come, and an
-- agent whose instructions say nothing about that case will do this again.
--
-- `agents.instructions` is the system prompt verbatim, so the line goes there:
-- in the two ensure functions a workspace is provisioned from, and on the rows
-- already provisioned. The backfill only touches a row still holding exactly
-- what the trigger wrote, so instructions anybody has edited are left alone.
--
-- The Orchestrator had no instructions at all until now — its persona lived in
-- its name and description. It gets the shortest ones that say what it is.

CREATE OR REPLACE FUNCTION berry_ensure_workspace_orchestrator(target_workspace uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF target_workspace IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO agents (
        id, workspace_id, board_id, name, description, instructions,
        status, capabilities, protected, created_at, updated_at
    )
    VALUES (
        gen_random_uuid(),
        target_workspace,
        NULL,
        'Orchestrator',
        'Built-in agent that picks up work when no other agent is available.',
        'You are Orchestrator, the workspace''s built-in agent: you take on work '
        || 'when no other agent is available. Be brief and concrete. '
        || 'If you have no tool for what someone asks, say so plainly and say what '
        || 'you can do instead — never describe the action as done.',
        'unknown',
        ARRAY['orchestrate', 'triage']::text[],
        true,
        now(),
        now()
    )
    ON CONFLICT DO NOTHING;
END
$$;

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
        || 'where each thing is done. Be brief and concrete. '
        || 'If you have no tool for what someone asks, say so plainly and say where a '
        || 'person can do it — never describe the action as done.',
        'available',
        'guide'
    )
    ON CONFLICT DO NOTHING;
END
$$;

-- The rows already provisioned, and only those still holding what the trigger
-- wrote: an Orchestrator with no instructions, and a Guide holding migration
-- 091's exact text.
UPDATE agents
   SET instructions =
           'You are Orchestrator, the workspace''s built-in agent: you take on work '
        || 'when no other agent is available. Be brief and concrete. '
        || 'If you have no tool for what someone asks, say so plainly and say what '
        || 'you can do instead — never describe the action as done.',
       updated_at = now()
 WHERE name = 'Orchestrator'
   AND protected
   AND (instructions IS NULL OR btrim(instructions) = '');

UPDATE agents
   SET instructions = instructions
        || ' If you have no tool for what someone asks, say so plainly and say where a '
        || 'person can do it — never describe the action as done.',
       updated_at = now()
 WHERE system_role = 'guide'
   AND instructions =
           'You are Guide, the Berry workspace helper. Explain how tasks, boards, agents, '
        || 'skills, squads and reviews work, suggest a first task, and point to the page '
        || 'where each thing is done. Be brief and concrete.';
