-- Reverses migration 179.

ALTER TABLE squads DROP CONSTRAINT IF EXISTS squads_instructions_ck;
ALTER TABLE squads DROP CONSTRAINT IF EXISTS squads_avatar_url_ck;
ALTER TABLE squads DROP COLUMN IF EXISTS instructions;
ALTER TABLE squads DROP COLUMN IF EXISTS avatar_url;
