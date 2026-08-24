-- Berry migration 010: orchestrator-authored plans, milestones, and the
-- human approval gate.
--
-- Product model: the user briefs the orchestrator, the orchestrator drafts a
-- plan (project -> milestones -> tasks, each already assigned), the user
-- approves it, and only then do agents start. After that the user is pulled in
-- only when a task is blocked or waiting for review.
--
-- The safety property this migration exists to guarantee is narrow and
-- important: NO TASK FROM AN UNAPPROVED PLAN CAN BE DISPATCHED. Agent runs cost
-- real money and touch real code, so "we forgot to check approval" must not be
-- expressible. Intake only ever selects issues in `todo`, so the guarantee is
-- enforced as "a planned issue cannot reach `todo` before its plan is
-- approved", as a trigger rather than a convention.

-- ------------------------------------------------------------------ milestones

CREATE TABLE IF NOT EXISTS milestones (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    -- Ordering within a project. Milestones are a sequence, not a set: the
    -- orchestrator plans them in an intended order and the board renders it.
    position integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'planned',
    target_date date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT milestones_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT milestones_project_fk
        FOREIGN KEY (workspace_id, project_id)
        REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT milestones_name_length_ck
        CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT milestones_description_length_ck
        CHECK (description IS NULL OR char_length(description) <= 20000),
    CONSTRAINT milestones_status_ck
        CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
    CONSTRAINT milestones_position_ck CHECK (position >= 0)
);

CREATE INDEX IF NOT EXISTS milestones_project_position_idx
    ON milestones (workspace_id, project_id, position, id);

-- Mirrors issue_project_links so a task's milestone is modelled the same way
-- its project is.
CREATE TABLE IF NOT EXISTS issue_milestone_links (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    milestone_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT issue_milestone_links_milestone_fk
        FOREIGN KEY (workspace_id, milestone_id)
        REFERENCES milestones(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS issue_milestone_links_milestone_idx
    ON issue_milestone_links (workspace_id, milestone_id, issue_id);

-- ----------------------------------------------------------------------- plans

CREATE TABLE IF NOT EXISTS plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    -- What the orchestrator understood from the brief. Shown to the user at the
    -- approval gate so they approve an intent, not just a task list.
    summary text,
    -- The orchestrator that authored this plan, and the person it briefed with.
    proposed_by uuid REFERENCES agents(id) ON DELETE SET NULL,
    briefed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at timestamptz,
    decision_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plans_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT plans_project_fk
        FOREIGN KEY (workspace_id, project_id)
        REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT plans_status_ck
        CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'superseded')),
    CONSTRAINT plans_summary_length_ck
        CHECK (summary IS NULL OR char_length(summary) <= 20000),
    -- An approved plan must record who approved it and when. Approval without
    -- an approver is not approval.
    CONSTRAINT plans_approval_complete_ck CHECK (
        (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
        OR (status <> 'approved' AND approved_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS plans_workspace_status_idx
    ON plans (workspace_id, status, created_at DESC, id);

-- One live plan per project. Rejected and superseded plans are history.
CREATE UNIQUE INDEX IF NOT EXISTS plans_one_open_per_project_key
    ON plans (workspace_id, project_id)
    WHERE status IN ('draft', 'pending_approval', 'approved');

CREATE TABLE IF NOT EXISTS plan_issues (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    plan_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plan_issues_plan_fk
        FOREIGN KEY (workspace_id, plan_id)
        REFERENCES plans(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS plan_issues_plan_idx
    ON plan_issues (workspace_id, plan_id, issue_id);

-- ------------------------------------------------------------- approval gate

-- A task belonging to an unapproved plan cannot enter `todo`, and therefore
-- cannot be selected by intake or dispatched to an agent.
--
-- This is a trigger and not a handler check on purpose. Agent runs spend money
-- and modify code; "some other writer forgot the approval check" must not be a
-- reachable state. Drafted tasks sit in `backlog`, which intake never selects,
-- so an unapproved plan is inert by construction.
CREATE OR REPLACE FUNCTION berry_block_unapproved_plan_dispatch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    plan_status text;
BEGIN
    IF NEW.status IS DISTINCT FROM 'todo' THEN
        RETURN NEW;
    END IF;
    SELECT plan.status INTO plan_status
      FROM plan_issues AS link
      JOIN plans AS plan
        ON plan.id = link.plan_id
       AND plan.workspace_id = link.workspace_id
     WHERE link.issue_id = NEW.id;

    IF plan_status IS NOT NULL AND plan_status <> 'approved' THEN
        RAISE EXCEPTION
            'issue % belongs to plan in status % and cannot be queued for an agent',
            NEW.id, plan_status
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS berry_issues_block_unapproved_dispatch ON issues;
CREATE TRIGGER berry_issues_block_unapproved_dispatch
    BEFORE INSERT OR UPDATE OF status ON issues
    FOR EACH ROW
    EXECUTE FUNCTION berry_block_unapproved_plan_dispatch();
