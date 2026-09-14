-- Berry 173: "about you" on a profile.
--
-- A person writes it once and every agent working with them reads it as
-- context, which is why it lives on the user rather than in a workspace
-- membership: the same sentence is true of them everywhere.
--
-- The 2000-character bound is the API's bound as well. Keeping it here too
-- means a row written by a migration, a fixture or psql is still renderable by
-- a client that trusts the documented maximum.
ALTER TABLE users ADD COLUMN IF NOT EXISTS description text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_description_length_ck'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_description_length_ck
            CHECK (description IS NULL OR char_length(description) <= 2000);
    END IF;
END $$;
