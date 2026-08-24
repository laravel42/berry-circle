-- Berry migration range 000-099: shared platform and compatibility foundations.
-- PostgreSQL 16+ provides gen_random_uuid() without an extension.

CREATE TABLE IF NOT EXISTS berry_schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL UNIQUE,
    checksum char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    duration_ms bigint NOT NULL DEFAULT 0 CHECK (duration_ms >= 0)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent')),
    actor_id uuid NOT NULL,
    method text NOT NULL CHECK (method = upper(method)),
    canonical_path text NOT NULL CHECK (char_length(canonical_path) BETWEEN 1 AND 2048),
    canonical_path_hash bytea NOT NULL CHECK (octet_length(canonical_path_hash) = 32),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    response_status integer CHECK (response_status BETWEEN 100 AND 599),
    response_headers jsonb,
    response_body bytea,
    lease_expires_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CHECK (
        (response_status IS NULL AND response_headers IS NULL AND response_body IS NULL)
        OR response_status IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_records_scope_key
    ON idempotency_records (
        actor_type,
        actor_id,
        method,
        canonical_path_hash,
        idempotency_key
    );
CREATE INDEX IF NOT EXISTS idempotency_records_expires_at_idx
    ON idempotency_records (expires_at);

CREATE TABLE IF NOT EXISTS outbox_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    topic text NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 200),
    aggregate_type text NOT NULL CHECK (char_length(aggregate_type) BETWEEN 1 AND 100),
    aggregate_id uuid NOT NULL,
    workspace_id uuid,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    available_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error text
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
    ON outbox_events (available_at, occurred_at, id)
    WHERE published_at IS NULL;
