-- Reverting narrows the shape back to human uploads only. Any run artifact
-- already stored would violate it, so the rows are dropped first: their bytes
-- are still in object storage, and the ledger row is what this migration added
-- the ability to write.
DELETE FROM attachments WHERE storage_key LIKE 'artifacts/%';

ALTER TABLE attachments
    DROP CONSTRAINT IF EXISTS attachments_artifact_key_ck;

ALTER TABLE attachments
    DROP CONSTRAINT IF EXISTS attachments_storage_key_shape_ck;

ALTER TABLE attachments
    ADD CONSTRAINT attachments_storage_key_shape_ck CHECK (
        storage_key ~ '^attachments/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    );
