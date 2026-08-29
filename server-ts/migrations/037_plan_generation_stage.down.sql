ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_generation_stage_ck;
ALTER TABLE plans DROP COLUMN IF EXISTS generation_stage;
