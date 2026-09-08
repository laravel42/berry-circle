-- Reverting removes the ability to hold a password credential. The constraints
-- come off first, then the columns they guard, so nothing references a column
-- mid-drop. Any stored credentials are discarded with the columns; a rollback
-- returns users to passwordless-only sign-in.

-- Sign-up idempotency, added by the up migration, comes off first: the index,
-- then the constraints, then the columns they guard.
DROP INDEX IF EXISTS users_creation_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_creation_key_pair_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_creation_fingerprint_len_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_creation_key_hash_len_ck;
ALTER TABLE users DROP COLUMN IF EXISTS creation_fingerprint;
ALTER TABLE users DROP COLUMN IF EXISTS creation_key_hash;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_salt_len_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_hash_len_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_pair_ck;

ALTER TABLE users DROP COLUMN IF EXISTS password_updated_at;
ALTER TABLE users DROP COLUMN IF EXISTS password_salt;
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
