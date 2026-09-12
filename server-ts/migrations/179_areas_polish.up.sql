-- Berry migration 179: a squad's standing instructions and its avatar.
--
-- A squad is briefed before its leader delegates. Until now that briefing was
-- assembled from the description alone, which is the one-line answer to "what
-- is this squad", not the standing instruction every member's work should
-- follow. The instructions tab writes this column; the avatar is how a squad
-- is recognised in a list beside agents and people, which already have one.

ALTER TABLE squads ADD COLUMN IF NOT EXISTS instructions text NOT NULL DEFAULT '';
ALTER TABLE squads ADD COLUMN IF NOT EXISTS avatar_url text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'squads_instructions_ck') THEN
        ALTER TABLE squads ADD CONSTRAINT squads_instructions_ck
            CHECK (char_length(instructions) <= 20000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'squads_avatar_url_ck') THEN
        ALTER TABLE squads ADD CONSTRAINT squads_avatar_url_ck
            CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 2048);
    END IF;
END
$$;
