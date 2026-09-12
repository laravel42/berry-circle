-- Berry migration 181: the install a person was offered, and what became of it.
--
-- Repository access is granted once, at someone's first login: if their
-- workspace has no installation Berry knows of, they are sent to GitHub to
-- choose an account and its repositories. Every login after that must only
-- identify them — and what makes the second login quiet has to be a row rather
-- than a guess, because the interesting cases are the ones where nothing was
-- installed. Someone who closes GitHub's tab, and an organisation install an
-- owner has still to approve, both leave no installation behind; without a
-- record of the offer they would be sent back to GitHub on every login, which
-- is the redirect loop this table exists to prevent.
--
-- One row per person per workspace, because the offer is made to a person and
-- the installation it would create belongs to a workspace. 'pending' is
-- GitHub's `setup_action=request`: the person asked an owner to install it, and
-- saying so is more use than a silence that looks like a refusal.
CREATE TABLE IF NOT EXISTS github_install_offers (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'offered',
    offered_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id),
    CONSTRAINT github_install_offers_status_ck CHECK (status IN ('offered', 'pending'))
);

COMMENT ON TABLE github_install_offers IS
    'Who has already been sent to GitHub to install the App, and for which workspace.';
COMMENT ON COLUMN github_install_offers.status IS
    'offered — sent to GitHub; pending — an owner was asked to approve the install.';
