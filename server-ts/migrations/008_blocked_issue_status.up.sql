-- Berry migration 008: add blocked issue workflow status.

ALTER TYPE issue_status ADD VALUE IF NOT EXISTS 'blocked';

ALTER TABLE issue_status_definitions
    DROP CONSTRAINT IF EXISTS issue_status_definitions_category_ck;

ALTER TABLE issue_status_definitions
    ADD CONSTRAINT issue_status_definitions_category_ck
    CHECK (
        category IN (
            'backlog',
            'todo',
            'in_progress',
            'in_review',
            'done',
            'blocked',
            'cancelled'
        )
    );

CREATE OR REPLACE FUNCTION berry_seed_workspace_issue_statuses()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO issue_status_definitions (
        workspace_id,
        key,
        name,
        description,
        category,
        color,
        sort_order,
        is_system,
        created_by
    )
    VALUES
        (NEW.id, 'backlog', 'Backlog', 'Parked work.', 'backlog', '#6b7280', 1000, true, NEW.created_by),
        (NEW.id, 'todo', 'Todo', 'Ready to start.', 'todo', '#64748b', 2000, true, NEW.created_by),
        (NEW.id, 'in-progress', 'In progress', 'Work in progress.', 'in_progress', '#f59e0b', 3000, true, NEW.created_by),
        (NEW.id, 'in-review', 'In review', 'Waiting for human review.', 'in_review', '#8b5cf6', 4000, true, NEW.created_by),
        (NEW.id, 'done', 'Done', 'Completed work.', 'done', '#22c55e', 5000, true, NEW.created_by),
        (NEW.id, 'blocked', 'Blocked', 'Work blocked by a dependency.', 'blocked', '#d97706', 5500, true, NEW.created_by),
        (NEW.id, 'cancelled', 'Cancelled', 'Work that will not continue.', 'cancelled', '#ef4444', 6000, true, NEW.created_by)
    ON CONFLICT (workspace_id, key) DO NOTHING;
    RETURN NEW;
END
$$;

INSERT INTO issue_status_definitions (
    workspace_id,
    key,
    name,
    description,
    category,
    color,
    sort_order,
    is_system,
    created_by
)
SELECT
    workspace.id,
    'blocked',
    'Blocked',
    'Work blocked by a dependency.',
    'blocked',
    '#d97706',
    5500,
    true,
    workspace.created_by
FROM workspaces AS workspace
WHERE workspace.deleted_at IS NULL
ON CONFLICT (workspace_id, key) DO NOTHING;
