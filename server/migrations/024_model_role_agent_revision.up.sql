-- 024: model role agents record the revision of the manifest Berry spawned
-- them with. The runtime cannot report manifest limits back, so provisioning
-- compares this revision with the binary's and re-spawns the role when the
-- manifest shape changed (history cap, output budget, hourly cap).
ALTER TABLE model_role_agents ADD COLUMN IF NOT EXISTS manifest_revision text NOT NULL DEFAULT '';
