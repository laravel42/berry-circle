-- Berry migration 011: conversations, participants, and reachability channels.
--
-- Berry owns the conversation; Infobip is transport. That split is forced by
-- the product requirements rather than chosen for purity:
--
--   * conversations happen between users only, or in groups mixing users and
--     agents. Infobip Conversations models one external customer talking to
--     agents in a queue, which cannot express either shape.
--   * a briefing must be able to start anywhere — in the app, or over WhatsApp
--     from a phone — and be the same conversation either way. That is only
--     true if the thread exists in Berry and a channel is just how a given
--     message happened to travel.
--
-- So: participants are Berry identities, messages are Berry rows, and the
-- channel is provenance on a message rather than the identity of the thread.

-- --------------------------------------------------- reachability off-platform

-- How to reach a person when they are away from a computer. Separate from
-- users.email because a login address and a messaging address are different
-- facts with different verification stories.
CREATE TABLE IF NOT EXISTS user_channel_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel text NOT NULL,
    -- Phone number in E.164, email address, or platform handle.
    address text NOT NULL,
    display_name text,
    -- Unverified addresses are never used for delivery: sending a work
    -- conversation to an unproven number is a disclosure bug, not a bad UX.
    verified_at timestamptz,
    preferred boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_channel_identities_channel_ck
        CHECK (channel IN ('WHATSAPP', 'SMS', 'VIBER', 'TELEGRAM', 'EMAIL', 'LIVE_CHAT')),
    CONSTRAINT user_channel_identities_address_length_ck
        CHECK (char_length(address) BETWEEN 3 AND 320)
);

-- One address belongs to one person. Without this, an inbound WhatsApp message
-- could be attributed to whichever user was found first.
CREATE UNIQUE INDEX IF NOT EXISTS user_channel_identities_address_key
    ON user_channel_identities (channel, lower(address));

CREATE INDEX IF NOT EXISTS user_channel_identities_user_idx
    ON user_channel_identities (user_id, channel);

-- At most one preferred address per channel per user.
CREATE UNIQUE INDEX IF NOT EXISTS user_channel_identities_preferred_key
    ON user_channel_identities (user_id, channel)
    WHERE preferred;

-- ------------------------------------------------------------- conversations

CREATE TABLE IF NOT EXISTS conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- `brief` is the conversation that produces a plan; `direct` and `group`
    -- are ordinary collaboration. Kept explicit because a brief has a product
    -- outcome the others do not.
    kind text NOT NULL DEFAULT 'group',
    topic text,
    status text NOT NULL DEFAULT 'open',
    -- Optional anchors. A brief may produce a plan; a thread may hang off an
    -- issue, which is how a blocked task reaches a human wherever they are.
    issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
    plan_id uuid,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    CONSTRAINT conversations_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT conversations_kind_ck
        CHECK (kind IN ('brief', 'direct', 'group')),
    CONSTRAINT conversations_status_ck
        CHECK (status IN ('open', 'closed')),
    CONSTRAINT conversations_topic_length_ck
        CHECK (topic IS NULL OR char_length(topic) <= 500),
    CONSTRAINT conversations_plan_fk
        FOREIGN KEY (workspace_id, plan_id)
        REFERENCES plans(workspace_id, id) ON DELETE SET NULL,
    CONSTRAINT conversations_closed_ck
        CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS conversations_workspace_updated_idx
    ON conversations (workspace_id, status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS conversations_issue_idx
    ON conversations (issue_id) WHERE issue_id IS NOT NULL;

-- Participants are polymorphic exactly like issue assignees: a conversation
-- can be two users, a user and an agent, or a group of both.
CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    participant_type text NOT NULL,
    participant_id uuid NOT NULL,
    role text NOT NULL DEFAULT 'member',
    joined_at timestamptz NOT NULL DEFAULT now(),
    left_at timestamptz,
    PRIMARY KEY (conversation_id, participant_type, participant_id),
    CONSTRAINT conversation_participants_type_ck
        CHECK (participant_type IN ('user', 'agent')),
    CONSTRAINT conversation_participants_role_ck
        CHECK (role IN ('owner', 'member'))
);

CREATE INDEX IF NOT EXISTS conversation_participants_lookup_idx
    ON conversation_participants (participant_type, participant_id, conversation_id)
    WHERE left_at IS NULL;

CREATE TABLE IF NOT EXISTS conversation_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_type text NOT NULL,
    -- Null only for `system` authorship.
    author_id uuid,
    body text NOT NULL,
    -- Provenance, not identity: how this message travelled. `in_app` means it
    -- never left Berry. The same thread can mix in_app and WHATSAPP freely,
    -- which is what makes "brief from anywhere" work.
    channel text NOT NULL DEFAULT 'in_app',
    direction text NOT NULL DEFAULT 'internal',
    -- Provider message id. Webhooks retry, so inbound delivery must be
    -- idempotent or a repeated callback duplicates the user's message.
    external_id text,
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversation_messages_author_ck
        CHECK (author_type IN ('user', 'agent', 'system')),
    CONSTRAINT conversation_messages_author_id_ck
        CHECK ((author_type = 'system') = (author_id IS NULL)),
    CONSTRAINT conversation_messages_direction_ck
        CHECK (direction IN ('internal', 'inbound', 'outbound')),
    CONSTRAINT conversation_messages_body_length_ck
        CHECK (char_length(body) BETWEEN 1 AND 100000)
);

CREATE INDEX IF NOT EXISTS conversation_messages_thread_idx
    ON conversation_messages (conversation_id, created_at, id);

-- Idempotency for provider callbacks.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_external_key
    ON conversation_messages (channel, external_id)
    WHERE external_id IS NOT NULL;

-- --------------------------------------------------------------- call sessions

-- A call belongs to a conversation, so "who may join" is the participant list
-- that already exists rather than a second access model to keep in sync.
CREATE TABLE IF NOT EXISTS call_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    -- Provider room/conversation identifier for the media session.
    external_id text,
    kind text NOT NULL DEFAULT 'video',
    status text NOT NULL DEFAULT 'ringing',
    started_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    ended_at timestamptz,
    CONSTRAINT call_sessions_kind_ck CHECK (kind IN ('audio', 'video')),
    CONSTRAINT call_sessions_status_ck
        CHECK (status IN ('ringing', 'active', 'ended', 'failed'))
);

CREATE INDEX IF NOT EXISTS call_sessions_conversation_idx
    ON call_sessions (conversation_id, created_at DESC);

-- One live call per conversation. Two concurrent rooms for one thread would
-- split participants between them with no way to tell which is "the" call.
CREATE UNIQUE INDEX IF NOT EXISTS call_sessions_one_live_per_conversation_key
    ON call_sessions (conversation_id)
    WHERE status IN ('ringing', 'active');
