-- Berry migration 088: squads — agents and people under one leader agent.
--
-- An issue given to a squad is assigned to its leader; the leader's run
-- decides who does what and delegates by creating sub-issues for members,
-- which squad_delegations records so a member finishing wakes the leader.

CREATE TABLE IF NOT EXISTS squads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    leader_agent_id uuid NOT NULL,
    archived_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT squads_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT squads_leader_fk FOREIGN KEY (workspace_id, leader_agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE RESTRICT,
    CONSTRAINT squads_name_ck CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT squads_description_ck CHECK (char_length(description) <= 2000)
);
CREATE UNIQUE INDEX IF NOT EXISTS squads_workspace_name_key
    ON squads (workspace_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS squad_members (
    squad_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    member_type text NOT NULL,
    member_id uuid NOT NULL,
    role text NOT NULL DEFAULT 'member',
    PRIMARY KEY (squad_id, member_type, member_id),
    CONSTRAINT squad_members_squad_fk FOREIGN KEY (workspace_id, squad_id)
        REFERENCES squads (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT squad_members_type_ck CHECK (member_type IN ('agent', 'user')),
    CONSTRAINT squad_members_role_ck CHECK (char_length(role) BETWEEN 1 AND 50)
);

CREATE TABLE IF NOT EXISTS issue_squads (
    issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    squad_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT issue_squads_squad_fk FOREIGN KEY (workspace_id, squad_id)
        REFERENCES squads (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS squad_delegations (
    child_issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    parent_issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    squad_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    member_agent_id uuid NOT NULL,
    last_notified_run_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT squad_delegations_squad_fk FOREIGN KEY (workspace_id, squad_id)
        REFERENCES squads (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS squad_delegations_parent_idx ON squad_delegations (parent_issue_id);
