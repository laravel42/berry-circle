-- Password credentials on users, plus the idempotency fingerprint a sign-up
-- needs to be a replay rather than a second account.
--
-- Additive and nullable so the migration runs cleanly on an existing database:
-- backfilled and passwordless dev accounts simply hold no credential and cannot
-- sign in via password until one is set. The check constraints are NOT VALID so
-- they guard new writes without forcing a full-table scan on apply.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_salt bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_updated_at timestamptz;

-- Both present or both absent: a half-set credential can never be verified.
ALTER TABLE users ADD CONSTRAINT users_password_pair_ck
    CHECK ((password_hash IS NULL) = (password_salt IS NULL)) NOT VALID;
-- scrypt digest is 32 bytes, salt is 16 (SCRYPT_PARAMS in src/auth/password.ts).
ALTER TABLE users ADD CONSTRAINT users_password_hash_len_ck
    CHECK (password_hash IS NULL OR octet_length(password_hash) = 32) NOT VALID;
ALTER TABLE users ADD CONSTRAINT users_password_salt_len_ck
    CHECK (password_salt IS NULL OR octet_length(password_salt) = 16) NOT VALID;

-- Sign-up idempotency, mirroring workspaces.create (migration 004): the key
-- hash and the request-body fingerprint are stored on the created row, and a
-- partial unique index makes a replay of the same key hit ON CONFLICT rather
-- than create a second account. Both are sha256 digests, so both are 32 bytes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS creation_key_hash bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS creation_fingerprint bytea;

ALTER TABLE users ADD CONSTRAINT users_creation_key_hash_len_ck
    CHECK (creation_key_hash IS NULL OR octet_length(creation_key_hash) = 32) NOT VALID;
ALTER TABLE users ADD CONSTRAINT users_creation_fingerprint_len_ck
    CHECK (creation_fingerprint IS NULL OR octet_length(creation_fingerprint) = 32) NOT VALID;
-- Both or neither: a stored key with no fingerprint could not tell a replay
-- from a conflict, and a fingerprint with no key would never be looked up.
ALTER TABLE users ADD CONSTRAINT users_creation_key_pair_ck
    CHECK (
        (creation_key_hash IS NULL AND creation_fingerprint IS NULL)
        OR (creation_key_hash IS NOT NULL AND creation_fingerprint IS NOT NULL)
    ) NOT VALID;

-- One account per key. Partial so the vast majority of rows (created without a
-- key, or before this migration) are not forced to share a single NULL slot.
CREATE UNIQUE INDEX IF NOT EXISTS users_creation_key
    ON users (creation_key_hash)
    WHERE creation_key_hash IS NOT NULL;
