-- Berry migration 182: a workspace reaches several accounts at once.
--
-- Until now the primary key was the workspace alone — one installation per
-- workspace — which made "which installation" a question nothing had to
-- answer. It also made a personal account and an organisation mutually
-- exclusive: installing on the second replaced the first, silently, and every
-- repository imported from the first became a repository no agent could reach.
--
-- The key is therefore the workspace *and* the installation. What replaces the
-- old certainty is a rule enforced one level down: an installation belongs to
-- exactly one workspace, so a token minted against it can only ever be minted
-- by that workspace, and a webhook naming it resolves to one workspace and no
-- other. That was already checked in the application (`claimedBy`); a unique
-- index is where it belongs, because it is the sentence the rest of the
-- integration's isolation rests on.
--
-- Existing rows need no moving: every one of them is already unique on
-- (workspace_id, installation_id), so the wider key keeps them all. The
-- de-duplication below is for the one shape the old schema permitted and the
-- new one forbids — the same installation_id recorded by two workspaces — and
-- keeps the workspace that recorded it first, which is the one the application
-- would have let keep it.
--
-- The pending state a settings page reports is `github_install_offers.status`
-- from migration 181 and is unchanged: an install awaiting an owner's approval
-- has no installation row to carry a state on, which is the whole reason that
-- table exists.

DELETE FROM github_installations AS duplicate
 WHERE EXISTS (
    SELECT 1 FROM github_installations AS kept
     WHERE kept.installation_id = duplicate.installation_id
       AND (kept.created_at, kept.workspace_id) < (duplicate.created_at, duplicate.workspace_id)
 );

ALTER TABLE github_installations
   DROP CONSTRAINT IF EXISTS github_installations_pkey;

ALTER TABLE github_installations
   ADD CONSTRAINT github_installations_pkey PRIMARY KEY (workspace_id, installation_id);

CREATE UNIQUE INDEX IF NOT EXISTS github_installations_installation_key
    ON github_installations (installation_id);

-- Listing a workspace's accounts is the read every GitHub surface starts with,
-- and it wants them in the order they were added so "Add another account"
-- appends rather than reshuffles.
CREATE INDEX IF NOT EXISTS github_installations_workspace_added_idx
    ON github_installations (workspace_id, created_at, installation_id);

COMMENT ON TABLE github_installations IS
    'The App installations a workspace mints repository tokens against — one per account.';
COMMENT ON COLUMN github_installations.installation_id IS
    'GitHub''s installation id, unique across Berry: an installation belongs to exactly one workspace.';
