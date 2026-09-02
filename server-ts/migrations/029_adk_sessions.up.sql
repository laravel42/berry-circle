-- An agent's conversation, owned by Berry rather than by a runtime.
--
-- ADK keeps a session per agent invocation: the contents exchanged with the
-- model, the tool calls made, and a state bag the agent carries between turns.
-- Its own DatabaseSessionService brings MikroORM, which would make a second
-- owner of this schema alongside these forward-only migrations. Berry supplies
-- the storage instead, so there stays exactly one migrator.
--
-- This is what replaces the runtime's per-agent directory. A session is a row, not
-- a process with a lifecycle, so nothing here can be marked crashed for being
-- idle and nothing has to be reconciled against an upstream list.

CREATE TABLE IF NOT EXISTS adk_sessions (
    -- ADK addresses a session by (appName, userId, sessionId) and generates the
    -- id itself, so the triple is the key rather than a surrogate.
    app_name text NOT NULL,
    user_id text NOT NULL,
    id text NOT NULL,

    -- Berry's scope, so a session can be found from the work it belongs to and
    -- cleaned up with it. Nullable because a session may exist before it is
    -- attached to a run — an ad-hoc ask has no run.
    workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE,
    run_id uuid REFERENCES runs (id) ON DELETE CASCADE,

    -- The agent's state bag between turns. An object, never a scalar.
    state jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at timestamptz NOT NULL DEFAULT now(),
    -- ADK orders sessions by when they were last written to, not created.
    last_update_time timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (app_name, user_id, id),
    CONSTRAINT adk_sessions_state_object_ck CHECK (jsonb_typeof(state) = 'object'),
    CONSTRAINT adk_sessions_app_name_ck CHECK (char_length(app_name) BETWEEN 1 AND 128),
    CONSTRAINT adk_sessions_user_id_ck CHECK (char_length(user_id) BETWEEN 1 AND 128),
    CONSTRAINT adk_sessions_id_ck CHECK (char_length(id) BETWEEN 1 AND 128)
);

-- Listing is always scoped to an app and ordered by recency.
CREATE INDEX IF NOT EXISTS adk_sessions_listing_idx
    ON adk_sessions (app_name, user_id, last_update_time DESC);

-- So a run's session is reachable from the run, for cancellation and cleanup.
CREATE INDEX IF NOT EXISTS adk_sessions_run_idx
    ON adk_sessions (run_id) WHERE run_id IS NOT NULL;

-- Every event in a session, in the order it happened.
--
-- Separate from `run_events`, which is Berry's own ledger of what a run did and
-- is a product surface. This table is the agent's transcript: what went to the
-- model and came back. The two answer different questions and one should not
-- be reshaped to serve the other.
CREATE TABLE IF NOT EXISTS adk_session_events (
    id text NOT NULL,
    app_name text NOT NULL,
    user_id text NOT NULL,
    session_id text NOT NULL,

    -- Monotonic within a session. ADK replays events in order, and ordering by
    -- timestamp alone would be ambiguous for events written in the same
    -- millisecond — which tool calls routinely are.
    sequence bigint NOT NULL,

    -- The whole ADK Event, stored as it was given. Berry does not interpret
    -- the parts; reshaping them here would mean this table had to change
    -- whenever ADK's content types did.
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (app_name, user_id, session_id, sequence),
    CONSTRAINT adk_session_events_payload_object_ck CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT adk_session_events_id_ck CHECK (char_length(id) BETWEEN 1 AND 128),
    CONSTRAINT adk_session_events_sequence_ck CHECK (sequence >= 0),
    FOREIGN KEY (app_name, user_id, session_id)
        REFERENCES adk_sessions (app_name, user_id, id) ON DELETE CASCADE
);

-- Replaying a session reads it in order; `numRecentEvents` reads the tail.
CREATE INDEX IF NOT EXISTS adk_session_events_replay_idx
    ON adk_session_events (app_name, user_id, session_id, sequence DESC);
