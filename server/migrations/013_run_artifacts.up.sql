-- Berry migration 013: artifacts produced by an agent run (ADR-0006).
--
-- An agent's output previously landed only in the runtime's own filesystem at
-- /data/workspaces/<agent>: keyed by agent rather than run, so two runs shared a
-- directory and one could overwrite the other's output; unreferenced by any row,
-- so nothing could list or link it; and outside the workspace scoping every
-- other Berry record obeys.
--
-- Artifacts become ordinary attachments instead of a parallel store. The
-- attachments ledger already carries the checksum, the pending -> ready state
-- that keeps a half-written upload from being served, and the presigned access
-- path; a second table would duplicate all three and drift from them.
--
-- Two columns are missing for an agent-authored file: who produced it, and
-- which run it came from.

-- Who produced it. `uploader_id` keeps referencing users, and agents get their
-- own column, so both sides retain a real foreign key: a deleted actor nulls
-- its reference rather than leaving an id that resolves to nothing. That is the
-- reason for two columns rather than the single polymorphic id `comments` uses
-- — there, author_id has no foreign key at all and nothing stops it dangling.
ALTER TABLE attachments
    ADD COLUMN IF NOT EXISTS uploader_type assignee_type,
    ADD COLUMN IF NOT EXISTS uploader_agent_id uuid
        REFERENCES agents (id) ON DELETE SET NULL;

-- Which run produced it. Null means the artifact did not come from one.
--
-- ON DELETE SET NULL, not CASCADE: deleting a run is bookkeeping, and it must
-- not destroy the file that run produced. The issue cascade already governs the
-- artifact's real lifetime.
ALTER TABLE attachments
    ADD COLUMN IF NOT EXISTS run_id uuid
        REFERENCES runs (id) ON DELETE SET NULL;

-- Every existing attachment was uploaded through the human upload path.
UPDATE attachments SET uploader_type = 'user' WHERE uploader_type IS NULL;

-- The declared kind and the populated column must agree. Either id may be null
-- on its own — an actor can be deleted after the fact — but an attachment may
-- never carry an agent id while claiming a user produced it, or the reverse.
ALTER TABLE attachments
    DROP CONSTRAINT IF EXISTS attachments_uploader_kind_ck;
ALTER TABLE attachments
    ADD CONSTRAINT attachments_uploader_kind_ck CHECK (
        (uploader_type IS NULL AND uploader_agent_id IS NULL)
        OR (uploader_type = 'user' AND uploader_agent_id IS NULL)
        OR (uploader_type = 'agent' AND uploader_id IS NULL)
    ) NOT VALID;

-- "What did this run produce" is the query this exists to answer, so it gets an
-- index rather than a sequential scan over every attachment in the workspace.
CREATE INDEX IF NOT EXISTS attachments_run_created_idx
    ON attachments (run_id, created_at DESC, id DESC)
    WHERE run_id IS NOT NULL;
