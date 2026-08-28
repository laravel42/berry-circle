ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_verify_commands_ck;
ALTER TABLE projects DROP COLUMN IF EXISTS verify_commands;
