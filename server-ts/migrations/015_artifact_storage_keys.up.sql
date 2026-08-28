-- Berry migration 015: let an artifact's storage key name the run (ADR-0006).
--
-- Migration 006 constrained every storage key to
-- attachments/<workspace>/<attachment>, which was right when a human upload was
-- the only way a file entered the store. ADR-0006 requires an artifact's key to
-- be scoped by workspace *and* run, so the location states which run produced
-- it rather than leaving that knowable only through a column.
--
-- The shape stays constrained rather than being relaxed to anything. The
-- constraint is what stops a key being assembled from user input, and a
-- storage key that could take an arbitrary shape is one path traversal away
-- from reading another workspace's objects.
ALTER TABLE attachments
    DROP CONSTRAINT IF EXISTS attachments_storage_key_shape_ck;

ALTER TABLE attachments
    ADD CONSTRAINT attachments_storage_key_shape_ck CHECK (
        -- A human upload, unchanged from migration 006.
        storage_key ~ '^attachments/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        -- A run artifact: workspace, then run, then attachment.
        OR storage_key ~ '^artifacts/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    );

-- An artifact key must belong to a row that claims to be one. Without this the
-- two shapes would merely coexist, and a human upload could be written under
-- the artifacts prefix where retention will eventually look for run output.
ALTER TABLE attachments
    DROP CONSTRAINT IF EXISTS attachments_artifact_key_ck;

ALTER TABLE attachments
    ADD CONSTRAINT attachments_artifact_key_ck CHECK (
        (storage_key LIKE 'artifacts/%') = (run_id IS NOT NULL)
    ) NOT VALID;
