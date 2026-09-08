-- What each Berry object is, on the git host.
--
-- One table rather than a column per object type. Six mappings each needing an
-- id, a status and an error would be twenty-four columns spread across six
-- tables, with no single place to ask "what failed to provision" — which is
-- the question an operator actually has.
--
-- Identified by the host's numeric id, never by name. Names are for people:
-- they get edited, they collide between owners, and matching on them is how
-- one project's history ends up attached to another's.
CREATE TABLE IF NOT EXISTS scm_links (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    provider      text NOT NULL,
    -- Which kind of Berry object this row maps. Text rather than an enum: a new
    -- mapping should not need a migration to name it, and the set is checked.
    berry_type    text NOT NULL,
    berry_id      uuid NOT NULL,

    -- Null until provisioning succeeds. That is the whole point of the status
    -- column beside it: Berry must never believe an external object exists
    -- because a row was written before the call returned.
    external_id     bigint,
    -- The per-repository number a person sees (issue #42), where the host has
    -- one. Distinct from external_id, which is globally unique to the host.
    external_number bigint,
    external_url    text,
    -- The host's own last-modified stamp, as of Berry's last write. A webhook
    -- carrying something not newer than this is Berry's own change coming back.
    external_updated_at timestamptz,

    status        text NOT NULL DEFAULT 'pending',
    error         text,
    last_synced_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT scm_links_provider_ck CHECK (provider IN ('gitea', 'github')),
    CONSTRAINT scm_links_type_ck CHECK (berry_type IN (
        'workspace', 'project', 'milestone', 'issue', 'review', 'run'
    )),
    -- `detached` is the state for an object whose host counterpart was deleted
    -- out from under Berry: the mapping is remembered, and is known to be dead.
    CONSTRAINT scm_links_status_ck CHECK (status IN ('pending', 'synced', 'failed', 'detached')),
    CONSTRAINT scm_links_error_ck CHECK (error IS NULL OR char_length(error) <= 4000),
    -- A synced link has something to point at. Without this the status column
    -- could claim success for a row that never got an id.
    CONSTRAINT scm_links_synced_ck CHECK (status <> 'synced' OR external_id IS NOT NULL)
);

-- One link per Berry object per provider: the mapping is a fact, not a history.
CREATE UNIQUE INDEX IF NOT EXISTS scm_links_berry_key
    ON scm_links (provider, berry_type, berry_id);

-- And one Berry object per host object. Two projects claiming one repository is
-- the corruption this integration exists to make impossible.
CREATE UNIQUE INDEX IF NOT EXISTS scm_links_external_key
    ON scm_links (provider, berry_type, external_id)
    WHERE external_id IS NOT NULL;

-- The webhook read: "which Berry object is this host id?", the only lookup on
-- the inbound path and the one that must never fall back to a name.
CREATE INDEX IF NOT EXISTS scm_links_external_lookup_idx
    ON scm_links (provider, external_id) WHERE external_id IS NOT NULL;

-- The operator read: what has not provisioned.
CREATE INDEX IF NOT EXISTS scm_links_unhealthy_idx
    ON scm_links (workspace_id, status) WHERE status <> 'synced';

COMMENT ON TABLE scm_links IS
    'Maps a Berry object to its counterpart on a git host, by the host''s id.';


-- A review, as a first-class Berry object.
--
-- Berry had no such thing: `issue_auto_reviews` records one agent's verdict on
-- one run, which is a different fact — it has an attempt number and a run id,
-- and a design review has neither. That table stays as the agent verdict trail.
--
-- `kind` is what decides whether a pull request is involved. Only a code review
-- has one; a design, architecture, requirements or research review is answered
-- in Berry and has no git artifact to point at.
CREATE TABLE IF NOT EXISTS reviews (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    issue_id     uuid NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
    -- The run whose work is under review, when a run produced it.
    run_id       uuid REFERENCES runs (id) ON DELETE SET NULL,
    kind         text NOT NULL,
    state        text NOT NULL DEFAULT 'open',
    title        text NOT NULL,
    summary      text,
    -- Set for a code review once its pull request exists. The id itself lives
    -- in scm_links; this is the number a person reads and a URL is built from.
    pull_request_number bigint,
    branch       text,
    head_commit  text,
    requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
    decided_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    decided_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reviews_kind_ck CHECK (kind IN (
        'code', 'design', 'architecture', 'requirements', 'research'
    )),
    CONSTRAINT reviews_state_ck CHECK (state IN (
        'open', 'approved', 'changes_requested', 'merged', 'closed'
    )),
    CONSTRAINT reviews_title_ck CHECK (char_length(title) BETWEEN 1 AND 300),
    -- Only a code review may name a pull request. This is the constraint that
    -- keeps "not every Berry review requires a PR" true in the data rather
    -- than only in the code that writes it.
    CONSTRAINT reviews_pull_request_ck CHECK (
        kind = 'code' OR (pull_request_number IS NULL AND branch IS NULL)
    ),
    CONSTRAINT reviews_decision_ck CHECK (
        (state IN ('open')) = (decided_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS reviews_issue_idx ON reviews (issue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_workspace_open_idx
    ON reviews (workspace_id, state, updated_at DESC);

COMMENT ON TABLE reviews IS
    'A review of an issue. Only kind = code corresponds to a pull request.';


-- Where a run''s work went.
--
-- The branch and commit were already produced by `agents/delivery.ts` and
-- reported in a run event payload, which is a stream to read rather than a
-- column to query. A reviewer asking "what branch is this on" should not have
-- to scan an event log for it.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS branch text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS head_commit text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS pull_request_number bigint;

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_branch_ck;
ALTER TABLE runs
    ADD CONSTRAINT runs_branch_ck
    CHECK (branch IS NULL OR char_length(branch) BETWEEN 1 AND 255);
