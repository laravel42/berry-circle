-- Berry migration range 000-099: P2 work-management catalogs and projects.
-- This migration is additive. All new product rows carry an explicit workspace
-- owner, and issue junctions verify that ownership through the issue's board.

CREATE UNIQUE INDEX IF NOT EXISTS agents_workspace_id_id_key
    ON agents (workspace_id, id);

CREATE TABLE IF NOT EXISTS projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    status text NOT NULL DEFAULT 'planned',
    priority text NOT NULL DEFAULT 'none',
    start_date date,
    target_date date,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT projects_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT projects_name_length_ck
        CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT projects_description_length_ck
        CHECK (description IS NULL OR char_length(description) <= 20000),
    CONSTRAINT projects_status_ck
        CHECK (status IN ('planned', 'active', 'paused', 'completed', 'cancelled')),
    CONSTRAINT projects_priority_ck
        CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
    CONSTRAINT projects_date_order_ck
        CHECK (start_date IS NULL OR target_date IS NULL OR start_date <= target_date)
);

CREATE INDEX IF NOT EXISTS projects_workspace_order_idx
    ON projects (workspace_id, updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_workspace_status_idx
    ON projects (workspace_id, status, priority, updated_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_workspace_name_idx
    ON projects (workspace_id, lower(name), id)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS project_resources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    kind text NOT NULL,
    url text NOT NULL,
    label text,
    description text,
    sort_order integer NOT NULL DEFAULT 0,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT project_resources_project_fk
        FOREIGN KEY (workspace_id, project_id)
        REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT project_resources_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT project_resources_kind_ck
        CHECK (kind IN ('link', 'document', 'repository')),
    CONSTRAINT project_resources_url_ck
        CHECK (
            char_length(url) BETWEEN 1 AND 2048
            AND url ~* '^https?://[^[:space:]]+$'
        ),
    CONSTRAINT project_resources_label_length_ck
        CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 200),
    CONSTRAINT project_resources_description_length_ck
        CHECK (description IS NULL OR char_length(description) <= 2000),
    CONSTRAINT project_resources_sort_order_ck
        CHECK (sort_order BETWEEN 0 AND 1000000000)
);

CREATE UNIQUE INDEX IF NOT EXISTS project_resources_active_url_key
    ON project_resources (workspace_id, project_id, url)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS project_resources_project_order_idx
    ON project_resources (workspace_id, project_id, sort_order, id)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS issue_project_links (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT issue_project_links_project_fk
        FOREIGN KEY (workspace_id, project_id)
        REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT issue_project_links_workspace_issue_key
        UNIQUE (workspace_id, issue_id)
);

CREATE INDEX IF NOT EXISTS issue_project_links_project_idx
    ON issue_project_links (workspace_id, project_id, issue_id);

