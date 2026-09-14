-- Berry migration 090: chat sessions that run agent tasks.
--
-- A conversation is a chat session. Per-person state (pinned, archived,
-- read position, unsent draft) lives on the participant row, because two
-- people in one thread pin and read it independently.

-- FK as A's handoff requires (A plan: "active_run_id uuid REFERENCES runs(id) ON DELETE SET NULL").
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS active_run_id uuid REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'agent';
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_title_source_ck;
ALTER TABLE conversations ADD CONSTRAINT conversations_title_source_ck
    CHECK (title_source IN ('agent', 'generated', 'user')) NOT VALID;

ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS last_read_at timestamptz;
ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS draft text NOT NULL DEFAULT '';
ALTER TABLE conversation_participants DROP CONSTRAINT IF EXISTS conversation_participants_draft_ck;
ALTER TABLE conversation_participants ADD CONSTRAINT conversation_participants_draft_ck
    CHECK (char_length(draft) <= 20000) NOT VALID;

ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS conversation_messages_run_idx
    ON conversation_messages (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_pinned_agents (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    position integer NOT NULL,
    PRIMARY KEY (user_id, agent_id),
    CONSTRAINT user_pinned_agents_agent_fk FOREIGN KEY (workspace_id, agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);
