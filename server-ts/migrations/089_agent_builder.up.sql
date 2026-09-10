-- Berry migration 089: agent builder sessions and their drafts.
--
-- A session is a short conversation that ends with an agent; each turn keeps
-- the draft it produced, so a person can go back to an earlier one and apply it.

CREATE TABLE IF NOT EXISTS agent_builder_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'drafting',
    applied_agent_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_builder_sessions_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT agent_builder_sessions_status_ck CHECK (status IN ('drafting', 'applied', 'discarded'))
);

CREATE TABLE IF NOT EXISTS agent_builder_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    turn integer NOT NULL,
    prompt text NOT NULL,
    draft jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_builder_drafts_session_fk FOREIGN KEY (workspace_id, session_id)
        REFERENCES agent_builder_sessions (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT agent_builder_drafts_turn_key UNIQUE (session_id, turn),
    CONSTRAINT agent_builder_drafts_prompt_ck CHECK (char_length(prompt) BETWEEN 1 AND 4000)
);