CREATE TABLE IF NOT EXISTS issue_labels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    color text NOT NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    CONSTRAINT issue_labels_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT issue_labels_name_length_ck
        CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT issue_labels_description_length_ck
        CHECK (description IS NULL OR char_length(description) <= 1000),
    CONSTRAINT issue_labels_color_ck
        CHECK (color ~ '^#[0-9a-f]{6}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS issue_labels_active_name_key
    ON issue_labels (workspace_id, lower(name))
    WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS issue_labels_workspace_order_idx
    ON issue_labels (workspace_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS issue_label_memberships (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    label_id uuid NOT NULL,
    assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, issue_id, label_id),
    CONSTRAINT issue_label_memberships_label_fk
        FOREIGN KEY (workspace_id, label_id)
        REFERENCES issue_labels(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS issue_label_memberships_label_idx
    ON issue_label_memberships (workspace_id, label_id, issue_id);

CREATE TABLE IF NOT EXISTS issue_status_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    category text NOT NULL,
    color text NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    is_system boolean NOT NULL DEFAULT false,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    CONSTRAINT issue_status_definitions_workspace_id_id_key
        UNIQUE (workspace_id, id),
    CONSTRAINT issue_status_definitions_workspace_key_key
        UNIQUE (workspace_id, key),
    CONSTRAINT issue_status_definitions_key_ck
        CHECK (key ~ '^[a-z][a-z0-9-]{0,31}$'),
    CONSTRAINT issue_status_definitions_name_length_ck
        CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT issue_status_definitions_description_length_ck
        CHECK (description IS NULL OR char_length(description) <= 1000),
    CONSTRAINT issue_status_definitions_category_ck
        CHECK (
            category IN (
                'backlog',
                'todo',
                'in_progress',
                'in_review',
                'done',
                'cancelled'
            )
        ),
    CONSTRAINT issue_status_definitions_color_ck
        CHECK (color ~ '^#[0-9a-f]{6}$'),
    CONSTRAINT issue_status_definitions_sort_order_ck
        CHECK (sort_order BETWEEN 0 AND 1000000000),
    CONSTRAINT issue_status_definitions_system_key_ck
        CHECK (NOT is_system OR replace(key, '-', '_') = category),
    CONSTRAINT issue_status_definitions_system_active_ck
        CHECK (NOT is_system OR archived_at IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS issue_status_definitions_active_name_key
    ON issue_status_definitions (workspace_id, lower(name))
    WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS issue_status_definitions_workspace_order_idx
    ON issue_status_definitions (workspace_id, sort_order, id)
    WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS issue_property_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    kind text NOT NULL,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    icon text,
    sort_order integer NOT NULL DEFAULT 0,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    CONSTRAINT issue_property_definitions_workspace_id_id_key
        UNIQUE (workspace_id, id),
    CONSTRAINT issue_property_definitions_name_length_ck
        CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT issue_property_definitions_description_length_ck
        CHECK (description IS NULL OR char_length(description) <= 1000),
    CONSTRAINT issue_property_definitions_kind_ck
        CHECK (kind IN ('text', 'number', 'boolean', 'date', 'url', 'select', 'multi_select')),
    CONSTRAINT issue_property_definitions_config_object_ck
        CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 32768),
    CONSTRAINT issue_property_definitions_config_shape_ck
        CHECK (
            (
                kind IN ('text', 'number', 'boolean', 'date', 'url')
                AND config = '{}'::jsonb
            )
            OR (
                kind IN ('select', 'multi_select')
                AND jsonb_typeof(config -> 'options') = 'array'
                AND jsonb_array_length(config -> 'options') BETWEEN 1 AND 100
            )
        ),
    CONSTRAINT issue_property_definitions_icon_length_ck
        CHECK (icon IS NULL OR char_length(icon) BETWEEN 1 AND 100),
    CONSTRAINT issue_property_definitions_sort_order_ck
        CHECK (sort_order BETWEEN 0 AND 1000000000)
);

CREATE UNIQUE INDEX IF NOT EXISTS issue_property_definitions_active_name_key
    ON issue_property_definitions (workspace_id, lower(name))
    WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS issue_property_definitions_workspace_order_idx
    ON issue_property_definitions (workspace_id, sort_order, id)
    WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS issue_property_values (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    property_id uuid NOT NULL,
    value jsonb NOT NULL,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, issue_id, property_id),
    CONSTRAINT issue_property_values_property_fk
        FOREIGN KEY (workspace_id, property_id)
        REFERENCES issue_property_definitions(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT issue_property_values_size_ck
        CHECK (pg_column_size(value) <= 16384)
);

CREATE INDEX IF NOT EXISTS issue_property_values_property_idx
    ON issue_property_values (workspace_id, property_id, issue_id);

CREATE TABLE IF NOT EXISTS quick_action_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    target_agent_id uuid NOT NULL,
    prompt text NOT NULL,
    visibility text NOT NULL DEFAULT 'private',
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    CONSTRAINT quick_action_definitions_workspace_id_id_key
        UNIQUE (workspace_id, id),
    CONSTRAINT quick_action_definitions_agent_fk
        FOREIGN KEY (workspace_id, target_agent_id)
        REFERENCES agents(workspace_id, id) ON DELETE RESTRICT,
    CONSTRAINT quick_action_definitions_name_length_ck
        CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT quick_action_definitions_description_length_ck
        CHECK (description IS NULL OR char_length(description) <= 1000),
    CONSTRAINT quick_action_definitions_prompt_length_ck
        CHECK (char_length(prompt) BETWEEN 1 AND 20000),
    CONSTRAINT quick_action_definitions_visibility_ck
        CHECK (visibility IN ('private', 'workspace'))
);

CREATE INDEX IF NOT EXISTS quick_action_definitions_workspace_order_idx
    ON quick_action_definitions (workspace_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS quick_action_definitions_target_idx
    ON quick_action_definitions (workspace_id, target_agent_id)
    WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quick_action_definitions_active_name_key
    ON quick_action_definitions (workspace_id, lower(name))
    WHERE archived_at IS NULL AND visibility = 'workspace';

CREATE OR REPLACE FUNCTION berry_validate_owned_issue_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    owner_workspace_id uuid;
BEGIN
    SELECT board.workspace_id
      INTO owner_workspace_id
      FROM issues AS issue
      JOIN boards AS board ON board.id = issue.board_id
     WHERE issue.id = NEW.issue_id;

    IF owner_workspace_id IS NULL OR owner_workspace_id <> NEW.workspace_id THEN
        RAISE EXCEPTION 'issue does not belong to the supplied workspace'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION berry_keep_status_definition_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.workspace_id <> OLD.workspace_id
       OR NEW.key <> OLD.key
       OR NEW.category <> OLD.category
       OR NEW.is_system <> OLD.is_system THEN
        RAISE EXCEPTION 'issue status identity and workflow category are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION berry_validate_property_value()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    property_kind text;
    property_config jsonb;
    property_archived_at timestamptz;
    scalar_value text;
BEGIN
    SELECT definition.kind, definition.config, definition.archived_at
      INTO property_kind, property_config, property_archived_at
      FROM issue_property_definitions AS definition
     WHERE definition.workspace_id = NEW.workspace_id
       AND definition.id = NEW.property_id;

    IF property_kind IS NULL OR property_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'property definition is unavailable'
            USING ERRCODE = '23503';
    END IF;

    scalar_value := NEW.value #>> '{}';
    CASE property_kind
        WHEN 'text' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR char_length(scalar_value) > 10000 THEN
                RAISE EXCEPTION 'invalid text property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'number' THEN
            IF jsonb_typeof(NEW.value) <> 'number' THEN
                RAISE EXCEPTION 'invalid number property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'boolean' THEN
            IF jsonb_typeof(NEW.value) <> 'boolean' THEN
                RAISE EXCEPTION 'invalid boolean property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'date' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR scalar_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
                RAISE EXCEPTION 'invalid date property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'url' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR char_length(scalar_value) > 2048
               OR scalar_value !~* '^https?://[^[:space:]]+$' THEN
                RAISE EXCEPTION 'invalid URL property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'select' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR NOT EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(property_config -> 'options') AS option
                    WHERE option ->> 'id' = scalar_value
               ) THEN
                RAISE EXCEPTION 'invalid select property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'multi_select' THEN
            IF jsonb_typeof(NEW.value) <> 'array'
               OR jsonb_array_length(NEW.value) > 50
               OR EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(NEW.value) AS selected
                    WHERE jsonb_typeof(selected) <> 'string'
                       OR NOT EXISTS (
                           SELECT 1
                             FROM jsonb_array_elements(property_config -> 'options') AS option
                            WHERE option ->> 'id' = selected #>> '{}'
                       )
               )
               OR (
                   SELECT count(*) <> count(DISTINCT selected #>> '{}')
                     FROM jsonb_array_elements(NEW.value) AS selected
               ) THEN
                RAISE EXCEPTION 'invalid multi-select property value' USING ERRCODE = '23514';
            END IF;
        ELSE
            RAISE EXCEPTION 'unknown property kind' USING ERRCODE = '23514';
    END CASE;
    RETURN NEW;
END
$$;

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
        (NEW.id, 'cancelled', 'Cancelled', 'Work that will not continue.', 'cancelled', '#ef4444', 6000, true, NEW.created_by)
    ON CONFLICT (workspace_id, key) DO NOTHING;
    RETURN NEW;
END
$$;

CREATE TRIGGER berry_projects_set_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
CREATE TRIGGER berry_project_resources_set_updated_at
    BEFORE UPDATE ON project_resources
    FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
CREATE TRIGGER berry_issue_labels_set_updated_at
    BEFORE UPDATE ON issue_labels
    FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
CREATE TRIGGER berry_issue_status_definitions_set_updated_at
    BEFORE UPDATE ON issue_status_definitions
    FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
CREATE TRIGGER berry_issue_property_definitions_set_updated_at
    BEFORE UPDATE ON issue_property_definitions
    FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
CREATE TRIGGER berry_issue_property_values_set_updated_at
    BEFORE UPDATE ON issue_property_values
    FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();
CREATE TRIGGER berry_quick_action_definitions_set_updated_at
    BEFORE UPDATE ON quick_action_definitions
    FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();

CREATE TRIGGER berry_issue_project_links_workspace
    BEFORE INSERT OR UPDATE ON issue_project_links
    FOR EACH ROW EXECUTE FUNCTION berry_validate_owned_issue_row();
CREATE TRIGGER berry_issue_label_memberships_workspace
    BEFORE INSERT OR UPDATE ON issue_label_memberships
    FOR EACH ROW EXECUTE FUNCTION berry_validate_owned_issue_row();
CREATE TRIGGER berry_issue_property_values_workspace
    BEFORE INSERT OR UPDATE ON issue_property_values
    FOR EACH ROW EXECUTE FUNCTION berry_validate_owned_issue_row();
CREATE TRIGGER berry_issue_property_values_type
    BEFORE INSERT OR UPDATE ON issue_property_values
    FOR EACH ROW EXECUTE FUNCTION berry_validate_property_value();
CREATE TRIGGER berry_issue_status_definitions_immutable
    BEFORE UPDATE ON issue_status_definitions
    FOR EACH ROW EXECUTE FUNCTION berry_keep_status_definition_identity();
CREATE TRIGGER berry_workspaces_seed_issue_statuses
    AFTER INSERT ON workspaces
    FOR EACH ROW EXECUTE FUNCTION berry_seed_workspace_issue_statuses();

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
    seed.key,
    seed.name,
    seed.description,
    seed.category,
    seed.color,
    seed.sort_order,
    true,
    workspace.created_by
FROM workspaces AS workspace
CROSS JOIN (
    VALUES
        ('backlog', 'Backlog', 'Parked work.', 'backlog', '#6b7280', 1000),
        ('todo', 'Todo', 'Ready to start.', 'todo', '#64748b', 2000),
        ('in-progress', 'In progress', 'Work in progress.', 'in_progress', '#f59e0b', 3000),
        ('in-review', 'In review', 'Waiting for human review.', 'in_review', '#8b5cf6', 4000),
        ('done', 'Done', 'Completed work.', 'done', '#22c55e', 5000),
        ('cancelled', 'Cancelled', 'Work that will not continue.', 'cancelled', '#ef4444', 6000)
) AS seed(key, name, description, category, color, sort_order)
WHERE workspace.deleted_at IS NULL
ON CONFLICT (workspace_id, key) DO NOTHING;
