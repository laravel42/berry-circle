-- Berry migration 085: the skills catalogue.
--
-- A skill is a named piece of instructions plus supporting files that an
-- agent carries into a task. The container writes enabled skills into the
-- task workspace as a directory per skill; the catalogue is Berry's record.

CREATE TABLE IF NOT EXISTS skills (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    content text NOT NULL DEFAULT '',
    labels text[] NOT NULL DEFAULT ARRAY[]::text[],
    source_kind text NOT NULL DEFAULT 'manual',
    source_url text,
    source_ref text,
    imported_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT skills_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT skills_name_ck CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    CONSTRAINT skills_description_ck CHECK (char_length(description) <= 1024),
    CONSTRAINT skills_content_ck CHECK (octet_length(content) <= 262144),
    CONSTRAINT skills_labels_ck CHECK (coalesce(array_length(labels, 1), 0) <= 20),
    CONSTRAINT skills_source_kind_ck CHECK (source_kind IN ('manual', 'github', 'zip'))
);

CREATE UNIQUE INDEX IF NOT EXISTS skills_workspace_name_key ON skills (workspace_id, name);

CREATE TABLE IF NOT EXISTS skill_files (
    skill_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    path text NOT NULL,
    content text NOT NULL,
    PRIMARY KEY (skill_id, path),
    CONSTRAINT skill_files_skill_fk FOREIGN KEY (workspace_id, skill_id)
        REFERENCES skills (workspace_id, id) ON DELETE CASCADE,
    -- Relative, no dot-dot segment: the container writes these under the
    -- skill's directory and a path that climbs out would write elsewhere.
    CONSTRAINT skill_files_path_ck CHECK (
        char_length(path) <= 255
        AND path ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
        AND path !~ '(^|/)\.\.(/|$)'
    ),
    CONSTRAINT skill_files_content_ck CHECK (octet_length(content) <= 262144)
);

CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id uuid NOT NULL,
    skill_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, skill_id),
    CONSTRAINT agent_skills_agent_fk FOREIGN KEY (workspace_id, agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT agent_skills_skill_fk FOREIGN KEY (workspace_id, skill_id)
        REFERENCES skills (workspace_id, id) ON DELETE CASCADE
);
