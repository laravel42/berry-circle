-- Back to one installation per workspace.
--
-- Narrowing the key drops rows rather than merging them: a workspace reaching
-- two accounts cannot be described by the old schema at all, so the oldest
-- installation — the one it had before this work — is what survives, and the
-- accounts added since are forgotten. The App stays installed on GitHub; only
-- Berry's record of it goes.
DELETE FROM github_installations AS extra
 WHERE EXISTS (
    SELECT 1 FROM github_installations AS kept
     WHERE kept.workspace_id = extra.workspace_id
       AND (kept.created_at, kept.installation_id) < (extra.created_at, extra.installation_id)
 );

DROP INDEX IF EXISTS github_installations_workspace_added_idx;
DROP INDEX IF EXISTS github_installations_installation_key;

ALTER TABLE github_installations
   DROP CONSTRAINT IF EXISTS github_installations_pkey;

ALTER TABLE github_installations
   ADD CONSTRAINT github_installations_pkey PRIMARY KEY (workspace_id);
