-- Password sign-in is gone (workstream J): GitHub via Better Auth is the only
-- way in. The credentials and the sign-up idempotency pair added by 050 are
-- dropped rather than left as dead secrets in every users row.
DROP INDEX IF EXISTS users_creation_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_creation_key_pair_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_creation_fingerprint_len_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_creation_key_hash_len_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_salt_len_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_hash_len_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_pair_ck;
ALTER TABLE users DROP COLUMN IF EXISTS creation_fingerprint;
ALTER TABLE users DROP COLUMN IF EXISTS creation_key_hash;
ALTER TABLE users DROP COLUMN IF EXISTS password_updated_at;
ALTER TABLE users DROP COLUMN IF EXISTS password_salt;
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
