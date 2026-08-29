-- What an agent is allowed to do.
--
-- Berry's claim is that revoking a permission makes the runtime refuse the
-- call, which needs somewhere to say what is granted. This is that column.
--
-- Existing agents get the four permissions they already had in practice, so
-- this changes what is *recorded* rather than what any current agent can do.
--
-- `merge_without_approval` is deliberately not among them and is deliberately
-- not a default. An agent that could merge its own work would make the human
-- review gate advisory, and the gate is the product.
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS permissions text[] NOT NULL
    DEFAULT ARRAY['read_repository', 'create_branches', 'run_commands', 'open_pull_requests']::text[];

-- A cap rather than a vocabulary check: the set of permission names belongs in
-- the application, which ignores any it does not recognise, and a CHECK
-- listing them here would have to be migrated every time one is added.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_permissions_ck;
ALTER TABLE agents
    ADD CONSTRAINT agents_permissions_ck
    CHECK (array_length(permissions, 1) IS NULL OR array_length(permissions, 1) <= 32)
    NOT VALID;

COMMENT ON COLUMN agents.permissions IS
    'Granted permission names. Unknown names are ignored by the server; absence is denial.';
