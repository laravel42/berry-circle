-- The internal git server is gone; a project's repository is its GitHub link.
--
-- `git_repo` named a repository on Berry's own Gitea. Nothing serves those any
-- more, so every value in the column points at a host that no longer exists —
-- which is worse than an empty column, because a name that looks like an
-- address invites something to try it.
--
-- The column is kept and emptied rather than dropped. Forward-only migrations
-- mean a drop is unrecoverable, and `github_repo_full_name` beside it already
-- carries the answer; an empty column costs a few bytes a row and leaves the
-- door open if Berry ever hosts repositories again.
UPDATE projects SET git_repo = NULL WHERE git_repo IS NOT NULL;

COMMENT ON COLUMN projects.git_repo IS
    'Unused since the internal git server was removed. A project''s repository is github_repo_full_name.';

-- The links written for objects on that server are dead in the same way: they
-- hold ids that resolved on a host nobody runs. `detached` is the status that
-- already means exactly this — the mapping is remembered, and known to be dead.
UPDATE scm_links
   SET status = 'detached', error = 'the internal git server was removed', updated_at = now()
 WHERE provider = 'gitea' AND status <> 'detached';
