-- A composite ON DELETE SET NULL nulls the whole key, workspace included.
--
-- `goals.project_id` was meant to fall away when its project is deleted. The
-- constraint spans two columns, so PostgreSQL sets both to NULL — including
-- `goals.workspace_id`, which is NOT NULL. The delete fails:
--
--   null value in column "workspace_id" of relation "goals"
--     violates not-null constraint
--
-- The effect is that a project cannot be deleted once Berry has planned it,
-- because planning attaches a goal to it. Two more constraints have the same
-- shape and the same latent failure: deleting a plan or a goal that a
-- conversation points at.
--
-- PostgreSQL 15 added column-specific SET NULL, which says the thing that was
-- always meant: forget the reference, keep the row where it belongs.

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_project_fk;
ALTER TABLE goals
    ADD CONSTRAINT goals_project_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id)
    ON DELETE SET NULL (project_id);

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_plan_fk;
ALTER TABLE conversations
    ADD CONSTRAINT conversations_plan_fk
    FOREIGN KEY (workspace_id, plan_id)
    REFERENCES plans (workspace_id, id)
    ON DELETE SET NULL (plan_id);

-- Kept NOT VALID, as it was: the rows already here were never checked, and
-- validating them is a separate decision from fixing the delete behaviour.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_goal_fk;
ALTER TABLE conversations
    ADD CONSTRAINT conversations_goal_fk
    FOREIGN KEY (workspace_id, goal_id)
    REFERENCES goals (workspace_id, id)
    ON DELETE SET NULL (goal_id)
    NOT VALID;
