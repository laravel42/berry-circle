-- A goal is the group of tasks one plan compile produced, inside one project.
--
-- It is no longer something a person writes. Nothing authors its title, its
-- membership or its status after compile, which is why the states only a person
-- could reach are gone and the remaining four are a function of the tasks
-- underneath it. See docs/adr/0010-goals-as-derived-task-groups.md.

-- Retire every goal that groups no tasks.
--
-- Until now a goal was minted when a plan was *generated*, before any task
-- existed, so every abandoned generation left one behind. A goal that names no
-- tasks names nothing. Soft-deleted rather than dropped: if this reading is
-- wrong the rows are still here.
UPDATE goals
SET deleted_at = now(), updated_at = now()
WHERE deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM goal_issues gi WHERE gi.goal_id = goals.id);

-- A surviving goal takes the project its tasks are already in.
--
-- `array_agg` rather than `min`: uuid gained an aggregate only in PostgreSQL 14
-- and this has to run wherever the rest of the schema runs. The HAVING is the
-- point of the join — a goal whose tasks span two projects is not placeable and
-- falls through to the retirement below.
UPDATE goals g
SET project_id = placed.project_id, updated_at = now()
FROM (
    SELECT gi.goal_id, (array_agg(DISTINCT l.project_id))[1] AS project_id
    FROM goal_issues gi
    JOIN issue_project_links l ON l.issue_id = gi.issue_id
    GROUP BY gi.goal_id
    HAVING count(DISTINCT l.project_id) = 1
) AS placed
WHERE g.id = placed.goal_id
  AND g.project_id IS NULL
  AND g.deleted_at IS NULL;

-- Anything still unplaceable cannot be a group of a project's tasks.
UPDATE goals
SET deleted_at = now(), updated_at = now()
WHERE deleted_at IS NULL AND project_id IS NULL;

-- Four states, and every one of them observable from the tasks.
--
-- `draft` was an artifact of minting the goal before its tasks existed and maps
-- to `planned`. `cancelled` was reachable only by hand: such a goal is retired,
-- and its status normalised so the narrowed constraint holds for every row —
-- once `deleted_at` is set the status says nothing anyway.
UPDATE goals SET status = 'planned', updated_at = now() WHERE status = 'draft';

UPDATE goals
SET deleted_at = coalesce(deleted_at, now()), status = 'planned', updated_at = now()
WHERE status = 'cancelled';

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_status_ck;
ALTER TABLE goals
    ADD CONSTRAINT goals_status_ck
    CHECK (status IN ('planned', 'active', 'blocked', 'completed'));

-- A live goal belongs to a project. A retired one may predate the rule, which
-- is why this is a CHECK against `deleted_at` and not `SET NOT NULL`.
ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_live_project_ck;
ALTER TABLE goals
    ADD CONSTRAINT goals_live_project_ck
    CHECK (deleted_at IS NOT NULL OR project_id IS NOT NULL);

-- Every goal is made the same way now, and the prompt belongs to the plan.
ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_source_ck;
ALTER TABLE goals DROP COLUMN IF EXISTS source;
ALTER TABLE goals DROP COLUMN IF EXISTS source_prompt;

-- The one definition of the rule, so the wire, the database and any later
-- reader cannot disagree about it.
--
-- Order is the whole content. `blocked` is tested before "started but not
-- finished" so that it means what it says — the goal cannot advance — rather
-- than merely that some task is stuck while others move.
CREATE OR REPLACE FUNCTION berry_goal_derived_status(p_goal_id uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN count(*) = 0
            THEN 'planned'
        WHEN count(*) FILTER (WHERE i.status NOT IN ('done', 'cancelled')) = 0
            THEN 'completed'
        WHEN count(*) FILTER (WHERE i.status IN ('in_progress', 'in_review')) > 0
            THEN 'active'
        WHEN count(*) FILTER (WHERE i.status = 'blocked') > 0
             AND count(*) FILTER (WHERE i.status IN ('backlog', 'todo')) = 0
            THEN 'blocked'
        WHEN count(*) FILTER (WHERE i.status IN ('done', 'cancelled')) > 0
            THEN 'active'
        ELSE 'planned'
    END
    FROM goal_issues gi
    JOIN issues i ON i.id = gi.issue_id AND i.deleted_at IS NULL
    WHERE gi.goal_id = p_goal_id;
$$;

COMMENT ON FUNCTION berry_goal_derived_status(uuid) IS
    'A goal''s status as a function of its tasks: planned, active, blocked or completed.';

-- A goal''s tasks live in the goal''s project, enforced rather than assumed.
--
-- `goal_issues.project_id` is derivable from `issue_project_links`; it is
-- carried here so the pair of foreign keys below can hold the two sides
-- together, which no CHECK could do across three tables. The effect is that
-- moving a task into another project while it belongs to a goal is refused,
-- because the cascade from `issue_project_links` would land on a value
-- `goals` does not have.
ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_workspace_project_key;
ALTER TABLE goals
    ADD CONSTRAINT goals_workspace_project_key UNIQUE (workspace_id, id, project_id);

ALTER TABLE issue_project_links DROP CONSTRAINT IF EXISTS issue_project_links_workspace_project_key;
ALTER TABLE issue_project_links
    ADD CONSTRAINT issue_project_links_workspace_project_key
    UNIQUE (workspace_id, issue_id, project_id);

ALTER TABLE goal_issues ADD COLUMN IF NOT EXISTS project_id uuid;

UPDATE goal_issues gi
SET project_id = l.project_id
FROM issue_project_links l
WHERE l.issue_id = gi.issue_id AND gi.project_id IS NULL;

-- Nothing may join a goal without saying which project it joins it in. The
-- table is empty of unplaced rows by the update above, so this is safe here and
-- becomes the compile path's obligation from now on.
DELETE FROM goal_issues WHERE project_id IS NULL;
ALTER TABLE goal_issues ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE goal_issues DROP CONSTRAINT IF EXISTS goal_issues_goal_project_fk;
ALTER TABLE goal_issues
    ADD CONSTRAINT goal_issues_goal_project_fk
    FOREIGN KEY (workspace_id, goal_id, project_id)
    REFERENCES goals (workspace_id, id, project_id)
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE goal_issues DROP CONSTRAINT IF EXISTS goal_issues_issue_project_fk;
ALTER TABLE goal_issues
    ADD CONSTRAINT goal_issues_issue_project_fk
    FOREIGN KEY (workspace_id, issue_id, project_id)
    REFERENCES issue_project_links (workspace_id, issue_id, project_id)
    ON UPDATE CASCADE ON DELETE CASCADE;

COMMENT ON COLUMN goal_issues.project_id IS
    'The project both the task and its goal are in; carried so the pair of foreign keys can hold them together.';
