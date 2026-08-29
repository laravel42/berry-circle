ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_permissions_ck;
ALTER TABLE agents DROP COLUMN IF EXISTS permissions;
